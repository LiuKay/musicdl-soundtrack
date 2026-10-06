'use strict';

// Persist metadata only. Playback URLs and server tokens expire across restarts.
const SessionState = (() => {
  const key = 'soundtrack-session-v1';
  const text = value => typeof value === 'string' ? value.slice(0, 500) : '';
  function normalize(value) {
    const data = value?.version === 1 ? value : {};
    const items = (Array.isArray(data.items) ? data.items : []).slice(0, 200).map(item => {
      item = item && typeof item === 'object' ? item : {};
      return Object.fromEntries(['song_name', 'singers', 'album', 'ext', 'source_id', 'identity',
        'relative', 'restore_key'].map(k => [k, text(item[k])]).concat([['local', item.local === true]]));
    });
    const validIndex = i => Number.isInteger(i) && i >= 0 && i < items.length;
    const order = [...new Set((Array.isArray(data.order) ? data.order : []).filter(validIndex))];
    items.forEach((_, i) => { if (!order.includes(i)) order.push(i); });
    return {
      version: 1, items, order,
      current: validIndex(data.current) ? data.current : null,
      shuffle: data.shuffle === true,
      repeat: ['off', 'all', 'one'].includes(data.repeat) ? data.repeat : 'off',
      history: [...new Set((Array.isArray(data.history) ? data.history : [])
        .filter(v => typeof v === 'string').map(v => v.trim().slice(0, 200)).filter(Boolean))].slice(0, 10),
      sources: [...new Set((Array.isArray(data.sources) ? data.sources : [])
        .filter(v => typeof v === 'string' && /^[A-Za-z0-9]+$/.test(v)))].slice(0, 20)
    };
  }
  function read() {
    try { return normalize(JSON.parse(localStorage.getItem(key))); }
    catch { return normalize(null); }
  }
  function write(data) {
    try { localStorage.setItem(key, JSON.stringify(normalize(data))); return true; }
    catch { return false; }
  }
  function sourceSelection(saved, available) {
    const valid = available.filter(s => saved.includes(s.id)).map(s => s.id);
    return valid.length ? valid : available.filter(s => s.default).map(s => s.id).concat(
      available.some(s => s.default) ? [] : available.slice(0, 1).map(s => s.id));
  }
  function resolveRemote(track, signal) {
    return new Promise((resolve, reject) => {
      if (!track.identity || !track.source_id) { reject(Error('缺少可靠曲目身份，请重新查找')); return; }
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const es = new EventSource(`/api/search?${new URLSearchParams({
        q: `${track.song_name} ${track.singers}`.trim(), sources: track.source_id
      })}`);
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); es.close(); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => finish(Error('连接超时，请重试或重新查找')), 45000);
      signal.addEventListener('abort', abort, { once: true });
      es.addEventListener('result', event => {
        try {
          const result = JSON.parse(event.data);
          if (result.identity === track.identity && result.source_id === track.source_id) finish(null, result);
        } catch { finish(Error('曲目信息无效，请重新查找')); }
      });
      es.addEventListener('done', () => finish(Error('未找到相同版本，请重新查找')));
      es.addEventListener('source_error', () => finish(Error('音乐来源暂不可用，请重试')));
      es.onerror = () => finish(Error('连接失败，请重试'));
    });
  }
  async function resolveLocal(track, signal) {
    const response = await fetch('/api/library', { signal });
    if (!response.ok) throw Error('无法读取本地音乐，请重试');
    const data = await response.json();
    const match = data.tracks.find(t => t.relative === track.relative && t.restore_key === track.restore_key);
    if (!track.restore_key || !match) throw Error('文件已更改或移走，请从本地音乐重新选择');
    return match;
  }
  return { normalize, read, write, sourceSelection, resolveRemote, resolveLocal };
})();
