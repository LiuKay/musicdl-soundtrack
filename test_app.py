import unittest
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import fake_useragent
import app


class SearchCompatibilityTest(unittest.TestCase):
    SOURCE_ORDER = [
        'MiguMusicClient',
        'NeteaseMusicClient',
        'KuwoMusicClient',
        'QQMusicClient',
        'KugouMusicClient',
        'FiveSingMusicClient',
        'JamendoMusicClient',
        'SpotifyMusicClient',
    ]

    def test_safe_search_uses_current_musicdl_signature(self):
        class Client:
            def _search(self, keyword, search_url, request_overrides, song_infos, progress):
                song_infos.append('result')

        bucket = []
        app._safe_search(Client(), 'query', 'url', bucket, app._NullProgress())
        self.assertEqual(bucket, ['result'])

    def test_bundle_contains_user_agent_data(self):
        installed_data = Path(fake_useragent.__file__).parent / 'data' / 'browsers.jsonl'
        self.assertTrue(installed_data.is_file())

        resources = Path('dist/Soundtrack.app/Contents/Resources')
        if resources.exists():
            data_files = list(resources.glob('lib/python*/fake_useragent/data/browsers.jsonl'))
            self.assertTrue(data_files)

    def test_sources_api_lists_supported_sources_in_order(self):
        response = app.app.test_client().get('/api/sources')

        self.assertEqual(response.status_code, 200)
        sources = response.get_json()
        self.assertEqual([source['id'] for source in sources], self.SOURCE_ORDER)
        self.assertEqual(list(app.SUPPORTED_SOURCES), self.SOURCE_ORDER)
        self.assertEqual(app.SOURCE_ORDER, self.SOURCE_ORDER)

    def test_migu_is_the_only_default_source(self):
        sources = app.app.test_client().get('/api/sources').get_json()

        defaults = [source['id'] for source in sources if source['default']]
        self.assertEqual(defaults, ['MiguMusicClient'])

    def test_deduplication_keeps_shared_ids_from_different_sources(self):
        seen = set()
        lock = app.threading.Lock()
        emitted = []
        first_source = [SimpleNamespace(identifier='shared-id') for _ in range(2)]
        second_source = [SimpleNamespace(identifier='shared-id')]

        with mock.patch.object(app.REGISTRY, 'add', side_effect=['first', 'second']), \
                mock.patch.object(app, '_track_payload', side_effect=lambda song, token: {'token': token}):
            first_count = app._drain(
                [first_source], [0], 'MiguMusicClient', seen, lock,
                lambda event, data: emitted.append((event, data)),
            )
            second_count = app._drain(
                [second_source], [0], 'SpotifyMusicClient', seen, lock,
                lambda event, data: emitted.append((event, data)),
            )

        self.assertEqual((first_count, second_count), (1, 1))
        self.assertEqual(
            seen,
            {('MiguMusicClient', 'shared-id'), ('SpotifyMusicClient', 'shared-id')},
        )
        self.assertEqual(emitted, [('result', {'token': 'first'}), ('result', {'token': 'second'})])

    def test_stream_emulates_range_when_upstream_ignores_it(self):
        class UpstreamResponse:
            status_code = 200
            headers = {}

            def iter_content(self, chunk_size):
                yield b'0123456789'

            def close(self):
                pass

        token = 'range-fallback-test'
        app.REGISTRY._tracks[token] = {
            'song_info': SimpleNamespace(
                download_url='https://example.test/audio.mp3',
                ext='mp3',
                file_size_bytes=43,
                downloaded_contents=b'0123456789',
            ),
            'source': 'SpotifyMusicClient',
            'headers': {},
            'cookies': {},
        }
        try:
            with mock.patch.object(app.requests, 'get', return_value=UpstreamResponse()) as get:
                response = app.app.test_client().get(
                    f'/api/stream/{token}',
                    headers={'Range': 'bytes=3-6'},
                )
        finally:
            app.REGISTRY._tracks.pop(token, None)

        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.headers['Content-Range'], 'bytes 3-6/10')
        self.assertEqual(response.headers['Content-Length'], '4')
        self.assertEqual(response.data, b'3456')
        self.assertEqual(get.call_args.kwargs['headers']['Range'], 'bytes=3-6')

    def test_byte_range_parser_accepts_only_valid_single_ranges(self):
        self.assertEqual(app._parse_byte_range('bytes=3-6', 10), (3, 6))
        self.assertEqual(app._parse_byte_range('bytes=7-', 10), (7, 9))
        self.assertEqual(app._parse_byte_range('bytes=-3', 10), (7, 9))
        self.assertIsNone(app._parse_byte_range('bytes=3-6,8-9', 10))
        self.assertIsNone(app._parse_byte_range('bytes=10-', 10))
        self.assertIsNone(app._parse_byte_range('items=3-6', 10))

    def test_stream_uses_cached_audio_and_prunes_oldest_file(self):
        token = 'audio-cache-test'
        entry = {
            'song_info': SimpleNamespace(
                download_url='https://example.test/audio.mp3',
                song_name='Cached',
                singers='Artist',
                album='Album',
                ext='mp3',
                file_size='10 B',
                file_size_bytes=10,
            ),
            'source': 'MiguMusicClient',
            'headers': {},
            'cookies': {},
        }
        app.REGISTRY._tracks[token] = entry
        try:
            with tempfile.TemporaryDirectory() as cache_dir, \
                    mock.patch.object(app, 'CACHE_DIR', cache_dir), \
                    mock.patch.object(app.requests, 'get') as get:
                cached = app._cache_path(entry)
                Path(cached).write_bytes(b'0123456789')
                response = app.app.test_client().get(
                    f'/api/stream/{token}?cache=1&cache_max_mb=128',
                    headers={'Range': 'bytes=3-6'},
                )
                body = response.data
                response.close()
                old = Path(cache_dir) / 'old.mp3'
                old.write_bytes(b'old')
                os.utime(old, (1, 1))
                app._prune_cache(10, keep=cached)
                self.assertFalse(old.exists())
        finally:
            app.REGISTRY._tracks.pop(token, None)

        self.assertEqual(response.status_code, 206)
        self.assertEqual(body, b'3456')
        get.assert_not_called()

    def test_cache_audio_writes_complete_file(self):
        entry = {
            'song_info': SimpleNamespace(
                download_url='https://example.test/audio.mp3',
                song_name='Fresh', singers='Artist', album='Album',
                ext='mp3', file_size='6 B', file_size_bytes=6,
            ),
            'source': 'MiguMusicClient',
            'headers': {},
            'cookies': {},
        }
        upstream = mock.MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.headers = {'Content-Length': '6'}
        upstream.iter_content.return_value = [b'abc', b'def']
        with tempfile.TemporaryDirectory() as cache_dir, \
                mock.patch.object(app, 'CACHE_DIR', cache_dir), \
                mock.patch.object(app.requests, 'get', return_value=upstream):
            path = app._cache_path(entry)
            app._cache_audio(entry, path, 1024)
            self.assertEqual(Path(path).read_bytes(), b'abcdef')
        upstream.raise_for_status.assert_called_once()

    def test_download_copies_complete_cache_without_network(self):
        token = 'cached-download-test'
        entry = {
            'song_info': SimpleNamespace(
                download_url='https://example.test/audio.mp3',
                song_name='Cached', singers='Artist', album='Album',
                ext='mp3', file_size='6 B', file_size_bytes=6,
                duration='3:00', lyric='[00:01.00]Hello', cover_url='',
            ),
            'source': 'MiguMusicClient',
            'headers': {},
            'cookies': {},
        }
        app.REGISTRY._tracks[token] = entry
        try:
            with tempfile.TemporaryDirectory() as root, \
                    mock.patch.object(app, 'CACHE_DIR', os.path.join(root, 'cache')), \
                    mock.patch.object(app, 'DOWNLOAD_DIR', os.path.join(root, 'downloads')), \
                    mock.patch.object(app.requests, 'get') as get:
                os.makedirs(app.CACHE_DIR)
                Path(app._cache_path(entry)).write_bytes(b'abcdef')
                app.run_download('cached-download', token)
                record = app._get_dl('cached-download')
                self.assertEqual(Path(record['path']).read_bytes(), b'abcdef')
                metadata = json.loads(Path(record['path'] + '.soundtrack.json').read_text())
                self.assertNotIn('lyric', metadata)
                self.assertEqual(
                    Path(record['path']).with_suffix('.lrc').read_text().strip(),
                    '[00:01.00]Hello',
                )
                get.assert_not_called()
        finally:
            app.REGISTRY._tracks.pop(token, None)
            app.DOWNLOADS.pop('cached-download', None)

        self.assertEqual(record['status'], 'done')
        self.assertEqual(record['downloaded'], 6)

    def test_download_queue_respects_live_concurrency_limit(self):
        started = []

        class Thread:
            def __init__(self, target, args, daemon):
                self.target, self.args = target, args

            def start(self):
                started.append(self)

        old_limit = app.DOWNLOAD_CONCURRENCY
        try:
            app.DOWNLOAD_CONCURRENCY = 1
            app.DOWNLOAD_ACTIVE = 0
            app.DOWNLOAD_PENDING.clear()
            with mock.patch.object(app.threading, 'Thread', Thread), \
                    mock.patch.object(app, 'run_download'):
                app._enqueue_download('first', 'token-1')
                app._enqueue_download('second', 'token-2')
                self.assertEqual([thread.args[0] for thread in started], ['first'])
                self.assertEqual(app._get_dl('second')['status'], 'queued')

                response = app.app.test_client().post(
                    '/api/download/concurrency', json={'concurrency': 2},
                )
                self.assertEqual(response.get_json(), {'concurrency': 2})
                self.assertEqual(
                    [thread.args[0] for thread in started],
                    ['first', 'second'],
                )
                app._set_download_concurrency(1)
                app._enqueue_download('third', 'token-3')
                started[0].target(*started[0].args)
                self.assertEqual(len(started), 2)
                started[1].target(*started[1].args)
                self.assertEqual(
                    [thread.args[0] for thread in started],
                    ['first', 'second', 'third'],
                )
                invalid = app.app.test_client().post(
                    '/api/download/concurrency', json={'concurrency': 1.5},
                )
                self.assertEqual(invalid.status_code, 400)
        finally:
            app.DOWNLOAD_CONCURRENCY = old_limit
            app.DOWNLOAD_ACTIVE = 0
            app.DOWNLOAD_PENDING.clear()
            app.DOWNLOADS.pop('first', None)
            app.DOWNLOADS.pop('second', None)
            app.DOWNLOADS.pop('third', None)

    def test_download_metadata_saves_raster_cover(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.headers = {'Content-Type': 'image/jpeg'}
        response.iter_content.return_value = [b'cover']
        song = SimpleNamespace(
            song_name='Song', singers='Singer', album='Album', duration='3:00',
            lyric='[00:01.00]Hello', cover_url='https://example.test/cover.jpg',
        )
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(app, 'DOWNLOAD_DIR', root), \
                mock.patch.object(app.requests, 'get', return_value=response), \
                mock.patch.object(
                    app.SongInfoUtils, 'savelyricsthenwritetagstoaudio',
                ) as write_tags:
            audio = os.path.join(root, 'song.mp3')
            Path(audio).write_bytes(b'audio')
            app._save_download_metadata(audio, {
                'song_info': song, 'headers': {}, 'cookies': {},
            })

            cover_path = Path(audio + '.soundtrack.cover.jpg')
            self.assertEqual(cover_path.read_bytes(), b'cover')
            tag_song = write_tags.call_args.args[0]
            self.assertEqual(tag_song.save_path, audio)
            self.assertEqual(Path(tag_song.cover_url), cover_path.resolve())
            self.assertTrue(cover_path.exists())
            response.iter_content.return_value = [b'x' * (5 * 1024 * 1024 + 1)]
            app._save_download_metadata(audio, {
                'song_info': song, 'headers': {}, 'cookies': {},
            })
            self.assertFalse(cover_path.exists())

    def test_library_lists_and_range_streams_only_local_audio(self):
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(app, 'DOWNLOAD_DIR', root):
            source = Path(root) / 'Migu'
            source.mkdir()
            audio = source / 'Song - Singer.mp3'
            audio.write_bytes(b'0123456789')
            Path(str(audio) + '.soundtrack.json').write_text(json.dumps({
                'song_name': 'Metadata Song',
                'singers': 'Metadata Singer',
                'album': 'Metadata Album',
                'duration': '3:00',
                'cover_mime': 'image/jpeg',
            }))
            Path(str(audio) + '.soundtrack.cover').write_bytes(b'cover')
            audio.with_suffix('.lrc').write_text('[00:01.00]Hello')
            (source / 'partial.mp3.part').write_bytes(b'partial')
            (source / 'notes.txt').write_text('not audio')

            client = app.app.test_client()
            library = client.get('/api/library').get_json()
            self.assertEqual(len(library['tracks']), 1)
            self.assertEqual(
                (library['tracks'][0]['song_name'], library['tracks'][0]['singers']),
                ('Metadata Song', 'Metadata Singer'),
            )
            self.assertEqual(library['tracks'][0]['lyric'], '[00:01.00]Hello')
            cover = client.get(library['tracks'][0]['cover_url'])
            cover_body = cover.data
            cover_nosniff = cover.headers['X-Content-Type-Options']
            cover.close()
            response = client.get(
                library['tracks'][0]['stream_url'],
                headers={'Range': 'bytes=3-6'},
            )
            body = response.data
            response.close()

            with app.app.test_request_context():
                escaped = app.api_library_file('../outside.mp3')

        self.assertEqual(response.status_code, 206)
        self.assertEqual(body, b'3456')
        self.assertEqual(cover_body, b'cover')
        self.assertEqual(cover_nosniff, 'nosniff')
        self.assertEqual(escaped[1], 404)

    def test_player_uses_web_audio_gain_for_volume(self):
        script = Path('static/app.js').read_text()

        self.assertIn('audioCtx.createGain()', script)
        self.assertNotIn('audio.volume = ratio', script)

    def test_lyric_endpoint_preserves_registered_song_lyric(self):
        token = 'lyric-compatibility-test'
        app.REGISTRY._tracks[token] = {
            'song_info': SimpleNamespace(lyric='[00:01.00]Hello'),
            'source': 'KugouMusicClient',
            'headers': {},
            'cookies': {},
        }
        try:
            response = app.app.test_client().get(f'/api/lyric/{token}')
        finally:
            app.REGISTRY._tracks.pop(token, None)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {'lyric': '[00:01.00]Hello'})


if __name__ == '__main__':
    unittest.main()
