import unittest
import json
import os
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import fake_useragent
import app
import desktop


class SearchCompatibilityTest(unittest.TestCase):
    def test_desktop_exit_checks_live_background_tasks_not_page_state(self):
        window = SimpleNamespace(confirm_close=False)
        for status in ['queued', 'downloading', 'checking', 'waiting_conversion', 'converting',
                       'tagging', 'cancelling', 'new-future-stage']:
            with self.subTest(status=status), mock.patch.object(app, 'DOWNLOADS', {'job': {'status': status}}):
                desktop._update_close_confirmation(window, app)
                self.assertTrue(window.confirm_close)
        with mock.patch.object(app, 'DOWNLOADS', {'job': {'status': 'downloading'}}):
            desktop._update_close_confirmation(window, app)
            app.DOWNLOADS['job']['status'] = 'done'
            desktop._update_close_confirmation(window, app)
            self.assertFalse(window.confirm_close)

    def test_desktop_exit_does_not_warn_for_finished_or_failed_tasks(self):
        window = SimpleNamespace(confirm_close=True)
        for records in [{}, {'a': {'status': 'done'}, 'b': {'status': 'error'}, 'c': {'status': 'cancelled'}}]:
            with mock.patch.object(app, 'DOWNLOADS', records):
                desktop._update_close_confirmation(window, app)
                self.assertFalse(window.confirm_close)
                self.assertEqual(app.DOWNLOADS, records)

    def test_desktop_exit_failure_keeps_confirmation_and_does_not_mutate_tasks(self):
        window = SimpleNamespace(confirm_close=False)
        broken = SimpleNamespace(DL_LOCK=mock.MagicMock(), DOWNLOADS=None)
        with self.assertRaises(AttributeError):
            desktop._update_close_confirmation(window, broken)
        self.assertTrue(window.confirm_close)

    def test_desktop_exit_warns_while_submission_has_not_created_a_task_yet(self):
        window = SimpleNamespace(confirm_close=False)
        with mock.patch.object(app, 'DOWNLOADS', {}), mock.patch.object(app, 'DOWNLOAD_REQUESTS_IN_FLIGHT', 0):
            @app._track_download_request
            def submitting():
                desktop._update_close_confirmation(window, app)
                self.assertTrue(window.confirm_close)
                self.assertEqual(app.DOWNLOAD_REQUESTS_IN_FLIGHT, 1)
                raise ValueError('submission failed')
            with self.assertRaises(ValueError):
                submitting()
            self.assertEqual(app.DOWNLOAD_REQUESTS_IN_FLIGHT, 0)
            desktop._update_close_confirmation(window, app)
            self.assertFalse(window.confirm_close)

    def test_download_submission_routes_hold_exit_guard_even_before_validation(self):
        with mock.patch.object(app, 'DOWNLOAD_REQUESTS_IN_FLIGHT', 0):
            for route in [app.api_download, app.api_library_export, app.api_retry_download]:
                self.assertTrue(hasattr(route, '__wrapped__'))
            for url in ['/api/download', '/api/library/export', '/api/download/missing/retry']:
                app.app.test_client().post(url, json={})
                self.assertEqual(app.DOWNLOAD_REQUESTS_IN_FLIGHT, 0)

    def test_playback_identity_survives_tokens_and_distinguishes_versions(self):
        song = SimpleNamespace(source='MiguMusicClient', identifier='song-1', ext='mp3',
                               song_name='Song', singers='Artist', album='', file_size='100',
                               duration='3:00', cover_url='', lyric='')
        first = app._track_payload(song, 'old')
        second = app._track_payload(song, 'new')
        self.assertEqual(first['identity'], second['identity'])
        self.assertEqual(first['source_id'], 'MiguMusicClient')
        song.identifier = 'live-version'
        self.assertNotEqual(first['identity'], app._track_payload(song, 'new')['identity'])
        song.identifier = None
        self.assertEqual(app._track_payload(song, 'new')['identity'], '')

    def test_local_restore_key_changes_with_directory_or_file(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            keys = []
            for directory in [first, second]:
                Path(directory, 'Song.mp3').write_bytes(b'audio')
                with mock.patch.object(app, 'DOWNLOAD_DIR', directory):
                    keys.append(app._library_tracks()[0]['restore_key'])
                    self.assertEqual(keys[-1], app._library_tracks()[0]['restore_key'])
                    Path(directory, 'Song.mp3').write_bytes(b'changed')
                    self.assertNotEqual(keys[-1], app._library_tracks()[0]['restore_key'])
            self.assertNotEqual(*keys)

    def test_desktop_uses_persistent_origin_and_shuts_down_server(self):
        with mock.patch.object(desktop, 'make_server') as make_server, \
                mock.patch.object(desktop.threading, 'Thread'), \
                mock.patch.object(desktop.webview, 'create_window') as create_window, \
                mock.patch.object(desktop.webview, 'start') as start, \
                mock.patch.dict(os.environ, {}, clear=False):
            closing = create_window.return_value.events.closing
            desktop.main()
            make_server.assert_called_once_with('127.0.0.1', 42001, app.app, threaded=True)
            self.assertEqual(create_window.call_args.args[1], 'http://127.0.0.1:42001')
            self.assertTrue(create_window.call_args.kwargs['confirm_close'])
            self.assertIn('不会自动恢复', create_window.call_args.kwargs['localization']['global.quitConfirmation'])
            closing.__iadd__.assert_called_once()
            self.assertFalse(start.call_args.kwargs['private_mode'])
            self.assertEqual(start.call_args.kwargs['storage_path'], str(desktop.SETTINGS_DIR / 'webview'))
            make_server.return_value.shutdown.assert_called_once()

    def test_desktop_port_conflict_never_opens_another_local_service(self):
        with mock.patch.object(desktop, 'make_server', side_effect=SystemExit(1)), \
                mock.patch.object(desktop.webview, 'create_window') as create_window, \
                mock.patch.dict(os.environ, {}, clear=False):
            with self.assertRaises(SystemExit):
                desktop.main()
            create_window.assert_not_called()

    def test_payload_cleans_exact_placeholders_without_changing_versions(self):
        song = SimpleNamespace(source='MiguMusicClient', ext='.FLAC', song_name='晴天（Live 2026）',
                               singers='Alice', album=' NULL ', file_size='N/A', duration='None',
                               cover_url=None, lyric='')
        payload = app._track_payload(song, 'token')
        self.assertEqual(payload['song_name'], '晴天（Live 2026）')
        self.assertEqual(payload['source_label'], '咪咕音乐')
        self.assertEqual([payload[key] for key in ('album', 'file_size', 'duration', 'cover_url')], [''] * 4)
        self.assertEqual(app._display_text('None Shall Pass'), 'None Shall Pass')
        song.song_name, song.singers = 'null', 'undefined'
        self.assertEqual(app._track_payload(song, 'token')['song_name'], '未知曲目')
        self.assertEqual(app._track_payload(song, 'token')['singers'], '未知艺人')

    def test_source_labels_accept_provider_ids_and_saved_folder_names(self):
        for source in ['Migu', 'MIGU', 'MiguMusicClient', '咪咕音乐']:
            self.assertEqual(app._source_label(source), '咪咕音乐')
        self.assertEqual(app._source_label('Netease'), '网易云音乐')
        self.assertEqual(app._source_label('MyCollection'), 'MyCollection')

    def test_library_display_cleanup_preserves_files_and_stored_identity(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(app, 'DOWNLOAD_DIR', tmp):
            folder = Path(tmp, 'Migu')
            folder.mkdir()
            audio = folder / '晴天（伴奏版） - Alice.mp3'
            audio.write_bytes(b'audio')
            metadata = Path(str(audio) + '.soundtrack.json')
            original = json.dumps({'song_name': 'NULL', 'singers': 'none', 'album': 'undefined', 'identity': 'stable'})
            metadata.write_text(original)
            track = app._library_tracks()[0]
            self.assertEqual(track['song_name'], '晴天（伴奏版）')
            self.assertEqual(track['singers'], 'Alice')
            self.assertEqual(track['album'], '')
            self.assertEqual(track['source_label'], '咪咕音乐')
            self.assertEqual(track['identity'], 'stable')
            self.assertEqual(metadata.read_text(), original)
            self.assertEqual(audio.read_bytes(), b'audio')

    def test_music_clients_use_absolute_cache_workspace_from_read_only_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            resources = Path(tmp, 'Resources')
            resources.mkdir()
            resources.chmod(0o555)
            original_cwd = os.getcwd()
            cache = Path(tmp, 'cache')

            def build(**kwargs):
                for cfg in kwargs['init_music_clients_cfg'].values():
                    work_dir = Path(cfg.get('work_dir', 'musicdl_outputs'))
                    self.assertTrue(work_dir.is_absolute())
                    self.assertTrue(work_dir.is_relative_to(cache))
                    work_dir.mkdir(parents=True, exist_ok=True)
                return SimpleNamespace(music_clients={})

            try:
                os.chdir(resources)
                with mock.patch.object(app, 'CACHE_DIR', str(cache)), \
                        mock.patch.object(app.musicdl, 'MusicClient', side_effect=build):
                    app.ClientManager()._build()
                self.assertFalse((resources / 'musicdl_outputs').exists())
            finally:
                os.chdir(original_cwd)
                resources.chmod(0o755)

    def test_initialization_errors_are_distinct_and_do_not_expose_paths(self):
        with mock.patch.object(app.MANAGER, 'client', side_effect=OSError('private path')):
            events = list(app.search_stream('test', ['MiguMusicClient']))
        error = next(event for event in events if event.startswith('event: source_error'))
        data = json.loads(error.split('data: ', 1)[1])
        self.assertEqual(data.get('code'), 'initialization_failed')
        self.assertNotIn('private path', error)

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

    def test_safe_search_counts_failed_requests_without_exposing_details(self):
        client = SimpleNamespace(_search=mock.Mock(side_effect=RuntimeError('private detail')))
        errors = []
        app._safe_search(client, 'query', 'url', [], app._NullProgress(), errors)
        self.assertEqual(errors, [True])

    def test_source_done_reports_request_failures(self):
        client = SimpleNamespace(
            _constructsearchurls=lambda **kwargs: ['url'],
            _search=mock.Mock(side_effect=RuntimeError('private detail')),
        )
        with mock.patch.object(app.MANAGER, 'client', return_value=client):
            events = list(app.search_stream('query', ['MiguMusicClient']))
        done = next(event for event in events if event.startswith('event: source_done'))
        data = json.loads(done.split('data: ', 1)[1])
        self.assertEqual(data['error_count'], 1)
        self.assertEqual(data['count'], 0)
        self.assertFalse(data['timed_out'])
        self.assertNotIn('private detail', ''.join(events))

    def test_sources_api_lists_supported_sources_in_order(self):
        response = app.app.test_client().get('/api/sources')

        self.assertEqual(response.status_code, 200)
        sources = response.get_json()
        self.assertEqual([source['id'] for source in sources], self.SOURCE_ORDER)
        self.assertEqual(list(app.SUPPORTED_SOURCES), self.SOURCE_ORDER)
        self.assertEqual(app.SOURCE_ORDER, self.SOURCE_ORDER)

    def test_api_rejects_non_local_host(self):
        response = app.app.test_client().get('/api/library', headers={'Host': 'evil.test'})

        self.assertEqual(response.status_code, 403)

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
                # Clearing after the cached response opens must not truncate it.
                app.app.test_client().delete('/api/cache')
                body = response.data
                response.close()
                Path(cached).write_bytes(b'0123456789')
                old = Path(cache_dir) / ('a' * 64 + '.mp3')
                old.write_bytes(b'old')
                os.utime(old, (1, 1))
                app._prune_cache(10, keep=cached)
                self.assertFalse(old.exists())
        finally:
            app.REGISTRY._tracks.pop(token, None)

        self.assertEqual(response.status_code, 206)
        self.assertEqual(body, b'3456')
        get.assert_not_called()

    def test_cache_management_preserves_downloads_unrelated_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(app, 'CACHE_DIR', str(Path(root) / 'cache')), \
                mock.patch.object(app, 'DOWNLOAD_DIR', str(Path(root) / 'downloads')):
            cache = Path(app.CACHE_DIR)
            cache.mkdir()
            downloads = Path(app.DOWNLOAD_DIR)
            downloads.mkdir()
            saved = downloads / 'saved.mp3'
            saved.write_bytes(b'permanent')
            unrelated = cache / 'personal.mp3'
            unrelated.write_bytes(b'personal')
            workspace = cache / 'musicdl'
            workspace.mkdir()
            (workspace / ('a' * 64 + '.mp3')).write_bytes(b'provider data')
            link = cache / ('b' * 64 + '.mp3')
            link.symlink_to(saved)
            (cache / ('c' * 64 + '.mp3')).write_bytes(b'audio')
            (cache / ('d' * 64 + '.mp3.part')).write_bytes(b'partial')
            client = app.app.test_client()
            usage = client.get('/api/cache').get_json()
            self.assertEqual((usage['bytes'], usage['files'], usage['partial_bytes']), (12, 1, 7))
            result = client.delete('/api/cache').get_json()
            self.assertEqual((result['removed'], result['freed_bytes'], result['bytes']), (2, 12, 0))
            self.assertEqual(saved.read_bytes(), b'permanent')
            self.assertEqual(unrelated.read_bytes(), b'personal')
            self.assertTrue(link.is_symlink())
            self.assertEqual(len(list(workspace.iterdir())), 1)
            self.assertEqual(client.delete('/api/cache').get_json()['removed'], 0)

    def test_cache_cleanup_and_pruning_skip_active_writers(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(app, 'CACHE_DIR', root), \
                mock.patch.object(app, 'CACHE_JOBS', {'a' * 64}):
            complete = Path(root) / ('a' * 64 + '.mp3')
            partial = Path(str(complete) + '.part')
            complete.write_bytes(b'complete')
            partial.write_bytes(b'partial')
            unrelated = Path(root) / 'personal.mp3'
            unrelated.write_bytes(b'personal')
            app._prune_cache(0)
            result = app.app.test_client().delete('/api/cache').get_json()
            self.assertEqual((result['removed'], result['active_jobs'], result['bytes']), (0, 1, 15))
            self.assertTrue(complete.exists())
            self.assertTrue(partial.exists())
            app.CACHE_JOBS.clear()
            app._prune_cache(0)
            self.assertFalse(complete.exists())
            self.assertTrue(unrelated.exists())
            result = app.app.test_client().delete('/api/cache').get_json()
            self.assertEqual(result['bytes'], 0)

    def test_cache_rejects_overlapping_roots_including_aliases(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            alias = base / 'alias'
            downloads = base / 'downloads'
            downloads.mkdir()
            alias.symlink_to(downloads, target_is_directory=True)
            for cache, target in [(downloads, downloads), (base, downloads),
                                  (downloads / 'cache', downloads), (alias, downloads)]:
                with self.subTest(cache=cache, target=target), \
                        mock.patch.object(app, 'CACHE_DIR', str(cache)), \
                        mock.patch.object(app, 'DOWNLOAD_DIR', str(target)):
                    for method in ['get', 'delete']:
                        response = getattr(app.app.test_client(), method)('/api/cache')
                        self.assertEqual(response.status_code, 503)
                    with self.assertRaises(OSError):
                        app._prune_cache(0)

    def test_cache_missing_directory_is_empty_and_does_not_create_it(self):
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(app, 'CACHE_DIR', str(Path(root) / 'missing')):
            for method in ['get', 'delete']:
                response = getattr(app.app.test_client(), method)('/api/cache')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()['bytes'], 0)
            self.assertFalse(Path(app.CACHE_DIR).exists())

    def test_cache_clear_reports_files_it_cannot_remove(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(app, 'CACHE_DIR', root):
            path = Path(root) / ('a' * 64 + '.mp3')
            path.write_bytes(b'locked')
            with mock.patch.object(app.os, 'remove', side_effect=PermissionError):
                result = app.app.test_client().delete('/api/cache').get_json()
            self.assertEqual((result['removed'], result['failed'], result['bytes']), (0, 1, 6))

    def test_concurrent_cache_writers_enforce_limit_after_both_publish(self):
        entries = [{'song_info': SimpleNamespace(download_url='https://example.test/song.mp3',
                    song_name=name, ext='mp3'), 'source': 'MiguMusicClient', 'headers': {}, 'cookies': {}}
                   for name in ['first', 'second']]
        before, after = threading.Barrier(2), threading.Barrier(2)
        prune = app._prune_cache

        def synchronized_prune(*args, **kwargs):
            before.wait(timeout=5)
            prune(*args, **kwargs)
            after.wait(timeout=5)

        upstream = mock.MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.headers = {'Content-Length': '6'}
        upstream.iter_content.return_value = [b'abcdef']
        with tempfile.TemporaryDirectory() as root, mock.patch.object(app, 'CACHE_DIR', root), \
                mock.patch.object(app, 'CACHE_JOBS', {app._cache_key(entry) for entry in entries}), \
                mock.patch.object(app.requests, 'get', return_value=upstream), \
                mock.patch.object(app, '_prune_cache', side_effect=synchronized_prune):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(app._cache_audio, entry, app._cache_path(entry), 10) for entry in entries]
                for future in futures:
                    future.result(timeout=10)
            self.assertEqual(sum(path.stat().st_size for path in Path(root).iterdir()), 6)
            self.assertFalse(app.CACHE_JOBS)

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

    def test_failed_download_delete_cleans_partial_file(self):
        download_id = 'failed-download'
        try:
            with tempfile.TemporaryDirectory() as root, \
                    mock.patch.object(app, 'DOWNLOAD_DIR', root):
                path = os.path.join(root, 'Migu', 'Failed - Artist.mp3')
                tmp_path = path + f'.{download_id}.part'
                os.makedirs(os.path.dirname(path))
                Path(tmp_path).write_bytes(b'partial')
                app._set_dl(
                    download_id, status='error', path=path, tmp_path=tmp_path,
                )

                response = app.app.test_client().delete(f'/api/download/{download_id}')

                self.assertEqual(response.status_code, 204)
                self.assertFalse(Path(tmp_path).exists())
                self.assertEqual(app._get_dl(download_id), {})
        finally:
            app.DOWNLOADS.pop(download_id, None)
            app.DOWNLOAD_CANCELLED.discard(download_id)

    def test_active_download_delete_stops_and_cleans_partial_file(self):
        download_id = 'active-download'
        token = 'active-download-token'
        entry = {
            'song_info': SimpleNamespace(
                download_url='https://example.test/audio.mp3',
                song_name='Active', singers='Artist', ext='mp3',
                file_size_bytes=6,
            ),
            'source': 'MiguMusicClient', 'headers': {}, 'cookies': {},
        }
        upstream = mock.MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.headers = {'Content-Length': '6'}
        app.REGISTRY._tracks[token] = entry
        old_active = app.DOWNLOAD_ACTIVE
        try:
            with tempfile.TemporaryDirectory() as root, \
                    mock.patch.object(app, 'DOWNLOAD_DIR', root), \
                    mock.patch.object(app.requests, 'get', return_value=upstream):
                client = app.app.test_client()

                def chunks(chunk_size):
                    yield b'abc'
                    app.DOWNLOAD_DIR = os.path.join(root, 'new-downloads')
                    self.assertEqual(
                        client.delete(f'/api/download/{download_id}').status_code,
                        202,
                    )
                    yield b'def'

                upstream.iter_content.side_effect = chunks
                app.DOWNLOAD_ACTIVE = 1
                app._set_dl(download_id, status='queued')
                app._run_download_job(download_id, token)
                path = os.path.join(root, 'Migu', 'Active - Artist.mp3')
                tmp_path = path + f'.{download_id}.part'

                self.assertFalse(Path(path).exists())
                self.assertFalse(Path(tmp_path).exists())
                self.assertEqual(app._get_dl(download_id)['status'], 'cancelled')
        finally:
            app.DOWNLOAD_ACTIVE = old_active
            app.REGISTRY._tracks.pop(token, None)
            app.DOWNLOADS.pop(download_id, None)
            app.DOWNLOAD_CANCELLED.discard(download_id)

    def test_active_download_delete_after_publish_removes_audio(self):
        download_id = 'published-download'
        token = 'published-download-token'
        entry = {
            'song_info': SimpleNamespace(
                download_url='https://example.test/audio.mp3',
                song_name='Published', singers='Artist', ext='mp3',
                file_size_bytes=3,
            ),
            'source': 'MiguMusicClient', 'headers': {}, 'cookies': {},
        }
        upstream = mock.MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.headers = {'Content-Length': '3'}
        upstream.iter_content.return_value = [b'abc']
        app.REGISTRY._tracks[token] = entry
        old_active = app.DOWNLOAD_ACTIVE
        try:
            with tempfile.TemporaryDirectory() as root, \
                    mock.patch.object(app, 'DOWNLOAD_DIR', root), \
                    mock.patch.object(app.requests, 'get', return_value=upstream), \
                    mock.patch.object(app, '_save_download_metadata') as save_metadata:
                client = app.app.test_client()
                save_metadata.side_effect = lambda path, item: client.delete(
                    f'/api/download/{download_id}',
                )
                app.DOWNLOAD_ACTIVE = 1
                app._set_dl(download_id, status='queued')
                app._run_download_job(download_id, token)
                path = Path(root) / 'Migu' / 'Published - Artist.mp3'

                self.assertFalse(path.exists())
                self.assertEqual(app._get_dl(download_id)['status'], 'cancelled')
        finally:
            app.DOWNLOAD_ACTIVE = old_active
            app.REGISTRY._tracks.pop(token, None)
            app.DOWNLOADS.pop(download_id, None)
            app.DOWNLOAD_CANCELLED.discard(download_id)

    def test_active_download_cleanup_failure_keeps_error_record(self):
        download_id = 'cleanup-failure'
        old_active = app.DOWNLOAD_ACTIVE
        try:
            app.DOWNLOAD_ACTIVE = 1
            app._set_dl(download_id, status='cancelling', path='/tmp/song.mp3')
            app.DOWNLOAD_CANCELLED.add(download_id)
            with mock.patch.object(app, 'run_download'), \
                    mock.patch.object(app, '_delete_download_files', return_value=False):
                app._run_download_job(download_id, 'token')

            record = app._get_dl(download_id)
            self.assertEqual(record['status'], 'error')
            self.assertIn('无法清理', record['message'])
        finally:
            app.DOWNLOAD_ACTIVE = old_active
            app.DOWNLOADS.pop(download_id, None)
            app.DOWNLOAD_CANCELLED.discard(download_id)

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
            self.assertEqual(library['tracks'][0]['relative'], 'Migu/Song - Singer.mp3')
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
                escaped_delete = app.api_delete_library_file('../outside.mp3')

            with mock.patch.object(app.os, 'remove', side_effect=PermissionError):
                failed_delete = client.delete(library['tracks'][0]['delete_url'])
            deleted = client.delete(library['tracks'][0]['delete_url'])
            deleted_files = [
                audio, Path(str(audio) + '.soundtrack.json'),
                Path(str(audio) + '.soundtrack.cover'), audio.with_suffix('.lrc'),
            ]

        self.assertEqual(response.status_code, 206)
        self.assertEqual(body, b'3456')
        self.assertEqual(cover_body, b'cover')
        self.assertEqual(cover_nosniff, 'nosniff')
        self.assertEqual(escaped[1], 404)
        self.assertEqual(escaped_delete[1], 404)
        self.assertEqual(failed_delete.status_code, 409)
        self.assertEqual(deleted.status_code, 204)
        self.assertFalse(any(path.exists() for path in deleted_files))

    def test_desktop_reveals_only_downloaded_files(self):
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(app, 'DOWNLOAD_DIR', root), \
                mock.patch.object(desktop.sys, 'platform', 'darwin'), \
                mock.patch.object(desktop.subprocess, 'Popen') as popen:
            source = Path(root) / 'Migu'
            source.mkdir()
            audio = source / 'Song - Singer.mp3'
            audio.write_bytes(b'audio')
            api = desktop.DesktopApi(app)

            self.assertTrue(api.reveal_downloaded_file('Migu/Song - Singer.mp3'))
            self.assertFalse(api.reveal_downloaded_file('../outside.mp3'))
            self.assertFalse(api.reveal_downloaded_file('Migu/missing.mp3'))
            popen.assert_called_once_with(['open', '-R', str(audio.resolve())])

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
