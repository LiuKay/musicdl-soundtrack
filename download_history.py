"""Bounded task receipts, never a resumable queue or a store for media URLs."""
import json
import os
from pathlib import Path
import tempfile


class DownloadHistory:
    LIMIT = 100
    FIELDS = ('name', 'song_name', 'singers', 'format', 'source_id')

    def __init__(self, path):
        self.path = Path(path)
        self.warning = ''
        self.read_failed = False

    def load(self):
        try:
            with self.path.open('r', encoding='utf-8') as stream:
                raw = stream.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError('history too large')
            data = json.loads(raw)
            if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('tasks'), list):
                raise ValueError('invalid history')
            records = {}
            for item in data['tasks'][-self.LIMIT:]:
                if not isinstance(item, dict):
                    continue
                ident = item.get('download_id')
                if not isinstance(ident, str) or len(ident) != 16 or any(c not in '0123456789abcdef' for c in ident):
                    continue
                rec = self._receipt(item)
                if rec is not None:
                    rec['restored'] = True
                    rec['message'] = ('上次导出未完成，请返回本地音乐重新导出。' if rec['local']
                                      else '请重新查找歌曲后下载，原任务不会自动续传。')
                    records[ident] = rec
            return records
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, TypeError, OverflowError, RecursionError):
            self.read_failed = True
            self.warning = '历史任务读取失败，原记录已保留；本次任务暂不保存到磁盘。'
            return {}

    def _receipt(self, rec):
        if rec.get('status') in ('done', 'cancelled'):
            return None
        result = {key: rec[key][:500] for key in self.FIELDS if isinstance(rec.get(key), str)}
        updated = rec.get('updated', 0)
        result.update(status='error' if rec.get('status') == 'error' else 'interrupted',
                      local=rec.get('local') is True,
                      updated=updated if isinstance(updated, (int, float)) and 0 <= updated <= 1e12 else 0)
        return result

    def save(self, records):
        if self.read_failed:
            return
        temp_path = None
        try:
            tasks = []
            for ident, rec in records.items():
                receipt = self._receipt(rec)
                if receipt is not None:
                    tasks.append(dict(receipt, download_id=ident))
            tasks.sort(key=lambda rec: rec['updated'])
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_path = tempfile.mkstemp(prefix='.downloads-', dir=self.path.parent)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump({'version': 1, 'tasks': tasks[-self.LIMIT:]}, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, self.path)
            self.warning = ''
        except (OSError, ValueError, TypeError):
            self.warning = '任务记录保存失败，重启后可能无法找回；当前下载不受影响。'
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
