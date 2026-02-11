#!/bin/bash
# embark-claude-index — Linux/macOS/WSL setup script
# Run this after installing the plugin to configure the indexing service.
#
# What this does:
#   1. Clones/updates the repo to a stable location (~/.claude/repos/embark-claude-index)
#   2. Installs npm dependencies
#   3. Runs the interactive setup wizard (project detection, config generation)
#   4. Optionally builds Zoekt for full-text code search
#   5. Prints next steps for starting the service

set -e

REPO_URL="https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git"
STABLE_DIR="$HOME/.claude/repos/embark-claude-index"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
SKIP_CLONE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-clone) SKIP_CLONE=true; shift ;;
        *) shift ;;
    esac
done

echo ""
echo "=== embark-claude-index setup ==="
echo ""

# ── Step 1: Ensure stable repo location ─────────────────────

if [ "$SKIP_CLONE" = false ]; then
    if [ -d "$STABLE_DIR/.git" ]; then
        echo "[1/4] Updating repo at $STABLE_DIR ..."
        cd "$STABLE_DIR"
        git pull --ff-only 2>/dev/null || echo "  Warning: git pull failed, continuing with existing checkout."
        echo "  Repo updated."
    else
        echo "[1/4] Cloning repo to $STABLE_DIR ..."
        mkdir -p "$(dirname "$STABLE_DIR")"
        git clone "$REPO_URL" "$STABLE_DIR"
        echo "  Repo cloned."
    fi
else
    echo "[1/4] Skipping clone (--skip-clone)."
    STABLE_DIR="$PLUGIN_DIR"
fi

cd "$STABLE_DIR"

# ── Step 2: Install dependencies ─────────────────────────────

echo "[2/4] Installing npm dependencies ..."

# Prefer Node 22 if available (needed for undici)
if [ -x "$HOME/local/node22/bin/node" ]; then
    export PATH="$HOME/local/node22/bin:$PATH"
fi

NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
    echo "  Error: Node.js 20.18+ is required (found: $(node --version 2>/dev/null || echo 'none'))."
    echo "  Install Node.js 22: https://nodejs.org/"
    exit 1
fi

npm install --production 2>&1 | tail -1
echo "  Dependencies installed."

# ── Step 3: Run interactive setup wizard ─────────────────────

echo "[3/4] Running setup wizard ..."
echo ""

node src/setup.js
SETUP_EXIT=$?

if [ $SETUP_EXIT -ne 0 ]; then
    echo ""
    echo "Setup wizard exited with errors. Re-run later with:"
    echo "  cd $STABLE_DIR && node src/setup.js"
    exit 1
fi

# ── Step 4: Zoekt setup (optional) ──────────────────────────

echo ""
echo "[4/4] Checking Zoekt (full-text code search) ..."

if command -v zoekt-index &>/dev/null || [ -x "$HOME/go/bin/zoekt-index" ]; then
    echo "  Zoekt already installed."
elif command -v go &>/dev/null || [ -x /usr/local/go/bin/go ]; then
    echo "  Go found. Installing Zoekt ..."
    export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
    go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest 2>/dev/null && \
    go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest 2>/dev/null && \
    echo "  Zoekt installed." || \
    echo "  Warning: Zoekt install failed. Full-text search will be unavailable."
else
    echo "  Go not found. Zoekt (full-text search) is optional."
    echo "  Install Go to enable it: https://go.dev/dl/"
fi

# ── Summary ──────────────────────────────────────────────────

echo ""
echo "=== Setup complete ==="
echo ""
echo "Repo location:  $STABLE_DIR"
echo ""
echo "Next steps:"
echo "  1. Start the service:"
echo "     cd $STABLE_DIR && ./start-service.sh --bg"
echo ""
echo "  2. Start the file watcher (if on Windows, run in a Windows terminal):"
echo "     cd $STABLE_DIR && node src/watcher/watcher-client.js"
echo ""
echo "  3. Restart Claude Code to load the MCP tools."
echo ""
