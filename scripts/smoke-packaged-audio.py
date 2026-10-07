"""Exercise packaged assets, recovery, conversion and Trash with isolated data."""
import json
import hashlib
import os
import plistlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.parse
import wave
from pathlib import Path

from mutagen.mp3 import MP3


def isolated_executable(executable, root):
    if sys.platform != 'darwin':
        return executable, []
    if executable.parent.name != 'MacOS' or executable.parents[1].name != 'Contents' or executable.parents[2].suffix != '.app':
        raise ValueError('Expected an executable inside a macOS .app bundle')
    # WKWebView ignores pywebview's storage_path on macOS; private_mode also
    # clears the default store in pywebview 6.2.1. Use a separate bundle identity.
    bundle = root / 'SoundtrackSmoke.app'
    info = bundle / 'Contents/Info.plist'
    identifier = 'com.musicdl.soundtrack.smoke-' + root.name.replace('_', '-')
    stores = [Path.home() / 'Library' / folder / identifier for folder in ('WebKit', 'Caches')]
    stores.append(Path.home() / 'Library/Saved Application State' / (identifier + '.savedState'))
    if any(store.exists() or store.is_symlink() for store in stores):
        raise RuntimeError('Temporary app identity already has a profile')
    shutil.copytree(executable.parents[2], bundle, symlinks=True)
    with info.open('rb') as stream:
        metadata = plistlib.load(stream)
    metadata['CFBundleIdentifier'] = identifier
    with info.open('wb') as stream:
        plistlib.dump(metadata, stream)
    subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(bundle)], check=True)
    return bundle / 'Contents/MacOS' / executable.name, stores


def request(path, data=None, *, method=None, headers=None, raw=False):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request('http://127.0.0.1:42001' + path, data=body,
                                 headers={'Content-Type': 'application/json', **(headers or {})},
                                 method=method)
    with urllib.request.urlopen(req, timeout=5) as response:
        body = response.read()
        return body if raw else json.loads(body) if body else None


def start(executable, env):
    # Recheck on restart too: never send mutations to a user's running instance.
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 42001))
    process = subprocess.Popen([str(executable)], env=env)
    try:
        deadline = time.monotonic() + 60
        while True:
            if process.poll() is not None:
                raise RuntimeError('Packaged app exited before becoming ready')
            try:
                formats = request('/api/download/formats')
                assert formats == {'mp3_conversion': True, 'tool_source': 'bundled'}, formats
                library = request('/api/library')
                assert Path(library['directory']).expanduser().resolve() == Path(env['SOUNDTRACK_DOWNLOAD_DIR']).resolve(), library
                return process
            except (OSError, ValueError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Packaged app did not become ready')
                time.sleep(.5)
    except BaseException:
        stop(process)
        raise


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def check_recovery():
    history = request('/api/downloads')
    assert not history['history_warning'], history
    tasks = {task['download_id']: task for task in history['tasks']}
    for ident, status in [('a' * 16, 'interrupted'), ('b' * 16, 'error')]:
        task = tasks[ident]
        assert task['status'] == status and task['restored'], task
        assert not any(key in task for key in ('token', 'file_url', 'relative')), task


def main():
    executable = Path(sys.argv[1]).resolve(strict=True)
    # Never accidentally test or terminate an already-running user's app.
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 42001))
    with tempfile.TemporaryDirectory(prefix='soundtrack-packaged-audio-') as work:
        root = Path(work)
        downloads = root / 'downloads'
        downloads.mkdir()
        source = downloads / f'{root.name}-测试 source.wav'
        with wave.open(str(source), 'wb') as audio:
            audio.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
            audio.writeframes(b'\0\0' * 44100)
        original = source.read_bytes()
        stat = source.stat()
        restore_key = hashlib.sha256(json.dumps([
            str(downloads.resolve()), source.name, stat.st_size, stat.st_mtime_ns,
        ]).encode()).hexdigest()
        settings = root / 'settings'
        settings.mkdir()
        # Deterministic interrupted/failed receipts; never use the user's profile.
        (settings / 'downloads.json').write_text(json.dumps({'version': 1, 'tasks': [
            {'download_id': 'a' * 16, 'song_name': 'Interrupted fixture', 'status': 'converting', 'local': True},
            {'download_id': 'b' * 16, 'song_name': 'Failed fixture', 'status': 'error', 'source_id': 'MiguMusicClient'},
        ]}), encoding='utf-8')
        env = dict(os.environ, PATH='', SOUNDTRACK_DOWNLOAD_DIR=str(downloads),
                   SOUNDTRACK_CACHE_DIR=str(root / 'cache'),
                   SOUNDTRACK_SETTINGS_DIR=str(settings))
        env.pop('SOUNDTRACK_FFMPEG', None)
        env.pop('SOUNDTRACK_FFPROBE', None)
        env['PYTHONWARNINGS'] = ','.join(filter(None, [env.get('PYTHONWARNINGS'),
            'error:Unable to find acceptable character detection dependency']))
        executable, stores = isolated_executable(executable, root)
        process = None
        try:
            process = start(executable, env)
            project = Path(__file__).resolve().parent.parent
            for name in ('index.html', 'style.css', 'app.js', 'session.js', 'favorites.js'):
                route = '/' if name == 'index.html' else '/static/' + name
                assert request(route, raw=True) == (project / 'static' / name).read_bytes(), name
            check_recovery()
            print('PASS: packaged frontend assets match source; interrupted and failed receipts restored')
            assert process.poll() is None, 'Packaged process exited before export'
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
            print('PASS: packaged app uses bundled tools with empty PATH; WAV -> MP3; original preserved')
            stop(process)
            process = start(executable, env)
            check_recovery()
            assert source.read_bytes() == original
            assert outputs[0].is_file(), 'Export missing after restart'
            print('PASS: receipts and exported audio survive an actual app restart')
            # Only the generated WAV is moved; exported MP3 must remain intact.
            library = request('/api/library')
            assert Path(library['directory']).expanduser().resolve() == downloads.resolve(), library
            track = next(item for item in library['tracks'] if item['relative'] == source.name)
            assert track['restore_key'] == restore_key, 'Fixture was replaced or directory changed'
            assert process.poll() is None, 'Packaged process exited before Trash check'
            request('/api/library/delete/' + urllib.parse.quote(source.name), method='DELETE',
                    headers={'If-Match': restore_key})
            assert not source.exists(), 'Generated WAV was not moved to system Trash'
            assert outputs[0].is_file(), 'Trash removed a different file'
            print('PASS: generated WAV moved to system Trash; exported MP3 preserved')
            print('NOTE: the one-second silent WAV remains recoverable in system Trash')
        finally:
            if process is not None:
                stop(process)
            for store in stores:
                if store.is_dir() and not store.is_symlink():
                    shutil.rmtree(store)


if __name__ == '__main__':
    main()
