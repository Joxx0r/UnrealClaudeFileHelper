@echo off
cd /d "%~dp0"

if not exist config.json (
    echo config.json not found.
    echo Run setup.bat to create your config, or copy config.example.json to config.json and edit it.
    pause
    exit /b 1
)

echo Starting index service in WSL...
start "" /B wsl -- bash -c "export PATH=$HOME/go/bin:/usr/local/go/bin:$PATH && cd ~/repos/unreal-index && exec node src/service/index.js 2>&1 | tee /tmp/unreal-index.log"

:: Wait for service to come up
echo Waiting for service on port 3847...
set TRIES=0
:wait_loop
if %TRIES% GEQ 30 (
    echo ERROR: Service did not start within 30s
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:3847/health >nul 2>&1 && goto service_up
set /a TRIES+=1
goto wait_loop

:service_up
echo Service is running.

echo Starting file watcher...
node src/watcher/watcher-client.js
