'use strict';

// Only durable identity and display metadata belong in a favorite.
const FavoritesState = (() => {
  const storageKey = 'soundtrack-favorites-v1';
  const limit = 200;
  const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
  function key(item) {
    if (!item || typeof item !== 'object') return '';
    if (item.local === true) return validText(item.relative) && validText(item.restore_key)
      ? JSON.stringify(['local', item.relative, item.restore_key]) : '';
    return validText(item.identity) && validText(item.source_id) && /^[A-Za-z0-9]+$/.test(item.source_id)
      ? JSON.stringify(['remote', item.source_id, item.identity]) : '';
  }
  function metadata(item) {
    if (!key(item) || !validText(item.song_name)) return null;
    const fields = item.local === true ? ['relative', 'restore_key'] : ['source_id', 'identity'];
    return Object.fromEntries(['song_name', 'singers', 'album', 'ext', ...fields]
      .map(field => [field, typeof item[field] === 'string' ? item[field].slice(0, 500) : ''])
      .concat([['local', item.local === true]]));
  }
  function read() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return { items: [], error: '' };
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Array.isArray(value.items) || value.items.length > limit) throw Error();
      const items = value.items.map(metadata);
      if (items.some(item => !item) || new Set(items.map(key)).size !== items.length) throw Error();
      return { items, error: '' };
    } catch {
      return { items: [], error: '无法读取收藏，原记录未改动。请检查浏览器存储权限或备份后恢复收藏数据。' };
    }
  }
  function save(items, previous, counts) {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, items }));
      return { items, error: '', ...counts };
    } catch {
      return { ...previous, error: '收藏未保存，原记录未改动。请检查浏览器存储权限或可用空间。', added: 0, removed: 0 };
    }
  }
  function add(candidates) {
    const previous = read();
    if (previous.error) return previous;
    const items = [...previous.items], keys = new Set(items.map(key));
    let added = 0, skipped = 0;
    for (const candidate of candidates) {
      const item = metadata(candidate);
      if (!item) { skipped++; continue; }
      if (keys.has(key(item))) continue;
      if (items.length >= limit) { skipped++; continue; }
      items.unshift(item); keys.add(key(item)); added++;
    }
    return added ? save(items, previous, { added, skipped }) : { ...previous, added, skipped };
  }
  function remove(item) {
    const previous = read();
    if (previous.error) return previous;
    const items = previous.items.filter(saved => key(saved) !== key(item));
    return items.length === previous.items.length ? { ...previous, removed: 0 }
      : save(items, previous, { removed: 1 });
  }
  return { storageKey, limit, key, read, add, remove };
})();
