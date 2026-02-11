---
name: setup
description: Initialize and configure the embark-claude-index plugin. Installs dependencies in WSL, runs the setup wizard, installs Zoekt, and starts the indexing service. Run this after first installing the plugin.
---

# embark-claude-index Setup

First-time setup for the Unreal Engine code index plugin.

**IMPORTANT: This service runs entirely in WSL.** All setup commands below MUST be executed inside WSL using `wsl -- bash -c '...'`. Do NOT run npm install, setup wizard, or Zoekt installation on Windows directly.

## When to Use

Trigger this skill when:
- User just installed the plugin and needs to set it up
- User says "setup", "configure", or "initialize" the index
- User wants to reconfigure project paths or re-run setup
- The MCP tools return "service not running" errors and no config exists

## Setup Steps

All commands run from Windows via `wsl -- bash -c '...'`. Use single quotes for the outer bash -c string to prevent Windows shell variable expansion.

### Step 1: Locate the plugin source and copy to WSL

The plugin cache is on Windows. Find it and determine the WSL-accessible path:

```powershell
# Find the plugin cache directory on Windows
dir "$env:USERPROFILE\.claude\plugins\cache\embark-claude-index" -Recurse -Filter "package.json" -Depth 4
```

The Windows path `C:\Users\<user>\.claude\plugins\cache\...` is accessible from WSL as `/mnt/c/Users/<user>/.claude/plugins/cache/...`.

Clone or copy the repo to a stable WSL location:

```bash
wsl -- bash -c 'PLUGIN_SRC="/mnt/c/Users/$(cmd.exe /c echo %USERNAME% 2>/dev/null | tr -d "\r")/.claude/plugins/cache/embark-claude-index"; DEST="$HOME/.claude/repos/embark-claude-index"; mkdir -p "$DEST" && cp -r "$PLUGIN_SRC"/embark-claude-index/*/. "$DEST/"'
```

Or if git is available in WSL, clone directly:

```bash
wsl -- bash -c 'git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$HOME/.claude/repos/embark-claude-index" 2>/dev/null || (cd "$HOME/.claude/repos/embark-claude-index" && git pull --ff-only)'
```

### Step 2: Install Node.js dependencies in WSL

```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && npm install --production'
```

If this fails with Node version errors, the user needs Node.js 20.18+ in WSL. Check with:
```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; node --version'
```

If `better-sqlite3` fails to compile:
```bash
wsl -- bash -c 'sudo apt install -y build-essential python3'
```
Then retry npm install.

### Step 3: Run the interactive setup wizard in WSL

```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && node src/setup.js'
```

The wizard will interactively ask the user for:
- Project root path (detects `.uproject` files)
- Engine source paths
- Content/asset indexing preferences
- It generates `config.json`

**Note:** The wizard understands Windows paths (e.g. `C:\Projects\MyGame`) and converts them automatically.

### Step 4: Install Zoekt in WSL (full-text code search)

Zoekt provides fast regex search across the entire codebase. It requires Go.

```bash
wsl -- bash -c 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"; which zoekt-index 2>/dev/null && echo "Zoekt already installed" || (go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest && go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest && echo "Zoekt installed")'
```

If Go is not installed:
```bash
wsl -- bash -c 'which go 2>/dev/null || echo "Go not found — install from https://go.dev/dl/ to enable Zoekt full-text search"'
```

If Go is missing, tell the user: Zoekt is optional but recommended. Without it, `unreal_grep` will use a slower fallback. They can install Go later and re-run this step.

### Step 5: Start the indexing service in WSL

```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && screen -dmS unreal-index bash -c "node src/service/index.js 2>&1 | tee /tmp/unreal-index.log"'
```

Wait a few seconds, then verify:
```bash
wsl -- bash -c 'sleep 3 && curl -s http://127.0.0.1:3847/health'
```

If the health check fails, check the log:
```bash
wsl -- bash -c 'tail -20 /tmp/unreal-index.log'
```

### Step 6: Start the file watcher on Windows

This is the ONLY step that runs on Windows directly:

```powershell
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "src\watcher\watcher-client.js" -WorkingDirectory "$env:USERPROFILE\.claude\repos\embark-claude-index"
```

Or tell the user to open a separate terminal and run:
```
cd %USERPROFILE%\.claude\repos\embark-claude-index
node src\watcher\watcher-client.js
```

### Step 7: Verify

After the watcher outputs "initial scan complete" (may take a few minutes on first run), verify the index has data:

```bash
wsl -- bash -c 'curl -s http://127.0.0.1:3847/internal/status'
```

This should show non-zero counts for indexed files.

Tell the user: **Restart Claude Code** to pick up the MCP tools. After restart, all `unreal_*` tools will be available.

## Troubleshooting

- **Node.js too old in WSL**: Need 20.18+. Install Node 22: `wsl -- bash -c 'curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz | tar -xJ -C ~/local/node22 --strip-components=1'`
- **Port 3847 in use**: `wsl -- bash -c 'kill $(lsof -ti:3847)'` then restart
- **WSL networking**: Ensure `%USERPROFILE%\.wslconfig` contains `[wsl2]` and `networkingMode=mirrored`
- **Screen not installed**: `wsl -- bash -c 'sudo apt install -y screen'`
- **better-sqlite3 compile error**: `wsl -- bash -c 'sudo apt install -y build-essential python3'`
