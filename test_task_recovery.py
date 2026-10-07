import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import app
from download_history import DownloadHistory
from test_download_workflow import DownloadWorkflowFixture


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name, 'state', 'downloads.json')
        self.history = DownloadHistory(self.path)

    def test_receipts_keep_failures_and_interruptions_without_secrets_or_live_paths(self):
        records = {f'{i:016x}': dict(status=status, song_name='歌曲', singers='歌手', updated=i,
                                    token='secret-token', url='https://private', cookies={'secret': 'cookie'},
                                    path='/private/song.mp3', message='https://secret-error')
                   for i, status in enumerate(['queued', 'converting', 'error', 'done', 'cancelled'])}
        self.history.save(records)
        raw = self.path.read_text()
        self.assertNotIn('secret', raw)
        self.assertNotIn('/private', raw)
        restored = DownloadHistory(self.path).load()
        self.assertEqual([r['status'] for r in restored.values()], ['interrupted', 'interrupted', 'error'])
        self.assertTrue(all(r['restored'] for r in restored.values()))
        self.assertEqual(restored['0000000000000000']['song_name'], '歌曲')

    def test_bounds_and_invalid_history_preserve_original(self):
        self.history.save({f'{i:016x}': {'status': 'error', 'updated': i} for i in range(110)})
        self.assertEqual(len(self.history.load()), 100)
        self.assertNotIn('0000000000000000', self.history.load())
        self.path.write_text('{broken')
        broken = DownloadHistory(self.path)
        self.assertEqual(broken.load(), {})
        broken.save({})
        self.assertEqual(self.path.read_text(), '{broken')
        self.assertTrue(broken.warning)

    def test_atomic_failure_retains_previous_records_and_reports_warning(self):
        self.history.save({'0000000000000001': {'status': 'error'}})
        before = self.path.read_bytes()
        with mock.patch('download_history.os.replace', side_effect=PermissionError):
            self.history.save({})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(self.history.warning)
        self.assertEqual(list(self.path.parent.glob('.downloads-*')), [])
        self.history.save({})
        self.assertFalse(self.history.warning)

    def test_loaded_untrusted_records_cannot_restore_tokens_or_file_actions(self):
        self.path.parent.mkdir()
        self.path.write_text(json.dumps({'version': 1, 'tasks': [None,
            {'download_id': '../outside', 'status': 'error'},
            {'download_id': 'a' * 16, 'status': 'error', 'token': 'evil',
             'path': '/outside.mp3', 'updated': 'bad', 'local': True}]}))
        records = self.history.load()
        self.assertEqual(list(records), ['a' * 16])
        self.assertNotIn('token', records['a' * 16])
        self.assertNotIn('path', records['a' * 16])
        self.assertEqual(records['a' * 16]['updated'], 0)

    def test_extreme_timestamps_and_deep_json_never_block_startup(self):
        self.path.parent.mkdir()
        self.path.write_text(json.dumps({'version': 1, 'tasks': [
            {'download_id': 'a' * 16, 'updated': 10 ** 1000, 'status': 'error'}]}))
        self.assertEqual(self.history.load()['a' * 16]['updated'], 0)
        self.path.write_text('[' * 2000 + ']' * 2000)
        self.assertEqual(self.history.load(), {})
        self.assertTrue(self.history.warning)


class RecoveryIntegrationTest(DownloadWorkflowFixture):
    def setUp(self):
        super().setUp()
        patch = mock.patch.object(app, 'DOWNLOAD_HISTORY', None)
        patch.start()
        self.addCleanup(patch.stop)
        self.path = self.root / 'state' / 'downloads.json'
        app.initialize_download_history(self.path)

    def test_restart_records_do_not_resume_block_downloads_or_allow_stale_retry(self):
        result = self.client.post('/api/download', json={'token': 'one', 'format': 'mp3'}).get_json()
        ident = result['download_id']
        app.DOWNLOADS.clear()
        self.enqueue.reset_mock()
        app.initialize_download_history(self.path)
        task = self.client.get('/api/downloads').get_json()['tasks'][0]
        self.assertEqual(task['status'], 'interrupted')
        self.assertEqual(task['source_id'], 'MiguMusicClient')
        self.assertNotIn('token', task)
        self.assertNotIn('file_url', task)
        self.enqueue.assert_not_called()
        self.assertEqual(self.plan(['one']).get_json()['items'][0]['status'], 'ready')
        self.assertEqual(self.client.post(f'/api/download/{ident}/retry').status_code, 409)
        self.assertEqual(self.client.delete(f'/api/download/{ident}').status_code, 204)
        self.assertEqual(DownloadHistory(self.path).load(), {})

    def test_status_changes_persist_but_progress_does_not_write_each_chunk(self):
        ident = 'b' * 16
        with mock.patch.object(app.DOWNLOAD_HISTORY, 'save', wraps=app.DOWNLOAD_HISTORY.save) as save:
            app._set_dl(ident, status='queued', song_name='song')
            app._set_dl(ident, status='downloading', downloaded=1)
            app._set_dl(ident, status='downloading', downloaded=2)
            self.assertEqual(save.call_count, 2)
            app._set_dl(ident, status='error', message='private error')
            self.assertEqual(DownloadHistory(self.path).load()[ident]['status'], 'error')
            app._set_dl(ident, status='done')
            self.assertEqual(DownloadHistory(self.path).load(), {})


class TrashTest(DownloadWorkflowFixture):
    def setUp(self):
        super().setUp()
        self.audio = self.saved()
        self.relative = self.audio.relative_to(self.downloads).as_posix()
        self.url = '/api/library/delete/' + self.relative
        self.trash = self.root / 'fake-trash'
        self.trash.mkdir()

    def move(self, path):
        Path(path).rename(self.trash / Path(path).name)

    def test_trash_moves_audio_and_owned_metadata_but_preserves_shared_lyrics(self):
        sibling = self.audio.with_suffix('.flac')
        sibling.write_bytes(b'flac')
        lyrics = self.audio.with_suffix('.lrc')
        lyrics.write_text('shared')
        with mock.patch.object(app, 'send2trash', side_effect=self.move):
            response = self.client.delete(self.url)
        self.assertEqual(response.status_code, 204)
        self.assertFalse(self.audio.exists())
        self.assertTrue((self.trash / self.audio.name).exists())
        self.assertTrue(lyrics.exists())
        self.assertTrue(sibling.exists())

    def test_trash_failure_never_falls_back_to_permanent_deletion(self):
        with mock.patch.object(app, 'send2trash', side_effect=PermissionError), \
                mock.patch.object(app.os, 'remove') as remove:
            response = self.client.delete(self.url)
        self.assertEqual(response.status_code, 409)
        self.assertTrue(self.audio.exists())
        remove.assert_not_called()

    def test_sidecar_failure_reports_partial_success(self):
        def move(path):
            if path != str(self.audio.resolve()):
                raise PermissionError()
            self.move(path)
        with mock.patch.object(app, 'send2trash', side_effect=move):
            response = self.client.delete(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertIn('warning', response.get_json())
        self.assertFalse(self.audio.exists())
        self.assertTrue(Path(str(self.audio) + '.soundtrack.json').exists())

    def test_stale_listing_and_active_output_cannot_trash_files(self):
        track = self.client.get('/api/library').get_json()['tracks'][0]
        self.audio.write_bytes(b'changed audio')
        with mock.patch.object(app, 'send2trash') as trash:
            self.assertEqual(self.client.delete(self.url, headers={'If-Match': track['restore_key']}).status_code, 409)
            app.DOWNLOADS['job'] = {'status': 'tagging', 'path': str(self.audio)}
            self.assertEqual(self.client.delete(self.url).status_code, 409)
            trash.assert_not_called()

    def test_active_conversion_input_cannot_be_trashed(self):
        local = app._local_entry(self.relative)
        token = app.REGISTRY.add_local(local)
        app.DOWNLOADS['job'] = {'status': 'queued', 'token': token, 'download_root': str(self.downloads)}
        with mock.patch.object(app, 'send2trash') as trash:
            self.assertEqual(self.client.delete(self.url).status_code, 409)
            trash.assert_not_called()

    @unittest.skipIf(os.name == 'nt', 'symlinks require special Windows privileges')
    def test_audio_parent_and_sidecar_symlinks_never_move_targets(self):
        link = self.downloads / 'linked.mp3'
        link.symlink_to(self.audio)
        parent = self.downloads / 'alias'
        parent.symlink_to(self.audio.parent, target_is_directory=True)
        with mock.patch.object(app, 'send2trash') as trash:
            self.assertEqual(self.client.delete('/api/library/delete/linked.mp3').status_code, 404)
            self.assertEqual(self.client.delete('/api/library/delete/alias/' + self.audio.name).status_code, 404)
            meta = Path(str(self.audio) + '.soundtrack.json')
            meta.unlink()
            meta.symlink_to(self.audio)
            self.assertEqual(self.client.delete(self.url).status_code, 409)
            trash.assert_not_called()


if __name__ == '__main__':
    unittest.main()
