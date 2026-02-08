"""Service management for Unreal Index — start, stop, check status."""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

from typing import Callable

_CREATE_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_PATH = _ROOT / "config.json"
_DEFAULT_PORT = 3847
_SCREEN_SESSION = "unreal-index"
_WSL_REPO_DIR = "~/repos/unreal-index"
_REPO_URL = "https://github.com/EmbarkStudios/UnrealClaudeFileHelper.git"


def _get_wsl_distro() -> str:
    return os.environ.get("WSL_DISTRO", "Ubuntu")


# --- Config ---


def read_config() -> dict:
    """Read the full config.json, or return empty dict."""
    try:
        return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def config_exists() -> bool:
    return _CONFIG_PATH.exists()


def read_port() -> int:
    """Read the service port from config.json."""
    config = read_config()
    return int(config.get("service", {}).get("port", _DEFAULT_PORT))


def write_config(config: dict) -> None:
    """Write config dict to config.json."""
    _CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


# --- Port / process checks ---


def check_port(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.15)
            return s.connect_ex(("127.0.0.1", port)) == 0
    except OSError:
        return False


def _find_pid_on_port(port: int) -> int | None:
    if sys.platform != "win32":
        return None
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, text=True, timeout=5,
            creationflags=_CREATE_NO_WINDOW,
        )
        pattern = re.compile(rf":\s*{port}\s+.*?LISTENING\s+(\d+)")
        for line in result.stdout.splitlines():
            m = pattern.search(line)
            if m:
                pid = int(m.group(1))
                if pid > 0:
                    return pid
    except (subprocess.TimeoutExpired, OSError):
        pass
    return None


def _find_pid_by_pattern(pattern: str) -> int | None:
    if sys.platform != "win32":
        return None
    try:
        result = subprocess.run(
            ["wmic", "process", "where",
             f"commandline like '%{pattern}%'",
             "get", "processid"],
            capture_output=True, text=True, timeout=5,
            creationflags=_CREATE_NO_WINDOW,
        )
        for line in result.stdout.strip().splitlines():
            line = line.strip()
            if line and line.lower() != "processid":
                try:
                    return int(line)
                except ValueError:
                    continue
    except (subprocess.TimeoutExpired, OSError):
        pass
    return None


def check_process_running(pattern: str) -> bool:
    return _find_pid_by_pattern(pattern) is not None


# --- Index service (WSL) ---


def check_wsl_screen() -> bool:
    """Check if the WSL screen session exists."""
    try:
        result = subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c",
             f"screen -ls 2>/dev/null | grep -q {_SCREEN_SESSION}"],
            capture_output=True, timeout=5,
            creationflags=_CREATE_NO_WINDOW,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def start_index_service() -> bool:
    """Start the index service in WSL via screen."""
    if sys.platform != "win32":
        # Non-WSL: start directly
        try:
            subprocess.Popen(
                ["node", str(_ROOT / "src" / "service" / "index.js")],
                cwd=str(_ROOT),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
            )
            return True
        except (OSError, FileNotFoundError):
            return False

    # Kill any existing screen session
    try:
        subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c",
             f"screen -S {_SCREEN_SESSION} -X quit 2>/dev/null"],
            capture_output=True, timeout=5,
            creationflags=_CREATE_NO_WINDOW,
        )
    except (subprocess.TimeoutExpired, OSError):
        pass

    # Determine WSL repo path
    wsl_repo = "~/repos/unreal-index"

    try:
        script = (
            f"cd {wsl_repo} && "
            f"screen -dmS {_SCREEN_SESSION} bash -c '"
            f'export PATH="$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH" && '
            f"node src/service/index.js > /tmp/unreal-index.log 2>&1'"
        )
        result = subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c", script],
            capture_output=True, text=True, timeout=15,
            creationflags=_CREATE_NO_WINDOW,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def stop_index_service() -> bool:
    """Stop the index service."""
    port = read_port()

    if sys.platform != "win32":
        pid = _find_pid_on_port(port)
        if pid:
            try:
                subprocess.run(["kill", str(pid)], capture_output=True, timeout=5)
                return True
            except (subprocess.TimeoutExpired, OSError):
                pass
        return False

    # WSL: quit screen + kill port + kill zoekt
    try:
        subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c",
             f"screen -S {_SCREEN_SESSION} -X quit 2>/dev/null; "
             f"kill $(lsof -ti:{port}) 2>/dev/null; "
             f"pkill -9 -f zoekt-webserver 2>/dev/null; "
             f"pkill -9 -f zoekt-index 2>/dev/null"],
            capture_output=True, timeout=10,
            creationflags=_CREATE_NO_WINDOW,
        )
        return True
    except (subprocess.TimeoutExpired, OSError):
        return False


# --- Watcher (native Windows) ---


def start_watcher() -> bool:
    """Start the watcher process (native, runs on Windows to read project files)."""
    watcher_js = str(_ROOT / "src" / "watcher" / "watcher-client.js")
    try:
        kwargs = {"cwd": str(_ROOT), "stdout": subprocess.DEVNULL,
                  "stderr": subprocess.DEVNULL, "stdin": subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW
        subprocess.Popen(["node", watcher_js], **kwargs)
        return True
    except (OSError, FileNotFoundError):
        return False


def stop_watcher() -> bool:
    """Stop the watcher process."""
    pid = _find_pid_by_pattern("watcher-client.js")
    if pid is None:
        return False
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/F"],
            capture_output=True, timeout=5,
            creationflags=_CREATE_NO_WINDOW,
        )
        return True
    except (subprocess.TimeoutExpired, OSError):
        return False


def check_watcher_running() -> bool:
    return check_process_running("watcher-client.js")


# --- Log access ---


def get_service_log(lines: int = 50) -> str:
    """Get recent log output from the WSL service."""
    if sys.platform != "win32":
        return ""
    try:
        result = subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c",
             f"tail -{lines} /tmp/unreal-index.log 2>/dev/null"],
            capture_output=True, text=True, timeout=5,
            creationflags=_CREATE_NO_WINDOW,
        )
        return result.stdout if result.returncode == 0 else ""
    except (subprocess.TimeoutExpired, OSError):
        return ""


# --- Installation functions ---


def install_node_deps(
    on_output: Callable[[str], None] | None = None,
) -> tuple[bool, str]:
    """Run npm install in the repo root (Windows-side, for watcher)."""
    try:
        result = subprocess.run(
            ["npm", "install"],
            capture_output=True, text=True, timeout=120,
            cwd=str(_ROOT), shell=True,
            creationflags=_CREATE_NO_WINDOW,
        )
        output = result.stdout + result.stderr
        if on_output and output.strip():
            on_output(output)
        if result.returncode != 0:
            return False, f"npm install failed:\n{output}"
        return True, "Node.js dependencies installed"
    except subprocess.TimeoutExpired:
        return False, "npm install timed out"
    except FileNotFoundError:
        return False, "npm not found on PATH"


def clone_or_pull_wsl(
    on_output: Callable[[str], None] | None = None,
) -> tuple[bool, str]:
    """Clone or pull the unreal-index repo inside WSL for the service."""
    if sys.platform != "win32":
        return True, "Not on Windows, WSL clone not needed"
    script = f"""
    if [ -d {_WSL_REPO_DIR}/.git ]; then
        cd {_WSL_REPO_DIR} && git pull 2>&1
    else
        mkdir -p $(dirname {_WSL_REPO_DIR})
        git clone {_REPO_URL} {_WSL_REPO_DIR} 2>&1
    fi
    """
    try:
        result = subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c", script],
            capture_output=True, text=True, timeout=120,
            creationflags=_CREATE_NO_WINDOW,
        )
        output = result.stdout + result.stderr
        if on_output and output.strip():
            on_output(output)
        if result.returncode != 0:
            return False, f"WSL git clone/pull failed:\n{output}"
        return True, f"WSL repo updated at {_WSL_REPO_DIR}"
    except subprocess.TimeoutExpired:
        return False, "WSL git operation timed out after 120s"
    except (FileNotFoundError, OSError) as e:
        return False, f"WSL not available: {e}"


def install_deps_wsl(
    on_output: Callable[[str], None] | None = None,
) -> tuple[bool, str]:
    """Run npm install inside WSL for native module compilation (better-sqlite3)."""
    if sys.platform != "win32":
        return True, "Not on Windows, WSL deps not needed"
    script = f"""
    export PATH="$HOME/local/node22/bin:$PATH"
    cd {_WSL_REPO_DIR} && npm install 2>&1
    """
    try:
        result = subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c", script],
            capture_output=True, text=True, timeout=180,
            creationflags=_CREATE_NO_WINDOW,
        )
        output = result.stdout + result.stderr
        if on_output and output.strip():
            on_output(output)
        if result.returncode != 0:
            return False, f"WSL npm install failed:\n{output}"
        return True, "WSL Node.js dependencies installed"
    except subprocess.TimeoutExpired:
        return False, "WSL npm install timed out after 180s"
    except (FileNotFoundError, OSError) as e:
        return False, f"WSL not available: {e}"


def install_zoekt_binaries(
    on_output: Callable[[str], None] | None = None,
) -> tuple[bool, str]:
    """Install Zoekt search binaries via WSL Go."""
    zoekt_pkg = "github.com/sourcegraph/zoekt/cmd/...@latest"

    if sys.platform != "win32":
        # Native Go install
        import shutil
        go_exe = shutil.which("go")
        if not go_exe:
            return False, "Go not found. Install Go first."
        try:
            result = subprocess.run(
                [go_exe, "install", zoekt_pkg],
                capture_output=True, text=True, timeout=300,
            )
            output = result.stdout + result.stderr
            if on_output and output.strip():
                on_output(output)
            if result.returncode == 0:
                return True, "Zoekt installed"
            return False, f"go install failed: {output}"
        except subprocess.TimeoutExpired:
            return False, "go install timed out (300s)"

    # Windows: install via WSL
    if on_output:
        on_output("Installing Zoekt via WSL (requires Go in WSL)...")

    try:
        go_check = subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c",
             'export PATH="$HOME/go/bin:/usr/local/go/bin:$PATH" && go version'],
            capture_output=True, text=True, timeout=15,
            creationflags=_CREATE_NO_WINDOW,
        )
        if go_check.returncode != 0:
            return False, "Go not found in WSL. Install Go inside WSL first."
        if on_output:
            on_output(f"  WSL Go: {go_check.stdout.strip()}")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False, "WSL not available"

    try:
        result = subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c",
             f'export PATH="$HOME/go/bin:/usr/local/go/bin:$PATH" && go install {zoekt_pkg}'],
            capture_output=True, text=True, timeout=300,
            creationflags=_CREATE_NO_WINDOW,
        )
        output = result.stdout + result.stderr
        if on_output and output.strip():
            on_output(output)
        if result.returncode == 0:
            return True, "Zoekt installed via WSL"
        return False, f"WSL go install failed: {output}"
    except subprocess.TimeoutExpired:
        return False, "WSL go install timed out (300s)"
    except (FileNotFoundError, OSError):
        return False, "WSL not available to install Zoekt"


def create_wsl_data_dirs(
    on_output: Callable[[str], None] | None = None,
) -> tuple[bool, str]:
    """Create data directories inside WSL (~/.unreal-index/*)."""
    if sys.platform != "win32":
        dirs = Path.home() / ".unreal-index"
        dirs.mkdir(parents=True, exist_ok=True)
        (dirs / "mirror").mkdir(exist_ok=True)
        (dirs / "zoekt-index").mkdir(exist_ok=True)
        return True, "Data directories created"

    script = """
    mkdir -p ~/.unreal-index/mirror ~/.unreal-index/zoekt-index 2>&1
    echo "Created ~/.unreal-index directories"
    """
    try:
        result = subprocess.run(
            ["wsl", "-d", _get_wsl_distro(), "--", "bash", "-c", script],
            capture_output=True, text=True, timeout=10,
            creationflags=_CREATE_NO_WINDOW,
        )
        output = result.stdout + result.stderr
        if on_output and output.strip():
            on_output(output)
        if result.returncode != 0:
            return False, f"mkdir failed:\n{output}"
        return True, "WSL data directories created"
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, f"WSL not available: {e}"


def validate_service(port: int, timeout_secs: int = 15) -> tuple[bool, str]:
    """Start the service and validate it comes up on the expected port."""
    import time

    if not start_index_service():
        return False, "Failed to start index service"

    deadline = time.time() + timeout_secs
    while time.time() < deadline:
        if check_port(port):
            return True, f"Service running on port {port}"
        time.sleep(1)

    return False, f"Service did not start within {timeout_secs}s"
