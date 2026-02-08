@echo off
cd /d "%~dp0"
pip install -q PySide6 2>nul
python tools\launcher.py %*
