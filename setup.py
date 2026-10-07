from pathlib import Path
from importlib.metadata import distribution

from setuptools import setup


STATIC_FILES = [str(path) for path in Path('static').iterdir() if path.is_file()]
# mypyc extensions import a wheel-specific helper dynamically, beyond modulegraph.
CHARSET_HELPERS = [path.name.split('.')[0]
                   for path in distribution('charset-normalizer').files or []
                   if len(path.parts) == 1 and path.name.split('.')[0].endswith('__mypyc')]
AUDIO_TOOLS = Path('build/audio-tools')
for name in ('bin/ffmpeg', 'bin/ffprobe', 'licenses/FFmpeg-LGPL-2.1.txt',
             'licenses/LAME-LGPL-2.0.txt', 'audio-tools-source.tar.gz'):
    if not (AUDIO_TOOLS / name).is_file():
        raise SystemExit('Missing bundled audio tools. Run: make audio-tools')
AUDIO_FILES = [('audio-tools/' + directory,
                [str(path) for path in (AUDIO_TOOLS / directory).iterdir() if path.is_file()])
               for directory in ('bin', 'licenses')]

setup(
    app=['desktop.py'],
    name='Soundtrack',
    data_files=[('static', STATIC_FILES), *AUDIO_FILES],
    options={
        'py2app': {
            'argv_emulation': False,
            'packages': ['fake_useragent', 'flask', 'musicdl', 'requests', 'webview', 'send2trash'],
            'includes': CHARSET_HELPERS,
            'plist': {
                'CFBundleDisplayName': '声轨',
                'CFBundleIdentifier': 'com.musicdl.soundtrack',
            },
        },
    },
)
