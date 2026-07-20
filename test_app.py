import unittest
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
