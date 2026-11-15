#!/usr/bin/env python3
"""Local server: serves the visualizer AND separates songs into instruments on this PC.

    pip install demucs
    python tools/server.py            # then open http://127.0.0.1:8765/

In "分離" mode the page uploads the chosen audio file here; Demucs (htdemucs_6s: drums, bass, other,
vocals, guitar, piano) splits it, and the page plays the song while analysing each instrument.
Results are cached in .stems-cache/ by file content, so the same song is only separated once.

Nothing leaves this machine: the server listens on 127.0.0.1 only.
"""
import argparse
import hashlib
import importlib.util
import json
import mimetypes
import re
import shutil
import subprocess
import sys
import threading
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".stems-cache"
STEMS = ["drums", "bass", "other", "vocals", "guitar", "piano"]
MODEL = "htdemucs_6s"
MAX_UPLOAD = 600 * 1024 * 1024
ID_RE = re.compile(r"^[0-9a-f]{16}$")

jobs = {}                          # id -> {state: queued|running|done|error, pct, error}
jobs_lock = threading.Lock()
worker = threading.Semaphore(1)    # one separation at a time (CPU / GPU heavy)
opts = {"device": None, "bitrate": 128, "origins": set()}


def stem_path(job_id, name):
    return CACHE / job_id / "stems" / f"{name}.mp3"


def stems_ready(job_id):
    return all(stem_path(job_id, n).is_file() for n in STEMS)


def run_job(job_id, src):
    job = jobs[job_id]
    with worker:
        job.update(state="running", pct=0)
        out = CACHE / job_id / "out"
        cmd = [sys.executable, "-m", "demucs", "-n", MODEL, "--mp3", "--mp3-bitrate", str(opts["bitrate"]),
               "-o", str(out), str(src)]
        if opts["device"]:
            cmd += ["-d", opts["device"]]
        tail = b""
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            while True:
                chunk = p.stderr.read(256)
                if not chunk:
                    break
                tail = (tail + chunk)[-2000:]
                found = re.findall(rb"(\d{1,3})%\|", tail)     # tqdm progress: " 42%|####"
                if found:
                    job["pct"] = min(99, int(found[-1]))
            code = p.wait()
            if code != 0:
                job.update(state="error", error="demucs failed: " + tail.decode("utf-8", "replace")[-300:])
                return
            produced = out / MODEL / src.stem
            dest = CACHE / job_id / "stems"
            dest.mkdir(parents=True, exist_ok=True)
            for n in STEMS:
                shutil.move(str(produced / f"{n}.mp3"), dest / f"{n}.mp3")
            shutil.rmtree(out, ignore_errors=True)
            job.update(state="done", pct=100)
        except Exception as e:                                   # noqa: BLE001 - report anything to the page
            job.update(state="error", error=str(e))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "InkSeparator"

    def log_message(self, fmt, *args):                           # keep the console quiet
        pass

    # ---- helpers ----
    def cors(self):
        origin = self.headers.get("Origin")
        if origin and origin in opts["origins"]:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")

    def json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, path, head_only=False):
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", ""))
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:                                                # suffix range: last N bytes
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head_only:
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    data = f.read(min(65536, left))
                    if not data:
                        break
                    self.wfile.write(data)
                    left -= len(data)
        except (BrokenPipeError, ConnectionResetError):          # the player seeked / stopped
            pass

    # ---- routes ----
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET(head_only=True)

    def do_GET(self, head_only=False):
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.split("/") if p]

        if len(parts) == 2 and parts[0] == "status" and ID_RE.match(parts[1]):
            job_id = parts[1]
            job = jobs.get(job_id)
            if job is None and stems_ready(job_id):
                job = {"state": "done", "pct": 100}
            return self.json(job or {"state": "error", "error": "unknown job"}, 200 if job else 404)

        if len(parts) == 3 and parts[0] == "stems" and ID_RE.match(parts[1]):
            name = parts[2][:-4] if parts[2].endswith(".mp3") else ""
            if name in STEMS and stem_path(parts[1], name).is_file():
                return self.serve_file(stem_path(parts[1], name), head_only)
            return self.json({"error": "not found"}, 404)

        # static files of the visualizer (nothing hidden, no cache folder)
        rel = Path(*parts) if parts else Path("index.html")
        target = (ROOT / rel).resolve()
        if (ROOT in target.parents or target == ROOT) and not any(p.startswith(".") for p in rel.parts):
            if target.is_dir():
                target = target / "index.html"
            if target.is_file():
                return self.serve_file(target, head_only)
        self.json({"error": "not found"}, 404)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/separate":
            return self.json({"error": "not found"}, 404)
        ext = parse_qs(url.query).get("ext", [".mp3"])[0]
        if not re.match(r"^\.[A-Za-z0-9]{1,5}$", ext):
            ext = ".mp3"
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_UPLOAD:
            return self.json({"error": "bad size"}, 413)

        CACHE.mkdir(exist_ok=True)
        tmp = CACHE / f"upload-{uuid.uuid4().hex}"
        sha = hashlib.sha1()
        left = length
        with open(tmp, "wb") as f:
            while left > 0:
                data = self.rfile.read(min(1 << 20, left))
                if not data:
                    break
                sha.update(data)
                f.write(data)
                left -= len(data)
        if left:
            tmp.unlink(missing_ok=True)
            return self.json({"error": "incomplete upload"}, 400)

        job_id = sha.hexdigest()[:16]
        with jobs_lock:
            if stems_ready(job_id):
                jobs[job_id] = {"state": "done", "pct": 100}
                tmp.unlink(missing_ok=True)
            elif job_id in jobs and jobs[job_id]["state"] in ("queued", "running"):
                tmp.unlink(missing_ok=True)
            else:
                folder = CACHE / job_id
                folder.mkdir(exist_ok=True)
                src = folder / f"input{ext}"
                shutil.move(str(tmp), src)
                jobs[job_id] = {"state": "queued", "pct": 0}
                threading.Thread(target=run_job, args=(job_id, src), daemon=True).start()
        self.json({"id": job_id})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--device", default=None, help="cpu / cuda (default: demucs decides)")
    ap.add_argument("--bitrate", type=int, default=128, help="mp3 kbps per stem")
    ap.add_argument("--origin", action="append", default=[],
                    help="extra page origin allowed to call this server (e.g. https://my-site.example)")
    ap.add_argument("--open", action="store_true", help="open the page in the browser")
    args = ap.parse_args()

    opts["device"], opts["bitrate"] = args.device, args.bitrate
    opts["origins"] = {f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}", *args.origin}

    if importlib.util.find_spec("demucs") is None:
        print("! demucs is not installed: run  pip install demucs  (separation will fail until then)")
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"serving {ROOT}\nopen {url}\nCtrl+C to stop")
    if args.open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
