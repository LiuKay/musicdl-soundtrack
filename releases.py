"""Read-only, cached checks against this project's public stable releases."""

import re
import threading
import time
from urllib.parse import quote

import requests

from version import VERSION


RELEASES_URL = 'https://github.com/LiuKay/musicdl-soundtrack/releases'
API_URL = 'https://api.github.com/repos/LiuKay/musicdl-soundtrack/releases/latest'
_lock = threading.Lock()
_cached = None
_expires = 0


def version_parts(value):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', str(value))
    return tuple(map(int, match.groups())) if match else None


def check_update():
    global _cached, _expires
    with _lock:
        if _cached is not None and time.monotonic() < _expires:
            return dict(_cached)
        result = {'current': VERSION, 'releases_url': RELEASES_URL, 'status': 'unavailable'}
        try:
            response = requests.get(API_URL, timeout=(3.05, 8), allow_redirects=False,
                                    headers={'Accept': 'application/vnd.github+json',
                                             'User-Agent': 'Soundtrack/' + VERSION})
            if response.status_code != 200:
                raise ValueError('release unavailable')
            data = response.json()
            tag = data.get('tag_name', '')
            latest = version_parts(tag)
            if latest is None or data.get('draft') or data.get('prerelease'):
                raise ValueError('not a stable version')
            result.update(status='available' if latest > version_parts(VERSION) else 'current',
                          latest=tag.lstrip('v'), url=RELEASES_URL + '/tag/' + quote(tag, safe=''))
        except (requests.RequestException, ValueError, TypeError, AttributeError):
            result['message'] = '暂时无法检查更新，请稍后重试或前往发布页。'
        _cached = result
        _expires = time.monotonic() + (60 if result['status'] == 'unavailable' else 3600)
        return dict(result)
