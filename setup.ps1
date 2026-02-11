# embark-claude-index — Windows setup script
# Run this after installing the plugin to configure the indexing service.
#
# What this does:
#   1. Clones/updates the repo to a stable location (~/.claude/repos/embark-claude-index)
#   2. Installs npm dependencies
#   3. Runs the interactive setup wizard (project detection, config generation)
#   4. Prints next steps for starting the service

param(
    [switch]$SkipClone,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git"
$StableDir = Join-Path $env:USERPROFILE ".claude\repos\embark-claude-index"
$PluginDir = $PSScriptRoot

Write-Host ""
Write-Host "=== embark-claude-index setup ===" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Ensure stable repo location ─────────────────────

if (-not $SkipClone) {
    if (Test-Path (Join-Path $StableDir ".git")) {
        Write-Host "[1/3] Updating repo at $StableDir ..." -ForegroundColor Yellow
        Push-Location $StableDir
        try {
            git pull --ff-only 2>&1 | Out-Null
            Write-Host "  Repo updated." -ForegroundColor Green
        } catch {
            Write-Host "  Warning: git pull failed, continuing with existing checkout." -ForegroundColor Yellow
        }
        Pop-Location
    } else {
        Write-Host "[1/3] Cloning repo to $StableDir ..." -ForegroundColor Yellow
        $ParentDir = Split-Path $StableDir -Parent
        if (-not (Test-Path $ParentDir)) {
            New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
        }
        git clone $RepoUrl $StableDir
        Write-Host "  Repo cloned." -ForegroundColor Green
    }
} else {
    Write-Host "[1/3] Skipping clone (--SkipClone)." -ForegroundColor Yellow
    $StableDir = $PluginDir
}

# ── Step 2: Install dependencies ─────────────────────────────

Write-Host "[2/3] Installing npm dependencies ..." -ForegroundColor Yellow
Push-Location $StableDir
try {
    npm install --production 2>&1 | Out-Null
    Write-Host "  Dependencies installed." -ForegroundColor Green
} catch {
    Write-Host "  Error: npm install failed. Make sure Node.js 20.18+ is installed." -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# ── Step 3: Run interactive setup wizard ─────────────────────

Write-Host "[3/3] Running setup wizard ..." -ForegroundColor Yellow
Write-Host ""

Push-Location $StableDir
node src/setup.js
$SetupExitCode = $LASTEXITCODE
Pop-Location

if ($SetupExitCode -ne 0) {
    Write-Host ""
    Write-Host "Setup wizard exited with errors. You can re-run it later with:" -ForegroundColor Yellow
    Write-Host "  cd $StableDir && node src/setup.js" -ForegroundColor White
    exit 1
}

# ── Summary ──────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Repo location:  $StableDir" -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Start the service (in WSL):" -ForegroundColor White
Write-Host "     cd $($StableDir -replace '\\','/') && ./start-service.sh --bg" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Start the file watcher (in Windows):" -ForegroundColor White
Write-Host "     cd $StableDir && node src\watcher\watcher-client.js" -ForegroundColor Gray
Write-Host ""
Write-Host "  3. Restart Claude Code to load the MCP tools." -ForegroundColor White
Write-Host ""
