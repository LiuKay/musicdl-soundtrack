'use strict';

// Display groups never replace a provider's durable track identity.
const SearchModel = (() => {
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/\s+/g, ' ').trim().replace(/[（]/g, '(').replace(/[）]/g, ')');
  function duration(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    if (!/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(value || '')) return 0;
    return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }
  function preview(track) {
    return track.preview === true ? 'confirmed' : track.preview_suspected === true ? 'suspected' : '';
  }
  function quality(track) {
    const format = String(track.ext || '').toUpperCase();
    const rate = Number(track.bitrate_kbps);
    return [format, track.lossless ? '无损' : rate > 0 ? `${rate} kbps` : ''].filter(Boolean).join(' · ');
  }
  function compatible(a, b) {
    const secondsA = duration(a.duration), secondsB = duration(b.duration);
    return normalize(a.song_name) !== '' && normalize(a.singers) !== ''
      && !['未知曲目', '未知艺人'].includes(a.song_name) && a.singers !== '未知艺人'
      && normalize(a.song_name) === normalize(b.song_name)
      && normalize(a.singers) === normalize(b.singers)
      && normalize(a.album) === normalize(b.album)
      && secondsA > 0 && secondsB > 0 && Math.abs(secondsA - secondsB) <= 2
      && preview(a) === preview(b);
  }
  function rank(track) {
    return [preview(track) ? 1 : 0, track.lossless ? 0 : 1, -(Number(track.bitrate_kbps) || 0)];
  }
  function compare(a, b) {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }
  function groups(items, filters = {}, downloaded = new Set()) {
    const result = [];
    for (const track of items) {
      if (filters.lossless && !track.lossless || filters.downloaded && downloaded.has(track.token)
          || filters.preview && preview(track)) continue;
      // Compare every member to avoid merging a chain of different durations.
      const group = result.find(group => group.items.every(item => compatible(item, track)));
      if (group) group.items.push(track);
      else result.push({ id: track.token, items: [track] });
    }
    for (const group of result) group.items.sort(compare);
    return result.sort((a, b) => Number(Boolean(preview(a.items[0]))) - Number(Boolean(preview(b.items[0]))));
  }
  return { normalize, duration, preview, quality, compatible, compare, groups };
})();
