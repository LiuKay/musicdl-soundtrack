from pathlib import Path

from setuptools import setup


STATIC_FILES = [str(path) for path in Path('static').iterdir() if path.is_file()]

setup(
    app=['desktop.py'],
    name='Soundtrack',
    data_files=[('static', STATIC_FILES)],
    options={
        'py2app': {
            'argv_emulation': False,
            'packages': ['fake_useragent', 'flask', 'musicdl', 'requests', 'webview'],
            'plist': {
                'CFBundleDisplayName': '声轨',
                'CFBundleIdentifier': 'com.musicdl.soundtrack',
            },
        },
    },
)
