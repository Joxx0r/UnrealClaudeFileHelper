# embark-claude-index - Windows setup script
# Run this after installing the plugin to configure the indexing service.
#
# IMPORTANT: The indexing service runs in WSL. This script uses
# `wsl -- bash --noprofile --norc -lc '...'` for all service-side operations.
#
# What this does:
#   1. Clones/updates the repo inside WSL (~/.claude/repos/embark-claude-index)
#   2. Ensures Node.js is available in WSL
#   3. Installs Linux prerequisites in WSL when possible
#   4. Installs npm dependencies in WSL
#   5. Prepares Zoekt in WSL (unless -DisableZoekt)
#   6. Creates/syncs config.json and keeps zoekt.enabled in sync
#   7. Installs Windows bridge/watcher dependencies (Claude-first; Codex optional)
#   8. Starts the service in WSL (tmux) and verifies health on 127.0.0.1:3847
#   9. Prints next steps for watcher and agent integration

param(
    [string]$ProjectRoot = "",
    [switch]$SkipSetupWizard,
    [switch]$DisableZoekt
)

$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsRepoDir = (Resolve-Path $ScriptDir).Path
$WindowsRepoDirForward = $WindowsRepoDir -replace '\\', '/'
$WindowsConfigPath = Join-Path $WindowsRepoDir "config.json"
$DefaultClaudeRepoDir = Join-Path $env:USERPROFILE ".claude\repos\embark-claude-index"

$WslHome = ""
$WslRepoDir = ""
$WslNodeDir = ""
$WindowsRepoWslPath = ""
$ShouldEnableZoekt = -not $DisableZoekt
$ZoektPrepared = $false

function Convert-WindowsPathToWsl([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $drive = $full.Substring(0, 1).ToLowerInvariant()
    $rest = $full.Substring(2).Replace('\', '/')
    return "/mnt/$drive$rest"
}

function Invoke-Wsl([string]$Command, [switch]$AllowFailure) {
    wsl -- bash --noprofile --norc -lc $Command
    $exitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "WSL command failed (exit $exitCode): $Command"
    }
}

function Test-WslFile([string]$Path) {
    $result = wsl -- bash --noprofile --norc -lc "if [ -f '$Path' ]; then echo yes; fi"
    return ($result -match "yes")
}

function Set-ConfigZoektEnabled([string]$Path, [bool]$Enabled) {
    if (-not (Test-Path $Path)) {
        return
    }

    $text = [System.IO.File]::ReadAllText($Path)
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
        $text = $text.Substring(1)
    }

    $cfg = $text | ConvertFrom-Json
    if (-not $cfg) {
        throw "Failed to parse JSON from $Path"
    }

    if (-not ($cfg.PSObject.Properties.Name -contains "zoekt")) {
        $cfg | Add-Member -NotePropertyName zoekt -NotePropertyValue ([pscustomobject]@{})
    }
    $zoekt = $cfg.zoekt

    if (-not ($zoekt.PSObject.Properties.Name -contains "webPort")) { $zoekt | Add-Member -NotePropertyName webPort -NotePropertyValue 6070 }
    if (-not ($zoekt.PSObject.Properties.Name -contains "indexDir")) { $zoekt | Add-Member -NotePropertyName indexDir -NotePropertyValue "./data/zoekt-index" }
    if (-not ($zoekt.PSObject.Properties.Name -contains "mirrorDir")) { $zoekt | Add-Member -NotePropertyName mirrorDir -NotePropertyValue "./data/zoekt-mirror" }
    if (-not ($zoekt.PSObject.Properties.Name -contains "parallelism")) { $zoekt | Add-Member -NotePropertyName parallelism -NotePropertyValue 4 }
    if (-not ($zoekt.PSObject.Properties.Name -contains "fileLimitBytes")) { $zoekt | Add-Member -NotePropertyName fileLimitBytes -NotePropertyValue 524288 }
    if (-not ($zoekt.PSObject.Properties.Name -contains "reindexDebounceMs")) { $zoekt | Add-Member -NotePropertyName reindexDebounceMs -NotePropertyValue 5000 }
    if (-not ($zoekt.PSObject.Properties.Name -contains "searchTimeoutMs")) { $zoekt | Add-Member -NotePropertyName searchTimeoutMs -NotePropertyValue 3000 }

    if ($zoekt.PSObject.Properties.Name -contains "enabled") {
        $zoekt.enabled = $Enabled
    }
    else {
        $zoekt | Add-Member -NotePropertyName enabled -NotePropertyValue $Enabled
    }

    $json = ($cfg | ConvertTo-Json -Depth 40) + "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Resolve-ProjectRoot([string]$Preferred) {
    if ($Preferred) {
        if (-not (Test-Path $Preferred)) {
            throw "ProjectRoot does not exist: $Preferred"
        }
        return (Resolve-Path $Preferred).Path
    }

    if (Test-Path "C:\p4\games\Games\Discovery\Discovery.uproject") {
        return "C:\p4\games\Games\Discovery"
    }

    $searchRoots = @(
        "C:\p4\games\Games",
        "C:\p4\games",
        (Split-Path -Parent $WindowsRepoDir)
    )

    foreach ($root in $searchRoots) {
        if (-not (Test-Path $root)) {
            continue
        }

        $uproject = Get-ChildItem -Path $root -Filter *.uproject -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\Saved\\' } |
            Select-Object -First 1

        if ($uproject) {
            return $uproject.DirectoryName
        }
    }

    return $null
}

function New-ConfigObject([string]$RootPath, [bool]$EnableZoekt) {
    $root = (Resolve-Path $RootPath).Path
    $projectName = Split-Path -Leaf $root

    $projects = @()

    $scriptPath = Join-Path $root "Script"
    if (Test-Path $scriptPath) {
        $projects += @{
            name       = $projectName
            paths      = @($scriptPath -replace '\\', '/')
            language   = "angelscript"
            extensions = @(".as")
        }
    }

    $cppPaths = @()
    $sourcePath = Join-Path $root "Source"
    if (Test-Path $sourcePath) { $cppPaths += ($sourcePath -replace '\\', '/') }
    $pluginsPath = Join-Path $root "Plugins"
    if (Test-Path $pluginsPath) { $cppPaths += ($pluginsPath -replace '\\', '/') }
    if ($cppPaths.Count -gt 0) {
        $projects += @{
            name       = "$projectName-Cpp"
            paths      = @($cppPaths)
            language   = "cpp"
            extensions = @(".h", ".hpp", ".cpp", ".inl")
        }
    }

    $contentPath = Join-Path $root "Content"
    if (Test-Path $contentPath) {
        $contentFwd = $contentPath -replace '\\', '/'
        $projects += @{
            name        = "$projectName-Content"
            paths       = @($contentFwd)
            contentRoot = $contentFwd
            language    = "content"
            extensions  = @(".uasset", ".umap")
        }
    }

    $configPath = Join-Path $root "Config"
    if (Test-Path $configPath) {
        $projects += @{
            name       = "$projectName-Config"
            paths      = @($configPath -replace '\\', '/')
            language   = "config"
            extensions = @(".ini")
        }
    }

    $gamesRoot = Split-Path -Parent $root
    $enginePaths = @()
    $engineSource = Join-Path $gamesRoot "Engine\Source"
    if (Test-Path $engineSource) { $enginePaths += ($engineSource -replace '\\', '/') }
    $enginePlugins = Join-Path $gamesRoot "Engine\Plugins"
    if (Test-Path $enginePlugins) { $enginePaths += ($enginePlugins -replace '\\', '/') }
    if ($enginePaths.Count -gt 0) {
        $projects += @{
            name       = "Engine"
            paths      = @($enginePaths)
            language   = "cpp"
            extensions = @(".h", ".hpp", ".cpp", ".inl")
        }
    }

    if ($projects.Count -eq 0) {
        throw "Could not find Script/Source/Content/Config under $root"
    }

    return @{
        projects = @($projects)
        exclude  = @(
            "**/Intermediate/**",
            "**/Binaries/**",
            "**/ThirdParty/**",
            "**/__ExternalActors__/**",
            "**/__ExternalObjects__/**",
            "**/Developers/**",
            "**/.git/**",
            "**/node_modules/**"
        )
        service  = @{
            port = 3847
            host = "127.0.0.1"
        }
        watcher  = @{
            debounceMs     = 100
            windowsRepoDir = $WindowsRepoDirForward
        }
        zoekt    = @{
            enabled           = $EnableZoekt
            webPort           = 6070
            indexDir          = "./data/zoekt-index"
            mirrorDir         = "./data/zoekt-mirror"
            parallelism       = 4
            fileLimitBytes    = 524288
            reindexDebounceMs = 5000
            searchTimeoutMs   = 3000
        }
    }
}

function Save-Config([hashtable]$Config) {
    $json = ($Config | ConvertTo-Json -Depth 20) + "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($WindowsConfigPath, $json, $utf8NoBom)
    Invoke-Wsl ("cp '{0}/config.json' '{1}/config.json'" -f $WindowsRepoWslPath, $WslRepoDir)
}

Write-Host ""
Write-Host "=== embark-claude-index setup ===" -ForegroundColor Cyan
Write-Host ""

# Step 0: Verify WSL
Write-Host "Checking WSL ..." -ForegroundColor Yellow
try {
    $wslCheck = wsl -- bash --noprofile --norc -lc 'echo ok' 2>&1
    if ($wslCheck -notmatch "ok") {
        throw "WSL not responding"
    }
    Write-Host "  WSL is available." -ForegroundColor Green
}
catch {
    Write-Host "  ERROR: WSL is required but not available." -ForegroundColor Red
    Write-Host "  Install WSL: https://learn.microsoft.com/en-us/windows/wsl/install" -ForegroundColor White
    exit 1
}

$wslHomeRaw = (wsl -- bash --noprofile --norc -lc 'cd ~ && pwd -P')
$WslHome = (($wslHomeRaw -split "`r?`n") | Where-Object { $_ -match '^/' } | Select-Object -Last 1).Trim()
if (-not $WslHome -or -not ($WslHome -match '^/')) {
    throw "Could not detect WSL HOME directory."
}
$WslRepoDir = "$WslHome/.claude/repos/embark-claude-index"
$WslNodeDir = "$WslHome/local/node22"
$WslNodeBinary = "$WslNodeDir/bin/node"
$WslNpmCli = "$WslNodeDir/lib/node_modules/npm/bin/npm-cli.js"
$WindowsRepoWslPath = Convert-WindowsPathToWsl $WindowsRepoDir

# Step 1: Clone/update repo in WSL
Write-Host "[1/9] Setting up repo in WSL ..." -ForegroundColor Yellow
Invoke-Wsl ("mkdir -p '{0}/.claude/repos'; if [ -d '{1}/.git' ]; then cd '{1}' && git pull --ff-only || true; else git clone '{2}' '{1}'; fi" -f $WslHome, $WslRepoDir, $RepoUrl)

# Step 2: Ensure Node 22 in WSL
Write-Host "[2/9] Ensuring Node.js in WSL ..." -ForegroundColor Yellow
$nodeBootstrap = ('set -e; if [ ! -x "{0}" ]; then rm -rf "{1}"; mkdir -p "{1}"; curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz | tar -xJ -C "{1}" --strip-components=1; fi; "{0}" --version; "{0}" "{2}" --version' -f $WslNodeBinary, $WslNodeDir, $WslNpmCli)
Invoke-Wsl $nodeBootstrap

# Step 3: Install Linux dependencies (screen/build tools)
Write-Host "[3/9] Ensuring Linux dependencies (screen/build tools) ..." -ForegroundColor Yellow
$depsCommand = 'if ( ! command -v screen >/dev/null 2>&1 && ! command -v tmux >/dev/null 2>&1 ) || ! command -v python3 >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n apt-get update && sudo -n apt-get install -y screen build-essential python3 curl || echo deps_install_skipped; else echo deps_install_skipped; fi; fi; command -v screen >/dev/null 2>&1 && echo screen_ok || echo screen_missing; command -v tmux >/dev/null 2>&1 && echo tmux_ok || echo tmux_missing; command -v python3 >/dev/null 2>&1 && echo python3_ok || echo python3_missing; command -v g++ >/dev/null 2>&1 && echo gpp_ok || echo gpp_missing'
try {
    Invoke-Wsl $depsCommand
}
catch {
    Write-Host "  Warning: Could not install one or more Linux packages automatically." -ForegroundColor Yellow
    Write-Host "  Continuing; service start will use tmux/nohup fallback if screen is missing." -ForegroundColor Gray
}

# Step 4: Install npm dependencies in WSL
Write-Host "[4/9] Installing npm dependencies in WSL ..." -ForegroundColor Yellow
Invoke-Wsl ('cd "{0}" && env PATH="{1}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "{2}" "{3}" ci --omit=dev' -f $WslRepoDir, "$WslNodeDir/bin", $WslNodeBinary, $WslNpmCli)

# Step 5: Prepare Zoekt binaries (Go + zoekt-index/zoekt-webserver)
Write-Host "[5/9] Preparing Zoekt full-text search support ..." -ForegroundColor Yellow
if ($ShouldEnableZoekt) {
    $zoektPrepCommand = ('set -e; if [ ! -x "{0}/local/go/bin/go" ] && ! command -v go >/dev/null 2>&1; then mkdir -p "{0}/local"; curl -fsSL https://go.dev/dl/go1.22.12.linux-amd64.tar.gz -o "{0}/local/go.tar.gz"; rm -rf "{0}/local/go"; tar -xzf "{0}/local/go.tar.gz" -C "{0}/local"; rm -f "{0}/local/go.tar.gz"; fi; if [ -x "{0}/local/go/bin/go" ]; then "{0}/local/go/bin/go" install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest >/dev/null 2>&1 || true; "{0}/local/go/bin/go" install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest >/dev/null 2>&1 || true; elif command -v go >/dev/null 2>&1; then go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest >/dev/null 2>&1 || true; go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest >/dev/null 2>&1 || true; else echo go_missing; exit 0; fi; if [ -x "{0}/go/bin/zoekt-index" ] && [ -x "{0}/go/bin/zoekt-webserver" ]; then echo zoekt_ready; else echo zoekt_missing; fi' -f $WslHome)
    $zoektPrepOutput = wsl -- bash --noprofile --norc -lc $zoektPrepCommand
    if ($LASTEXITCODE -eq 0 -and $zoektPrepOutput -match 'zoekt_ready') {
        $ZoektPrepared = $true
        Write-Host "  Zoekt binaries are ready in WSL." -ForegroundColor Green
    }
    else {
        Write-Host "  Warning: Zoekt binaries are not ready. Setup will continue without Zoekt." -ForegroundColor Yellow
        Write-Host "  Re-run setup later (without -DisableZoekt) after Go/network access is available." -ForegroundColor Gray
    }
}
else {
    Write-Host "  Skipped Zoekt setup due to -DisableZoekt." -ForegroundColor Gray
}

# Step 6: Ensure config.json exists
Write-Host "[6/9] Ensuring config.json ..." -ForegroundColor Yellow
$wslConfigPath = "$WslRepoDir/config.json"
$wslConfigExists = Test-WslFile $wslConfigPath
$windowsConfigExists = Test-Path $WindowsConfigPath

if ($windowsConfigExists -and -not $wslConfigExists) {
    Invoke-Wsl ("cp '{0}/config.json' '{1}/config.json'" -f $WindowsRepoWslPath, $WslRepoDir)
    $wslConfigExists = $true
}

if ($wslConfigExists -and -not $windowsConfigExists) {
    Invoke-Wsl ("cp '{0}/config.json' '{1}/config.json'" -f $WslRepoDir, $WindowsRepoWslPath)
    $windowsConfigExists = $true
}

if (-not $wslConfigExists -or -not $windowsConfigExists) {
    $configCreated = $false

    if (-not $SkipSetupWizard) {
        Write-Host "  Running setup wizard (interactive) ..." -ForegroundColor Gray
        wsl -- bash --noprofile --norc -lc ('cd "{0}" && "{1}" src/setup.js' -f $WslRepoDir, $WslNodeBinary)
        $wizardExit = $LASTEXITCODE
        if ($wizardExit -eq 0 -and (Test-WslFile $wslConfigPath)) {
            Invoke-Wsl ("cp '{0}/config.json' '{1}/config.json'" -f $WslRepoDir, $WindowsRepoWslPath)
            $configCreated = $true
        }
    }

    if (-not $configCreated) {
        $resolvedProjectRoot = Resolve-ProjectRoot $ProjectRoot
        if (-not $resolvedProjectRoot) {
            throw "Could not create config.json automatically. Re-run with -ProjectRoot 'C:\Path\To\Project' or run the wizard manually."
        }

        Write-Host "  Generating config.json from project root: $resolvedProjectRoot" -ForegroundColor Gray
        $config = New-ConfigObject $resolvedProjectRoot ($ShouldEnableZoekt -and $ZoektPrepared)
        Save-Config $config
    }
}

# Keep zoekt.enabled in sync for existing configs too.
$desiredZoektEnabled = $ShouldEnableZoekt -and $ZoektPrepared
Set-ConfigZoektEnabled $WindowsConfigPath $desiredZoektEnabled
Invoke-Wsl ("cp '{0}/config.json' '{1}/config.json'" -f $WindowsRepoWslPath, $WslRepoDir)
if ($desiredZoektEnabled) {
    Write-Host "  Zoekt is enabled in config.json." -ForegroundColor Green
}
elseif ($ShouldEnableZoekt -and -not $ZoektPrepared) {
    Write-Host "  Zoekt remains disabled in config.json because binaries are not ready." -ForegroundColor Yellow
}
else {
    Write-Host "  Zoekt is disabled in config.json." -ForegroundColor Gray
}

# Step 7: Set UNREAL_INDEX_DIR and install Windows bridge deps
Write-Host "[7/9] Installing Windows bridge/watcher dependencies (Claude primary) ..." -ForegroundColor Yellow
[Environment]::SetEnvironmentVariable("UNREAL_INDEX_DIR", $WindowsRepoDir, "User")
Push-Location $WindowsRepoDir
try {
    npm install --ignore-scripts --omit=dev --no-package-lock
}
finally {
    Pop-Location
}

# Step 8: Start service in WSL
Write-Host "[8/9] Starting indexing service in WSL ..." -ForegroundColor Yellow
$servicePath = "{0}/go/bin:{0}/local/go/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -f $WslHome
$launchScript = @"
cat > /tmp/unreal-index-start.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec >/tmp/unreal-index.log 2>&1
cd "$WslRepoDir"
export PATH="$servicePath"
exec "$WslNodeBinary" src/service/index.js
EOF
chmod +x /tmp/unreal-index-start.sh
"@
wsl -- bash --noprofile --norc -lc $launchScript
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Failed to prepare WSL launch script." -ForegroundColor Red
    exit 1
}

$tmuxStart = 'tmux kill-session -t unreal-index >/dev/null 2>&1 || true; rm -f /tmp/unreal-index.log; tmux new-session -d -s unreal-index /tmp/unreal-index-start.sh; sleep 1; tmux has-session -t unreal-index'
wsl -- bash --noprofile --norc -lc $tmuxStart
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Failed to launch service process in WSL." -ForegroundColor Red
    Write-Host "  Last log lines from WSL:" -ForegroundColor Yellow
    Invoke-Wsl "tail -80 /tmp/unreal-index.log || true" -AllowFailure
    exit 1
}
Write-Host "  Launch mode: tmux" -ForegroundColor Gray

$serviceUp = $false
for ($i = 0; $i -lt 120; $i++) {
    $health = ""
    try {
        $health = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3847/health" -TimeoutSec 2).Content
    }
    catch {
        $health = ""
    }
    if ($health -match '"status"\s*:\s*"ok"') {
        $serviceUp = $true
        break
    }
    Start-Sleep -Seconds 1
}

if (-not $serviceUp) {
    Write-Host "  ERROR: Service did not become healthy on port 3847." -ForegroundColor Red
    Write-Host "  Service diagnostics from WSL:" -ForegroundColor Yellow
    Invoke-Wsl 'tmux ls || true; pgrep -af "src/service/index.js" || true; ss -ltnp | grep 3847 || true' -AllowFailure
    Write-Host "  Last log lines from WSL:" -ForegroundColor Yellow
    Invoke-Wsl "tail -80 /tmp/unreal-index.log || true" -AllowFailure
    exit 1
}
Write-Host "  Service is running." -ForegroundColor Green

# Step 9: Final status
Write-Host "[9/9] Final status" -ForegroundColor Yellow
$healthJson = ""
try {
    $healthJson = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3847/health" -TimeoutSec 2).Content
}
catch {
    $healthJson = "unavailable"
}
Write-Host "  Health: $healthJson" -ForegroundColor Gray
Write-Host ("  Zoekt enabled: {0}" -f $desiredZoektEnabled) -ForegroundColor Gray

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host ""
if ($WindowsRepoDir -ne $DefaultClaudeRepoDir) {
    Write-Host "Note: Claude's default repo path is $DefaultClaudeRepoDir" -ForegroundColor Yellow
    Write-Host "      This setup uses $WindowsRepoDir via UNREAL_INDEX_DIR." -ForegroundColor Yellow
    Write-Host ""
}
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Start the file watcher in a Windows terminal:" -ForegroundColor White
Write-Host "     cd $WindowsRepoDir" -ForegroundColor Gray
Write-Host "     node src\watcher\watcher-client.js $WindowsConfigPath" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Restart Claude Code (primary agent) to load unreal-index tools." -ForegroundColor White
Write-Host ""
Write-Host "  3. Optional - Codex secondary path:" -ForegroundColor White
Write-Host "     codex mcp add unreal-index -- node $WindowsRepoDir\src\bridge\mcp-bridge.js" -ForegroundColor Gray
Write-Host ""
Write-Host "  4. Restart your terminal to pick up UNREAL_INDEX_DIR user env var." -ForegroundColor White
Write-Host ""
