---
name: setup
description: Initialize and configure the embark-claude-index plugin. Clones repo, installs dependencies, sets environment variables, runs the setup wizard, installs Zoekt, and starts the indexing service. Run this after first installing the plugin.
---

# embark-claude-index Setup

First-time setup for the Unreal Engine code index plugin.

**CRITICAL SHELL INFO**: Claude Code runs in **Git Bash (MINGW)** on Windows. All commands below use bash syntax. Do NOT use PowerShell (`$env:`, `Get-ChildItem`) or cmd.exe (`dir /s`) syntax — they will fail.

**IMPORTANT**: This service runs entirely in WSL. Use `wsl -- bash -c '...'` for all service-side operations. Use single quotes for the bash -c argument to prevent variable expansion by Git Bash.

## When to Use

Trigger this skill when:
- User just installed the plugin and needs to set it up
- User says "setup", "configure", or "initialize" the index
- User wants to reconfigure project paths or re-run setup
- The MCP tools return "service not running" errors and no config exists

## Setup Steps

Execute these steps sequentially. Each step depends on the previous one succeeding.

### Step 1: Clone the repo into WSL

Use git clone directly in WSL. This is the simplest and most reliable approach.

```bash
wsl -- bash -c 'mkdir -p "$HOME/.claude/repos" && if [ -d "$HOME/.claude/repos/embark-claude-index/.git" ]; then cd "$HOME/.claude/repos/embark-claude-index" && git pull --ff-only && echo "Repo updated"; else git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$HOME/.claude/repos/embark-claude-index" && echo "Repo cloned"; fi'
```

If this succeeds, move to Step 2. If git clone fails (network issues), ask the user to check their internet connection.

### Step 2: Install Node.js dependencies in WSL

```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && node --version && npm install --production'
```

**If Node.js is not found or too old** (need 20.18+):
```bash
wsl -- bash -c 'mkdir -p "$HOME/local/node22" && curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz | tar -xJ -C "$HOME/local/node22" --strip-components=1 && echo "Node.js installed: $($HOME/local/node22/bin/node --version)"'
```
Then retry the npm install command above.

**If better-sqlite3 fails to compile** (missing build tools):
```bash
wsl -- bash -c 'sudo apt install -y build-essential python3'
```
Then retry npm install.

### Step 3: Clone or update Windows-side repo for the MCP bridge

The MCP bridge runs on Windows (spawned by Claude Code via stdio). It needs a Windows-accessible copy with `node_modules` installed.

```bash
if [ -d "$USERPROFILE/.claude/repos/embark-claude-index/.git" ]; then
  cd "$USERPROFILE/.claude/repos/embark-claude-index" && git pull --ff-only && echo "Windows repo updated"
else
  git clone https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git "$USERPROFILE/.claude/repos/embark-claude-index" && echo "Windows repo cloned"
fi
```

Install dependencies on Windows (use `--ignore-scripts` to skip native compilation of better-sqlite3, which is only needed in WSL):

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && npm install --ignore-scripts --omit=dev
```

### Step 4: Set UNREAL_INDEX_DIR environment variable

Set `UNREAL_INDEX_DIR` as a **persistent user-level environment variable** so the MCP bridge can be found across sessions. This is required for the plugin's `.mcp.json` to resolve the bridge path.

```bash
powershell.exe -Command "[Environment]::SetEnvironmentVariable('UNREAL_INDEX_DIR', (Join-Path \$env:USERPROFILE '.claude\repos\embark-claude-index'), 'User')"
```

Verify it was set:
```bash
powershell.exe -Command "[Environment]::GetEnvironmentVariable('UNREAL_INDEX_DIR', 'User')"
```

This should print something like `C:\Users\<username>\.claude\repos\embark-claude-index`.

**IMPORTANT**: Tell the user they must **restart their terminal** (not just Claude Code) for the new environment variable to take effect. The variable persists across all future sessions.

### Step 5: Run the interactive setup wizard in WSL

```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && node src/setup.js'
```

The wizard will interactively ask the user for:
- Project root path (detects `.uproject` files)
- Engine source paths
- Content/asset indexing preferences
- It generates `config.json`

**Note:** The wizard accepts Windows paths (e.g. `C:\Projects\MyGame`) and converts them automatically.

### Step 6: Install Zoekt in WSL (full-text code search)

Zoekt provides fast regex search across the entire codebase. It requires Go.

```bash
wsl -- bash -c 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"; if command -v zoekt-index >/dev/null 2>&1; then echo "Zoekt already installed"; elif command -v go >/dev/null 2>&1; then echo "Installing Zoekt..." && go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest && go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest && echo "Zoekt installed"; else echo "Go not found - Zoekt (optional) requires Go: https://go.dev/dl/"; fi'
```

If Go is missing, tell the user: Zoekt is optional but recommended. Without it, `unreal_grep` will be unavailable. They can install Go later and re-run this step.

### Step 7: Start the indexing service in WSL

First check if it's already running:
```bash
wsl -- bash -c 'curl -s http://127.0.0.1:3847/health 2>/dev/null && echo "Service already running" || echo "Service not running"'
```

If not running, start it:
```bash
wsl -- bash -c 'export PATH="$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"; cd "$HOME/.claude/repos/embark-claude-index" && screen -dmS unreal-index bash -c "node src/service/index.js 2>&1 | tee /tmp/unreal-index.log"'
```

**If screen is not installed:**
```bash
wsl -- bash -c 'sudo apt install -y screen'
```
Then retry the start command.

Wait a few seconds, then verify:
```bash
wsl -- bash -c 'sleep 3 && curl -s http://127.0.0.1:3847/health'
```

If the health check fails, check the log:
```bash
wsl -- bash -c 'tail -20 /tmp/unreal-index.log'
```

### Step 8: Start the file watcher

The watcher runs on the Windows side to watch project files:

```bash
cd "$USERPROFILE/.claude/repos/embark-claude-index" && node src/watcher/watcher-client.js
```

Note: The watcher runs in the foreground and will block the terminal. Tell the user they can:
- Let it run in this terminal (it shows progress as files are indexed)
- Or open a separate terminal to run it

### Step 9: Install PreToolUse hooks (optional but recommended)

The hooks intercept Grep, Glob, and Bash tool calls and route them through the unreal-index service for faster results. The setup wizard (Step 5) should have already prompted for this. If the user skipped it, they can install hooks now.

The hook needs to be installed into the user's **project working directory** — the directory where they run Claude Code (where `.claude/` exists or will be created). This is typically the project's `Script/` directory or project root.

```bash
node "$USERPROFILE/.claude/repos/embark-claude-index/src/hooks/install.js" "<PROJECT_DIR>"
```

Replace `<PROJECT_DIR>` with the actual project path (e.g., `D:\p4\games\Games\MyProject\Script`).

Alternatively, from the repo root on Windows:
```bash
"$USERPROFILE/.claude/repos/embark-claude-index/install-hooks.bat" "<PROJECT_DIR>"
```

This will:
- Compile a Go proxy binary (or fall back to Node.js if Go is not available)
- Deploy it to `<PROJECT_DIR>/.claude/hooks/`
- Update `<PROJECT_DIR>/.claude/settings.json` with the PreToolUse hook config
- Create/update `<PROJECT_DIR>/.claude/CLAUDE.local.md` with search instructions

Tell the user they need to **restart Claude Code** after installing hooks.

### Step 10: Verify

After the watcher outputs "initial scan complete" (may take a few minutes on first run), verify the index has data:

```bash
wsl -- bash -c 'curl -s http://127.0.0.1:3847/internal/status'
```

This should show non-zero counts for indexed files.

Tell the user:
- **Restart their terminal AND Claude Code** to pick up the `UNREAL_INDEX_DIR` environment variable and MCP tools. After restart, all `unreal_*` tools will be available.
- **Open the dashboard** at [http://localhost:3847](http://localhost:3847) to monitor service health, watcher status, Zoekt, query analytics, and MCP tool usage. The dashboard shows the status of all components and has controls to start/restart services.

## Troubleshooting

Common errors and fixes (all commands use bash syntax for Git Bash):

- **"wsl is not recognized"**: WSL is not installed. User needs: https://learn.microsoft.com/en-us/windows/wsl/install
- **Node.js too old in WSL**: Need 20.18+. Install Node 22 with the command in Step 2.
- **Port 3847 in use**: `wsl -- bash -c 'kill $(lsof -ti:3847)'` then restart service
- **WSL networking / localhost not working**: Check `cat "$USERPROFILE/.wslconfig"` contains `[wsl2]` and `networkingMode=mirrored`
- **Screen not installed**: `wsl -- bash -c 'sudo apt install -y screen'`
- **better-sqlite3 compile error**: `wsl -- bash -c 'sudo apt install -y build-essential python3'`
- **npm install fails with EACCES**: Don't run npm as root. Fix permissions: `wsl -- bash -c 'sudo chown -R $(whoami) "$HOME/.claude"'`
- **MCP bridge not found / "Failed to reconnect"**: Ensure `UNREAL_INDEX_DIR` is set: `powershell.exe -Command "[Environment]::GetEnvironmentVariable('UNREAL_INDEX_DIR', 'User')"`. If empty, re-run Step 4. If set but wrong path, update it and restart terminal.
- **Plugin update broke MCP bridge**: Run `cd "$USERPROFILE/.claude/repos/embark-claude-index" && git pull --ff-only && npm install --ignore-scripts --omit=dev` to update the Windows repo.
