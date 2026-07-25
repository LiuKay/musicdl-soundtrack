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
import shutil
import threading
import requests
from collections import deque
from copy import copy
from pathlib import Path
from flask import (
    Flask, request, Response, jsonify, send_file, send_from_directory,
    stream_with_context, url_for,
)

from musicdl import musicdl
from musicdl.modules import SongInfoUtils


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
COVER_MIME_SUFFIXES = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/avif': '.avif',
}
COVER_MIME_TYPES = set(COVER_MIME_SUFFIXES)


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
DOWNLOAD_CANCELLED = set()
DL_LOCK = threading.Lock()
DOWNLOAD_CONCURRENCY = 3
DOWNLOAD_ACTIVE = 0
DOWNLOAD_PENDING = deque()
DOWNLOAD_QUEUE_LOCK = threading.Lock()


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


def _save_download_metadata(path, entry):
    song = entry['song_info']
    metadata = {
        'song_name': str(getattr(song, 'song_name', '') or ''),
        'singers': str(getattr(song, 'singers', '') or ''),
        'album': str(getattr(song, 'album', '') or ''),
        'duration': str(getattr(song, 'duration', '') or ''),
    }
    for suffix in ('', *COVER_MIME_SUFFIXES.values()):
        try:
            os.remove(path + '.soundtrack.cover' + suffix)
        except OSError:
            pass
    cover_url = getattr(song, 'cover_url', None)
    if isinstance(cover_url, str) and cover_url.startswith('http'):
        try:
            with requests.get(
                    cover_url,
                    headers={'User-Agent': entry['headers'].get('User-Agent', 'Mozilla/5.0')},
                    timeout=(10, 20),
                    verify=False) as response:
                response.raise_for_status()
                cover_mime = response.headers.get('Content-Type', '').split(';', 1)[0].lower()
                if cover_mime in COVER_MIME_TYPES:
                    cover_path = path + '.soundtrack.cover' + COVER_MIME_SUFFIXES[cover_mime]
                    cover_tmp = cover_path + '.part'
                    size = 0
                    with open(cover_tmp, 'wb') as fp:
                        for chunk in response.iter_content(chunk_size=64 * 1024):
                            size += len(chunk)
                            if size > 5 * 1024 * 1024:
                                break
                            fp.write(chunk)
                    if size <= 5 * 1024 * 1024:
                        os.replace(cover_tmp, cover_path)
                        metadata['cover_mime'] = cover_mime
                    else:
                        os.remove(cover_tmp)
        except (OSError, requests.RequestException):
            pass
    metadata_tmp = path + '.soundtrack.json.part'
    try:
        with open(metadata_tmp, 'w', encoding='utf-8') as fp:
            json.dump(metadata, fp, ensure_ascii=False)
        os.replace(metadata_tmp, path + '.soundtrack.json')
    except OSError:
        try:
            os.remove(metadata_tmp)
        except OSError:
            pass
    try:
        SongInfoUtils.savelrctofile(
            Path(path), str(getattr(song, 'lyric', '') or ''), overwrite=True,
        )
    except Exception:
        pass
    try:
        tag_song = copy(song)
        tag_song.save_path = path
        tag_song.cover_url = _existing_download_cover(path, metadata) or ''
        SongInfoUtils.savelyricsthenwritetagstoaudio(
            tag_song, overwrite=True, timeout=10,
        )
    except Exception:
        pass


def _existing_sidecar(path, suffix):
    root = os.path.realpath(DOWNLOAD_DIR)
    sidecar = os.path.realpath(path + suffix)
    try:
        if os.path.commonpath((root, sidecar)) == root and os.path.isfile(sidecar):
            return sidecar
    except ValueError:
        pass
    return None


def _existing_download_cover(path, metadata):
    suffix = COVER_MIME_SUFFIXES.get(metadata.get('cover_mime'))
    if suffix:
        cover = _existing_sidecar(path, '.soundtrack.cover' + suffix)
        if cover:
            return cover
    return _existing_sidecar(path, '.soundtrack.cover')


def _read_download_metadata(path):
    metadata_path = _existing_sidecar(path, '.soundtrack.json')
    if not metadata_path:
        return {}
    try:
        with open(metadata_path, encoding='utf-8') as fp:
            metadata = json.load(fp)
        if not isinstance(metadata, dict):
            return {}
        return {key: value for key, value in metadata.items() if isinstance(value, str)}
    except (OSError, ValueError):
        return {}


def _read_download_lyric(path):
    root = os.path.realpath(DOWNLOAD_DIR)
    lyric_path = os.path.realpath(str(Path(path).with_suffix('.lrc')))
    try:
        if os.path.commonpath((root, lyric_path)) != root or not os.path.isfile(lyric_path):
            return ''
        with open(lyric_path, encoding='utf-8') as fp:
            lyric = fp.read(2 * 1024 * 1024 + 1)
        return lyric if len(lyric) <= 2 * 1024 * 1024 else ''
    except (OSError, UnicodeError, ValueError):
        return ''


def run_download(download_id, token):
    entry = REGISTRY.get(token)
    if not entry:
        _set_dl(download_id, status='error', message='曲目已过期，请重新搜索')
        return
    song = entry['song_info']
    source = entry['source']
    sub = os.path.join(DOWNLOAD_DIR, SUPPORTED_SOURCES.get(source, {}).get('short', source))
    os.makedirs(sub, exist_ok=True)
    ext = (str(song.ext) or 'mp3').lstrip('.')
    fname = f"{_safe_name(str(song.song_name))} - {_safe_name(str(song.singers))}.{ext}"
    path = os.path.join(sub, fname)
    tmp = path + f'.{download_id}.part'
    _set_dl(download_id, name=fname, path=path, tmp_path=tmp)
    _check_download_cancelled(download_id)

    cached_total = None
    try:
        cached = _cache_path(entry)
        with CACHE_LOCK:
            if os.path.isfile(cached):
                cached_total = os.path.getsize(cached)
                _set_dl(download_id, status='downloading', total=cached_total, downloaded=0,
                        name=fname, path=path)
                shutil.copy2(cached, tmp)
                _check_download_cancelled(download_id)
                os.utime(cached)
                os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
    if cached_total is not None:
        _save_download_metadata(path, entry)
        _set_dl(download_id, status='done', downloaded=cached_total,
                total=cached_total, speed=0, name=fname, path=path)
        return

    _check_download_cancelled(download_id)
    url = getattr(song, 'download_url', None)
    if not isinstance(url, str) or not url.startswith('http'):
        _set_dl(download_id, status='error', message='该曲目没有可用的下载地址')
        return
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
            with open(tmp, 'wb') as fp:
                for chunk in resp.iter_content(chunk_size=256 * 1024):
                    _check_download_cancelled(download_id)
                    if not chunk:
                        continue
                    fp.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last >= 0.25:
                        speed = (done - last_bytes) / (now - last)
                        _set_dl(download_id, downloaded=done, total=total, speed=speed)
                        last, last_bytes = now, done
            _check_download_cancelled(download_id)
            os.replace(tmp, path)
            _save_download_metadata(path, entry)
            _check_download_cancelled(download_id)
            _set_dl(download_id, status='done', downloaded=done,
                    total=total or done, speed=0, name=fname, path=path)
    except InterruptedError:
        pass
    except Exception as err:
        _set_dl(download_id, status='error', message=str(err))


def _set_dl(download_id, **fields):
    with DL_LOCK:
        rec = DOWNLOADS.setdefault(download_id, {})
        if download_id in DOWNLOAD_CANCELLED:
            for key in ('path', 'tmp_path'):
                if fields.get(key):
                    rec[key] = fields[key]
            return
        rec.update(fields)
        rec['updated'] = time.time()


def _get_dl(download_id):
    with DL_LOCK:
        return dict(DOWNLOADS.get(download_id, {}))


def _check_download_cancelled(download_id):
    with DL_LOCK:
        if download_id in DOWNLOAD_CANCELLED:
            raise InterruptedError


def _delete_download_files(path, tmp_path=None, include_audio=True):
    if not path:
        return
    root = os.path.realpath(DOWNLOAD_DIR)
    path = os.path.realpath(path)
    try:
        if os.path.commonpath((root, path)) != root:
            return
    except ValueError:
        return
    files = [tmp_path or path + '.part']
    if include_audio:
        files.extend([
            path, path + '.part', path + '.soundtrack.json',
            path + '.soundtrack.json.part', str(Path(path).with_suffix('.lrc')),
        ])
        for suffix in ('', *COVER_MIME_SUFFIXES.values()):
            files.extend((path + '.soundtrack.cover' + suffix,
                          path + '.soundtrack.cover' + suffix + '.part'))
    for filename in files:
        try:
            os.remove(filename)
        except OSError:
            pass


def _cancel_download(download_id):
    with DL_LOCK:
        rec = DOWNLOADS.get(download_id)
        if not rec:
            return False
        status = rec.get('status')
        DOWNLOAD_CANCELLED.add(download_id)
        rec['status'] = 'cancelled'
        rec['updated'] = time.time()
        path = rec.get('path')
        tmp_path = rec.get('tmp_path')
    with DOWNLOAD_QUEUE_LOCK:
        pending = len(DOWNLOAD_PENDING)
        remaining = [job for job in DOWNLOAD_PENDING if job[0] != download_id]
        DOWNLOAD_PENDING.clear()
        DOWNLOAD_PENDING.extend(remaining)
        removed = len(DOWNLOAD_PENDING) != pending
    if removed or status in ('done', 'error'):
        _delete_download_files(path, tmp_path, include_audio=False)
        with DL_LOCK:
            DOWNLOADS.pop(download_id, None)
            DOWNLOAD_CANCELLED.discard(download_id)
    return True


def _run_download_job(download_id, token):
    global DOWNLOAD_ACTIVE
    try:
        run_download(download_id, token)
    finally:
        with DL_LOCK:
            cancelled = download_id in DOWNLOAD_CANCELLED
            rec = DOWNLOADS.get(download_id, {})
            path, tmp_path = rec.get('path'), rec.get('tmp_path')
        if cancelled:
            _delete_download_files(path, tmp_path, include_audio=False)
            with DL_LOCK:
                DOWNLOADS.pop(download_id, None)
                DOWNLOAD_CANCELLED.discard(download_id)
        with DOWNLOAD_QUEUE_LOCK:
            DOWNLOAD_ACTIVE -= 1
        _drain_download_queue()


def _drain_download_queue():
    global DOWNLOAD_ACTIVE
    while True:
        with DOWNLOAD_QUEUE_LOCK:
            if DOWNLOAD_ACTIVE >= DOWNLOAD_CONCURRENCY or not DOWNLOAD_PENDING:
                return
            download_id, token = DOWNLOAD_PENDING.popleft()
            DOWNLOAD_ACTIVE += 1
        thread = threading.Thread(
            target=_run_download_job,
            args=(download_id, token),
            daemon=True,
        )
        try:
            thread.start()
        except RuntimeError as err:
            with DOWNLOAD_QUEUE_LOCK:
                DOWNLOAD_ACTIVE -= 1
            _set_dl(download_id, status='error', message=str(err))


def _enqueue_download(download_id, token):
    # ponytail: one in-memory FIFO; persist it only if resumable downloads are added.
    _set_dl(download_id, status='queued', downloaded=0, total=0)
    with DOWNLOAD_QUEUE_LOCK:
        DOWNLOAD_PENDING.append((download_id, token))
    _drain_download_queue()


def _set_download_concurrency(value):
    global DOWNLOAD_CONCURRENCY
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError
    if not 1 <= value <= 5:
        raise ValueError
    with DOWNLOAD_QUEUE_LOCK:
        DOWNLOAD_CONCURRENCY = value
    _drain_download_queue()
    return value


def _library_tracks():
    root = os.path.abspath(DOWNLOAD_DIR)
    tracks = []
    if not os.path.isdir(root):
        return tracks
    # ponytail: scan on drawer open; add an index only if large libraries make this slow.
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = [name for name in subdirs if not name.startswith('.')]
        for name in files:
            ext = os.path.splitext(name)[1].lower().lstrip('.')
            if name.startswith('.') or ext not in RESULT_EXT_TO_MIME:
                continue
            path = os.path.join(directory, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            relative = os.path.relpath(path, root).replace(os.sep, '/')
            stem = os.path.splitext(name)[0]
            song_name, separator, singers = stem.rpartition(' - ')
            if not separator:
                song_name, singers = stem, ''
            source = relative.split('/', 1)[0] if '/' in relative else ''
            metadata = _read_download_metadata(path)
            tracks.append({
                'token': 'local-' + hashlib.sha256(relative.encode()).hexdigest()[:16],
                'song_name': metadata.get('song_name') or song_name,
                'singers': metadata.get('singers') or singers,
                'album': metadata.get('album', ''),
                'duration': metadata.get('duration', ''),
                'lyric': _read_download_lyric(path) or metadata.get('lyric', ''),
                'source': source,
                'ext': ext,
                'file_size_bytes': stat.st_size,
                'modified': stat.st_mtime,
                'relative': relative,
                'has_cover': bool(_existing_download_cover(path, metadata)),
                'local': True,
            })
    return sorted(tracks, key=lambda track: track['modified'], reverse=True)


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
    _set_dl(download_id, name=str(entry['song_info'].song_name))
    _enqueue_download(download_id, token)
    return jsonify({'download_id': download_id})


@app.route('/api/download/concurrency', methods=['GET', 'POST'])
def api_download_concurrency():
    if request.method == 'GET':
        return jsonify({'concurrency': DOWNLOAD_CONCURRENCY})
    data = request.get_json(force=True, silent=True) or {}
    try:
        concurrency = _set_download_concurrency(data.get('concurrency'))
    except (TypeError, ValueError):
        return jsonify({'error': '同时下载数必须是 1–5'}), 400
    return jsonify({'concurrency': concurrency})


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
            if rec.get('status') in ('done', 'error', 'cancelled'):
                return
            time.sleep(0.3)

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/download/<download_id>', methods=['DELETE'])
def api_delete_download(download_id):
    if not _cancel_download(download_id):
        return jsonify({'error': '下载任务不存在'}), 404
    return '', 204


@app.route('/api/file/<download_id>')
def api_file(download_id):
    rec = _get_dl(download_id)
    if not rec or rec.get('status') != 'done' or not rec.get('path'):
        return 'not ready', 404
    path = rec['path']
    return send_from_directory(os.path.dirname(path), os.path.basename(path), as_attachment=True)


@app.route('/api/library')
def api_library():
    tracks = _library_tracks()
    for track in tracks:
        relative = track.pop('relative')
        track['stream_url'] = url_for('api_library_file', relative=relative)
        track['delete_url'] = url_for('api_delete_library_file', relative=relative)
        track['cover_url'] = (
            url_for('api_library_cover', relative=relative)
            if track.pop('has_cover') else ''
        )
    directory = os.path.abspath(DOWNLOAD_DIR)
    home = os.path.expanduser('~')
    if directory == home or directory.startswith(home + os.sep):
        directory = '~' + directory[len(home):]
    return jsonify({
        'directory': directory,
        'tracks': tracks,
    })


@app.route('/api/library/delete/<path:relative>', methods=['DELETE'])
def api_delete_library_file(relative):
    ext = os.path.splitext(relative)[1].lower().lstrip('.')
    if ext not in RESULT_EXT_TO_MIME:
        return '', 404
    root = os.path.realpath(DOWNLOAD_DIR)
    path = os.path.realpath(os.path.join(root, relative))
    try:
        if os.path.commonpath((root, path)) != root or not os.path.isfile(path):
            return '', 404
    except ValueError:
        return '', 404
    _delete_download_files(path)
    return '', 204


@app.route('/api/library/file/<path:relative>')
def api_library_file(relative):
    ext = os.path.splitext(relative)[1].lower().lstrip('.')
    if ext not in RESULT_EXT_TO_MIME:
        return '', 404
    root = os.path.realpath(DOWNLOAD_DIR)
    path = os.path.realpath(os.path.join(root, relative))
    try:
        if os.path.commonpath((root, path)) != root or not os.path.isfile(path):
            return '', 404
    except ValueError:
        return '', 404
    return send_file(
        path, conditional=True,
        mimetype=RESULT_EXT_TO_MIME.get(ext, 'application/octet-stream'),
    )


@app.route('/api/library/cover/<path:relative>')
def api_library_cover(relative):
    ext = os.path.splitext(relative)[1].lower().lstrip('.')
    if ext not in RESULT_EXT_TO_MIME:
        return '', 404
    root = os.path.realpath(DOWNLOAD_DIR)
    audio_path = os.path.realpath(os.path.join(root, relative))
    metadata = _read_download_metadata(audio_path)
    cover_path = _existing_download_cover(audio_path, metadata)
    try:
        if os.path.commonpath((root, audio_path)) != root or not cover_path:
            return '', 404
    except ValueError:
        return '', 404
    cover_mime = metadata.get('cover_mime', 'image/jpeg')
    if cover_mime not in COVER_MIME_TYPES:
        cover_mime = 'image/jpeg'
    response = send_file(
        cover_path,
        mimetype=cover_mime,
    )
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f'\n  🎵  Music player running at  http://127.0.0.1:{port}\n')
    app.run(host='127.0.0.1', port=port, threaded=True, debug=False)
