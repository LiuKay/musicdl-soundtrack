'''
Function:
    A modern web-based music search / download / player powered by musicdl.

    The hard, slow part of musicdl is search: for every track it resolves the real
    audio URL (network round-trips), which is why a naive blocking call feels frozen.
    This server never blocks on that. It drives musicdl's per-result `_search` itself,
    watches the shared result list grow, and streams every track to the browser the
    instant it is resolved (Server-Sent Events). A per-source watchdog abandons any
    source that hangs, so one stuck platform can never freeze the whole UI.

Author:
    Built on top of CharlesPikachu/musicdl.
'''
import os
import re
import time
import uuid
import json
import queue
import hashlib
import threading
import requests
from flask import (
    Flask, request, Response, jsonify, send_file, send_from_directory,
    stream_with_context,
)

from musicdl import musicdl


# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(os.environ.get('RESOURCEPATH', HERE), 'static')
DOWNLOAD_DIR = os.environ.get('SOUNDTRACK_DOWNLOAD_DIR', os.path.join(HERE, 'downloads'))
CACHE_DIR = os.environ.get(
    'SOUNDTRACK_CACHE_DIR', os.path.join(HERE, '.runtime-home', 'cache'),
)
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# All sources we expose. Only Migu is enabled by default (per requirement);
# the others are one toggle away in the UI.
SUPPORTED_SOURCES = {
    'MiguMusicClient':    {'label': '咪咕音乐', 'short': 'Migu',    'default': True},
    'NeteaseMusicClient': {'label': '网易云音乐', 'short': 'Netease', 'default': False},
    'KuwoMusicClient':    {'label': '酷我音乐', 'short': 'Kuwo',    'default': False},
    'QQMusicClient':      {'label': 'QQ音乐',   'short': 'QQ',      'default': False},
    'KugouMusicClient':   {'label': '酷狗音乐', 'short': 'Kugou',   'default': False},
    'FiveSingMusicClient': {'label': '5sing',   'short': '5sing',   'default': False},
    'JamendoMusicClient': {'label': 'Jamendo',  'short': 'Jamendo', 'default': False},
    'SpotifyMusicClient': {'label': 'Spotify',  'short': 'Spotify', 'default': False},
}
SOURCE_ORDER = [
    'MiguMusicClient', 'NeteaseMusicClient', 'KuwoMusicClient', 'QQMusicClient',
    'KugouMusicClient', 'FiveSingMusicClient', 'JamendoMusicClient',
    'SpotifyMusicClient',
]

SEARCH_SIZE_PER_SOURCE = 8       # how many tracks to try to resolve per source
PER_SOURCE_TIMEOUT = 35          # seconds before a hanging source is abandoned
RESULT_EXT_TO_MIME = {
    'mp3': 'audio/mpeg', 'flac': 'audio/flac', 'wav': 'audio/wav',
    'm4a': 'audio/mp4', 'aac': 'audio/aac', 'ape': 'audio/x-ape', 'ogg': 'audio/ogg',
}


# ---------------------------------------------------------------------------
# musicdl client manager (one MusicClient, lazily built, holds all sources)
# ---------------------------------------------------------------------------
class ClientManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._mc = None

    def _build(self):
        cfg = {s: {'search_size_per_source': SEARCH_SIZE_PER_SOURCE, 'disable_print': True}
               for s in SUPPORTED_SOURCES}
        return musicdl.MusicClient(music_sources=list(SUPPORTED_SOURCES.keys()),
                                   init_music_clients_cfg=cfg)

    def client(self, source):
        with self._lock:
            if self._mc is None:
                self._mc = self._build()
        return self._mc.music_clients[source]


MANAGER = ClientManager()


# ---------------------------------------------------------------------------
# in-memory registry: token -> resolved track (so play/download need no re-search)
# ---------------------------------------------------------------------------
class TrackRegistry:
    def __init__(self):
        self._lock = threading.Lock()
        self._tracks = {}

    def add(self, song_info, source):
        token = uuid.uuid4().hex[:16]
        client = MANAGER.client(source)
        headers = dict(getattr(client, 'default_download_headers', {}) or {})
        headers.update(dict(getattr(song_info, 'default_download_headers', {}) or {}))
        cookies = dict(getattr(client, 'default_download_cookies', {}) or {})
        cookies.update(dict(getattr(song_info, 'default_download_cookies', {}) or {}))
        with self._lock:
            self._tracks[token] = {
                'song_info': song_info,
                'source': source,
                'headers': headers,
                'cookies': cookies,
            }
        return token

    def get(self, token):
        with self._lock:
            return self._tracks.get(token)


REGISTRY = TrackRegistry()

CACHE_JOBS = set()
CACHE_LOCK = threading.Lock()


def _cache_key(entry):
    song = entry['song_info']
    fields = (
        entry['source'],
        getattr(song, 'song_name', ''),
        getattr(song, 'singers', ''),
        getattr(song, 'album', ''),
        getattr(song, 'ext', ''),
        getattr(song, 'file_size', ''),
        getattr(song, 'file_size_bytes', ''),
    )
    return hashlib.sha256('\0'.join(map(str, fields)).encode()).hexdigest()


def _cache_path(entry):
    ext = re.sub(
        r'[^a-z0-9]', '',
        str(getattr(entry['song_info'], 'ext', '')).lower(),
    ) or 'audio'
    return os.path.join(CACHE_DIR, f'{_cache_key(entry)}.{ext}')


def _cache_limit():
    try:
        value = int(request.args.get('cache_max_mb', 1024))
    except (TypeError, ValueError):
        value = 1024
    return min(5120, max(128, value)) * 1024 * 1024


def _prune_cache(max_bytes, keep=None):
    os.makedirs(CACHE_DIR, exist_ok=True)
    # ponytail: directory mtime is the LRU index; add a database only if this scan becomes slow.
    with CACHE_LOCK:
        files = []
        for name in os.listdir(CACHE_DIR):
            path = os.path.join(CACHE_DIR, name)
            if name.endswith('.part') or not os.path.isfile(path):
                continue
            try:
                stat = os.stat(path)
                files.append((stat.st_mtime, stat.st_size, path, path == keep))
            except OSError:
                pass
        total = sum(size for _, size, _, _ in files)
        for _, size, path, is_kept in sorted(files):
            if total <= max_bytes:
                break
            if is_kept:
                continue
            try:
                os.remove(path)
                total -= size
            except OSError:
                pass


def _cache_audio(entry, path, max_bytes):
    key = _cache_key(entry)
    tmp = path + '.part'
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        url = getattr(entry['song_info'], 'download_url', None)
        with requests.get(url, headers=entry['headers'], cookies=entry['cookies'],
                          stream=True, timeout=(10, 30), verify=False) as resp:
            resp.raise_for_status()
            total = int(float(resp.headers.get('Content-Length', 0) or 0))
            if total > max_bytes:
                return
            written = 0
            with open(tmp, 'wb') as fp:
                for chunk in resp.iter_content(chunk_size=256 * 1024):
                    if not chunk:
                        continue
                    written += len(chunk)
                    if written > max_bytes:
                        return
                    fp.write(chunk)
        if written:
            os.replace(tmp, path)
            _prune_cache(max_bytes, keep=path)
    except Exception:
        pass
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
        with CACHE_LOCK:
            CACHE_JOBS.discard(key)


def _start_cache(entry, path, max_bytes):
    key = _cache_key(entry)
    with CACHE_LOCK:
        if key in CACHE_JOBS or os.path.isfile(path):
            return
        CACHE_JOBS.add(key)
    threading.Thread(
        target=_cache_audio, args=(entry, path, max_bytes), daemon=True,
    ).start()


class _NullProgress:
    '''A no-op stand-in for rich.Progress so we can call musicdl's `_search`
    without rendering anything to a terminal.'''
    def add_task(self, *a, **k): return 0
    def update(self, *a, **k): pass
    def advance(self, *a, **k): pass
    def __getattr__(self, _): return lambda *a, **k: None


def _track_payload(song_info, token):
    '''Serialize a SongInfo into the minimal JSON the frontend needs.'''
    def s(v):
        return '' if v is None else str(v)
    ext = s(song_info.ext).lower().lstrip('.')
    return {
        'token': token,
        'source': SUPPORTED_SOURCES.get(s(song_info.source), {}).get('short', s(song_info.source)),
        'source_label': SUPPORTED_SOURCES.get(s(song_info.source), {}).get('label', s(song_info.source)),
        'song_name': s(song_info.song_name) or '未知曲目',
        'singers': s(song_info.singers) or '未知艺人',
        'album': s(song_info.album),
        'ext': ext,
        'file_size': s(song_info.file_size),
        'duration': s(song_info.duration),
        'cover_url': s(song_info.cover_url),
        'has_lyric': bool(getattr(song_info, 'lyric', None)),
        'lossless': ext in {'flac', 'wav', 'ape', 'alac'},
    }


# ---------------------------------------------------------------------------
# streaming search: drive musicdl per result, emit each track as it resolves
# ---------------------------------------------------------------------------
def search_stream(keyword, sources):
    '''Generator yielding SSE messages. Every source runs concurrently; each
    resolved track is pushed the moment musicdl appends it to its result list.'''
    out = queue.Queue()
    seen_identifiers = set()
    seen_lock = threading.Lock()
    active = {'n': 0}

    def emit(event, data):
        out.put(f'event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n')

    def run_source(source):
        try:
            client = MANAGER.client(source)
            progress = _NullProgress()
            try:
                search_urls = client._constructsearchurls(keyword=keyword, rule={}, request_overrides={})
            except Exception as err:
                emit('source_error', {'source': source, 'message': str(err)})
                return
            buckets = [[] for _ in search_urls]
            threads = []
            for i, url in enumerate(search_urls):
                t = threading.Thread(
                    target=_safe_search,
                    args=(client, keyword, url, buckets[i], progress),
                    daemon=True,
                )
                t.start()
                threads.append(t)

            deadline = time.time() + PER_SOURCE_TIMEOUT
            cursors = [0] * len(buckets)
            count = 0
            while True:
                drained = _drain(buckets, cursors, source, seen_identifiers, seen_lock, emit)
                count += drained
                alive = any(t.is_alive() for t in threads)
                if not alive or time.time() > deadline:
                    break
                time.sleep(0.12)
            # final flush of anything that landed at the very end
            count += _drain(buckets, cursors, source, seen_identifiers, seen_lock, emit)
            timed_out = any(t.is_alive() for t in threads)
            emit('source_done', {'source': source, 'count': count, 'timed_out': timed_out})
        except Exception as err:
            emit('source_error', {'source': source, 'message': str(err)})
        finally:
            with seen_lock:
                active['n'] -= 1
                if active['n'] == 0:
                    out.put(None)  # sentinel: all sources finished

    valid = [s for s in SOURCE_ORDER if s in sources]
    if not valid:
        yield 'event: done\ndata: {"count": 0}\n\n'
        return

    active['n'] = len(valid)
    for source in valid:
        emit('source_start', {'source': source,
                              'label': SUPPORTED_SOURCES[source]['label']})
        threading.Thread(target=run_source, args=(source,), daemon=True).start()

    total = 0
    while True:
        msg = out.get()
        if msg is None:
            break
        if msg.startswith('event: result'):
            total += 1
        yield msg
    yield f'event: done\ndata: {{"count": {total}}}\n\n'


def _safe_search(client, keyword, url, bucket, progress):
    try:
        client._search(keyword=keyword, search_url=url, request_overrides={},
                        song_infos=bucket, progress=progress)
    except Exception:
        pass


def _drain(buckets, cursors, source, seen, lock, emit):
    '''Emit every newly-appeared track; dedup identifiers within each source.'''
    emitted = 0
    for i, bucket in enumerate(buckets):
        while cursors[i] < len(bucket):
            song_info = bucket[cursors[i]]
            cursors[i] += 1
            try:
                ident = str(getattr(song_info, 'identifier', None))
                dedup_key = (source, ident)
                with lock:
                    if dedup_key in seen:
                        continue
                    seen.add(dedup_key)
                token = REGISTRY.add(song_info, source)
                emit('result', _track_payload(song_info, token))
                emitted += 1
            except Exception:
                continue
    return emitted


# ---------------------------------------------------------------------------
# downloads: chunked, with live progress, using the musicdl-resolved URL
# ---------------------------------------------------------------------------
DOWNLOADS = {}
DL_LOCK = threading.Lock()


def _safe_name(name):
    name = re.sub(r'[\\/:*?"<>|]', '_', name or 'track').strip()
    return name[:120] or 'track'


def _parse_byte_range(value, total_size):
    '''Parse one HTTP byte range against a known resource size.'''
    if not value.startswith('bytes=') or ',' in value or total_size <= 0:
        return None
    try:
        start_text, end_text = value[6:].split('-', 1)
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else total_size - 1
            if start < 0 or start >= total_size or end < start:
                return None
            return start, min(end, total_size - 1)
        suffix_size = int(end_text)
        if suffix_size <= 0:
            return None
        return max(total_size - suffix_size, 0), total_size - 1
    except (TypeError, ValueError):
        return None


def run_download(download_id, token):
    entry = REGISTRY.get(token)
    if not entry:
        _set_dl(download_id, status='error', message='曲目已过期，请重新搜索')
        return
    song = entry['song_info']
    url = getattr(song, 'download_url', None)
    if not isinstance(url, str) or not url.startswith('http'):
        _set_dl(download_id, status='error', message='该曲目没有可用的下载地址')
        return

    source = entry['source']
    sub = os.path.join(DOWNLOAD_DIR, SUPPORTED_SOURCES.get(source, {}).get('short', source))
    os.makedirs(sub, exist_ok=True)
    ext = (str(song.ext) or 'mp3').lstrip('.')
    fname = f"{_safe_name(str(song.song_name))} - {_safe_name(str(song.singers))}.{ext}"
    path = os.path.join(sub, fname)

    try:
        with requests.get(url, headers=entry['headers'], cookies=entry['cookies'],
                          stream=True, timeout=(10, 30), verify=False) as resp:
            resp.raise_for_status()
            total = int(float(resp.headers.get('Content-Length', 0) or 0))
            if total <= 0:
                total = int(getattr(song, 'file_size_bytes', 0) or 0)
            _set_dl(download_id, status='downloading', total=total, downloaded=0,
                    name=fname, path=path)
            done = 0
            last = time.time()
            last_bytes = 0
            tmp = path + '.part'
            with open(tmp, 'wb') as fp:
                for chunk in resp.iter_content(chunk_size=256 * 1024):
                    if not chunk:
                        continue
                    fp.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last >= 0.25:
                        speed = (done - last_bytes) / (now - last)
                        _set_dl(download_id, downloaded=done, total=total, speed=speed)
                        last, last_bytes = now, done
            os.replace(tmp, path)
            _set_dl(download_id, status='done', downloaded=done,
                    total=total or done, speed=0, name=fname, path=path)
    except Exception as err:
        _set_dl(download_id, status='error', message=str(err))


def _set_dl(download_id, **fields):
    with DL_LOCK:
        rec = DOWNLOADS.setdefault(download_id, {})
        rec.update(fields)
        rec['updated'] = time.time()


def _get_dl(download_id):
    with DL_LOCK:
        return dict(DOWNLOADS.get(download_id, {}))


# ---------------------------------------------------------------------------
# Flask app + routes
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder=None)
requests.packages.urllib3.disable_warnings()


@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')


@app.route('/static/<path:fname>')
def static_files(fname):
    return send_from_directory(STATIC_DIR, fname)


@app.route('/api/sources')
def api_sources():
    return jsonify([
        {'id': sid, 'label': SUPPORTED_SOURCES[sid]['label'],
         'short': SUPPORTED_SOURCES[sid]['short'], 'default': SUPPORTED_SOURCES[sid]['default']}
        for sid in SOURCE_ORDER
    ])


@app.route('/api/search')
def api_search():
    keyword = (request.args.get('q') or '').strip()
    raw_sources = (request.args.get('sources') or '').strip()
    sources = [s for s in raw_sources.split(',') if s in SUPPORTED_SOURCES]
    if not sources:
        sources = [s for s in SOURCE_ORDER if SUPPORTED_SOURCES[s]['default']]
    if not keyword:
        return jsonify({'error': '请输入搜索关键词'}), 400

    @stream_with_context
    def generate():
        yield 'retry: 10000\n\n'
        for msg in search_stream(keyword, sources):
            yield msg

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/stream/<token>')
def api_stream(token):
    '''Proxy the upstream audio with Range support so <audio> can seek.'''
    entry = REGISTRY.get(token)
    if not entry:
        return 'expired', 404
    song = entry['song_info']
    url = getattr(song, 'download_url', None)
    if not isinstance(url, str) or not url.startswith('http'):
        return 'no audio url', 404

    ext = (str(song.ext) or 'mp3').lstrip('.').lower()
    if request.args.get('cache') == '1':
        try:
            max_bytes = _cache_limit()
            path = _cache_path(entry)
            _prune_cache(max_bytes)
            if os.path.isfile(path):
                os.utime(path)
                return send_file(
                    path, conditional=True,
                    mimetype=RESULT_EXT_TO_MIME.get(ext, 'application/octet-stream'),
                )
            _start_cache(entry, path, max_bytes)
        except OSError:
            pass

    upstream_headers = dict(entry['headers'])
    range_header = request.headers.get('Range')
    if range_header:
        upstream_headers['Range'] = range_header

    try:
        up = requests.get(url, headers=upstream_headers, cookies=entry['cookies'],
                          stream=True, timeout=(10, 30), verify=False)
    except Exception as err:
        return f'upstream error: {err}', 502

    resp_headers = {
        'Content-Type': RESULT_EXT_TO_MIME.get(ext, 'application/octet-stream'),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
    }
    for h in ('Content-Length', 'Content-Range'):
        if h in up.headers:
            resp_headers[h] = up.headers[h]

    response_status = up.status_code
    range_window = None
    downloaded_contents = None
    if range_header and up.status_code == 200:
        cached_contents = getattr(song, 'downloaded_contents', None)
        if isinstance(cached_contents, (bytes, bytearray, memoryview)):
            downloaded_contents = cached_contents
            total_size = len(downloaded_contents)
        else:
            total_size = 0
        range_window = _parse_byte_range(range_header, total_size)
        if range_window:
            start, end = range_window
            response_status = 206
            resp_headers['Content-Length'] = str(end - start + 1)
            resp_headers['Content-Range'] = f'bytes {start}-{end}/{total_size}'

    def generate():
        try:
            if range_window and downloaded_contents is not None:
                start, end = range_window
                for offset in range(start, end + 1, 64 * 1024):
                    yield bytes(downloaded_contents[offset:min(offset + 64 * 1024, end + 1)])
                return
            for chunk in up.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            up.close()

    return Response(stream_with_context(generate()), status=response_status,
                    headers=resp_headers)


@app.route('/api/cover/<token>')
def api_cover(token):
    '''Proxy cover art (some hosts block hotlinking / need referer).'''
    entry = REGISTRY.get(token)
    if not entry:
        return '', 404
    url = getattr(entry['song_info'], 'cover_url', None)
    if not isinstance(url, str) or not url.startswith('http'):
        return '', 404
    try:
        up = requests.get(url, headers={'User-Agent': entry['headers'].get('User-Agent', 'Mozilla/5.0')},
                          timeout=(10, 20), verify=False)
        return Response(up.content, status=up.status_code,
                        headers={'Content-Type': up.headers.get('Content-Type', 'image/jpeg'),
                                 'Cache-Control': 'public, max-age=86400'})
    except Exception:
        return '', 502


@app.route('/api/lyric/<token>')
def api_lyric(token):
    entry = REGISTRY.get(token)
    if not entry:
        return jsonify({'lyric': ''})
    return jsonify({'lyric': getattr(entry['song_info'], 'lyric', '') or ''})


@app.route('/api/download', methods=['POST'])
def api_download():
    data = request.get_json(force=True, silent=True) or {}
    token = data.get('token')
    entry = REGISTRY.get(token)
    if not entry:
        return jsonify({'error': '曲目已过期，请重新搜索'}), 404
    download_id = uuid.uuid4().hex[:16]
    _set_dl(download_id, status='starting', downloaded=0, total=0,
            name=str(entry['song_info'].song_name))
    threading.Thread(target=run_download, args=(download_id, token), daemon=True).start()
    return jsonify({'download_id': download_id})


@app.route('/api/download/<download_id>/progress')
def api_download_progress(download_id):
    @stream_with_context
    def generate():
        yield 'retry: 10000\n\n'
        while True:
            rec = _get_dl(download_id)
            if not rec:
                yield 'event: error\ndata: {"message":"unknown download"}\n\n'
                return
            yield f'event: progress\ndata: {json.dumps(rec, ensure_ascii=False)}\n\n'
            if rec.get('status') in ('done', 'error'):
                return
            time.sleep(0.3)

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/file/<download_id>')
def api_file(download_id):
    rec = _get_dl(download_id)
    if not rec or rec.get('status') != 'done' or not rec.get('path'):
        return 'not ready', 404
    path = rec['path']
    return send_from_directory(os.path.dirname(path), os.path.basename(path), as_attachment=True)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f'\n  🎵  Music player running at  http://127.0.0.1:{port}\n')
    app.run(host='127.0.0.1', port=port, threaded=True, debug=False)
