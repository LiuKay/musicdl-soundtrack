import json
import os
import tempfile
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import app
import audio_formats
from test_audio_fixtures import SILENT_FLAC


class DownloadWorkflowFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.downloads = self.root / 'downloads'
        self.downloads.mkdir()
        self.entries = {}
        for patch in [mock.patch.object(app, 'DOWNLOAD_DIR', str(self.downloads)),
                      mock.patch.object(app, 'CACHE_DIR', str(self.root / 'cache')),
                      mock.patch.object(app, 'DOWNLOADS', {}),
                      mock.patch.object(app, 'DOWNLOAD_CANCELLED', set()),
                      mock.patch.object(app.REGISTRY, '_tracks', self.entries)]:
            patch.start()
            self.addCleanup(patch.stop)
        self.enqueue = mock.patch.object(app, '_enqueue_download').start()
        self.addCleanup(mock.patch.stopall)
        self.client = app.app.test_client()
        self.entry = self.track('one')

    def track(self, token, identifier='song-1', source='MiguMusicClient', ext='mp3', size=100):
        entry = {'song_info': SimpleNamespace(identifier=identifier, song_name='Song', singers='Artist',
                                              album='Album', duration='0:01', ext=ext, file_size_bytes=size,
                                              lyric='', cover_url='', download_url='https://example.test/audio'),
                 'source': source, 'headers': {}, 'cookies': {}}
        self.entries[token] = entry
        return entry

    def saved(self, entry=None, ext='mp3', legacy=False):
        entry = entry or self.entry
        folder = self.downloads / 'MIGU'
        folder.mkdir(exist_ok=True)
        path = folder / f'Song - Artist.{ext}'
        path.write_bytes(b'original audio')
        metadata = {'song_name': 'Song', 'singers': 'Artist', 'album': 'Album',
                    'source': entry['source'], 'identity': '' if legacy else app._download_identity(entry)}
        Path(str(path) + '.soundtrack.json').write_text(json.dumps(metadata))
        return path

    def plan(self, tokens, target='mp3'):
        return self.client.post('/api/download/plan', json={'tokens': tokens, 'format': target})


class DownloadWorkflowTest(DownloadWorkflowFixture):
    def test_saved_identity_survives_research_and_memory_reset(self):
        self.saved()
        self.entries.clear()
        self.track('new-search')
        app.DOWNLOADS.clear()
        item = self.plan(['new-search']).get_json()['items'][0]
        self.assertEqual(item['status'], 'existing')
        self.assertEqual(item['existing'][0]['relative'], 'MIGU/Song - Artist.mp3')
        self.assertNotIn('lyric', item['existing'][0])

    def test_different_recordings_sources_and_quality_are_not_skipped(self):
        self.saved()
        self.track('version', identifier='song-live')
        self.track('source', source='QQMusicClient')
        self.track('quality', size=200)
        items = self.plan(['version', 'source', 'quality']).get_json()['items']
        self.assertEqual([item['status'] for item in items], ['ready'] * 3)

    def test_missing_file_and_legacy_metadata_do_not_block_download(self):
        path = self.saved()
        path.unlink()
        self.assertEqual(self.plan(['one']).get_json()['items'][0]['status'], 'ready')
        self.saved(legacy=True)
        item = self.plan(['one']).get_json()['items'][0]
        self.assertEqual(item['status'], 'ready')
        self.assertEqual(len(item['similar']), 1)
        self.assertEqual(item['existing'], [])

    def test_missing_identifier_never_certifies_an_exact_duplicate(self):
        entry = self.track('unknown', identifier='')
        self.saved(entry)
        self.assertEqual(self.plan(['unknown']).get_json()['items'][0]['status'], 'ready')

    def test_duplicate_requires_explicit_confirmation(self):
        path = self.saved()
        response = self.client.post('/api/download', json={'token': 'one', 'format': 'mp3'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'already_downloaded')
        self.enqueue.assert_not_called()
        response = self.client.post('/api/download', json={'token': 'one', 'format': 'mp3', 'duplicate': True})
        self.assertEqual(response.status_code, 200)
        self.enqueue.assert_called_once()
        self.assertEqual(path.read_bytes(), b'original audio')

    def test_concurrent_requests_and_new_search_tokens_share_one_task(self):
        self.track('two')
        def submit(index):
            token = 'one' if index % 2 else 'two'
            return app._submit_download(token, self.entries[token], 'mp3')[0]['download_id']
        with ThreadPoolExecutor(max_workers=6) as pool:
            ids = list(pool.map(submit, range(12)))
        self.assertEqual(len(set(ids)), 1)
        self.enqueue.assert_called_once()
        self.assertEqual(self.plan(['two']).get_json()['items'][0]['status'], 'active')

    def test_batch_without_converter_keeps_native_tracks_available(self):
        self.track('flac', ext='flac')
        with mock.patch.object(audio_formats, 'can_convert', return_value=False):
            items = self.plan(['one', 'flac', 'expired', 'one']).get_json()['items']
        self.assertEqual([item['status'] for item in items], ['ready', 'unavailable', 'unavailable'])
        self.enqueue.assert_not_called()

    def test_plan_rejects_bad_bodies_and_oversized_batches(self):
        for body in [[], None, {'tokens': ['one'], 'format': []}, {'tokens': 'one', 'format': 'mp3'},
                     {'tokens': [[]], 'format': 'mp3'}, {'tokens': ['one'] * 201, 'format': 'mp3'}]:
            self.assertEqual(self.client.post('/api/download/plan', json=body).status_code, 400)
        self.assertEqual(self.client.post('/api/download', json={
            'token': 'one', 'format': 'mp3', 'duplicate': 'yes',
        }).status_code, 400)

    def test_export_rejects_path_traversal_symlinks_missing_and_mp3(self):
        outside = self.root / 'outside.flac'
        outside.write_bytes(b'private audio')
        (self.downloads / 'linked.flac').symlink_to(outside)
        for relative in ['../outside.flac', str(outside), 'linked.flac', 'missing.flac', None, ['bad']]:
            response = self.client.post('/api/library/export', json={'relative': relative, 'format': 'mp3'})
            self.assertEqual(response.status_code, 400)
        self.saved()
        self.assertEqual(self.client.post('/api/library/export', json={
            'relative': 'MIGU/Song - Artist.mp3', 'format': 'mp3',
        }).status_code, 400)
        self.enqueue.assert_not_called()
        self.assertEqual(outside.read_bytes(), b'private audio')
        self.assertEqual(len(app._library_tracks()), 1)

    def test_export_without_tools_has_actionable_error(self):
        self.saved(ext='flac')
        with mock.patch.object(audio_formats, 'can_convert', return_value=False):
            response = self.client.post('/api/library/export', json={'relative': 'MIGU/Song - Artist.flac', 'format': 'mp3'})
        self.assertEqual(response.status_code, 503)
        self.assertIn('FFmpeg', response.get_json()['error'])

    def test_retry_resubmits_only_failed_task_and_removes_old_record(self):
        result = self.client.post('/api/download', json={'token': 'one', 'format': 'mp3'}).get_json()
        ident = result['download_id']
        self.assertEqual(self.client.post(f'/api/download/{ident}/retry').status_code, 409)
        app._set_dl(ident, status='error', message='network failed')
        response = self.client.post(f'/api/download/{ident}/retry')
        self.assertEqual(response.status_code, 200)
        self.assertNotEqual(response.get_json()['download_id'], ident)
        self.assertNotIn(ident, app.DOWNLOADS)
        self.assertEqual(self.enqueue.call_count, 2)

    def test_retry_refuses_changed_directory(self):
        response = self.client.post('/api/download', json={'token': 'one', 'format': 'mp3'})
        ident = response.get_json()['download_id']
        app._set_dl(ident, status='error', download_root='/different')
        self.assertEqual(self.client.post(f'/api/download/{ident}/retry').status_code, 409)

    def test_recent_tasks_and_progress_keep_completed_file_actions(self):
        path = self.saved()
        app._set_dl('done', status='done', path=str(path), relative='MIGU/Song - Artist.mp3',
                    download_root=str(self.downloads), format='mp3', token='one')
        task = self.client.get('/api/downloads').get_json()['tasks'][0]
        self.assertEqual(task['file_url'], '/api/file/done')
        self.assertNotIn('path', task)
        progress = self.client.get('/api/download/done/progress').get_data(as_text=True)
        self.assertIn('event: progress', progress)
        self.assertIn('"status": "done"', progress)
        self.assertEqual(self.client.delete('/api/download/done').status_code, 204)
        self.assertTrue(path.exists())

    def test_browser_save_uses_attachment(self):
        self.saved()
        response = self.client.get('/api/library/file/MIGU/Song%20-%20Artist.mp3?download=1')
        self.addCleanup(response.close)
        self.assertIn('attachment', response.headers['Content-Disposition'])


@unittest.skipUnless(audio_formats.can_convert(), 'FFmpeg and FFprobe required')
class LocalExportTest(DownloadWorkflowFixture):
    # Real-file integration cases use the same isolated app fixture.
    def tone(self):
        wav = self.downloads / 'Original.wav'
        with wave.open(str(wav), 'wb') as fp:
            fp.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
            fp.writeframes(b'\0\0' * 44100)
        return wav

    def run_export(self, relative):
        response = self.client.post('/api/library/export', json={'relative': relative, 'format': 'mp3'})
        self.assertEqual(response.status_code, 200, response.get_json())
        ident = response.get_json()['download_id']
        with mock.patch.object(app.requests, 'get') as network:
            app.run_download(ident, app._get_dl(ident)['token'])
            network.assert_not_called()
        return app._get_dl(ident)

    def test_real_local_export_preserves_source_and_detects_repeat(self):
        source = self.tone()
        original = source.read_bytes()
        record = self.run_export(source.name)
        self.assertEqual(record['status'], 'done', record)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(audio_formats.inspect_audio(record['path'], lambda: None)[0], 'mp3')
        response = self.client.post('/api/library/export', json={'relative': source.name, 'format': 'mp3'})
        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.get_json()['can_download'])
        copy = self.client.post('/api/library/export', json={
            'relative': source.name, 'format': 'mp3', 'duplicate': True,
        })
        self.assertEqual(copy.status_code, 200)
        ident = copy.get_json()['download_id']
        app.run_download(ident, app._get_dl(ident)['token'])
        copied = app._get_dl(ident)
        self.assertEqual(copied['status'], 'done', copied)
        self.assertNotEqual(copied['path'], record['path'])
        self.assertTrue(Path(record['path']).exists())
        self.assertEqual(source.read_bytes(), original)
        self.assertFalse(list(self.downloads.rglob('*.part*')))

    def test_changed_local_source_is_not_silently_converted(self):
        source = self.tone()
        response = self.client.post('/api/library/export', json={'relative': source.name, 'format': 'mp3'})
        ident = response.get_json()['download_id']
        source.write_bytes(b'changed')
        with mock.patch.object(app, 'DOWNLOAD_ACTIVE', 1), mock.patch.object(app, '_drain_download_queue'):
            app._run_download_job(ident, app._get_dl(ident)['token'])
        self.assertEqual(app._get_dl(ident)['status'], 'error')
        self.assertIn('已改变', app._get_dl(ident)['message'])
        self.assertEqual(source.read_bytes(), b'changed')
        self.assertFalse(list(self.downloads.rglob('*.part*')))

    def test_search_download_reuses_matching_local_flac(self):
        entry = self.track('flac', ext='flac')
        source = self.saved(entry, ext='flac')
        source.write_bytes(SILENT_FLAC)
        item = self.plan(['flac']).get_json()['items'][0]
        self.assertEqual(item['local_source'], 'MIGU/Song - Artist.flac')
        response = self.client.post('/api/download', json={'token': 'flac', 'format': 'mp3'})
        ident = response.get_json()['download_id']
        with mock.patch.object(app.requests, 'get') as network:
            app.run_download(ident, app._get_dl(ident)['token'])
            network.assert_not_called()
        self.assertEqual(app._get_dl(ident)['status'], 'done')
        self.assertTrue(source.exists())


if __name__ == '__main__':
    unittest.main()
