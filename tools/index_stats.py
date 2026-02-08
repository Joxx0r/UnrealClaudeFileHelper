"""Index statistics panel — shows unreal-index service stats."""

from __future__ import annotations

import json
import re
import urllib.request

from PySide6.QtCore import QThread, Qt, Signal
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
)

from theme import COLORS
from service_manager import check_wsl_screen, get_service_log


class IndexStatsWorker(QThread):
    """Fetch stats from HTTP endpoints when the service is responding."""
    result_ready = Signal(dict)
    fetch_failed = Signal()

    def __init__(self, parent=None, port: int = 3847) -> None:
        super().__init__(parent)
        self._base_url = f"http://127.0.0.1:{port}"

    def run(self) -> None:
        try:
            health = self._fetch(f"{self._base_url}/health")
            stats = self._fetch_safe(f"{self._base_url}/stats")
            status = self._fetch_safe(f"{self._base_url}/status")
            summary = self._fetch_safe(f"{self._base_url}/summary")
            self.result_ready.emit({
                "health": health,
                "stats": stats or {},
                "status": status,
                "summary": summary,
            })
        except Exception:
            self.fetch_failed.emit()

    def _fetch(self, url: str) -> dict:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _fetch_safe(self, url: str) -> dict | None:
        try:
            return self._fetch(url)
        except Exception:
            return None


class LogWorker(QThread):
    """Read the WSL service log and screen session status for startup feedback."""
    result_ready = Signal(bool, str)

    def run(self) -> None:
        running = check_wsl_screen()
        log = get_service_log(lines=20) if running else ""
        self.result_ready.emit(running, log)


def _fmt_count(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _fmt_uptime(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    hours = seconds // 3600
    mins = (seconds % 3600) // 60
    return f"{hours}h {mins}m"


_LABEL_STYLE = f"border: none; color: {COLORS['fg']}; font-size: 9pt;"
_MUTED_STYLE = f"border: none; color: {COLORS['muted']}; font-size: 9pt;"
_DETAIL_STYLE = f"border: none; color: {COLORS['fg']}; font-size: 8pt; font-family: Consolas, monospace;"
_LOG_STYLE = (
    f"border: none; color: {COLORS['muted']}; font-size: 8pt; "
    f"font-family: Consolas, monospace;"
)

_STATUS_COLORS = {
    "indexed": COLORS["success"],
    "ready": COLORS["success"],
    "indexing": COLORS["warning"],
    "pending": COLORS["warning"],
    "error": COLORS["error"],
}

_LANG_LABELS = {
    "angelscript": "AS",
    "cpp": "C++",
    "config": "Config",
    "asset": "Assets",
    "content": "Content",
}

_RE_PROGRESS = re.compile(r"(\d+)\s*/\s*(\d+)")
_RE_FILES_INDEXED = re.compile(r"(\d+)\s+files?\s+indexed", re.IGNORECASE)
_RE_INDEXING = re.compile(
    r"(?:indexing|scanning|processing)\s+(\w[\w\s]*?)(?:\.\.\.|:|\s+\d)",
    re.IGNORECASE,
)


def _parse_log_status(log_text: str) -> dict:
    """Extract meaningful status from recent log lines."""
    lines = [l.strip() for l in log_text.strip().splitlines() if l.strip()]
    if not lines:
        return {"phase": "starting", "detail": "Waiting for output..."}

    last_lines = lines[-10:]
    result: dict = {"phase": "starting", "detail": ""}

    for line in reversed(last_lines):
        lower = line.lower()
        if "error" in lower or "fatal" in lower or "enoent" in lower:
            result["phase"] = "error"
            result["detail"] = line[:120]
            return result

    for line in reversed(last_lines):
        lower = line.lower()
        if "listening" in lower or "server started" in lower or "ready" in lower:
            result["phase"] = "ready"
            result["detail"] = line[:120]
            return result

    for line in reversed(last_lines):
        m_progress = _RE_PROGRESS.search(line)
        if m_progress:
            current = int(m_progress.group(1))
            total = int(m_progress.group(2))
            if total > 0:
                result["phase"] = "indexing"
                result["progress"] = current
                result["total"] = total
                result["detail"] = line[:120]
                return result

        if _RE_FILES_INDEXED.search(line):
            result["phase"] = "indexing"
            result["detail"] = line[:120]
            return result

        if _RE_INDEXING.search(line):
            result["phase"] = "indexing"
            result["detail"] = line[:120]
            return result

    result["detail"] = last_lines[-1][:120] if last_lines else "Starting..."
    return result


class IndexStatsPanel(QFrame):

    def __init__(self, port: int = 3847, parent=None) -> None:
        super().__init__(parent)
        self._port = port
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setStyleSheet(
            f"QFrame {{ background: {COLORS['bg_dark']}; "
            f"border: 1px solid {COLORS['border']}; border-radius: 6px; }}"
        )

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        layout.setSpacing(2)

        # --- Summary rows ---
        self._row1 = QLabel()
        self._row1.setStyleSheet(_LABEL_STYLE)
        layout.addWidget(self._row1)

        self._row2 = QLabel()
        self._row2.setStyleSheet(_LABEL_STYLE)
        layout.addWidget(self._row2)

        self._row3 = QLabel()
        self._row3.setStyleSheet(_LABEL_STYLE)
        self._row3.setTextFormat(Qt.TextFormat.RichText)
        layout.addWidget(self._row3)

        # --- Startup feedback ---
        self._startup_frame = QFrame()
        self._startup_frame.setStyleSheet("QFrame { border: none; }")
        startup_layout = QVBoxLayout(self._startup_frame)
        startup_layout.setContentsMargins(0, 0, 0, 0)
        startup_layout.setSpacing(4)

        self._startup_phase = QLabel()
        self._startup_phase.setStyleSheet(
            f"border: none; color: {COLORS['warning']}; font-size: 9pt; font-weight: bold;"
        )
        startup_layout.addWidget(self._startup_phase)

        self._startup_progress = QProgressBar()
        self._startup_progress.setMaximumHeight(14)
        self._startup_progress.setTextVisible(True)
        self._startup_progress.setVisible(False)
        startup_layout.addWidget(self._startup_progress)

        self._startup_detail = QLabel()
        self._startup_detail.setStyleSheet(_LOG_STYLE)
        self._startup_detail.setWordWrap(True)
        startup_layout.addWidget(self._startup_detail)

        self._startup_log = QLabel()
        self._startup_log.setStyleSheet(_LOG_STYLE)
        self._startup_log.setWordWrap(True)
        self._startup_log.setMaximumHeight(80)
        startup_layout.addWidget(self._startup_log)

        layout.addWidget(self._startup_frame)
        self._startup_frame.setVisible(False)

        # --- Details toggle ---
        toggle_row = QHBoxLayout()
        toggle_row.setContentsMargins(0, 4, 0, 0)
        self._toggle_btn = QPushButton("Show Details")
        self._toggle_btn.setFixedWidth(100)
        self._toggle_btn.setStyleSheet(
            f"QPushButton {{ border: 1px solid {COLORS['border']}; "
            f"background: {COLORS['bg']}; color: {COLORS['muted']}; "
            f"font-size: 8pt; padding: 2px 8px; border-radius: 3px; }}"
            f"QPushButton:hover {{ color: {COLORS['fg']}; background: {COLORS['bg_hover']}; }}"
        )
        self._toggle_btn.clicked.connect(self._toggle_details)
        toggle_row.addWidget(self._toggle_btn)
        toggle_row.addStretch()
        layout.addLayout(toggle_row)

        # --- Collapsible details ---
        self._details_frame = QFrame()
        self._details_frame.setStyleSheet("QFrame { border: none; }")
        details_layout = QVBoxLayout(self._details_frame)
        details_layout.setContentsMargins(0, 4, 0, 0)
        details_layout.setSpacing(2)

        self._details_header = QLabel("Per-Project Status")
        self._details_header.setStyleSheet(
            f"border: none; color: {COLORS['info']}; font-size: 8pt; font-weight: bold;"
        )
        details_layout.addWidget(self._details_header)

        self._project_labels: list[QLabel] = []
        for _ in range(12):
            lbl = QLabel()
            lbl.setStyleSheet(_DETAIL_STYLE)
            lbl.setTextFormat(Qt.TextFormat.RichText)
            lbl.setVisible(False)
            details_layout.addWidget(lbl)
            self._project_labels.append(lbl)

        self._details_frame.setVisible(False)
        layout.addWidget(self._details_frame)

        # --- Offline label ---
        self._offline_label = QLabel("Index service not running")
        self._offline_label.setStyleSheet(_MUTED_STYLE)
        self._offline_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self._offline_label)

        self._worker: IndexStatsWorker | None = None
        self._log_worker: LogWorker | None = None
        self._details_visible = False
        self.set_offline()

    def refresh(self) -> None:
        if self._worker and self._worker.isRunning():
            return
        self._worker = IndexStatsWorker(self, port=self._port)
        self._worker.result_ready.connect(self._on_result)
        self._worker.fetch_failed.connect(self._on_fetch_failed)
        self._worker.start()

    def refresh_startup(self) -> None:
        if self._log_worker and self._log_worker.isRunning():
            return
        self._log_worker = LogWorker(self)
        self._log_worker.result_ready.connect(self._on_log_result)
        self._log_worker.start()

    def set_offline(self) -> None:
        self._row1.setVisible(False)
        self._row2.setVisible(False)
        self._row3.setVisible(False)
        self._toggle_btn.setVisible(False)
        self._details_frame.setVisible(False)
        self._startup_frame.setVisible(False)
        self._offline_label.setVisible(True)

    def _toggle_details(self) -> None:
        self._details_visible = not self._details_visible
        self._details_frame.setVisible(self._details_visible)
        self._toggle_btn.setText("Hide Details" if self._details_visible else "Show Details")

    def _on_fetch_failed(self) -> None:
        self.refresh_startup()

    def _on_log_result(self, screen_running: bool, log_text: str) -> None:
        if not screen_running and not log_text:
            self.set_offline()
            return

        self._row1.setVisible(False)
        self._row2.setVisible(False)
        self._row3.setVisible(False)
        self._toggle_btn.setVisible(False)
        self._details_frame.setVisible(False)
        self._offline_label.setVisible(False)
        self._startup_frame.setVisible(True)

        if not screen_running:
            self._startup_phase.setText("\u25CF Service process not found")
            self._startup_phase.setStyleSheet(
                f"border: none; color: {COLORS['error']}; font-size: 9pt; font-weight: bold;"
            )
            self._startup_progress.setVisible(False)
            self._startup_detail.setText("The screen session exited. Check logs for errors.")
            self._show_log_tail(log_text)
            return

        parsed = _parse_log_status(log_text)
        phase = parsed.get("phase", "starting")
        detail = parsed.get("detail", "")

        if phase == "error":
            self._startup_phase.setText("\u25CF Error during startup")
            self._startup_phase.setStyleSheet(
                f"border: none; color: {COLORS['error']}; font-size: 9pt; font-weight: bold;"
            )
            self._startup_progress.setVisible(False)
            self._startup_detail.setText(detail)
        elif phase == "indexing":
            progress = parsed.get("progress")
            total = parsed.get("total")
            self._startup_phase.setText("\u25CF Indexing in progress...")
            self._startup_phase.setStyleSheet(
                f"border: none; color: {COLORS['warning']}; font-size: 9pt; font-weight: bold;"
            )
            if progress is not None and total and total > 0:
                self._startup_progress.setVisible(True)
                self._startup_progress.setMaximum(total)
                self._startup_progress.setValue(progress)
                self._startup_progress.setFormat(f"{progress}/{total} ({100 * progress // total}%)")
            else:
                self._startup_progress.setVisible(False)
            self._startup_detail.setText(detail)
        elif phase == "ready":
            self._startup_phase.setText("\u25CF Service ready — waiting for port...")
            self._startup_phase.setStyleSheet(
                f"border: none; color: {COLORS['success']}; font-size: 9pt; font-weight: bold;"
            )
            self._startup_progress.setVisible(False)
            self._startup_detail.setText(detail)
        else:
            self._startup_phase.setText("\u25CF Starting up...")
            self._startup_phase.setStyleSheet(
                f"border: none; color: {COLORS['warning']}; font-size: 9pt; font-weight: bold;"
            )
            self._startup_progress.setVisible(False)
            self._startup_detail.setText(detail if detail else "Initializing service...")

        self._show_log_tail(log_text)

    def _show_log_tail(self, log_text: str) -> None:
        lines = [l.strip() for l in log_text.strip().splitlines() if l.strip()]
        tail = lines[-5:] if lines else []
        if tail:
            self._startup_log.setText("\n".join(tail))
            self._startup_log.setVisible(True)
        else:
            self._startup_log.setVisible(False)

    def _on_result(self, data: dict) -> None:
        health = data.get("health", {})
        stats = data.get("stats", {})
        status = data.get("status")
        summary = data.get("summary")

        self._startup_frame.setVisible(False)
        self._offline_label.setVisible(False)
        self._row1.setVisible(True)
        self._row2.setVisible(True)
        self._row3.setVisible(True)
        self._toggle_btn.setVisible(True)

        total_files = stats.get("totalFiles", 0)
        total_types = stats.get("totalTypes", 0)
        total_members = stats.get("totalMembers", 0)

        zoekt = health.get("zoekt", {})
        is_indexing = zoekt.get("indexing", False)
        uptime_s = health.get("uptimeSeconds", 0)
        is_initializing = total_files == 0 and uptime_s < 120

        if total_files == 0 and is_indexing:
            self._row1.setText("Initial indexing in progress...")
            self._row1.setStyleSheet(
                f"border: none; color: {COLORS['warning']}; font-size: 9pt;"
            )
        elif is_initializing:
            self._row1.setText(f"Service initializing... (uptime: {_fmt_uptime(uptime_s)})")
            self._row1.setStyleSheet(
                f"border: none; color: {COLORS['warning']}; font-size: 9pt;"
            )
        else:
            self._row1.setText(
                f"Files: {_fmt_count(total_files)}    "
                f"Types: {_fmt_count(total_types)}    "
                f"Members: {_fmt_count(total_members)}"
            )
            self._row1.setStyleSheet(_LABEL_STYLE)

        by_lang = stats.get("byLanguage", {})
        lang_parts = []
        for lang, lang_data in by_lang.items():
            if lang == "content":
                continue
            files = lang_data.get("files", 0)
            label = _LANG_LABELS.get(lang, lang)
            lang_parts.append(f"{label}: {_fmt_count(files)}")

        if lang_parts:
            self._row2.setText("    ".join(lang_parts))
        elif is_indexing or is_initializing:
            self._row2.setText("Scanning project files...")
        else:
            self._row2.setText("No indexed files")

        zoekt_available = zoekt.get("available", False)
        zoekt_color = COLORS["success"] if zoekt_available else COLORS["error"]
        zoekt_text = "Ready" if zoekt_available else "Unavailable"
        if is_indexing:
            zoekt_color = COLORS["warning"]
            zoekt_text = "Indexing..."

        mem = health.get("memoryMB", {})
        mem_mb = mem.get("heapUsed", 0)
        uptime = _fmt_uptime(health.get("uptimeSeconds", 0))

        self._row3.setText(
            f"Zoekt: <span style='color:{zoekt_color};'>\u25CF</span> {zoekt_text}"
            f"    Memory: {mem_mb} MB"
            f"    Uptime: {uptime}"
        )

        projects = self._extract_projects(status, summary, stats)
        for i, lbl in enumerate(self._project_labels):
            if i < len(projects):
                proj = projects[i]
                name = proj.get("name", "?")
                lang = _LANG_LABELS.get(proj.get("language", ""), proj.get("language", ""))
                files = proj.get("files", 0)
                proj_status = proj.get("status", "unknown")
                color = _STATUS_COLORS.get(proj_status, COLORS["muted"])
                lbl.setText(
                    f"<span style='color:{color};'>\u25CF</span> "
                    f"{name}  "
                    f"<span style='color:{COLORS['muted']};'>({lang})</span>  "
                    f"{_fmt_count(files)} files  "
                    f"<span style='color:{color};'>{proj_status}</span>"
                )
                lbl.setVisible(True)
            else:
                lbl.setVisible(False)

    def _extract_projects(self, status: dict | None, summary: dict | None, stats: dict) -> list[dict]:
        # Check status endpoint for a list of project dicts
        if status and isinstance(status.get("projects"), list):
            items = status["projects"]
            if items and isinstance(items[0], dict):
                return items

        # stats.projects is a dict like {"Engine": {"files": N, "language": "cpp"}, ...}
        stats_projects = stats.get("projects", {})
        if isinstance(stats_projects, dict) and stats_projects:
            projects = []
            for name, proj_data in stats_projects.items():
                if isinstance(proj_data, dict):
                    projects.append({
                        "name": name,
                        "language": proj_data.get("language", ""),
                        "files": proj_data.get("files", 0),
                        "status": "indexed",
                    })
            return projects

        # Fallback: group by language
        projects = []
        by_lang = stats.get("byLanguage", {})
        for lang, lang_data in by_lang.items():
            if isinstance(lang_data, dict):
                projects.append({
                    "name": _LANG_LABELS.get(lang, lang),
                    "language": lang,
                    "files": lang_data.get("files", 0),
                    "status": "indexed",
                })
        return projects
