"""Dark theme (Dracula-inspired) for the Unreal Index launcher."""

COLORS = {
    "bg": "#282a36",
    "bg_dark": "#21222c",
    "bg_hover": "#383a4a",
    "fg": "#f8f8f2",
    "border": "#44475a",
    "accent": "#bd93f9",
    "success": "#50fa7b",
    "warning": "#ffb86c",
    "error": "#ff5555",
    "info": "#8be9fd",
    "muted": "#6272a4",
}

DARK_THEME = """
QMainWindow, QWidget {
    background-color: #282a36;
    color: #f8f8f2;
    font-family: "Segoe UI", "Consolas", monospace;
    font-size: 10pt;
}
QTextBrowser, QTextEdit {
    background-color: #21222c;
    color: #f8f8f2;
    border: 1px solid #44475a;
    selection-background-color: #44475a;
}
QProgressBar {
    background-color: #44475a;
    border: 1px solid #6272a4;
    border-radius: 3px;
    height: 16px;
    text-align: center;
}
QProgressBar::chunk {
    background-color: #bd93f9;
    border-radius: 2px;
}
QLabel {
    color: #f8f8f2;
}
QPushButton {
    background-color: #44475a;
    color: #f8f8f2;
    border: 1px solid #6272a4;
    border-radius: 3px;
    padding: 5px 15px;
}
QPushButton:hover {
    background-color: #6272a4;
}
QPushButton:pressed {
    background-color: #bd93f9;
}
QPushButton:disabled {
    background-color: #383a4a;
    color: #6272a4;
    border-color: #44475a;
}
QLineEdit, QSpinBox {
    background-color: #383a4a;
    color: #f8f8f2;
    border: 1px solid #6272a4;
    border-radius: 3px;
    padding: 4px 8px;
}
QLineEdit:focus, QSpinBox:focus {
    border-color: #bd93f9;
}
QListWidget {
    background-color: #21222c;
    color: #f8f8f2;
    border: 1px solid #44475a;
}
QListWidget::item:selected {
    background-color: #44475a;
}
QGroupBox {
    border: 1px solid #44475a;
    border-radius: 4px;
    margin-top: 8px;
    padding-top: 16px;
    color: #8be9fd;
    font-weight: bold;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 10px;
    padding: 0 4px;
}
QCheckBox {
    color: #f8f8f2;
    spacing: 8px;
}
QCheckBox::indicator {
    width: 14px;
    height: 14px;
    border: 2px solid #6272a4;
    border-radius: 3px;
    background-color: #383a4a;
}
QCheckBox::indicator:checked {
    background-color: #bd93f9;
    border-color: #bd93f9;
}
QScrollArea {
    border: none;
}
"""
