import unittest
from pathlib import Path

import app


class SearchCompatibilityTest(unittest.TestCase):
    def test_safe_search_uses_current_musicdl_signature(self):
        class Client:
            def _search(self, keyword, search_url, request_overrides, song_infos, progress):
                song_infos.append('result')

        bucket = []
        app._safe_search(Client(), 'query', 'url', bucket, app._NullProgress())
        self.assertEqual(bucket, ['result'])

    def test_bundle_contains_user_agent_data(self):
        resources = Path('dist/Soundtrack.app/Contents/Resources')
        if not resources.exists():
            self.skipTest('desktop app has not been built')
        data_files = list(resources.glob('lib/python*/fake_useragent/data/browsers.jsonl'))
        self.assertTrue(data_files)


if __name__ == '__main__':
    unittest.main()
