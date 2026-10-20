"""Where Parrot keeps its files.

DATA: the texts and recordings, in the same app-data folder the desktop app uses
(macOS: ~/Library/Application Support/io.github.qwertymuzaffar.parrot). PARROT_DATA overrides it.
MODELS: the whisper model and the pronunciation dictionary, downloaded on first use.
"""
import os
import sys

APP_ID = "io.github.qwertymuzaffar.parrot"


def _default_data():
    if sys.platform == "darwin":
        return os.path.expanduser(f"~/Library/Application Support/{APP_ID}")
    if sys.platform == "win32":
        return os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), APP_ID)
    return os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), APP_ID)


DATA = os.path.abspath(os.environ.get("PARROT_DATA", _default_data()))
TEXTS = os.path.join(DATA, "texts")
TRASH = os.path.join(DATA, "trash")
MODELS = os.path.join(DATA, "models")
