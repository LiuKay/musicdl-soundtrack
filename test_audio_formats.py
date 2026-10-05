import json
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import app
import audio_formats


class FormatRequestTest(unittest.TestCase):
    def setUp(self):
        self.entry = {'song_info': SimpleNamespace(ext='mp3', song_name='Test')}
        self.registry = mock.patch.object(app.REGISTRY, 'get', return_value=self.entry)
        self.registry.start()
        self.addCleanup(self.registry.stop)
        self.client = app.app.test_client()

    def test_rejects_invalid_bodies_and_formats(self):
        for data in [[], ['bad'], {'token': []}, {'token': 't', 'format': 'wav'},
                     {'token': 't', 'format': None}, {'token': 't', 'format': ['mp3']}]:
            with self.subTest(data=data):
                self.assertEqual(self.client.post('/api/download', json=data).status_code, 400)

    def test_flac_requires_original_flac_even_if_converter_exists(self):
        with mock.patch.object(app, '_enqueue_download') as enqueue:
            self.assertEqual(self.client.post('/api/download', json={
                'token': 't', 'format': 'flac',
            }).status_code, 400)
            enqueue.assert_not_called()

    def test_native_formats_work_without_tools_and_conversion_returns_503(self):
        with mock.patch.object(audio_formats, 'can_convert', return_value=False), \
                mock.patch.object(app, '_enqueue_download'):
            for ext, target, status in [('mp3', 'mp3', 200), ('.FLAC', 'flac', 200), ('flac', 'mp3', 503)]:
                self.entry['song_info'].ext = ext
                result = self.client.post('/api/download', json={'token': 't', 'format': target})
                self.assertEqual(result.status_code, status)
                if status == 200:
                    ident = result.get_json()['download_id']
                    self.assertEqual(app.DOWNLOADS.pop(ident)['format'], target)
            self.assertEqual(self.client.get('/api/download/formats').get_json(), {'mp3_conversion': False})


@unittest.skipUnless(audio_formats.can_convert(), 'FFmpeg/FFprobe are required for real audio tests')
class AudioConversionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.fixtures.cleanup)
        root = Path(cls.fixtures.name)
        wav = root / 'tone.wav'
        with wave.open(str(wav), 'wb') as audio:
            audio.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
            audio.writeframes(b'\0\0' * 44100)
        for ext, codec in [('mp3', 'libmp3lame'), ('flac', 'flac')]:
            subprocess.run([audio_formats.tool_path('ffmpeg'), '-v', 'error', '-i',
                            str(wav), '-c:a', codec, str(root / ('tone.' + ext))], check=True)
        cls.audio = {ext: (root / ('tone.' + ext)).read_bytes() for ext in ('mp3', 'flac', 'wav')}

    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.base = Path(self.root.name)
        self.entry = {
            'song_info': SimpleNamespace(ext='flac', song_name='Test', singers='Artist',
                                         album='', lyric='', cover_url='', duration='0:01',
                                         download_url='https://example.test/song', file_size_bytes=0),
            'source': 'MiguMusicClient', 'headers': {}, 'cookies': {},
        }
        for patch in [mock.patch.object(app, 'DOWNLOAD_DIR', str(self.base / 'downloads')),
                      mock.patch.object(app, 'CACHE_DIR', str(self.base / 'cache')),
                      mock.patch.object(app.REGISTRY, 'get', return_value=self.entry),
                      mock.patch.object(app, 'DOWNLOADS', {}),
                      mock.patch.object(app, 'DOWNLOAD_CANCELLED', set()),
                      mock.patch.object(app, 'DOWNLOAD_ACTIVE', 1)]:
            patch.start()
            self.addCleanup(patch.stop)
        Path(app.CACHE_DIR).mkdir()

    def cached_download(self, original, target, body=None, ident='test'):
        self.entry['song_info'].ext = original
        Path(app._cache_path(self.entry)).write_bytes(self.audio[original] if body is None else body)
        app._set_dl(ident, format=target)
        with mock.patch.object(app.requests, 'get') as network:
            app._run_download_job(ident, 'token')
            network.assert_not_called()
        return app._get_dl(ident)

    def test_flac_and_mp3_direct_download_do_not_encode(self):
        with mock.patch.object(audio_formats, 'convert_mp3') as encode, \
                mock.patch.object(app, '_save_download_metadata'):
            for ext in ('flac', 'mp3'):
                record = self.cached_download(ext, ext, ident=ext)
                self.assertEqual(record['status'], 'done')
                self.assertEqual(Path(record['path']).read_bytes(), self.audio[ext])
            encode.assert_not_called()

    def test_flac_and_wav_convert_to_real_mp3_and_record_output_metadata(self):
        for ext in ('flac', 'wav'):
            record = self.cached_download(ext, 'mp3', ident=ext)
            self.assertEqual(record['status'], 'done', record)
            self.assertEqual(audio_formats.inspect_audio(record['path'], lambda: None)[0], 'mp3')
            metadata = json.loads(Path(record['path'] + '.soundtrack.json').read_text())
            self.assertEqual(metadata['format'], 'mp3')
            self.assertEqual(metadata['source_format'], ext)
            self.assertFalse(list(self.base.rglob('*.part*')))

    def test_network_download_runs_the_same_format_pipeline(self):
        upstream = mock.MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.headers = {'Content-Length': str(len(self.audio['flac']))}
        upstream.iter_content.return_value = [self.audio['flac']]
        app._set_dl('network', format='mp3')
        with mock.patch.object(app.requests, 'get', return_value=upstream):
            app._run_download_job('network', 'token')
        result = app._get_dl('network')
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(audio_formats.inspect_audio(result['path'], lambda: None)[0], 'mp3')

    def test_mislabeled_flac_and_corrupt_audio_are_not_published(self):
        for body in (self.audio['mp3'], b'not music'):
            result = self.cached_download('flac', 'flac', body=body)
            self.assertEqual(result['status'], 'error')
            self.assertFalse(Path(result['path']).exists())
            self.assertFalse(list(self.base.rglob('*.part*')))

    def test_same_name_download_preserves_previous_audio(self):
        first = self.cached_download('flac', 'mp3', ident='first')
        previous = Path(first['path']).read_bytes()
        second = self.cached_download('flac', 'mp3', ident='second')
        self.assertEqual(second['status'], 'done')
        self.assertNotEqual(first['path'], second['path'])
        self.assertEqual(Path(first['path']).read_bytes(), previous)

    def test_failed_conversion_cleans_input_and_partial_output(self):
        def fail(source, destination, *args):
            Path(destination).write_bytes(b'partial')
            raise ValueError('conversion failed')
        with mock.patch.object(audio_formats, 'convert_mp3', side_effect=fail):
            result = self.cached_download('flac', 'mp3')
        self.assertEqual(result['status'], 'error')
        self.assertFalse(list(self.base.rglob('*.part*')))
        self.assertFalse(Path(result['path']).exists())

    def test_different_formats_do_not_share_or_delete_existing_lyrics(self):
        self.entry['song_info'].lyric = '[00:00.00]original'
        first = self.cached_download('flac', 'flac', ident='first')
        lyric = Path(first['path']).with_suffix('.lrc')
        original_lyric = lyric.read_bytes()
        second = self.cached_download('flac', 'mp3', ident='second')
        self.assertNotEqual(lyric, Path(second['path']).with_suffix('.lrc'))
        self.assertEqual(lyric.read_bytes(), original_lyric)

    def test_cancel_while_waiting_for_conversion_releases_download_slot(self):
        lock = mock.Mock()
        def wait(timeout):
            app._cancel_download('test')
            return False
        lock.acquire.side_effect = wait
        with mock.patch.object(app, 'TRANSCODE_LOCK', lock):
            result = self.cached_download('flac', 'mp3')
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(app.DOWNLOAD_ACTIVE, 0)
        lock.release.assert_not_called()
        self.assertFalse(list(self.base.rglob('*.part*')))

    def test_cancel_during_conversion_cleans_all_temporaries(self):
        def cancel(source, destination, duration, check, report):
            Path(destination).write_bytes(b'partial')
            app._cancel_download('test')
            check()
        with mock.patch.object(audio_formats, 'convert_mp3', side_effect=cancel):
            result = self.cached_download('flac', 'mp3')
        self.assertEqual(result['status'], 'cancelled')
        self.assertFalse(list(self.base.rglob('*.part*')))
        self.assertFalse(Path(result['path']).exists())
        self.assertTrue(app.TRANSCODE_LOCK.acquire(blocking=False))
        app.TRANSCODE_LOCK.release()

    def test_converter_terminates_process_on_cancel(self):
        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch.object(audio_formats.subprocess, 'Popen', return_value=process), \
                self.assertRaises(InterruptedError):
            audio_formats.convert_mp3('input', 'output', 1,
                                      mock.Mock(side_effect=InterruptedError), lambda pct: None)
        process.terminate.assert_called_once()

    def test_converter_timeout_stops_process(self):
        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch.object(audio_formats.subprocess, 'Popen', return_value=process), \
                mock.patch.object(audio_formats.time, 'monotonic', side_effect=[0, 1801]), \
                self.assertRaisesRegex(ValueError, '超时'):
            audio_formats.convert_mp3('input', 'output', 1, lambda: None, lambda pct: None)
        process.terminate.assert_called_once()


if __name__ == '__main__':
    unittest.main()
