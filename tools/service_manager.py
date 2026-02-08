"""Service management for Unreal Index — start, stop, check status."""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

_CREATE_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_PATH = _ROOT / "config.json"
_DEFAULT_PORT = 3847
_SCREEN_SESSION = "unreal-index"


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
