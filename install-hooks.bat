@echo off
REM Install unreal-index PreToolUse hooks into your project's .claude directory.
REM
REM This intercepts Grep, Glob, and Bash tool calls in Claude Code and routes
REM them through the unreal-index service for fast indexed results.
REM
REM Usage:
REM   install-hooks.bat <project-directory>
REM
REM Example:
REM   install-hooks.bat D:\p4\games\Games\MyProject\Script
REM
REM The project-directory should be the root of your Claude Code working
REM directory (where .claude/ exists or will be created).

if "%~1"=="" (
    echo.
    echo Usage: install-hooks.bat ^<project-directory^>
    echo.
    echo   project-directory  Path to your project root where .claude/ exists
    echo                      or will be created.
    echo.
    echo Example:
    echo   install-hooks.bat D:\p4\games\Games\MyProject\Script
    echo.
    exit /b 1
)

node "%~dp0src\hooks\install.js" "%~1"
