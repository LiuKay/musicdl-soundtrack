import json
import os
import sys
from pathlib import Path

import webview


DEFAULT_DOWNLOAD_DIR = Path.home() / 'Downloads' / 'Soundtrack'
if sys.platform == 'darwin':
    SETTINGS_DIR = Path.home() / 'Library' / 'Application Support' / 'Soundtrack'
elif os.name == 'nt':
    SETTINGS_DIR = Path(os.environ.get(
        'APPDATA', Path.home() / 'AppData' / 'Roaming',
    )) / 'Soundtrack'
else:
    SETTINGS_DIR = Path(os.environ.get(
        'XDG_CONFIG_HOME', Path.home() / '.config',
    )) / 'Soundtrack'
SETTINGS_PATH = SETTINGS_DIR / 'settings.json'


def _display_path(path):
    path = str(path)
    home = str(Path.home())
    return '~' + path[len(home):] if path == home or path.startswith(home + os.sep) else path


def _load_download_dir():
    try:
        path = Path(json.loads(
            SETTINGS_PATH.read_text(encoding='utf-8'),
        )['download_dir']).expanduser()
        if path.is_absolute() and path.is_dir():
            return path
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return DEFAULT_DOWNLOAD_DIR


def _save_download_dir(path):
    SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix('.tmp')
    tmp.write_text(
        json.dumps({'download_dir': str(path)}, ensure_ascii=False),
        encoding='utf-8',
    )
    os.replace(tmp, SETTINGS_PATH)


class DesktopApi:
    def __init__(self, app_module):
        self.app_module = app_module

    def get_download_dir(self):
        return _display_path(self.app_module.DOWNLOAD_DIR)

    def choose_download_dir(self):
        selected = webview.windows[0].create_file_dialog(
            webview.FileDialog.FOLDER,
            directory=self.app_module.DOWNLOAD_DIR,
        )
        if not selected:
            return None
        path = Path(selected[0]).resolve()
        if not path.is_dir():
            return None
        _save_download_dir(path)
        self.app_module.DOWNLOAD_DIR = str(path)
        return _display_path(path)


def main():
    os.environ.setdefault(
        'SOUNDTRACK_DOWNLOAD_DIR',
        str(_load_download_dir()),
    )
    cache_root = (
        Path.home() / 'Library' / 'Caches' if sys.platform == 'darwin'
        else Path(os.environ.get('LOCALAPPDATA', Path.home() / '.cache'))
    )
    os.environ.setdefault(
        'SOUNDTRACK_CACHE_DIR',
        str(cache_root / 'Soundtrack' / 'audio'),
    )
    import app as app_module

    webview.create_window(
        '声轨 · Soundtrack',
        app_module.app,
        js_api=DesktopApi(app_module),
        width=1280,
        height=800,
    )
    webview.start()


if __name__ == '__main__':
    main()
