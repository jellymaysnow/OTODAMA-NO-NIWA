@echo off
rem Starts the visualizer + local separation server (uses the .venv in this folder) and opens the page.
cd /d "%~dp0"
.venv\Scripts\python.exe tools\server.py --open
pause
