"""Unreal Index — standalone installer + launcher GUI."""

from __future__ import annotations

import json
import os
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
    config_exists,
    read_config,
    read_port,
    start_index_service,
    start_watcher,
    stop_index_service,
    stop_watcher,
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
    setup_complete = Signal()

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
        self._save_btn = QPushButton("Save Config && Start Services")
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
            checked = d["language"] != "content"  # Content unchecked by default
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
        write_config(config)
        self.setup_complete.emit()


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
        self.setMinimumSize(700, 600)

        self._stack = QStackedWidget()
        self.setCentralWidget(self._stack)

        self._setup_view = SetupView()
        self._setup_view.setup_complete.connect(self._on_setup_done)
        self._stack.addWidget(self._setup_view)

        self._launcher_view: LauncherView | None = None

        if config_exists():
            self._show_launcher()
        else:
            self._stack.setCurrentWidget(self._setup_view)

    def _show_launcher(self) -> None:
        if self._launcher_view is not None:
            self._launcher_view.setParent(None)
            self._launcher_view.deleteLater()
        self._launcher_view = LauncherView()
        self._stack.addWidget(self._launcher_view)
        self._stack.setCurrentWidget(self._launcher_view)

    def show_setup(self) -> None:
        self._setup_view = SetupView()
        self._setup_view.setup_complete.connect(self._on_setup_done)
        self._stack.addWidget(self._setup_view)
        self._stack.setCurrentWidget(self._setup_view)

    def _on_setup_done(self) -> None:
        self._show_launcher()


def main() -> None:
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setStyleSheet(DARK_THEME)

    window = UnrealIndexApp()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
