import os
from pathlib import Path

import webview


def main():
    os.environ.setdefault(
        'SOUNDTRACK_DOWNLOAD_DIR',
        str(Path.home() / 'Downloads' / 'Soundtrack'),
    )
    from app import app

    webview.create_window('声轨 · Soundtrack', app, width=1280, height=800)
    webview.start()


if __name__ == '__main__':
    main()
