@echo off
REM Start the unreal-index service in WSL.
REM Double-click this file or run from a command prompt.
REM After starting, opens the dashboard in your browser.

setlocal enabledelayedexpansion

echo.
echo  Unreal Index Service
echo  ====================
echo.

REM Check if WSL is available
wsl --status >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: WSL is not installed or not running.
    echo Install WSL: https://learn.microsoft.com/en-us/windows/wsl/install
    pause
    exit /b 1
)

REM Check if already running
for /f "tokens=*" %%i in ('wsl -- bash -c "curl -s http://127.0.0.1:3847/health 2>/dev/null && echo OK || echo DOWN"') do set "HEALTH=%%i"

echo !HEALTH! | findstr /C:"OK" >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo  Service is already running!
    echo  Dashboard: http://localhost:3847
    echo.
    start http://localhost:3847
    timeout /t 3 >nul
    exit /b 0
)

echo  Starting service in WSL...
echo.

REM Find the repo in WSL and start the service
wsl -- bash -c "export PATH=$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH; for d in $HOME/repos/unreal-index $HOME/.claude/repos/embark-claude-index $HOME/.claude/repos/unreal-index; do if [ -f $d/start-service.sh ]; then cd $d && bash start-service.sh --bg; exit; fi; done; echo ERROR: Repo not found in WSL"

if !ERRORLEVEL! EQU 0 (
    echo.
    echo  Service started successfully!
    echo  Dashboard: http://localhost:3847
    echo.
    echo  To start the file watcher, run in a separate terminal:
    echo    node "%~dp0src\watcher\watcher-client.js"
    echo.
    start http://localhost:3847
) else (
    echo.
    echo  Failed to start service. Check logs:
    echo    wsl -- bash -c "tail -20 /tmp/unreal-index.log"
    echo.
)

pause
