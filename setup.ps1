# embark-claude-index — Windows setup script
# Run this after installing the plugin to configure the indexing service.
#
# IMPORTANT: The indexing service runs in WSL. This script uses
# `wsl -- bash -c '...'` for all service-side operations.
#
# What this does:
#   1. Clones/updates the repo inside WSL (~/.claude/repos/embark-claude-index)
#   2. Installs npm dependencies in WSL
#   3. Runs the interactive setup wizard in WSL
#   4. Installs Zoekt in WSL (if Go is available)
#   5. Starts the service in WSL
#   6. Prints next steps for starting the file watcher

$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git"
$WslRepoDir = "`$HOME/.claude/repos/embark-claude-index"

Write-Host ""
Write-Host "=== embark-claude-index setup ===" -ForegroundColor Cyan
Write-Host ""

# ── Verify WSL is available ──────────────────────────────────

Write-Host "Checking WSL ..." -ForegroundColor Yellow
try {
    $wslCheck = wsl -- bash -c 'echo ok' 2>&1
    if ($wslCheck -ne "ok") { throw "WSL not responding" }
    Write-Host "  WSL is available." -ForegroundColor Green
} catch {
    Write-Host "  ERROR: WSL is required but not available." -ForegroundColor Red
    Write-Host "  Install WSL: https://learn.microsoft.com/en-us/windows/wsl/install" -ForegroundColor White
    exit 1
}

# ── Step 1: Clone/update repo in WSL ─────────────────────────

Write-Host "[1/5] Setting up repo in WSL ..." -ForegroundColor Yellow
wsl -- bash -c @"
if [ -d "$WslRepoDir/.git" ]; then
  cd "$WslRepoDir" && git pull --ff-only 2>/dev/null && echo '  Repo updated.'
else
  mkdir -p "`$(dirname "$WslRepoDir")"
  git clone $RepoUrl "$WslRepoDir" && echo '  Repo cloned.'
fi
"@
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Warning: git clone/pull had issues, continuing..." -ForegroundColor Yellow
}

# ── Step 2: Install dependencies in WSL ──────────────────────

Write-Host "[2/5] Installing npm dependencies in WSL ..." -ForegroundColor Yellow
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && npm install --production 2>&1 | tail -3'
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: npm install failed. Check that Node.js 20.18+ is installed in WSL." -ForegroundColor Red
    Write-Host "  Check: wsl -- bash -c 'node --version'" -ForegroundColor White
    exit 1
}
Write-Host "  Dependencies installed." -ForegroundColor Green

# ── Step 3: Run interactive setup wizard in WSL ──────────────

Write-Host "[3/5] Running setup wizard in WSL ..." -ForegroundColor Yellow
Write-Host "  (The wizard will ask for your project paths — Windows paths like C:\... are fine)" -ForegroundColor Gray
Write-Host ""
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && node src/setup.js'
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  Setup wizard exited with errors. Re-run later with:" -ForegroundColor Yellow
    Write-Host "  wsl -- bash -c 'cd `$HOME/.claude/repos/embark-claude-index && node src/setup.js'" -ForegroundColor White
    exit 1
}

# ── Step 4: Install Zoekt in WSL ─────────────────────────────

Write-Host "[4/5] Checking Zoekt (full-text code search) in WSL ..." -ForegroundColor Yellow
wsl -- bash -c 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"; if command -v zoekt-index &>/dev/null; then echo "  Zoekt already installed."; elif command -v go &>/dev/null; then echo "  Installing Zoekt..."; go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest 2>/dev/null && go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest 2>/dev/null && echo "  Zoekt installed." || echo "  Warning: Zoekt install failed. Full-text search unavailable."; else echo "  Go not found. Zoekt (optional) requires Go: https://go.dev/dl/"; fi'

# ── Step 5: Start service in WSL ─────────────────────────────

Write-Host "[5/5] Starting indexing service in WSL ..." -ForegroundColor Yellow
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && screen -dmS unreal-index bash -c "node src/service/index.js 2>&1 | tee /tmp/unreal-index.log"'
Start-Sleep -Seconds 3

$healthCheck = wsl -- bash -c 'curl -s http://127.0.0.1:3847/health 2>/dev/null || echo FAIL'
if ($healthCheck -match "FAIL") {
    Write-Host "  Warning: Service may not have started. Check:" -ForegroundColor Yellow
    Write-Host "  wsl -- bash -c 'tail -20 /tmp/unreal-index.log'" -ForegroundColor White
} else {
    Write-Host "  Service is running." -ForegroundColor Green
}

# ── Summary ──────────────────────────────────────────────────

$WindowsRepoDir = Join-Path $env:USERPROFILE ".claude\repos\embark-claude-index"

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Start the file watcher (in a Windows terminal):" -ForegroundColor White
Write-Host "     cd $WindowsRepoDir" -ForegroundColor Gray
Write-Host "     node src\watcher\watcher-client.js" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Restart Claude Code to load the MCP tools." -ForegroundColor White
Write-Host ""
