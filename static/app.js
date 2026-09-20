'use strict';

/* ------------------------------------------------------------------ */
/* state + refs                                                        */
/* ------------------------------------------------------------------ */
const $ = (s) => document.querySelector(s);
const audio = $('#audio');
const tracks = new Map();          // token -> payload
let queue = [];                    // ordered tokens (play order)
let activeQueue = [];              // independent from search results
let libraryQueue = [];
let libraryRequestId = 0;
let shuffleEnabled = false;
let shuffleOrder = [];
let repeatMode = 'off';            // off | all | one
const selectedTokens = new Set();
const downloadingTokens = new Set();
const batchTokens = new Set();
const sourceStates = new Map();
let batchDownloading = false;
let currentToken = null;
let searchES = null;
let sources = [];
let desktopReady = false;

const cacheToggle = $('#cacheToggle');
const cacheLimit = $('#cacheLimit');
const savedCacheLimit = localStorage.getItem('soundtrack-cache-limit');
cacheToggle.checked = localStorage.getItem('soundtrack-cache-enabled') === '1';
if ([...cacheLimit.options].some(o => o.value === savedCacheLimit)) cacheLimit.value = savedCacheLimit;
cacheToggle.onchange = () => localStorage.setItem('soundtrack-cache-enabled', cacheToggle.checked ? '1' : '0');
cacheLimit.onchange = () => localStorage.setItem('soundtrack-cache-limit', cacheLimit.value);
const downloadConcurrency = $('#downloadConcurrency');
const savedDownloadConcurrency = localStorage.getItem('soundtrack-download-concurrency');
if ([...downloadConcurrency.options].some(o => o.value === savedDownloadConcurrency)) {
  downloadConcurrency.value = savedDownloadConcurrency;
}
async function syncDownloadConcurrency(showToast = false) {
  try {
    await fetch('/api/download/concurrency', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: Number(downloadConcurrency.value) })
    }).then(r => r.json());
    localStorage.setItem('soundtrack-download-concurrency', downloadConcurrency.value);
    if (showToast) toast(`同时下载数：${downloadConcurrency.value}`);
  } catch {
    if (showToast) toast('无法更新同时下载数');
  }
}
downloadConcurrency.onchange = () => syncDownloadConcurrency(true);
syncDownloadConcurrency();

/* ------------------------------------------------------------------ */
/* sources / chips                                                     */
/* ------------------------------------------------------------------ */
async function loadSources() {
  try {
    const response = await fetch('/api/sources');
    if (!response.ok) throw new Error('sources unavailable');
    sources = await response.json();
  } catch {
    $('#sourceHelp').textContent = '音乐来源加载失败，请刷新重试。';
    toast('音乐来源加载失败，请刷新重试');
    return;
  }
  const wrap = $('#chips');
  wrap.innerHTML = '';
  sources.forEach(src => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (src.default ? ' on' : '');
    chip.dataset.id = src.id;
    chip.innerHTML = `<span class="dot" aria-hidden="true"></span>${esc(src.label)}`;
    chip.setAttribute('aria-pressed', String(src.default));
    chip.onclick = () => {
      chip.classList.toggle('on');
      if (!document.querySelectorAll('.chip.on').length) chip.classList.add('on');
      chip.setAttribute('aria-pressed', String(chip.classList.contains('on')));
    };
    wrap.appendChild(chip);
  });
  $('#sourceHelp').textContent = '至少保留一个来源，搜索时同时查找。';
}
function activeSources() {
  return [...document.querySelectorAll('.chip.on')].map(c => c.dataset.id);
}

/* ------------------------------------------------------------------ */
/* search (real-time SSE stream)                                       */
/* ------------------------------------------------------------------ */
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
document.querySelectorAll('[data-query]').forEach(button => {
  button.onclick = () => { $('#searchInput').value = button.dataset.query; runSearch(); };
});
$('#browseButton').onclick = () => { setPanel(null); $('#searchInput').focus(); };

function showSearchMessage(title, message) {
  $('#resultsHead').hidden = true;
  $('#placeholder').hidden = false;
  $('#placeholder h2').textContent = title;
  $('#placeholder p').textContent = message;
}

function runSearch() {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  if (searchES) { searchES.close(); searchES = null; }

  queue = [];
  selectedTokens.clear();
  pruneTracks();
  updateSelection();
  sourceStates.clear();
  $('#results').innerHTML = '';
  $('#spotlight').hidden = true;
  $('#pageTitle').textContent = q;
  $('.results-wrap').scrollTop = 0;
  $('#placeholder').hidden = true;
  $('#resultsHead').hidden = false;
  $('#searchBtn').disabled = true;

  const srcs = activeSources();
  srcs.forEach(id => setSourceState(id, 'busy', '等待响应'));
  const pending = new Set(srcs);
  let count = 0;
  let finished = false;
  setStatus(true, '搜索中…');

  const url = `/api/search?q=${encodeURIComponent(q)}&sources=${srcs.join(',')}`;
  const es = new EventSource(url);
  searchES = es;

  es.addEventListener('result', (ev) => {
    if (searchES !== es) return;
    const t = JSON.parse(ev.data);
    tracks.set(t.token, t);
    queue.push(t.token);
    addRow(t);
    updateSelection();
    if (count === 0) showSpotlight(t);
    count++;
    setStatus(true, `已找到 ${count} 首…`);
  });
  es.addEventListener('source_start', (ev) => {
    if (searchES !== es) return;
    setSourceState(JSON.parse(ev.data).source, 'busy', '搜索中');
  });
  es.addEventListener('source_done', (ev) => {
    if (searchES !== es) return;
    const d = JSON.parse(ev.data);
    pending.delete(d.source);
    setSourceState(d.source, d.timed_out || d.error_count ? 'warning' : 'done',
      `${d.count || 0} 首${d.timed_out ? ' · 超时' : d.error_count ? ' · 部分请求失败' : ' · 完成'}`);
  });
  es.addEventListener('source_error', (ev) => {
    if (searchES !== es) return;
    const d = JSON.parse(ev.data);
    pending.delete(d.source);
    setSourceState(d.source, 'error', '连接失败，请重试');
  });
  es.addEventListener('done', () => {
    if (searchES !== es) return;
    finished = true;
    es.close(); searchES = null;
    $('#searchBtn').disabled = false;
    if (count === 0) {
      const failed = [...sourceStates.values()].some(s => ['error', 'warning'].includes(s.state));
      showSearchMessage(failed ? '部分来源未能完成搜索' : '没有找到结果',
        failed ? '查看上方来源状态，稍后重试或换个音乐来源。' : '换个关键词，或启用更多音乐来源再试试。');
      setStatus(false, '');
    } else {
      setStatus(false, `共 ${count} 首`);
    }
  });
  es.onerror = () => {
    if (finished || searchES !== es) return;
    pending.forEach(id => setSourceState(id, 'error', '连接中断'));
    es.close(); searchES = null;
    $('#searchBtn').disabled = false;
    setStatus(false, count ? `共 ${count} 首` : '');
    if (count === 0) showSearchMessage('连接暂时中断', '请重新搜索，或切换音乐来源后再试。');
  };
}

function setSourceState(id, state, text) {
  sourceStates.set(id, { state, text });
  renderSourceStates();
}

function renderSourceStates() {
  const wrap = $('#sourceStatusList');
  wrap.replaceChildren();
  sourceStates.forEach(({ state, text }, id) => {
    const status = document.createElement('span');
    status.className = 'source-state ' + state;
    status.textContent = `${sources.find(s => s.id === id)?.label || id} · ${text}`;
    wrap.appendChild(status);
  });
  wrap.hidden = sourceStates.size === 0;
}

function pruneTracks() {
  const keep = new Set([...queue, ...activeQueue, ...libraryQueue, ...downloadingTokens, ...batchTokens, currentToken]);
  for (const token of tracks.keys()) { if (!keep.has(token)) tracks.delete(token); }
}

function updateSelection() {
  const count = queue.filter(token => selectedTokens.has(token)).length;
  $('#resultsToolbar').hidden = queue.length === 0;
  $('#selectionCount').textContent = count ? `已选 ${count} 首` : `${queue.length} 首歌曲`;
  $('#selectAll').checked = queue.length > 0 && count === queue.length;
  $('#selectAll').indeterminate = count > 0 && count < queue.length;
  $('#downloadSelected').disabled = !count || batchDownloading;
  $('#downloadSelected').textContent = batchDownloading ? '正在添加…' : '下载所选';
}

$('#selectAll').onchange = e => {
  queue.forEach(token => e.target.checked ? selectedTokens.add(token) : selectedTokens.delete(token));
  document.querySelectorAll('.row-select').forEach(input => { input.checked = e.target.checked; });
  updateSelection();
};
async function downloadSelected() {
  if (batchDownloading) return;
  const tokens = queue.filter(token => selectedTokens.has(token));
  batchDownloading = true;
  tokens.forEach(token => batchTokens.add(token));
  updateSelection();
  let started = 0;
  try {
    for (const token of tokens) {
      if (await startDownload(token)) { started++; selectedTokens.delete(token); }
    }
  } finally {
    batchTokens.clear();
    batchDownloading = false;
    document.querySelectorAll('.row').forEach(row => { row.querySelector('.row-select').checked = selectedTokens.has(row.dataset.token); });
    updateSelection();
    pruneTracks();
    toast(`已添加 ${started} / ${tokens.length} 首到下载任务`);
  }
}
$('#downloadSelected').onclick = downloadSelected;
$('#playAll').onclick = () => { if (queue.length) play(queue[0], queue); };

function showSpotlight(t) {
  $('#spotlight').hidden = false;
  $('#spotlightTitle').textContent = t.song_name;
  $('#spotlightArtist').textContent = [t.singers, t.album].filter(Boolean).join(' · ');
  const cover = $('#spotlightCover');
  cover.textContent = '♪';
  if (t.cover_url) {
    const img = new Image(148, 148);
    img.alt = t.album || t.song_name;
    img.src = `/api/cover/${t.token}`;
    img.onload = () => { if (queue[0] === t.token) cover.replaceChildren(img); };
  }
  $('#spotlightPlay').innerHTML = ICON_PLAY + '播放歌曲';
  $('#spotlightPlay').onclick = () => play(t.token);
}

function setStatus(busy, text) {
  const el = $('#searchStatus');
  el.innerHTML = (busy ? '<span class="spin"></span>' : '') + (text || '');
}

/* ------------------------------------------------------------------ */
/* result rows                                                         */
/* ------------------------------------------------------------------ */
function addRow(t) {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.token = t.token;
  const cover = t.cover_url
    ? `<img src="/api/cover/${t.token}" alt="" width="42" height="42" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="ph" style="display:none">♪</span>`
    : `<span class="ph">♪</span>`;
  li.innerHTML = `
    <label class="row-selection"><input class="row-select" type="checkbox" aria-label="选择 ${esc(t.song_name)}"></label>
    <div class="r-cover">
      ${cover}
      <span class="eq"><i></i><i></i><i></i></span>
    </div>
    <div class="r-title">
      <div class="name">${esc(t.song_name)}</div>
      <div class="artist">${esc(t.singers)}</div>
    </div>
    <div class="r-album">${esc(t.album) || '—'}</div>
    <div class="r-dur">${esc(t.duration) || '—'}</div>
    <div class="r-size ${t.lossless ? 'lossless' : ''}">${esc(t.file_size) || '—'}</div>
    <div class="r-src"><span class="tag">${esc(t.source)}</span></div>
    <div class="r-act">
      <button class="a-play" title="播放" aria-label="播放 ${esc(t.song_name)}">${ICON_PLAY}</button>
      <button class="a-next" title="下一首播放" aria-label="下一首播放 ${esc(t.song_name)}">${ICON_QUEUE}</button>
      <button class="a-dl" title="下载" aria-label="下载 ${esc(t.song_name)}">${ICON_DL}</button>
    </div>`;
  li.querySelector('.a-play').onclick = (e) => { e.stopPropagation(); play(t.token); };
  li.querySelector('.a-dl').onclick = (e) => { e.stopPropagation(); startDownload(t.token, e.currentTarget); };
  li.querySelector('.a-next').onclick = () => enqueueNext(t.token);
  li.querySelector('.row-select').onchange = e => {
    e.target.checked ? selectedTokens.add(t.token) : selectedTokens.delete(t.token);
    updateSelection();
  };
  li.ondblclick = e => { if (!e.target.closest('button, input, label')) play(t.token); };
  $('#results').appendChild(li);
}

const ICON_PLAY = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const ICON_DL = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3v10m0 0l-4-4m4 4l4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_FOLDER = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 6h7l2 2h9v10H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_QUEUE = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 6h16M4 11h9M4 16h7m6-3v8m-4-4h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ */
/* playback + Web Audio visualizer                                     */
/* ------------------------------------------------------------------ */
let audioCtx = null, analyser = null, gainNode = null, srcNode = null, vizData = null, vizRAF = null;

function ensureAudioGraph() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();
  srcNode = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = Number($('#volTrack').getAttribute('aria-valuenow')) / 100;
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.8;
  srcNode.connect(analyser);
  analyser.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  vizData = new Uint8Array(analyser.frequencyBinCount);
  drawViz();
}

function play(token, playQueue = null) {
  const t = tracks.get(token);
  if (!t) return;
  if (playQueue !== null) activeQueue = [...new Set(playQueue)].filter(id => tracks.has(id));
  else if (!activeQueue.includes(token)) activeQueue = [...queue];
  if (!activeQueue.includes(token)) activeQueue.push(token);
  if (playQueue !== null || !shuffleOrder.includes(token)) resetShuffle(token);
  currentToken = token;
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const cacheQuery = cacheToggle.checked
    ? `?cache=1&cache_max_mb=${cacheLimit.value}`
    : '';
  audio.src = t.stream_url || `/api/stream/${token}${cacheQuery}`;
  audio.play().catch(() => toast('无法播放该曲目'));

  // now-playing meta
  $('#player').dataset.empty = 'false';
  $('#npTitle').textContent = t.song_name;
  $('#npArtist').textContent = t.singers;
  const cv = $('#npCover');
  cv.innerHTML = `<div class="np-cover-fallback">♪</div>`;
  if (t.cover_url) {
    const img = new Image(56, 56);
    img.alt = t.album || t.song_name;
    img.onload = () => {
      if (currentToken === token) { cv.innerHTML = ''; cv.appendChild(img); }
    };
    img.src = t.local ? t.cover_url : `/api/cover/${token}`;
  }

  document.querySelectorAll('.row.playing,.library-item.playing').forEach(r => r.classList.remove('playing'));
  const row = document.querySelector(`[data-token="${token}"]`);
  if (row) row.classList.add('playing');

  if (t.local) showLyrics(t.lyric);
  else loadLyrics(token);
  renderQueue();
}

function resetShuffle(first = currentToken) {
  shuffleOrder = activeQueue.filter(token => token !== first);
  for (let i = shuffleOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]];
  }
  if (activeQueue.includes(first)) shuffleOrder.unshift(first);
}

function nextToken(order, token, dir, mode, automatic = false) {
  if (!order.length) return null;
  if (automatic && mode === 'one' && order.includes(token)) return token;
  const index = order.indexOf(token);
  const next = index + dir;
  if (next >= 0 && next < order.length) return order[next];
  return mode === 'all' ? order[(next + order.length) % order.length] : null;
}

function step(dir, automatic = false) {
  if (!currentToken) return;
  const order = shuffleEnabled ? shuffleOrder : activeQueue;
  const next = nextToken(order, currentToken, dir, repeatMode, automatic);
  if (next) play(next);
}

function enqueueNext(token) {
  if (!tracks.has(token) || token === currentToken) return;
  activeQueue = activeQueue.filter(id => id !== token);
  activeQueue.splice(Math.max(0, activeQueue.indexOf(currentToken) + 1), 0, token);
  shuffleOrder = shuffleOrder.filter(id => id !== token);
  shuffleOrder.splice(Math.max(0, shuffleOrder.indexOf(currentToken) + 1), 0, token);
  renderQueue();
  toast('已加入下一首播放');
}

function removeFromQueue(token) {
  if (token === currentToken) return;
  activeQueue = activeQueue.filter(id => id !== token);
  shuffleOrder = shuffleOrder.filter(id => id !== token);
  renderQueue();
  pruneTracks();
}

function renderQueue() {
  const list = $('#queueList');
  list.replaceChildren();
  const order = shuffleEnabled ? shuffleOrder : activeQueue;
  $('#queueCount').textContent = order.length;
  if (!order.length) { list.innerHTML = '<li class="dl-empty">队列还是空的<br>播放一首歌曲，或将它加入下一首。</li>'; return; }
  order.forEach(token => {
    const t = tracks.get(token);
    if (!t) return;
    const item = document.createElement('li');
    item.className = 'queue-item' + (token === currentToken ? ' current' : '');
    item.innerHTML = `<button class="queue-play" aria-label="播放 ${esc(t.song_name)}"><span>${esc(t.song_name)}</span><small>${esc(t.singers)}</small></button><button class="queue-remove" aria-label="从队列移除 ${esc(t.song_name)}" ${token === currentToken ? 'disabled title="当前曲目会保留"' : ''}>${ICON_TRASH}</button>`;
    item.querySelector('.queue-play').onclick = () => play(token);
    item.querySelector('.queue-remove').onclick = () => removeFromQueue(token);
    list.appendChild(item);
  });
}

$('#shuffleBtn').onclick = () => {
  shuffleEnabled = !shuffleEnabled;
  if (shuffleEnabled) resetShuffle();
  $('#shuffleBtn').setAttribute('aria-pressed', String(shuffleEnabled));
  renderQueue();
};
$('#repeatBtn').onclick = () => {
  repeatMode = { off: 'all', all: 'one', one: 'off' }[repeatMode];
  const label = { off: '顺序播放', all: '列表循环', one: '单曲循环' }[repeatMode];
  $('#repeatBtn').setAttribute('aria-label', label);
  $('#repeatBtn').title = label;
  $('#repeatBtn').dataset.mode = repeatMode;
  $('#repeatBtn').setAttribute('aria-pressed', String(repeatMode !== 'off'));
  toast(label);
};
$('#queueToggle').onclick = () => { renderQueue(); setPanel($('#queuePanel').classList.contains('open') ? null : 'queuePanel'); };
$('#queueClose').onclick = () => setPanel(null);
$('#clearQueue').onclick = () => {
  activeQueue = currentToken ? [currentToken] : [];
  resetShuffle(); renderQueue(); pruneTracks();
};

$('#playBtn').onclick = () => {
  if (!currentToken) { const first = activeQueue[0] || queue[0]; if (first) play(first); return; }
  if (audio.paused) { if (audioCtx?.state === 'suspended') audioCtx.resume(); audio.play(); }
  else audio.pause();
};
$('#prevBtn').onclick = () => step(-1);
$('#nextBtn').onclick = () => step(1);
audio.addEventListener('ended', () => step(1, true));
audio.addEventListener('play', () => syncPlayIcon(true));
audio.addEventListener('pause', () => syncPlayIcon(false));

function syncPlayIcon(playing) {
  $('.ic-play').toggleAttribute('hidden', playing);
  $('.ic-pause').toggleAttribute('hidden', !playing);
  $('#playBtn').setAttribute('aria-label', playing ? '暂停' : '播放');
  document.body.classList.toggle('audio-playing', playing);
}

/* time + seek */
audio.addEventListener('loadedmetadata', () => { $('#durTime').textContent = fmt(audio.duration); });
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $('#curTime').textContent = fmt(c);
  const p = d ? (c / d) * 100 : 0;
  $('#seekFill').style.width = p + '%';
  $('#seekKnob').style.left = p + '%';
  $('#seekTrack').setAttribute('aria-valuenow', String(Math.round(p)));
  $('#seekTrack').setAttribute('aria-valuetext', `${fmt(c)} / ${fmt(d)}`);
  syncLyric(c);
});
function fmt(s) { if (!isFinite(s)) return '0:00'; s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

dragControl($('#seekTrack'), (ratio) => { if (audio.duration) audio.currentTime = ratio * audio.duration; });
const volFill = $('#volFill');
dragControl($('#volTrack'), (ratio) => { if (gainNode) gainNode.gain.value = ratio; volFill.style.width = (ratio * 100) + '%'; });

function dragControl(track, onSet) {
  const set = (ratio) => {
    onSet(ratio);
    track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  };
  const handle = (e) => {
    const rect = track.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    set(Math.min(1, Math.max(0, x / rect.width)));
  };
  let dragging = false;
  const down = (e) => { dragging = true; handle(e); e.preventDefault(); };
  track.addEventListener('mousedown', down);
  track.addEventListener('touchstart', down, { passive: false });
  window.addEventListener('mousemove', (e) => dragging && handle(e));
  window.addEventListener('touchmove', (e) => dragging && handle(e), { passive: false });
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('touchend', () => dragging = false);
  window.addEventListener('touchcancel', () => dragging = false);
  track.addEventListener('keydown', e => {
    const value = Number(track.getAttribute('aria-valuenow')) / 100;
    if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.altKey) return;
    e.preventDefault();
    set(e.key === 'Home' ? 0 : e.key === 'End' ? 1 : Math.max(0, Math.min(1,
      value + (['ArrowLeft', 'ArrowDown'].includes(e.key) ? -.05 : .05))));
  });
}

/* visualizer */
function drawViz() {
  const canvas = $('#viz'), ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width = 220 * dpr, H = canvas.height = 44 * dpr;
  const render = () => {
    vizRAF = requestAnimationFrame(render);
    ctx.clearRect(0, 0, W, H);
    const bars = 40;
    let data;
    if (analyser && !audio.paused) { analyser.getByteFrequencyData(vizData); data = vizData; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    ctx.fillStyle = '#c92c48';
    const gap = 2 * dpr, bw = (W - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      let v;
      if (data) { v = (data[Math.floor(i * data.length / bars)] / 255); }
      else { v = 0.06 + 0.04 * Math.abs(Math.sin(Date.now() / 600 + i)); }
      const bh = Math.max(2 * dpr, v * H);
      const x = i * (bw + gap), y = (H - bh) / 2;
      const r = Math.min(bw / 2, 2 * dpr);
      roundRect(ctx, x, y, bw, bh, r); ctx.fill();
    }
  };
  render();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* lyrics (synced LRC)                                                 */
/* ------------------------------------------------------------------ */
let lyricLines = [];   // {t, text}
let lyricActive = -1;

function showNoLyrics() {
  lyricLines = []; lyricActive = -1;
  $('#lyricsScroll').innerHTML = '<div class="empty">暂无歌词</div>';
}

function showLyrics(lyric) {
  lyricLines = parseLRC(lyric);
  lyricActive = -1;
  const scroll = $('#lyricsScroll');
  if (!lyricLines.length) { showNoLyrics(); return; }
  scroll.innerHTML = '';
  lyricLines.forEach((line, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lr';
    item.dataset.i = index;
    item.textContent = line.text;
    item.onclick = () => { if (audio.duration) audio.currentTime = line.t; };
    scroll.appendChild(item);
  });
}

async function loadLyrics(token) {
  lyricLines = []; lyricActive = -1;
  const scroll = $('#lyricsScroll');
  scroll.innerHTML = '<div class="empty">加载歌词…</div>';
  try {
    const { lyric } = await fetch(`/api/lyric/${token}`).then(r => r.json());
    if (currentToken === token) showLyrics(lyric);
  } catch {
    if (currentToken === token) scroll.innerHTML = '<div class="empty">暂无歌词</div>';
  }
}
function parseLRC(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const times = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const m of times) {
      const t = (+m[1]) * 60 + (+m[2]) + (m[3] ? (+('0.' + m[3])) : 0);
      out.push({ t, text: content });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
function syncLyric(c) {
  if (!lyricLines.length) return;
  let idx = -1;
  for (let i = 0; i < lyricLines.length; i++) { if (lyricLines[i].t <= c + 0.2) idx = i; else break; }
  if (idx === lyricActive) return;
  lyricActive = idx;
  const scroll = $('#lyricsScroll');
  scroll.querySelectorAll('.lr.active').forEach(e => e.classList.remove('active'));
  const el = scroll.querySelector(`.lr[data-i="${idx}"]`);
  if (el) {
    el.classList.add('active');
    if ($('#lyricsPanel').classList.contains('open')) {
      const top = el.offsetTop - scroll.clientHeight / 2 + el.clientHeight / 2;
      scroll.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
}
function setPanel(name) {
  [['lyricsPanel', 'lyricsToggle', 'lyricsClose'], ['dlDrawer', 'downloadsButton', 'dlClose'], ['queuePanel', 'queueToggle', 'queueClose']].forEach(([id, trigger, close]) => {
    const open = name === id;
    const panel = $('#' + id);
    const restoreFocus = !open && panel.contains(document.activeElement);
    panel.classList.toggle('open', open);
    panel.inert = !open;
    $('#' + trigger).classList.toggle('on', open);
    $('#' + trigger).setAttribute('aria-expanded', String(open));
    if (restoreFocus) $('#' + trigger).focus();
    if (open) $('#' + close).focus();
  });
}
$('#lyricsToggle').onclick = () => setPanel($('#lyricsPanel').classList.contains('open') ? null : 'lyricsPanel');
$('#lyricsClose').onclick = () => setPanel(null);

/* ------------------------------------------------------------------ */
/* downloads                                                           */
/* ------------------------------------------------------------------ */
let dlCount = 0;
const fab = $('#downloadsButton');
fab.onclick = () => {
  setPanel($('#dlDrawer').classList.contains('open') ? null : 'dlDrawer');
  if ($('#dlDrawer').classList.contains('open')) loadLibrary();
};
$('#dlClose').onclick = () => setPanel(null);

async function loadLibrary() {
  const requestId = ++libraryRequestId;
  const list = $('#libraryList');
  try {
    const data = await fetch('/api/library').then(r => r.json());
    if (requestId !== libraryRequestId) return;
    $('#downloadDir').textContent = data.directory;
    const validLocal = new Set(data.tracks.map(t => t.token));
    for (const token of libraryQueue) {
      if (!validLocal.has(token)) {
        if (currentToken === token) clearLocalPlayback();
        activeQueue = activeQueue.filter(id => id !== token);
        shuffleOrder = shuffleOrder.filter(id => id !== token);
        tracks.delete(token);
      }
    }
    libraryQueue = [];
    list.innerHTML = '';
    $('#libraryCount').textContent = data.tracks.length;
    if (!data.tracks.length) {
      list.innerHTML = '<li class="dl-empty">暂无已下载歌曲</li>';
      renderQueue();
      return;
    }
    data.tracks.forEach(t => {
      tracks.set(t.token, t);
      libraryQueue.push(t.token);
      const li = document.createElement('li');
      li.className = 'library-item' + (desktopReady ? ' desktop' : '') + (currentToken === t.token ? ' playing' : '');
      li.dataset.token = t.token;
      li.innerHTML = `
        <div class="library-meta">
          <div class="library-name">${esc(t.song_name)}</div>
          <div class="library-sub">${esc(t.singers) || esc(t.source) || '本地音频'} · ${mb(t.file_size_bytes)}</div>
        </div>
        <button class="library-play" type="button" aria-label="播放 ${esc(t.song_name)}">${ICON_PLAY}</button>
        <button class="library-reveal" type="button" aria-label="在文件夹中显示 ${esc(t.song_name)}" ${desktopReady ? '' : 'hidden'}>${ICON_FOLDER}</button>
        <button class="library-delete" type="button" aria-label="删除 ${esc(t.song_name)}">${ICON_TRASH}</button>`;
      li.querySelector('.library-play').onclick = () => play(t.token, libraryQueue);
      li.querySelector('.library-reveal').onclick = async (e) => {
        e.currentTarget.disabled = true;
        try {
          const revealed = await window.pywebview.api.reveal_downloaded_file(t.relative);
          if (!revealed) throw new Error();
        } catch {
          toast('无法定位文件');
        } finally {
          e.currentTarget.disabled = false;
        }
      };
      li.querySelector('.library-delete').onclick = async (e) => {
        if (!confirm(`删除“${t.song_name}”及其本地文件？`)) return;
        e.currentTarget.disabled = true;
        try {
          if (currentToken === t.token) clearLocalPlayback();
          const response = await fetch(t.delete_url, { method: 'DELETE' });
          if (!response.ok) throw new Error();
          await loadLibrary();
          toast('已删除：' + t.song_name);
        } catch {
          e.currentTarget.disabled = false;
          toast('删除失败');
        }
      };
      li.ondblclick = (e) => { if (!e.target.closest('button')) play(t.token, libraryQueue); };
      list.appendChild(li);
    });
    renderQueue();
    pruneTracks();
  } catch {
    if (requestId !== libraryRequestId) return;
    list.innerHTML = '<li class="dl-empty">读取下载目录失败</li>';
  }
}

function clearLocalPlayback() {
  activeQueue = activeQueue.filter(token => token !== currentToken);
  shuffleOrder = shuffleOrder.filter(token => token !== currentToken);
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  currentToken = null;
  $('#player').dataset.empty = 'true';
  $('#npTitle').textContent = '未在播放';
  $('#npArtist').textContent = '选择一首歌开始';
  showNoLyrics();
  renderQueue();
}

window.addEventListener('pywebviewready', async () => {
  desktopReady = true;
  document.querySelectorAll('.library-item').forEach(item => item.classList.add('desktop'));
  document.querySelectorAll('.library-reveal').forEach(button => { button.hidden = false; });
  const button = $('#chooseDownloadDir');
  button.hidden = false;
  try {
    $('#downloadDir').textContent = await window.pywebview.api.get_download_dir();
  } catch {}
});
$('#chooseDownloadDir').onclick = async () => {
  try {
    const path = await window.pywebview.api.choose_download_dir();
    if (!path) return;
    if (tracks.get(currentToken)?.local) clearLocalPlayback();
    $('#downloadDir').textContent = path;
    await loadLibrary();
    toast('下载目录已更新');
  } catch {
    toast('无法选择下载目录');
  }
};

async function startDownload(token, btn) {
  const t = tracks.get(token);
  if (!t || downloadingTokens.has(token)) return false;
  downloadingTokens.add(token);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    downloadingTokens.delete(token);
    if (btn) btn.classList.remove('busy');
  };
  if (btn) btn.classList.add('busy');
  try {
    const res = await fetch('/api/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    }).then(r => r.json());
    if (res.error || !res.download_id) { toast(res.error || '下载启动失败'); release(); return false; }
    const item = addDlItem(t);
    trackDownload(res.download_id, item, btn, release);
    return true;
  } catch {
    toast('下载启动失败'); release(); return false;
  }
}

function addDlItem(t) {
  const list = $('#dlList');
  const empty = list.querySelector('.dl-empty'); if (empty) empty.remove();
  const li = document.createElement('li');
  li.className = 'dl-item';
  li.innerHTML = `
    <div class="dl-top">
      <div class="dl-name">${esc(t.song_name)} · ${esc(t.singers)}</div>
      <button class="dl-delete" type="button" aria-label="删除 ${esc(t.song_name)} 下载任务">${ICON_TRASH}</button>
    </div>
    <div class="dl-bar"><i></i></div>
    <div class="dl-stat"><span class="prog">准备中…</span><span class="s"></span></div>`;
  list.prepend(li);
  dlCount++; fab.classList.add('has'); fab.querySelector('.badge').textContent = dlCount;
  return li;
}

function removeDlItem(item) {
  if (!item.isConnected) return;
  item.remove();
  dlCount = Math.max(0, dlCount - 1);
  fab.querySelector('.badge').textContent = dlCount;
  if (!dlCount) {
    fab.classList.remove('has');
    $('#dlList').innerHTML = '<li class="dl-empty">暂无下载任务</li>';
  }
}

function trackDownload(id, item, btn, release = () => {}) {
  const es = new EventSource(`/api/download/${id}/progress`);
  item.querySelector('.dl-delete').onclick = async (e) => {
    if (!confirm('删除这个下载任务并清理临时文件？')) return;
    e.currentTarget.disabled = true;
    try {
      const response = await fetch(`/api/download/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      if (response.status === 202) {
        item.querySelector('.prog').textContent = '取消中…';
        return;
      }
      es.close();
      release();
      removeDlItem(item);
      if (btn) btn.classList.remove('busy');
      toast('下载任务已删除');
    } catch {
      e.currentTarget.disabled = false;
      toast('删除失败');
    }
  };
  es.addEventListener('progress', (ev) => {
    const d = JSON.parse(ev.data);
    item.classList.remove('error');
    const bar = item.querySelector('.dl-bar i');
    const prog = item.querySelector('.prog');
    const s = item.querySelector('.s');
    if (d.status === 'error') {
      item.classList.add('error'); prog.textContent = '失败';
      s.textContent = (d.message || '').slice(0, 24);
      item.querySelector('.dl-delete').disabled = false;
      es.close(); release(); if (btn) btn.classList.remove('busy'); return;
    }
    if (d.status === 'cancelling') {
      prog.textContent = '取消中…';
      s.textContent = '';
      return;
    }
    if (d.status === 'cancelled') {
      removeDlItem(item);
      release();
      es.close(); if (btn) btn.classList.remove('busy');
      toast('下载任务已删除');
      return;
    }
    if (d.status === 'queued') {
      bar.style.width = '0';
      prog.textContent = '等待中…';
      s.textContent = '';
      return;
    }
    const total = d.total || 0, done = d.downloaded || 0;
    const pct = total ? Math.min(100, done / total * 100) : 0;
    bar.style.width = (total ? pct : 8) + '%';
    prog.textContent = mb(done) + (total ? ' / ' + mb(total) : '');
    if (d.status === 'downloading' && d.speed) s.textContent = mb(d.speed) + '/s';
    if (d.status === 'done') {
      removeDlItem(item);
      release();
      loadLibrary();
      es.close(); if (btn) btn.classList.remove('busy');
      toast('下载完成：' + (d.name || ''));
    }
  });
  es.onerror = () => {
    item.classList.add('error');
    item.querySelector('.prog').textContent = '进度连接中断，正在重连';
    item.querySelector('.s').textContent = '请勿重复下载';
  };
}
function mb(b) { return (b / 1048576).toFixed(1) + 'MB'; }

/* ------------------------------------------------------------------ */
/* misc                                                                */
/* ------------------------------------------------------------------ */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function handleShortcuts(e) {
  if (e.key === 'Escape') setPanel(null);
  if (e.target.closest('input, select, textarea, [contenteditable="true"]')) return;
  if (e.altKey && ['ArrowRight', 'ArrowLeft'].includes(e.code)) {
    e.preventDefault();
    step(e.code === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (e.target.closest('button, [role="slider"]')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
}
document.addEventListener('keydown', handleShortcuts);

showNoLyrics();
loadSources();
