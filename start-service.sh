#!/bin/bash
# Start the unreal-index service in WSL.
# Usage: ./start-service.sh          (foreground)
#        ./start-service.sh --bg     (background via screen)

cd "$(dirname "$0")"

# Add Go/Zoekt binaries to PATH
export PATH="$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"

if [ "$1" = "--bg" ]; then
  screen -dmS unreal-index bash -c "node src/service/index.js 2>&1 | tee /tmp/unreal-index.log"
  sleep 3
  if screen -ls | grep -q unreal-index; then
    echo "Service started in screen session 'unreal-index'"
    echo "  Attach: screen -r unreal-index"
    echo "  Logs:   tail -f /tmp/unreal-index.log"
    curl -s http://127.0.0.1:3847/health | head -1
  else
    echo "ERROR: Service failed to start. Check /tmp/unreal-index.log"
    exit 1
  fi
else
  exec node src/service/index.js
fi
