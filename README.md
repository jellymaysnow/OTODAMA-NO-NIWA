# audio_vis

[日本語](README.ja.md)

A visualizer that turns sound into watercolor ink drops. It is a static page: just open `index.html`, or publish it with GitHub Pages.

## Features

- **Inputs**: built-in audio (`Project.wav`), microphone, or your own audio file (pick or drop).
- **Ink painting**: low / mid / high bands (or individual instruments) drop ink onto paper; long notes spread into wide, pale blooms. See [docs/ink.md](docs/ink.md).
- **Palettes**: preset palettes plus a free colour picker. A stereo-field scope (goniometer) is shown at the bottom left on wide screens.
- **Finishing**: when a song ends the paper dries and the work is signed with a title, date and seal. Save it as an image at any time.
- **Video recording**: record the painting with its sound, from the start of the song.
- **Separation mode (local only)**: splits a song into six instruments with Demucs and lets each instrument paint on its own.

## Try it

- **Public version (GitHub Pages)**: open the page and press start. Built-in audio, microphone and file loading work. Microphone input needs HTTPS, which Pages provides.
- **Locally**: open `index.html` in a browser, or double-click `start.bat` to start the local server (also required for separation mode).

## Separation mode is local only

It uses Demucs, so it works only while the local server (`tools/server.py`) is running on your own PC. On the public version it cannot connect and automatically falls back to normal mode. Audio is never uploaded anywhere.

```
pip install demucs numpy        # plus a suitable torch for your GPU/CPU
python tools/server.py --open   # or double-click start.bat
```

Details: [docs/ink.md](docs/ink.md).

## Project layout

| Path | Contents |
|---|---|
| `index.html`, `css/`, `js/` | The app (static) |
| `tools/server.py` | Local server for separation mode |
| `tools/separate.py` | Pre-separation of stems for built-in audio |
| `docs/` | Module documentation (English / Japanese) |
| `Project.wav` | Built-in audio |

## License and credits

- **Code**: [PolyForm Noncommercial License 1.0.0](LICENSE). Noncommercial use (personal, research, education, hobby, etc.) is allowed; selling or other commercial use is not.
- **Built-in audio (`Project.wav`)**: an original work of the author, not covered by the license above. All rights reserved; no redistribution or reuse without permission. No other audio files are included in this repository (excluded by `.gitignore`).
- **Third-party**: Tailwind CSS (MIT), Inter and Shippori Mincho (SIL OFL 1.1, via Google Fonts), and Demucs (MIT, local use only).

Copyright (c) 2026 Jieli
