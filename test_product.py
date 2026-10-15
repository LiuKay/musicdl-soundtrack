import unittest
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import requests

import app
import releases


class ProductMetadataTest(unittest.TestCase):
    def test_provider_display_uses_registered_source_instead_of_internal_song_label(self):
        song = SimpleNamespace(source='MIGUMUMUSIC', identifier='one', song_name='Song',
                               singers='Artist', album='', ext='mp3', file_size='', duration='03:00', cover_url='')
        with mock.patch.object(app.REGISTRY, 'get', return_value={'source': 'MiguMusicClient', 'song_info': song}):
            payload = app._track_payload(song, 'token')
        self.assertEqual(payload['source_label'], '咪咕音乐')
        self.assertEqual(payload['source'], 'Migu')

    def test_short_audio_is_only_suspected_and_explicit_trial_is_confirmed(self):
        short = app._quality_payload(SimpleNamespace(duration_s=30, bitrate=320000))
        self.assertFalse(short['preview'])
        self.assertTrue(short['preview_suspected'])
        self.assertEqual(short['bitrate_kbps'], 320)
        trial = app._quality_payload(SimpleNamespace(duration='03:20', raw_data={
            'download': {'data': [{'freeTrialInfo': {'start': 10, 'end': 40}, 'br': 128000}]}}))
        self.assertTrue(trial['preview'])
        self.assertFalse(trial['preview_suspected'])
        self.assertEqual(trial['bitrate_kbps'], 128)

    def test_missing_or_malformed_metadata_never_invents_quality_or_preview(self):
        for values in [{}, {'bitrate': 'NULL', 'duration_s': None},
                       {'bitrate': float('nan'), 'duration_s': 'NULL', 'raw_data': None},
                       {'raw_data': {'download': {'data': {'freeTrialInfo': {'end': 'bad'}}}}}]:
            metadata = app._quality_payload(SimpleNamespace(**values))
            self.assertIsNone(metadata['bitrate_kbps'])
            self.assertFalse(metadata['preview'])
            self.assertFalse(metadata['preview_suspected'])
        self.assertFalse(app._quality_payload(SimpleNamespace(duration='03:20'))['preview_suspected'])


class ReleaseCheckTest(unittest.TestCase):
    def setUp(self):
        self.cache = mock.patch.multiple(releases, _cached=None, _expires=0, VERSION='0.8.0')
        self.cache.start()
        self.addCleanup(self.cache.stop)

    def response(self, tag, **extra):
        return SimpleNamespace(status_code=200, json=lambda: {'tag_name': tag, **extra})

    def test_versions_compare_numerically_and_cache_without_following_redirects(self):
        with mock.patch.object(releases.requests, 'get', return_value=self.response('v0.10.0')) as get:
            result = releases.check_update()
            self.assertEqual(result['status'], 'available')
            self.assertEqual(result['url'], releases.RELEASES_URL + '/tag/v0.10.0')
            self.assertEqual(releases.check_update(), result)
            get.assert_called_once()
            self.assertFalse(get.call_args.kwargs['allow_redirects'])
            self.assertEqual(get.call_args.args, (releases.API_URL,))

    def test_unavailable_is_not_reported_as_up_to_date(self):
        for result in [self.response('v0.8.0-beta'), self.response('v1.0.0', draft=True),
                       self.response('v1.0.0', prerelease=True), self.response('https://evil.invalid'),
                       SimpleNamespace(status_code=429), SimpleNamespace(status_code=302)]:
            with self.subTest(result=result), mock.patch.multiple(releases, _cached=None, _expires=0), \
                    mock.patch.object(releases.requests, 'get', return_value=result):
                self.assertEqual(releases.check_update()['status'], 'unavailable')
        with mock.patch.multiple(releases, _cached=None, _expires=0), \
                mock.patch.object(releases.requests, 'get', side_effect=requests.Timeout):
            self.assertEqual(releases.check_update()['status'], 'unavailable')

    def test_version_endpoint_is_local_until_check_is_requested(self):
        with mock.patch.object(releases.requests, 'get', return_value=self.response('v0.8.0')) as get:
            client = app.app.test_client()
            response = client.get('/api/version')
            self.assertEqual(response.json['current'], app.VERSION)
            get.assert_not_called()
            self.assertEqual(client.get('/api/version?check=1').json['status'], 'current')


class DownloadOrganizationTest(unittest.TestCase):
    def test_templates_and_layouts_keep_paths_inside_root(self):
        entry = {'source': 'MiguMusicClient', 'song_info': SimpleNamespace(song_name='Song', singers='Artist')}
        with tempfile.TemporaryDirectory() as temp:
            root = os.path.realpath(temp)
            for layout, folder in [('source', 'Migu'), ('artist', 'Artist'), ('flat', '')]:
                for naming, name in [('title-artist', 'Song - Artist'), ('artist-title', 'Artist - Song'), ('title', 'Song')]:
                    sub, filename = app._download_destination(root, entry, 'mp3', {'layout': layout, 'naming': naming})
                    self.assertEqual(sub, os.path.join(root, folder).rstrip(os.sep))
                    self.assertEqual(filename, name + '.mp3')

    def test_untrusted_components_and_invalid_preferences_cannot_escape(self):
        entry = {'source': 'MiguMusicClient', 'song_info': SimpleNamespace(song_name='../NUL\x00', singers='../CON')}
        with tempfile.TemporaryDirectory() as temp:
            sub, filename = app._download_destination(os.path.realpath(temp), entry, 'mp3', {'layout': 'artist', 'naming': 'artist-title'})
            self.assertTrue(Path(sub).is_relative_to(Path(temp).resolve()))
            self.assertNotIn('/', filename)
            self.assertNotIn('\x00', filename)
            for value in [None, {}, {'layout': '../', 'naming': 'title'}, {'layout': 'flat', 'naming': '../../file'}]:
                with self.assertRaises(ValueError): app._download_organization({'organization': value})
            self.assertEqual(app._safe_name('CON'), '_CON')
            self.assertEqual(app._safe_name('...'), 'track')
            self.assertLessEqual(len(app._safe_name('测试' * 120).encode('utf-8')), 120)

    def test_artist_directory_symlink_outside_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            try:
                (Path(root) / 'Artist').symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('symlink permission unavailable')
            entry = {'source': 'MiguMusicClient', 'song_info': SimpleNamespace(song_name='Song', singers='Artist')}
            with self.assertRaises(ValueError):
                app._download_destination(os.path.realpath(root), entry, 'mp3', {'layout': 'artist', 'naming': 'title'})


if __name__ == '__main__':
    unittest.main()
