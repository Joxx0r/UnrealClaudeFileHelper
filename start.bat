@echo off
cd /d "%~dp0"

if not exist config.json (
    echo config.json not found. Run setup.bat first.
    pause
    exit /b 1
)

npm start
