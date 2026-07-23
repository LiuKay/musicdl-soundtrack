import os
import sys
from pathlib import Path

import webview


def main():
    os.environ.setdefault(
        'SOUNDTRACK_DOWNLOAD_DIR',
        str(Path.home() / 'Downloads' / 'Soundtrack'),
    )
    cache_root = (
        Path.home() / 'Library' / 'Caches' if sys.platform == 'darwin'
        else Path(os.environ.get('LOCALAPPDATA', Path.home() / '.cache'))
    )
    os.environ.setdefault(
        'SOUNDTRACK_CACHE_DIR',
        str(cache_root / 'Soundtrack' / 'audio'),
    )
    from app import app

    webview.create_window('声轨 · Soundtrack', app, width=1280, height=800)
    webview.start()


if __name__ == '__main__':
    main()
