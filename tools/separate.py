"""Split a song into instrument stems for the ink visualizer (run once per song, offline).

    pip install demucs
    python tools/separate.py "光の芽生え.mp3" --id hikari

Writes stems/<id>/{drums,bass,vocals,guitar,piano,other}.mp3 next to index.html.
Then point AV.BUILTIN_AUDIO.stems.dir in js/config.js at "stems/<id>/" and deploy the stems folder
together with the site. Uses Demucs' 6-source model (htdemucs_6s), which has separate guitar and piano.
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

STEMS = ["drums", "bass", "vocals", "guitar", "piano", "other"]
MODEL = "htdemucs_6s"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path, help="audio file to separate")
    ap.add_argument("--id", required=True, help="ASCII folder name under stems/ (keeps URLs simple)")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "stems")
    ap.add_argument("--bitrate", type=int, default=128, help="mp3 kbps per stem (web size vs quality)")
    ap.add_argument("--device", default=None, help="cpu / cuda (default: demucs decides)")
    args = ap.parse_args()

    if not args.input.is_file():
        print(f"not found: {args.input}", file=sys.stderr)
        return 1

    dest = args.out / args.id
    with tempfile.TemporaryDirectory() as tmp:
        cmd = [sys.executable, "-m", "demucs", "-n", MODEL, "--mp3", "--mp3-bitrate", str(args.bitrate),
               "-o", tmp, str(args.input)]
        if args.device:
            cmd += ["-d", args.device]
        print("running:", " ".join(cmd))
        if subprocess.call(cmd) != 0:
            print("demucs failed (is it installed? pip install demucs)", file=sys.stderr)
            return 1

        src = Path(tmp) / MODEL / args.input.stem
        dest.mkdir(parents=True, exist_ok=True)
        for name in STEMS:
            f = src / f"{name}.mp3"
            if not f.is_file():
                print(f"missing stem: {name}", file=sys.stderr)
                return 1
            shutil.copy2(f, dest / f"{name}.mp3")

    print(f"done: {dest}")
    print(f'config.js -> stems: {{ dir: "stems/{args.id}/", ext: "mp3", names: {STEMS} }}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
