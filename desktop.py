import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import webview
from werkzeug.serving import make_server


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
# Packaged smoke tests use an isolated profile as well as isolated audio folders.
SETTINGS_DIR = Path(os.environ.get('SOUNDTRACK_SETTINGS_DIR', SETTINGS_DIR)).expanduser()
SETTINGS_PATH = SETTINGS_DIR / 'settings.json'
QUIT_DOWNLOAD_MESSAGE = (
    '仍有正在提交或未完成的下载、转换任务（包括排队和取消中的任务）。\n\n'
    '退出声轨会中断这些任务，重新打开后保留中断记录，但不会自动恢复，需要手动重新操作。'
    '已完成的音乐文件会保留。\n\n'
    '要继续等待，请选择“取消”；确认退出请选择“确定”或“退出声轨”。'
)


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

    def reveal_downloaded_file(self, relative):
        if not isinstance(relative, str):
            return False
        root = Path(self.app_module.DOWNLOAD_DIR).resolve()
        path = (root / relative).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return False
        if not path.is_file():
            return False
        if sys.platform == 'darwin':
            command = ['open', '-R', str(path)]
        elif os.name == 'nt':
            command = ['explorer', '/select,', str(path)]
        else:
            command = ['xdg-open', str(path.parent)]
        try:
            subprocess.Popen(command)
        except OSError:
            return False
        return True


def _update_close_confirmation(window, app_module):
    # Use the framework's native confirmation after this synchronous callback.
    # Calling create_confirmation_dialog here would deadlock Cocoa's UI thread.
    window.confirm_close = True  # Keep the warning if reading state fails.
    with app_module.DL_LOCK:
        window.confirm_close = app_module.DOWNLOAD_REQUESTS_IN_FLIGHT > 0 or any(
            rec.get('status') not in app_module.DOWNLOAD_TERMINAL
            for rec in app_module.DOWNLOADS.values()
        )


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

    # A stable origin keeps browser preferences across launches. Bind before
    # opening the window: an occupied port must not open another local app.
    server = make_server('127.0.0.1', 42001, app_module.app, threaded=True)
    app_module.initialize_download_history(SETTINGS_DIR / 'downloads.json')
    threading.Thread(target=server.serve_forever, daemon=True).start()
    window = webview.create_window(
        '声轨 · Soundtrack',
        'http://127.0.0.1:42001',
        js_api=DesktopApi(app_module),
        width=1280,
        height=800,
        confirm_close=True,
        localization={'global.quitConfirmation': QUIT_DOWNLOAD_MESSAGE,
                      'global.quit': '退出声轨', 'global.cancel': '取消', 'global.ok': '确定'},
    )
    window.events.closing += lambda: _update_close_confirmation(window, app_module)
    try:
        webview.start(private_mode=False, storage_path=str(SETTINGS_DIR / 'webview'))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
