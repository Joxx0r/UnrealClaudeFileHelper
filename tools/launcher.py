"""Unreal Index — standalone installer + launcher GUI."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from enum import Enum, auto
from pathlib import Path

from PySide6.QtCore import QThread, QTimer, Qt, Signal
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFileDialog,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QStackedWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

# Ensure tools/ is on sys.path for sibling imports
_TOOLS_DIR = Path(__file__).resolve().parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

from theme import COLORS, DARK_THEME
from service_manager import (
    check_port,
    check_watcher_running,
    check_wsl_screen,
    clone_or_pull_wsl,
    config_exists,
    create_wsl_data_dirs,
    install_deps_wsl,
    install_node_deps,
    install_zoekt_binaries,
    read_config,
    read_port,
    register_mcp_server,
    start_index_service,
    start_watcher,
    stop_index_service,
    stop_watcher,
    validate_service,
    write_config,
)
from index_stats import IndexStatsPanel

_ROOT = Path(__file__).resolve().parent.parent


# ── Service Row Widget ─────────────────────────────────────


class ServiceState(Enum):
    STOPPED = auto()
    STARTING = auto()
    RUNNING = auto()
    STOPPING = auto()


_STATE_COLORS = {
    ServiceState.STOPPED: COLORS["error"],
    ServiceState.STARTING: COLORS["warning"],
    ServiceState.RUNNING: COLORS["success"],
    ServiceState.STOPPING: COLORS["warning"],
}


class ServiceRow(QFrame):
    start_requested = Signal(str)
    stop_requested = Signal(str)

    def __init__(self, name: str, display_name: str, port: int | None, parent=None) -> None:
        super().__init__(parent)
        self.service_name = name
        self._state = ServiceState.STOPPED

        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setStyleSheet(
            f"QFrame {{ background: {COLORS['bg_dark']}; "
            f"border: 1px solid {COLORS['border']}; border-radius: 6px; }}"
        )

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)

        self._icon = QLabel("\u25CB")
        self._icon.setFixedWidth(20)
        self._icon.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._icon.setStyleSheet("border: none; font-size: 14pt;")
        layout.addWidget(self._icon)

        self._name_label = QLabel(display_name)
        self._name_label.setStyleSheet(
            f"border: none; color: {COLORS['fg']}; font-weight: bold; font-size: 10pt;"
        )
        self._name_label.setMinimumWidth(200)
        layout.addWidget(self._name_label)

        self._port_label = QLabel(f":{port}" if port else "")
        self._port_label.setStyleSheet(f"border: none; color: {COLORS['muted']}; font-size: 9pt;")
        self._port_label.setFixedWidth(60)
        layout.addWidget(self._port_label)

        layout.addStretch()

        self._status_label = QLabel()
        self._status_label.setStyleSheet(f"border: none; font-size: 9pt;")
        self._status_label.setFixedWidth(80)
        self._status_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        layout.addWidget(self._status_label)

        self._action_btn = QPushButton()
        self._action_btn.setFixedWidth(80)
        self._action_btn.clicked.connect(self._on_action)
        layout.addWidget(self._action_btn)

        self._apply_state()

    @property
    def state(self) -> ServiceState:
        return self._state

    def set_state(self, state: ServiceState) -> None:
        if self._state != state:
            self._state = state
            self._apply_state()

    def _apply_state(self) -> None:
        color = _STATE_COLORS[self._state]
        icon = "\u25CF" if self._state != ServiceState.STOPPED else "\u25CB"

        self._icon.setText(icon)
        self._icon.setStyleSheet(f"border: none; color: {color}; font-size: 14pt;")

        if self._state == ServiceState.RUNNING:
            self._status_label.setText("Running")
            self._status_label.setStyleSheet(f"border: none; color: {COLORS['success']}; font-size: 9pt;")
            self._action_btn.setText("Stop")
            self._action_btn.setEnabled(True)
        elif self._state == ServiceState.STOPPED:
            self._status_label.setText("Stopped")
            self._status_label.setStyleSheet(f"border: none; color: {COLORS['error']}; font-size: 9pt;")
            self._action_btn.setText("Start")
            self._action_btn.setEnabled(True)
        elif self._state == ServiceState.STARTING:
            self._status_label.setText("Starting...")
            self._status_label.setStyleSheet(f"border: none; color: {COLORS['warning']}; font-size: 9pt;")
            self._action_btn.setText("Start")
            self._action_btn.setEnabled(False)
        elif self._state == ServiceState.STOPPING:
            self._status_label.setText("Stopping...")
            self._status_label.setStyleSheet(f"border: none; color: {COLORS['warning']}; font-size: 9pt;")
            self._action_btn.setText("Stop")
            self._action_btn.setEnabled(False)

    def _on_action(self) -> None:
        if self._state == ServiceState.RUNNING:
            self.stop_requested.emit(self.service_name)
        elif self._state == ServiceState.STOPPED:
            self.start_requested.emit(self.service_name)


# ── Status Check Worker ────────────────────────────────────


class StatusCheckWorker(QThread):
    result_ready = Signal(bool, bool)  # (index_running, watcher_running)

    def __init__(self, port: int) -> None:
        super().__init__()
        self._port = port

    def run(self) -> None:
        index_up = check_port(self._port)
        watcher_up = check_watcher_running()
        self.result_ready.emit(index_up, watcher_up)


# ── Step Widget ────────────────────────────────────────────


class StepWidget(QLabel):
    """A single install step label with pending/running/done/failed states."""

    def __init__(self, text: str, parent=None) -> None:
        super().__init__(parent)
        self._text = text
        self.set_pending()

    def set_pending(self) -> None:
        self.setText(f"  \u25CB  {self._text}")
        self.setStyleSheet(f"color: {COLORS['muted']};")

    def set_running(self) -> None:
        self.setText(f"  \u25CF  {self._text}...")
        self.setStyleSheet(f"color: {COLORS['accent']};")

    def set_done(self, message: str = "") -> None:
        suffix = f" \u2014 {message}" if message else ""
        self.setText(f"  \u2714  {self._text}{suffix}")
        self.setStyleSheet(f"color: {COLORS['success']};")

    def set_failed(self, message: str = "") -> None:
        suffix = f" \u2014 {message}" if message else ""
        self.setText(f"  \u2718  {self._text}{suffix}")
        self.setStyleSheet(f"color: {COLORS['error']};")


# ── Install Worker ─────────────────────────────────────────

_INSTALL_STEP_LABELS = [
    "Install Node.js dependencies (Windows)",
    "Clone/update repo in WSL",
    "Install Node.js dependencies (WSL)",
    "Install Zoekt search binaries",
    "Create data directories",
    "Write configuration",
    "Register MCP server",
    "Validate service",
]


class InstallWorker(QThread):
    step_started = Signal(int, str)
    step_completed = Signal(int, bool, str)
    log_output = Signal(str)
    all_done = Signal(bool)

    def __init__(self, config: dict, skip_wsl_pull: bool = False, skip_npm: bool = False) -> None:
        super().__init__()
        self._config = config
        self._skip_wsl_pull = skip_wsl_pull
        self._skip_npm = skip_npm

    def run(self) -> None:
        all_ok = True

        # Step 0: npm install (Windows-side for watcher)
        if self._skip_npm:
            self.step_started.emit(0, "Skipping npm install (local changes preserved)...")
            self.step_completed.emit(0, True, "Skipped (local changes)")
        else:
            self.step_started.emit(0, "Installing Node.js dependencies...")
            ok, msg = install_node_deps(lambda o: self.log_output.emit(o))
            self.step_completed.emit(0, ok, msg)
            if not ok:
                all_ok = False

        # Step 1: Clone/update repo in WSL
        if self._skip_wsl_pull:
            self.step_started.emit(1, "Skipping WSL clone/pull (local changes preserved)...")
            self.step_completed.emit(1, True, "Skipped (local changes)")
        elif sys.platform == "win32":
            self.step_started.emit(1, "Cloning/updating repo in WSL...")
            ok, msg = clone_or_pull_wsl(lambda o: self.log_output.emit(o))
            self.step_completed.emit(1, ok, msg)
            if not ok:
                all_ok = False
        else:
            self.step_completed.emit(1, True, "Skipped (not Windows)")

        # Step 2: WSL npm install
        if self._skip_wsl_pull and self._skip_npm:
            self.step_started.emit(2, "Skipping WSL npm install (local changes preserved)...")
            self.step_completed.emit(2, True, "Skipped (local changes)")
        elif sys.platform == "win32":
            self.step_started.emit(2, "Installing WSL Node.js dependencies...")
            ok, msg = install_deps_wsl(lambda o: self.log_output.emit(o))
            self.step_completed.emit(2, ok, msg)
            if not ok:
                all_ok = False
        else:
            self.step_completed.emit(2, True, "Skipped (not Windows)")

        # Step 3: Zoekt binaries
        self.step_started.emit(3, "Installing Zoekt search binaries...")
        ok, msg = install_zoekt_binaries(lambda o: self.log_output.emit(o))
        if ok:
            self.step_completed.emit(3, True, msg)
        else:
            self.log_output.emit(f"  Zoekt: {msg}")
            self.log_output.emit("  WARNING: Zoekt is required for search. Install Go and retry.")
            self.step_completed.emit(3, False, msg)
            all_ok = False

        # Step 4: Data directories
        self.step_started.emit(4, "Creating data directories...")
        ok, msg = create_wsl_data_dirs(lambda o: self.log_output.emit(o))
        self.step_completed.emit(4, ok, msg)
        if not ok:
            all_ok = False

        # Step 5: Write config
        self.step_started.emit(5, "Writing configuration...")
        try:
            write_config(self._config)
            self.step_completed.emit(5, True, "config.json written")
        except Exception as e:
            self.step_completed.emit(5, False, str(e))
            all_ok = False

        # Step 6: Register MCP server
        self.step_started.emit(6, "Registering MCP server at user scope...")
        ok, msg = register_mcp_server(lambda o: self.log_output.emit(o))
        self.step_completed.emit(6, ok, msg)
        if not ok:
            all_ok = False

        # Step 7: Validate service
        self.step_started.emit(7, "Validating service startup...")
        port = int(self._config.get("service", {}).get("port", 3847))
        ok, msg = validate_service(port, timeout_secs=30)
        self.step_completed.emit(7, ok, msg)
        if not ok:
            self.log_output.emit("  Service did not start. Check WSL and Node.js installation.")
            all_ok = False

        self.all_done.emit(all_ok)


# ── Install View ───────────────────────────────────────────


class InstallView(QWidget):
    install_complete = Signal()

    def __init__(self, config: dict, skip_wsl_pull: bool = False, skip_npm: bool = False, parent=None) -> None:
        super().__init__(parent)
        self._config = config
        self._skip_wsl_pull = skip_wsl_pull
        self._skip_npm = skip_npm
        self._worker: InstallWorker | None = None

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(8)
        scroll.setWidget(container)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(scroll)

        title = QLabel("Installing Unreal Index")
        title.setStyleSheet(f"color: {COLORS['info']}; font-size: 16pt; font-weight: bold;")
        layout.addWidget(title)

        subtitle = QLabel("Setting up dependencies and services...")
        subtitle.setStyleSheet(f"color: {COLORS['muted']}; font-size: 10pt;")
        layout.addWidget(subtitle)

        layout.addSpacing(8)

        # Progress bar
        self._progress = QProgressBar()
        self._progress.setRange(0, len(_INSTALL_STEP_LABELS))
        self._progress.setValue(0)
        self._progress.setTextVisible(False)
        self._progress.setFixedHeight(6)
        self._progress.setStyleSheet(
            f"QProgressBar {{ background: {COLORS['bg_dark']}; border: none; border-radius: 3px; }}"
            f"QProgressBar::chunk {{ background: {COLORS['accent']}; border-radius: 3px; }}"
        )
        layout.addWidget(self._progress)

        layout.addSpacing(4)

        # Step widgets
        self._steps: list[StepWidget] = []
        for label in _INSTALL_STEP_LABELS:
            step = StepWidget(label)
            self._steps.append(step)
            layout.addWidget(step)

        layout.addSpacing(8)

        # Log output
        log_label = QLabel("Log")
        log_label.setStyleSheet(f"color: {COLORS['muted']}; font-size: 9pt;")
        layout.addWidget(log_label)

        self._log = QTextEdit()
        self._log.setReadOnly(True)
        self._log.setMaximumHeight(180)
        self._log.setStyleSheet(
            f"background: {COLORS['bg_dark']}; color: {COLORS['fg']}; "
            f"font-family: Consolas, monospace; font-size: 9pt; "
            f"border: 1px solid {COLORS['border']}; border-radius: 4px;"
        )
        layout.addWidget(self._log)

        # Buttons row
        btn_row = QHBoxLayout()
        btn_row.addStretch()

        self._retry_btn = QPushButton("Retry")
        self._retry_btn.setFixedWidth(100)
        self._retry_btn.setVisible(False)
        self._retry_btn.clicked.connect(self._start_install)
        btn_row.addWidget(self._retry_btn)

        self._continue_btn = QPushButton("Continue to Launcher")
        self._continue_btn.setFixedWidth(180)
        self._continue_btn.setVisible(False)
        self._continue_btn.setStyleSheet(
            f"QPushButton {{ background: {COLORS['accent']}; color: {COLORS['bg']}; "
            f"font-weight: bold; border: none; padding: 8px 20px; border-radius: 4px; }}"
            f"QPushButton:hover {{ background: #caa4ff; }}"
        )
        self._continue_btn.clicked.connect(lambda: self.install_complete.emit())
        btn_row.addWidget(self._continue_btn)

        layout.addLayout(btn_row)
        layout.addStretch()

        # Auto-start
        QTimer.singleShot(200, self._start_install)

    def _start_install(self) -> None:
        self._retry_btn.setVisible(False)
        self._continue_btn.setVisible(False)
        self._progress.setValue(0)
        self._log.clear()
        self._completed_steps = 0
        for step in self._steps:
            step.set_pending()

        self._worker = InstallWorker(self._config, self._skip_wsl_pull, self._skip_npm)
        self._worker.step_started.connect(self._on_step_started)
        self._worker.step_completed.connect(self._on_step_completed)
        self._worker.log_output.connect(self._on_log)
        self._worker.all_done.connect(self._on_all_done)
        self._worker.start()

    def _on_step_started(self, index: int, description: str) -> None:
        if 0 <= index < len(self._steps):
            self._steps[index].set_running()
        self._log.append(description)

    def _on_step_completed(self, index: int, success: bool, message: str) -> None:
        if 0 <= index < len(self._steps):
            if success:
                self._steps[index].set_done(message)
            else:
                self._steps[index].set_failed(message)
        self._completed_steps = index + 1
        self._progress.setValue(self._completed_steps)
        if message:
            prefix = "OK" if success else "FAILED"
            self._log.append(f"  {prefix}: {message}")

    def _on_log(self, text: str) -> None:
        self._log.append(text)

    def _on_all_done(self, success: bool) -> None:
        if success:
            self._log.append("\nAll steps completed successfully!")
            self._continue_btn.setVisible(True)
        else:
            self._log.append("\nSome steps failed. Fix the issues and click Retry.")
            self._retry_btn.setVisible(True)
            self._continue_btn.setVisible(True)


# ── Prerequisites View ─────────────────────────────────────

_PREREQS = [
    {"name": "node", "display": "Node.js", "cmd": ["node", "--version"], "required": True,
     "help": "Install from https://nodejs.org/ or via winget: winget install OpenJS.NodeJS"},
    {"name": "npm", "display": "npm", "cmd": ["npm", "--version"], "required": True,
     "help": "Installed with Node.js"},
    {"name": "git", "display": "Git", "cmd": ["git", "--version"], "required": True,
     "help": "Install from https://git-scm.com/ or via winget: winget install Git.Git"},
    {"name": "go", "display": "Go (for Zoekt)", "cmd": ["go", "version"], "required": False,
     "help": "Install from https://go.dev/ or via winget: winget install GoLang.Go"},
]

if sys.platform == "win32":
    _PREREQS.append({
        "name": "wsl", "display": "WSL", "cmd": ["wsl", "--status"], "required": True,
        "help": "Install via: wsl --install",
    })


class PrereqCheckWorker(QThread):
    """Check all prerequisites in a background thread."""
    result_ready = Signal(list)  # list of (name, display, found, version, required, help)

    def run(self) -> None:
        results = []
        for p in _PREREQS:
            found = False
            version = ""
            try:
                kwargs = {"capture_output": True, "text": True, "timeout": 10}
                if sys.platform == "win32":
                    kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
                # npm needs shell=True on Windows
                if p["name"] == "npm" and sys.platform == "win32":
                    kwargs["shell"] = True
                result = subprocess.run(p["cmd"], **kwargs)
                if result.returncode == 0:
                    found = True
                    version = result.stdout.strip().split("\n")[0][:40]
            except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
                pass

            # Fallback: check shutil.which
            if not found and p["name"] not in ("wsl", "npm"):
                exe = shutil.which(p["name"])
                if exe:
                    found = True
                    version = f"found at {exe}"

            results.append({
                "name": p["name"],
                "display": p["display"],
                "found": found,
                "version": version,
                "required": p["required"],
                "help": p["help"],
            })
        self.result_ready.emit(results)


class PrereqRow(QFrame):
    """Single prerequisite status row."""

    def __init__(self, info: dict, parent=None) -> None:
        super().__init__(parent)
        self.info = info
        self.setFrameShape(QFrame.Shape.NoFrame)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(4, 2, 4, 2)

        self._icon = QLabel()
        self._icon.setFixedWidth(20)
        self._icon.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self._icon)

        self._name = QLabel(info["display"])
        self._name.setMinimumWidth(160)
        self._name.setStyleSheet(f"color: {COLORS['fg']};")
        layout.addWidget(self._name)

        self._version = QLabel()
        self._version.setMinimumWidth(200)
        layout.addWidget(self._version)

        tag = QLabel("required" if info["required"] else "optional")
        tag.setFixedWidth(60)
        tag.setStyleSheet(
            f"color: {COLORS['warning'] if info['required'] else COLORS['muted']}; font-size: 8pt;"
        )
        layout.addWidget(tag)

        layout.addStretch()
        self.update_status(info)

    def update_status(self, info: dict) -> None:
        self.info = info
        if info["found"]:
            self._icon.setText("\u2714")
            self._icon.setStyleSheet(f"color: {COLORS['success']}; font-size: 12pt;")
            self._version.setText(info["version"])
            self._version.setStyleSheet(f"color: {COLORS['success']}; font-size: 9pt;")
        else:
            self._icon.setText("\u2718")
            self._icon.setStyleSheet(f"color: {COLORS['error']}; font-size: 12pt;")
            self._version.setText(info["help"])
            self._version.setStyleSheet(f"color: {COLORS['muted']}; font-size: 9pt;")
            self._version.setWordWrap(True)


class PrerequisitesView(QWidget):
    prereqs_ok = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._worker: PrereqCheckWorker | None = None
        self._rows: list[PrereqRow] = []

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(8)

        title = QLabel("Prerequisites")
        title.setStyleSheet(f"color: {COLORS['info']}; font-size: 16pt; font-weight: bold;")
        layout.addWidget(title)

        subtitle = QLabel("Checking for required tools...")
        subtitle.setStyleSheet(f"color: {COLORS['muted']}; font-size: 10pt;")
        layout.addWidget(subtitle)
        self._subtitle = subtitle

        layout.addSpacing(8)

        self._rows_layout = QVBoxLayout()
        layout.addLayout(self._rows_layout)

        layout.addSpacing(8)

        self._status_label = QLabel()
        self._status_label.setWordWrap(True)
        self._status_label.setVisible(False)
        layout.addWidget(self._status_label)

        # Buttons
        btn_row = QHBoxLayout()
        btn_row.addStretch()

        self._recheck_btn = QPushButton("Re-check")
        self._recheck_btn.setFixedWidth(100)
        self._recheck_btn.setVisible(False)
        self._recheck_btn.clicked.connect(self._start_check)
        btn_row.addWidget(self._recheck_btn)

        self._continue_btn = QPushButton("Continue to Setup")
        self._continue_btn.setFixedWidth(180)
        self._continue_btn.setVisible(False)
        self._continue_btn.setStyleSheet(
            f"QPushButton {{ background: {COLORS['accent']}; color: {COLORS['bg']}; "
            f"font-weight: bold; border: none; padding: 8px 20px; border-radius: 4px; }}"
            f"QPushButton:hover {{ background: #caa4ff; }}"
        )
        self._continue_btn.clicked.connect(lambda: self.prereqs_ok.emit())
        btn_row.addWidget(self._continue_btn)

        layout.addLayout(btn_row)
        layout.addStretch()

        QTimer.singleShot(200, self._start_check)

    def _start_check(self) -> None:
        self._recheck_btn.setVisible(False)
        self._continue_btn.setVisible(False)
        self._status_label.setVisible(False)
        self._subtitle.setText("Checking for required tools...")

        for row in self._rows:
            row.setParent(None)
            row.deleteLater()
        self._rows.clear()

        self._worker = PrereqCheckWorker()
        self._worker.result_ready.connect(self._on_results)
        self._worker.start()

    def _on_results(self, results: list) -> None:
        for info in results:
            row = PrereqRow(info)
            self._rows.append(row)
            self._rows_layout.addWidget(row)

        missing_required = [r for r in results if r["required"] and not r["found"]]
        missing_optional = [r for r in results if not r["required"] and not r["found"]]

        self._recheck_btn.setVisible(True)

        if missing_required:
            names = ", ".join(r["display"] for r in missing_required)
            err_color = COLORS["error"]
            muted_color = COLORS["muted"]
            self._subtitle.setText("Some required tools are missing.")
            self._status_label.setText(
                f"<span style='color:{err_color}'>Missing required: {names}</span><br>"
                f"<span style='color:{muted_color}'>Install the missing tools and click Re-check, "
                f"or Continue anyway (some install steps may fail).</span>"
            )
            self._status_label.setTextFormat(Qt.TextFormat.RichText)
            self._status_label.setVisible(True)
            self._continue_btn.setVisible(True)
            self._continue_btn.setText("Continue Anyway")
        else:
            self._subtitle.setText("All required tools found!")
            if missing_optional:
                names = ", ".join(r["display"] for r in missing_optional)
                warn_color = COLORS["warning"]
                self._status_label.setText(
                    f"<span style='color:{warn_color}'>Optional missing: {names}</span>"
                )
                self._status_label.setTextFormat(Qt.TextFormat.RichText)
                self._status_label.setVisible(True)
            self._continue_btn.setVisible(True)
            self._continue_btn.setText("Continue to Setup")


# ── Setup View ─────────────────────────────────────────────


def _find_uproject(directory: str) -> str | None:
    try:
        for entry in Path(directory).iterdir():
            if entry.is_file() and entry.suffix == ".uproject":
                return str(entry)
    except OSError:
        pass
    return None


def _detect_directories(project_root: str) -> list[dict]:
    candidates = []
    checks = [
        ("Script", "angelscript", [".as"]),
        ("Source", "cpp", [".h", ".cpp"]),
        ("Plugins", "cpp", [".h", ".cpp"]),
        ("Content", "content", [".uasset", ".umap"]),
        ("Config", "config", [".ini"]),
    ]
    for subdir, language, extensions in checks:
        d = Path(project_root) / subdir
        if d.exists():
            candidates.append({
                "subdir": subdir,
                "path": str(d).replace("\\", "/"),
                "language": language,
                "extensions": extensions,
            })
    return candidates


def _detect_engine_root(project_root: str) -> str | None:
    d = Path(project_root).parent
    for _ in range(5):
        if (d / "Engine" / "Source").exists():
            return str(d)
        parent = d.parent
        if parent == d:
            break
        d = parent
    return None


def _detect_engine_dirs(engine_root: str) -> list[dict]:
    candidates = []
    for sub in ["Engine/Source", "Engine/Plugins"]:
        d = Path(engine_root) / sub
        if d.exists():
            candidates.append({
                "subdir": sub,
                "path": str(d).replace("\\", "/"),
                "language": "cpp",
                "extensions": [".h", ".cpp"],
            })
    return candidates


class SetupView(QWidget):
    setup_complete = Signal(dict)  # emits the config dict for installation

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._project_root: str = ""
        self._project_name: str = ""
        self._engine_root: str | None = None
        self._dir_checks: list[tuple[QCheckBox, dict]] = []
        self._engine_checks: list[tuple[QCheckBox, dict]] = []

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        container = QWidget()
        self._layout = QVBoxLayout(container)
        self._layout.setContentsMargins(16, 12, 16, 12)
        self._layout.setSpacing(12)
        scroll.setWidget(container)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(scroll)

        # Title
        title = QLabel("Unreal Index Setup")
        title.setStyleSheet(f"color: {COLORS['info']}; font-size: 16pt; font-weight: bold;")
        self._layout.addWidget(title)

        subtitle = QLabel(
            "Configure which directories to index for fast code search."
        )
        subtitle.setStyleSheet(f"color: {COLORS['muted']}; font-size: 10pt;")
        subtitle.setWordWrap(True)
        self._layout.addWidget(subtitle)

        # --- Project Path ---
        path_group = QGroupBox("Project Path")
        path_layout = QHBoxLayout(path_group)
        self._path_input = QLineEdit()
        self._path_input.setPlaceholderText("Path to .uproject file or project directory")
        self._path_input.textChanged.connect(self._on_path_changed)
        path_layout.addWidget(self._path_input)

        browse_btn = QPushButton("Browse...")
        browse_btn.setFixedWidth(100)
        browse_btn.clicked.connect(self._browse_project)
        path_layout.addWidget(browse_btn)
        self._layout.addWidget(path_group)

        # --- Detected Directories ---
        self._dirs_group = QGroupBox("Directories to Index")
        self._dirs_layout = QVBoxLayout(self._dirs_group)
        self._dirs_placeholder = QLabel("Select a project path above to detect directories.")
        self._dirs_placeholder.setStyleSheet(f"color: {COLORS['muted']};")
        self._dirs_layout.addWidget(self._dirs_placeholder)
        self._layout.addWidget(self._dirs_group)

        # --- Engine Directories ---
        self._engine_group = QGroupBox("Engine Directories")
        self._engine_layout = QVBoxLayout(self._engine_group)
        self._engine_placeholder = QLabel("Engine root will be auto-detected from project path.")
        self._engine_placeholder.setStyleSheet(f"color: {COLORS['muted']};")
        self._engine_layout.addWidget(self._engine_placeholder)
        self._layout.addWidget(self._engine_group)

        # --- Service Settings ---
        settings_group = QGroupBox("Service Settings")
        settings_layout = QVBoxLayout(settings_group)

        port_row = QHBoxLayout()
        port_row.addWidget(QLabel("Service Port:"))
        self._port_spin = QSpinBox()
        self._port_spin.setRange(1024, 65535)
        self._port_spin.setValue(3847)
        self._port_spin.setFixedWidth(100)
        port_row.addWidget(self._port_spin)
        port_row.addStretch()
        settings_layout.addLayout(port_row)

        zoekt_row = QHBoxLayout()
        zoekt_row.addWidget(QLabel("Zoekt Port:"))
        self._zoekt_port_spin = QSpinBox()
        self._zoekt_port_spin.setRange(1024, 65535)
        self._zoekt_port_spin.setValue(6070)
        self._zoekt_port_spin.setFixedWidth(100)
        zoekt_row.addWidget(self._zoekt_port_spin)
        zoekt_row.addStretch()
        settings_layout.addLayout(zoekt_row)

        self._layout.addWidget(settings_group)

        # --- Install Options ---
        options_group = QGroupBox("Install Options")
        options_layout = QVBoxLayout(options_group)

        self._skip_npm_cb = QCheckBox("Skip npm install (preserve local node_modules)")
        self._skip_npm_cb.setToolTip(
            "Check this if you have local changes to node_modules or package-lock.json "
            "that you don't want overwritten."
        )
        options_layout.addWidget(self._skip_npm_cb)

        self._skip_wsl_pull_cb = QCheckBox("Skip WSL clone/pull (preserve local WSL repo changes)")
        self._skip_wsl_pull_cb.setToolTip(
            "Check this if the WSL repo at ~/repos/unreal-index has local changes "
            "that differ from the remote and you want to keep them."
        )
        options_layout.addWidget(self._skip_wsl_pull_cb)

        self._layout.addWidget(options_group)

        # --- Config Preview ---
        preview_group = QGroupBox("Config Preview")
        preview_layout = QVBoxLayout(preview_group)
        self._preview = QTextEdit()
        self._preview.setReadOnly(True)
        self._preview.setMaximumHeight(200)
        self._preview.setStyleSheet(
            f"background: {COLORS['bg_dark']}; color: {COLORS['fg']}; "
            f"font-family: Consolas, monospace; font-size: 9pt;"
        )
        preview_layout.addWidget(self._preview)
        self._layout.addWidget(preview_group)

        # --- Save & Start ---
        btn_row = QHBoxLayout()
        btn_row.addStretch()
        self._save_btn = QPushButton("Install && Configure")
        self._save_btn.setFixedWidth(250)
        self._save_btn.setEnabled(False)
        self._save_btn.setStyleSheet(
            f"QPushButton {{ background: {COLORS['accent']}; color: {COLORS['bg']}; "
            f"font-weight: bold; border: none; padding: 8px 20px; border-radius: 4px; }}"
            f"QPushButton:hover {{ background: #caa4ff; }}"
            f"QPushButton:disabled {{ background: {COLORS['border']}; color: {COLORS['muted']}; }}"
        )
        self._save_btn.clicked.connect(self._save_and_start)
        btn_row.addWidget(self._save_btn)
        self._layout.addLayout(btn_row)

        self._layout.addStretch()

        # Load existing config if available
        self._load_existing()

    def _load_existing(self) -> None:
        if not config_exists():
            return
        config = read_config()
        projects = config.get("projects", [])
        if projects:
            first_path = projects[0].get("paths", [""])[0]
            if first_path:
                # Try to infer project root from first path
                p = Path(first_path)
                if p.parent.exists():
                    self._path_input.setText(str(p.parent))

        service = config.get("service", {})
        self._port_spin.setValue(service.get("port", 3847))
        zoekt = config.get("zoekt", {})
        self._zoekt_port_spin.setValue(zoekt.get("webPort", 6070))

    def _browse_project(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Select .uproject file", "",
            "Unreal Project (*.uproject);;All Files (*)"
        )
        if path:
            self._path_input.setText(path)

    def _on_path_changed(self, text: str) -> None:
        path = text.strip().strip('"').strip("'")
        if not path or not Path(path).exists():
            self._save_btn.setEnabled(False)
            return

        if path.endswith(".uproject"):
            self._project_root = str(Path(path).parent)
            self._project_name = Path(path).stem
        else:
            self._project_root = path
            uproject = _find_uproject(path)
            self._project_name = Path(uproject).stem if uproject else Path(path).name

        self._populate_directories()
        self._detect_engine()
        self._rebuild_preview()

    def _populate_directories(self) -> None:
        # Clear existing
        for cb, _ in self._dir_checks:
            cb.setParent(None)
            cb.deleteLater()
        self._dir_checks.clear()
        self._dirs_placeholder.setVisible(False)

        dirs = _detect_directories(self._project_root)
        for d in dirs:
            checked = True  # All detected directories checked by default
            cb = QCheckBox(f"{d['subdir']}/ ({d['language']})  —  {d['path']}")
            cb.setChecked(checked)
            cb.stateChanged.connect(lambda _: self._rebuild_preview())
            self._dirs_layout.addWidget(cb)
            self._dir_checks.append((cb, d))

        if not dirs:
            self._dirs_placeholder.setVisible(True)
            self._dirs_placeholder.setText("No standard directories found.")

    def _detect_engine(self) -> None:
        for cb, _ in self._engine_checks:
            cb.setParent(None)
            cb.deleteLater()
        self._engine_checks.clear()
        self._engine_placeholder.setVisible(False)

        self._engine_root = _detect_engine_root(self._project_root)
        if not self._engine_root:
            self._engine_placeholder.setVisible(True)
            self._engine_placeholder.setText("Engine root not found (looked up 5 parent levels).")
            return

        engine_dirs = _detect_engine_dirs(self._engine_root)
        for d in engine_dirs:
            cb = QCheckBox(f"{d['subdir']}  —  {d['path']}")
            cb.setChecked(True)
            cb.stateChanged.connect(lambda _: self._rebuild_preview())
            self._engine_layout.addWidget(cb)
            self._engine_checks.append((cb, d))

        if not engine_dirs:
            self._engine_placeholder.setVisible(True)
            self._engine_placeholder.setText("No Engine/Source or Engine/Plugins found.")

    def _build_config(self) -> dict:
        projects = []

        # Group selected dirs by language
        by_lang: dict[str, list[dict]] = {}
        for cb, d in self._dir_checks:
            if cb.isChecked():
                by_lang.setdefault(d["language"], []).append(d)

        name = self._project_name or "Project"

        if "angelscript" in by_lang:
            projects.append({
                "name": name,
                "paths": [d["path"] for d in by_lang["angelscript"]],
                "language": "angelscript",
                "extensions": [".as"],
            })

        if "cpp" in by_lang:
            # Separate Source and Plugins for clarity
            for d in by_lang["cpp"]:
                proj_name = f"{name}{d['subdir']}" if d["subdir"] != "Source" else f"{name}Source"
                projects.append({
                    "name": proj_name,
                    "paths": [d["path"]],
                    "language": "cpp",
                    "extensions": [".h", ".cpp"],
                })

        if "config" in by_lang:
            projects.append({
                "name": f"{name}Config",
                "paths": [d["path"] for d in by_lang["config"]],
                "language": "config",
                "extensions": [".ini"],
            })

        if "content" in by_lang:
            projects.append({
                "name": f"{name}Content",
                "paths": [d["path"] for d in by_lang["content"]],
                "language": "content",
                "extensions": [".uasset", ".umap"],
            })

        # Engine dirs
        engine_paths = [d["path"] for cb, d in self._engine_checks if cb.isChecked()]
        if engine_paths:
            projects.append({
                "name": "Engine",
                "paths": engine_paths[:1],  # Source
                "language": "cpp",
                "extensions": [".h", ".cpp"],
            })
            if len(engine_paths) > 1:
                projects.append({
                    "name": "EnginePlugins",
                    "paths": engine_paths[1:],
                    "language": "cpp",
                    "extensions": [".h", ".cpp"],
                })

        config = {
            "projects": projects,
            "exclude": [
                "**/Intermediate/**",
                "**/Binaries/**",
                "**/ThirdParty/**",
                "**/__ExternalActors__/**",
                "**/__ExternalObjects__/**",
                "**/Developers/**",
                "**/.git/**",
                "**/node_modules/**",
            ],
            "service": {
                "port": self._port_spin.value(),
                "host": "127.0.0.1",
            },
            "data": {
                "dbPath": "~/.unreal-index/index.db",
                "mirrorDir": "~/.unreal-index/mirror",
                "indexDir": "~/.unreal-index/zoekt-index",
            },
            "watcher": {"debounceMs": 100},
            "zoekt": {
                "enabled": True,
                "webPort": self._zoekt_port_spin.value(),
                "parallelism": max(1, (os.cpu_count() or 4) - 1),
                "fileLimitBytes": 524288,
                "reindexDebounceMs": 5000,
                "searchTimeoutMs": 3000,
            },
        }
        return config

    def _rebuild_preview(self) -> None:
        config = self._build_config()
        self._preview.setPlainText(json.dumps(config, indent=2))
        has_projects = len(config["projects"]) > 0
        self._save_btn.setEnabled(has_projects)

    def _save_and_start(self) -> None:
        config = self._build_config()
        options = {
            "config": config,
            "skip_wsl_pull": self._skip_wsl_pull_cb.isChecked(),
            "skip_npm": self._skip_npm_cb.isChecked(),
        }
        self.setup_complete.emit(options)


# ── Launcher View ──────────────────────────────────────────


class LauncherView(QWidget):

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(8)

        # Header
        header = QHBoxLayout()

        title = QLabel("Unreal Index")
        title.setStyleSheet(f"color: {COLORS['info']}; font-size: 14pt; font-weight: bold;")
        header.addWidget(title)

        header.addStretch()

        self._start_all_btn = QPushButton("Start All")
        self._start_all_btn.setFixedWidth(100)
        self._start_all_btn.clicked.connect(self._start_all)
        header.addWidget(self._start_all_btn)

        self._stop_all_btn = QPushButton("Stop All")
        self._stop_all_btn.setFixedWidth(100)
        self._stop_all_btn.clicked.connect(self._stop_all)
        header.addWidget(self._stop_all_btn)

        layout.addLayout(header)

        # Service rows
        self._port = read_port()

        self._index_row = ServiceRow("index", "Index Service (WSL)", self._port)
        self._index_row.start_requested.connect(self._on_start)
        self._index_row.stop_requested.connect(self._on_stop)
        layout.addWidget(self._index_row)

        self._watcher_row = ServiceRow("watcher", "File Watcher", None)
        self._watcher_row.start_requested.connect(self._on_start)
        self._watcher_row.stop_requested.connect(self._on_stop)
        layout.addWidget(self._watcher_row)

        # Stats
        separator = QFrame()
        separator.setFrameShape(QFrame.Shape.HLine)
        separator.setStyleSheet(f"color: {COLORS['border']};")
        layout.addWidget(separator)

        stats_header = QLabel("Index Statistics")
        stats_header.setStyleSheet(f"color: {COLORS['info']}; font-weight: bold; font-size: 10pt;")
        layout.addWidget(stats_header)

        self._stats_panel = IndexStatsPanel(port=self._port)
        layout.addWidget(self._stats_panel)

        layout.addStretch()

        # Footer
        footer = QHBoxLayout()
        footer.addStretch()

        reconfig_btn = QPushButton("Reconfigure")
        reconfig_btn.setFixedWidth(120)
        reconfig_btn.clicked.connect(self._reconfigure)
        footer.addWidget(reconfig_btn)
        layout.addLayout(footer)

        # Status check timer
        self._check_worker: StatusCheckWorker | None = None
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._refresh)
        self._timer.start(3000)
        self._refresh()

    def _refresh(self) -> None:
        if self._check_worker and self._check_worker.isRunning():
            return
        self._check_worker = StatusCheckWorker(self._port)
        self._check_worker.result_ready.connect(self._on_status)
        self._check_worker.start()

    def _on_status(self, index_running: bool, watcher_running: bool) -> None:
        if index_running:
            self._index_row.set_state(ServiceState.RUNNING)
            self._stats_panel.refresh()
        elif self._index_row.state not in (ServiceState.STARTING, ServiceState.STOPPING):
            self._index_row.set_state(ServiceState.STOPPED)
            if self._index_row.state == ServiceState.STARTING:
                self._stats_panel.refresh_startup()
            else:
                self._stats_panel.set_offline()

        if watcher_running:
            self._watcher_row.set_state(ServiceState.RUNNING)
        elif self._watcher_row.state not in (ServiceState.STARTING, ServiceState.STOPPING):
            self._watcher_row.set_state(ServiceState.STOPPED)

    def _on_start(self, name: str) -> None:
        if name == "index":
            self._index_row.set_state(ServiceState.STARTING)
            start_index_service()
        elif name == "watcher":
            self._watcher_row.set_state(ServiceState.STARTING)
            start_watcher()
        QTimer.singleShot(3000, self._refresh)

    def _on_stop(self, name: str) -> None:
        if name == "index":
            self._index_row.set_state(ServiceState.STOPPING)
            stop_index_service()
        elif name == "watcher":
            self._watcher_row.set_state(ServiceState.STOPPING)
            stop_watcher()
        QTimer.singleShot(1000, self._refresh)

    def _start_all(self) -> None:
        if self._index_row.state == ServiceState.STOPPED:
            self._on_start("index")
        if self._watcher_row.state == ServiceState.STOPPED:
            self._on_start("watcher")

    def _stop_all(self) -> None:
        if self._index_row.state == ServiceState.RUNNING:
            self._on_stop("index")
        if self._watcher_row.state == ServiceState.RUNNING:
            self._on_stop("watcher")

    def _reconfigure(self) -> None:
        window = self.window()
        if isinstance(window, UnrealIndexApp):
            window.show_setup()


# ── Main Window ────────────────────────────────────────────


class UnrealIndexApp(QMainWindow):

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Unreal Index")
        self.setMinimumSize(750, 750)

        self._stack = QStackedWidget()
        self.setCentralWidget(self._stack)

        self._prereqs_view: PrerequisitesView | None = None
        self._setup_view: SetupView | None = None
        self._install_view: InstallView | None = None
        self._launcher_view: LauncherView | None = None

        if config_exists():
            self._show_launcher()
        else:
            self._show_prereqs()

    def _show_prereqs(self) -> None:
        if self._prereqs_view is not None:
            self._prereqs_view.setParent(None)
            self._prereqs_view.deleteLater()
        self._prereqs_view = PrerequisitesView()
        self._prereqs_view.prereqs_ok.connect(self._show_setup)
        self._stack.addWidget(self._prereqs_view)
        self._stack.setCurrentWidget(self._prereqs_view)

    def _show_setup(self) -> None:
        if self._setup_view is not None:
            self._setup_view.setParent(None)
            self._setup_view.deleteLater()
        self._setup_view = SetupView()
        self._setup_view.setup_complete.connect(self._on_setup_done)
        self._stack.addWidget(self._setup_view)
        self._stack.setCurrentWidget(self._setup_view)

    def _show_launcher(self) -> None:
        if self._launcher_view is not None:
            self._launcher_view.setParent(None)
            self._launcher_view.deleteLater()
        self._launcher_view = LauncherView()
        self._stack.addWidget(self._launcher_view)
        self._stack.setCurrentWidget(self._launcher_view)

    def _show_install(self, options: dict) -> None:
        if self._install_view is not None:
            self._install_view.setParent(None)
            self._install_view.deleteLater()
        self._install_view = InstallView(
            config=options["config"],
            skip_wsl_pull=options.get("skip_wsl_pull", False),
            skip_npm=options.get("skip_npm", False),
        )
        self._install_view.install_complete.connect(self._show_launcher)
        self._stack.addWidget(self._install_view)
        self._stack.setCurrentWidget(self._install_view)

    def show_setup(self) -> None:
        """Called from LauncherView reconfigure button."""
        self._show_prereqs()

    def _on_setup_done(self, options: dict) -> None:
        self._show_install(options)


def main() -> None:
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setStyleSheet(DARK_THEME)

    window = UnrealIndexApp()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
