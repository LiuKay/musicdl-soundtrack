"""Exercise the packaged desktop app without a system FFmpeg installation."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

from mutagen.mp3 import MP3


def request(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request('http://127.0.0.1:42001' + path, data=body,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)


def main():
    executable = Path(sys.argv[1]).resolve(strict=True)
    # Never accidentally test or terminate an already-running user's app.
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 42001))
    with tempfile.TemporaryDirectory(prefix='soundtrack-packaged-audio-') as work:
        root = Path(work)
        downloads = root / 'downloads'
        downloads.mkdir()
        source = downloads / '测试 source.wav'
        with wave.open(str(source), 'wb') as audio:
            audio.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
            audio.writeframes(b'\0\0' * 44100)
        original = source.read_bytes()
        env = dict(os.environ, PATH='', SOUNDTRACK_DOWNLOAD_DIR=str(downloads),
                   SOUNDTRACK_CACHE_DIR=str(root / 'cache'),
                   SOUNDTRACK_SETTINGS_DIR=str(root / 'settings'))
        env.pop('SOUNDTRACK_FFMPEG', None)
        env.pop('SOUNDTRACK_FFPROBE', None)
        process = subprocess.Popen([str(executable)], env=env)
        try:
            deadline = time.monotonic() + 60
            while True:
                if process.poll() is not None:
                    raise RuntimeError('Packaged app exited before becoming ready')
                try:
                    formats = request('/api/download/formats')
                    break
                except (OSError, ValueError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Packaged app did not become ready')
                    time.sleep(.5)
            assert formats == {'mp3_conversion': True, 'tool_source': 'bundled'}, formats
            result = request('/api/library/export', {'relative': source.name, 'format': 'mp3'})
            deadline = time.monotonic() + 30
            while True:
                task = next(item for item in request('/api/downloads')['tasks']
                            if item['download_id'] == result['download_id'])
                if task['status'] == 'done':
                    break
                assert task['status'] not in ('error', 'cancelled'), task
                assert time.monotonic() < deadline, task
                time.sleep(.2)
            outputs = list(downloads.rglob('*.mp3'))
            assert len(outputs) == 1, outputs
            info = MP3(outputs[0]).info
            assert .9 <= info.length <= 1.2, info.length
            assert info.bitrate >= 300000, info.bitrate
            assert source.read_bytes() == original, 'Original audio was modified'
            print('PASS: packaged app uses bundled tools with empty PATH; WAV → MP3; original preserved')
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    main()
