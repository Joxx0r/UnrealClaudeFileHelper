---
name: setup
description: Initialize and configure the embark-claude-index plugin. Installs dependencies, runs the interactive setup wizard to detect Unreal projects, and starts the indexing service. Run this after first installing the plugin.
---

# embark-claude-index Setup

First-time setup for the Unreal Engine code index plugin.

## When to Use

Trigger this skill when:
- User just installed the plugin and needs to set it up
- User says "setup", "configure", or "initialize" the index
- User wants to reconfigure project paths or re-run setup
- The MCP tools return "service not running" errors and no config exists

## Setup Steps

### Step 1: Find the plugin directory

The plugin is installed at one of these locations. Check in order:
1. `~/.claude/repos/embark-claude-index` (stable clone from previous setup)
2. The plugin cache directory (where this skill is running from)

```bash
# Check for stable clone first
ls ~/.claude/repos/embark-claude-index/package.json 2>/dev/null
```

If no stable clone exists, the plugin source is in the current plugin cache directory. Find it:

```powershell
# Windows
ls "$env:USERPROFILE\.claude\plugins\cache\embark-claude-index" -Recurse -Filter "package.json" -Depth 3
```

### Step 2: Install dependencies

```bash
# In WSL (preferred for the service):
cd ~/.claude/repos/embark-claude-index
export PATH="$HOME/local/node22/bin:$PATH"
npm install --production
```

Or on Windows if no WSL:
```powershell
cd "$env:USERPROFILE\.claude\repos\embark-claude-index"
npm install --production
```

### Step 3: Run the interactive setup wizard

The wizard detects `.uproject` files, configures paths, and generates `config.json`:

```bash
# In WSL:
cd ~/.claude/repos/embark-claude-index
node src/setup.js
```

Or on Windows:
```powershell
cd "$env:USERPROFILE\.claude\repos\embark-claude-index"
node src/setup.js
```

The wizard will:
- Ask for the project root (detects `.uproject` files)
- Configure engine source paths
- Set up content/asset indexing
- Generate `config.json`

### Step 4: Start the indexing service

```bash
# In WSL (background via screen):
cd ~/.claude/repos/embark-claude-index
./start-service.sh --bg
```

Verify it's running:
```bash
curl -s http://127.0.0.1:3847/health
```

### Step 5: Start the file watcher

In a separate Windows terminal:
```powershell
cd "$env:USERPROFILE\.claude\repos\embark-claude-index"
node src\watcher\watcher-client.js
```

### Step 6: Verify

After the watcher completes initial indexing (watch for "initial scan complete" in output), verify:
```bash
curl -s http://127.0.0.1:3847/internal/status
```

This should show non-zero counts for indexed files.

Tell the user: **Restart Claude Code** to pick up the MCP tools. After restart, all `unreal_*` tools will be available.

## Troubleshooting

- **Node.js too old**: Need Node 20.18+. On WSL, check `~/local/node22/bin/node --version`
- **Port 3847 in use**: `kill $(lsof -ti:3847)` in WSL, then restart
- **WSL networking**: Ensure `.wslconfig` has `networkingMode=mirrored`
- **npm install fails on better-sqlite3**: Need build tools: `sudo apt install build-essential python3`
