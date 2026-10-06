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
let libraryLoaded = false;
let libraryLoading = false;
let libraryErrorMessage = '';
let shuffleEnabled = false;
let shuffleOrder = [];
let repeatMode = 'off';            // off | all | one
const selectedTokens = new Set();
const downloadingTokens = new Set();
const batchTokens = new Set();
const formatTokens = new Set();
const sourceStates = new Map();
let batchDownloading = false;
let currentToken = null;
let searchES = null;
let sources = [];
let desktopReady = false;
const downloadTasks = new Map();
let downloadPlanning = false;
let pendingDownloadRequests = 0;
let leaveWarningEnabled = false;
let markerTimer;
let markerRequestId = 0;
const savedSession = SessionState.read();
let searchHistory = savedSession.history;
let preferredSources = savedSession.sources;
let sessionReady = false;
let playbackRequest = 0;
let playbackController = null;
let refreshAttempted = false;
function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { toast('无法保存偏好，当前会话仍可使用'); }
}
const formatPreference = $('#downloadFormatPreference');
const savedFormat = readPreference('soundtrack-download-format');
if (['mp3', 'flac', 'ask'].includes(savedFormat)) formatPreference.value = savedFormat;
formatPreference.onchange = () => {
  writePreference('soundtrack-download-format', formatPreference.value);
  scheduleDownloadMarkers();
};

const cacheToggle = $('#cacheToggle');
const cacheLimit = $('#cacheLimit');
const savedCacheLimit = readPreference('soundtrack-cache-limit');
cacheToggle.checked = readPreference('soundtrack-cache-enabled') === '1';
if ([...cacheLimit.options].some(o => o.value === savedCacheLimit)) cacheLimit.value = savedCacheLimit;
cacheToggle.onchange = () => writePreference('soundtrack-cache-enabled', cacheToggle.checked ? '1' : '0');
cacheLimit.onchange = () => writePreference('soundtrack-cache-limit', cacheLimit.value);
const downloadConcurrency = $('#downloadConcurrency');
const savedDownloadConcurrency = readPreference('soundtrack-download-concurrency');
if ([...downloadConcurrency.options].some(o => o.value === savedDownloadConcurrency)) {
  downloadConcurrency.value = savedDownloadConcurrency;
}
async function syncDownloadConcurrency(showToast = false) {
  try {
    await fetch('/api/download/concurrency', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: Number(downloadConcurrency.value) })
    }).then(r => r.json());
    writePreference('soundtrack-download-concurrency', downloadConcurrency.value);
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
  preferredSources = SessionState.sourceSelection(preferredSources, sources);
  sources.forEach(src => {
    const selected = preferredSources.includes(src.id);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (selected ? ' on' : '');
    chip.dataset.id = src.id;
    chip.innerHTML = `<span class="dot" aria-hidden="true"></span>${esc(src.label)}`;
    chip.setAttribute('aria-pressed', String(selected));
    chip.onclick = () => {
      chip.classList.toggle('on');
      if (!document.querySelectorAll('.chip.on').length) chip.classList.add('on');
      chip.setAttribute('aria-pressed', String(chip.classList.contains('on')));
      preferredSources = activeSources();
      saveSession();
    };
    wrap.appendChild(chip);
  });
  $('#sourceHelp').textContent = '至少保留一个来源，搜索时同时查找。';
}
function activeSources() {
  return [...document.querySelectorAll('.chip.on')].map(c => c.dataset.id);
}

function saveSession() {
  if (!sessionReady) return;
  const tokens = activeQueue.filter(token => tracks.has(token)).slice(0, 200);
  const saved = SessionState.write({
    version: 1, items: tokens.map(token => tracks.get(token)),
    current: currentToken === null ? null : tokens.indexOf(currentToken),
    order: shuffleOrder.map(token => tokens.indexOf(token)).filter(i => i >= 0),
    shuffle: shuffleEnabled, repeat: repeatMode, history: searchHistory, sources: preferredSources
  });
  $('#queueSaveStatus').textContent = saved ? '自动保留前 200 首，恢复后暂停' : '无法保存记录，当前会话仍可使用';
}

function rememberSearch(query) {
  searchHistory = [query.slice(0, 200), ...searchHistory.filter(q => q !== query.slice(0, 200))].slice(0, 10);
  renderHistory(); saveSession();
}

function renderHistory() {
  $('#searchHistory').hidden = !searchHistory.length;
  const list = $('#historyList');
  list.replaceChildren();
  searchHistory.forEach(query => {
    const item = document.createElement('span');
    item.className = 'history-item';
    item.innerHTML = `<button class="history-search" type="button">${esc(query)}</button><button class="history-remove" type="button" aria-label="移除搜索记录 ${esc(query)}">×</button>`;
    item.querySelector('.history-search').onclick = () => { $('#searchInput').value = query; runSearch(); };
    item.querySelector('.history-remove').onclick = () => {
      searchHistory = searchHistory.filter(q => q !== query); renderHistory(); saveSession();
    };
    list.appendChild(item);
  });
}
$('#clearHistory').onclick = () => { searchHistory = []; renderHistory(); saveSession(); };

function restoreSession() {
  savedSession.items.forEach((t, i) => {
    const token = `saved-${i}`;
    tracks.set(token, { ...t, token, pendingResolution: true });
    activeQueue.push(token);
  });
  currentToken = savedSession.current === null ? null : activeQueue[savedSession.current];
  shuffleOrder = savedSession.order.map(i => activeQueue[i]);
  shuffleEnabled = savedSession.shuffle;
  repeatMode = savedSession.repeat;
  $('#shuffleBtn').setAttribute('aria-pressed', String(shuffleEnabled));
  syncRepeatMode();
  syncPlayIcon(false);
  if (currentToken) showNowPlaying(currentToken, tracks.get(currentToken));
  renderHistory();
  sessionReady = true;
  renderQueue();
}

/* ------------------------------------------------------------------ */
/* search (real-time SSE stream)                                       */
/* ------------------------------------------------------------------ */
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
document.querySelectorAll('[data-query]').forEach(button => {
  button.onclick = () => { $('#searchInput').value = button.dataset.query; runSearch(); };
});
$('#browseButton').onclick = () => { setView('search'); $('#searchInput').focus(); };

function setView(view) {
  setPanel(null);
  for (const [name, button] of [['search', 'browseButton'], ['library', 'libraryButton']]) {
    const selected = view === name;
    $('#' + name + 'View').hidden = !selected;
    $('#' + button).classList.toggle('selected', selected);
    if (selected) $('#' + button).setAttribute('aria-current', 'page');
    else $('#' + button).removeAttribute('aria-current');
  }
  document.body.dataset.view = view;
  $('.results-wrap').scrollTop = 0;
}

async function openLibrary() {
  setView('library');
  $('#librarySearch').focus();
  await loadLibrary();
}
$('#libraryButton').onclick = $('#openLocalLibrary').onclick = openLibrary;

function showSearchMessage(title, message) {
  $('#resultsHead').hidden = true;
  $('#placeholder').hidden = false;
  $('#placeholder h2').textContent = title;
  $('#placeholder p').textContent = message;
}

function runSearch() {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  rememberSearch(q);
  setView('search');
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
    setSourceState(d.source, 'error', sourceErrorMessage(d));
  });
  es.addEventListener('done', () => {
    if (searchES !== es) return;
    finished = true;
    es.close(); searchES = null;
    $('#searchBtn').disabled = false;
    scheduleDownloadMarkers();
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

function sourceErrorMessage(error) {
  return error.code === 'initialization_failed'
    ? '初始化失败，请检查缓存目录权限或更新应用'
    : '连接失败，请重试';
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
  const keep = new Set([...queue, ...activeQueue, ...libraryQueue, ...downloadingTokens, ...batchTokens, ...formatTokens, currentToken]);
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
  if (batchDownloading || downloadPlanning) return;
  const tokens = queue.filter(token => selectedTokens.has(token));
  if (!tokens.length) return;
  batchDownloading = true;
  tokens.forEach(token => batchTokens.add(token));
  updateSelection();
  let started = 0;
  let format = null;
  try {
    format = formatPreference.value === 'ask' ? await chooseDownloadFormat(tokens) : formatPreference.value;
    if (!format) return;
    const plan = await planDownloads(tokens, format);
    if (!plan) return;
    for (const item of plan.items) {
      if (item.status === 'active') { setPanel('dlDrawer'); await restoreDownloads(); continue; }
      if (item.status !== 'ready' && !(item.status === 'existing' && plan.duplicate && item.can_download !== false)) continue;
      if (await startDownload(item.token, null, format, plan.duplicate)) { started++; selectedTokens.delete(item.token); }
    }
  } finally {
    batchTokens.clear();
    batchDownloading = false;
    document.querySelectorAll('.row').forEach(row => { row.querySelector('.row-select').checked = selectedTokens.has(row.dataset.token); });
    updateSelection();
    pruneTracks();
    if (started) toast(`已添加 ${started} / ${tokens.length} 首；已保存或不可下载项未重复添加`);
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
      <div class="name" title="${esc(t.song_name)}">${esc(t.song_name)}</div>
      <div class="artist">${esc(t.singers)}</div>
      <div class="track-download-meta"><span>${esc(originalFormat(t).toUpperCase())}</span><span class="download-state"></span></div>
    </div>
    <div class="r-album" title="${esc(t.album)}">${esc(t.album) || '—'}</div>
    <div class="r-dur">${esc(t.duration) || '—'}</div>
    <div class="r-size ${t.lossless ? 'lossless' : ''}">${esc(t.file_size) || '—'}</div>
    <div class="r-src"><span class="tag" title="${esc(t.source_label || t.source)}">${esc(t.source_label || t.source)}</span></div>
    <div class="r-act">
      <button class="a-play" title="播放" aria-label="播放 ${esc(t.song_name)}">${ICON_PLAY}</button>
      <button class="a-next" title="下一首播放" aria-label="下一首播放 ${esc(t.song_name)}">${ICON_QUEUE}</button>
      <button class="a-dl" title="下载" aria-label="下载 ${esc(t.song_name)}">${ICON_DL}</button>
    </div>`;
  li.querySelector('.a-play').onclick = (e) => { e.stopPropagation(); play(t.token); };
  li.querySelector('.a-dl').onclick = (e) => { e.stopPropagation(); requestDownload(t.token, e.currentTarget); };
  li.querySelector('.a-next').onclick = () => enqueueNext(t.token);
  li.querySelector('.row-select').onchange = e => {
    e.target.checked ? selectedTokens.add(t.token) : selectedTokens.delete(t.token);
    updateSelection();
  };
  li.ondblclick = e => { if (!e.target.closest('button, input, label')) play(t.token); };
  $('#results').appendChild(li);
  scheduleDownloadMarkers();
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

function cancelPlaybackRequest() {
  ++playbackRequest;
  playbackController?.abort();
  playbackController = null;
}

async function play(token, playQueue = null, refresh = false) {
  const t = tracks.get(token);
  if (!t) return;
  cancelPlaybackRequest();
  const requestId = playbackRequest;
  if (!refresh) refreshAttempted = false;
  if (playQueue !== null) activeQueue = [...new Set(playQueue)].filter(id => tracks.has(id));
  else if (!activeQueue.includes(token)) activeQueue = [...queue];
  if (!activeQueue.includes(token)) activeQueue.push(token);
  if (playQueue !== null || !shuffleOrder.includes(token)) resetShuffle(token);
  currentToken = token;
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  t.resolveError = '';
  showNowPlaying(token, t);
  showNoLyrics();
  renderQueue();
  if (t.local || t.pendingResolution || refresh) {
    t.pendingResolution = true;
    const controller = new AbortController();
    playbackController = controller;
    $('#npArtist').textContent = '正在重新连接…';
    syncPlayIcon(true);
    try {
      const resolved = await (t.local ? SessionState.resolveLocal(t, controller.signal)
        : SessionState.resolveRemote(t, controller.signal));
      if (requestId !== playbackRequest) return;
      Object.assign(t, resolved, { token, playback_token: resolved.token, pendingResolution: false });
    } catch (error) {
      if (requestId !== playbackRequest) return;
      t.resolveError = error.name === 'AbortError' ? '' : error.message;
      if (t.resolveError) toast(t.resolveError);
      $('#npArtist').textContent = t.resolveError || t.singers;
      syncPlayIcon(false);
      renderQueue();
      return;
    } finally {
      if (requestId === playbackRequest) playbackController = null;
    }
  }
  showNowPlaying(token, t);
  const cacheQuery = cacheToggle.checked
    ? `?cache=1&cache_max_mb=${cacheLimit.value}`
    : '';
  audio.src = t.stream_url || `/api/stream/${t.playback_token || token}${cacheQuery}`;
  audio.play().catch(error => {
    if (requestId === playbackRequest && error.name !== 'AbortError' && !audio.error) {
      syncPlayIcon(false);
      toast('请点击播放继续');
    }
  });
  if (t.local) showLyrics(t.lyric);
  else loadLyrics(token, t.playback_token || token);
  renderQueue();
}

function showNowPlaying(token, t) {
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
    img.src = t.local ? t.cover_url : `/api/cover/${t.playback_token || token}`;
  }

  document.querySelectorAll('.row.playing,.library-item.playing').forEach(r => r.classList.remove('playing'));
  const row = document.querySelector(`[data-token="${token}"]`);
  if (row) row.classList.add('playing');

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
  saveSession();
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
    item.innerHTML = `<button class="queue-play" aria-label="播放 ${esc(t.song_name)}"><span>${esc(t.song_name)}</span><small>${esc(t.resolveError || t.singers)}</small></button>${t.resolveError && !t.local ? '<button class="queue-research" type="button">重新查找</button>' : ''}<button class="queue-remove" aria-label="从队列移除 ${esc(t.song_name)}" ${token === currentToken ? 'disabled title="当前曲目会保留"' : ''}>${ICON_TRASH}</button>`;
    item.querySelector('.queue-play').onclick = () => play(token);
    const research = item.querySelector('.queue-research');
    if (research) research.onclick = () => {
      $('#searchInput').value = `${t.song_name} ${t.singers}`.trim();
      runSearch();
    };
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
  syncRepeatMode();
  saveSession();
  toast({ off: '顺序播放', all: '列表循环', one: '单曲循环' }[repeatMode]);
};
function syncRepeatMode() {
  const label = { off: '顺序播放', all: '列表循环', one: '单曲循环' }[repeatMode];
  $('#repeatBtn').setAttribute('aria-label', label);
  $('#repeatBtn').title = label;
  $('#repeatBtn').dataset.mode = repeatMode;
  $('#repeatBtn').setAttribute('aria-pressed', String(repeatMode !== 'off'));
}
$('#queueToggle').onclick = () => { renderQueue(); setPanel($('#queuePanel').classList.contains('open') ? null : 'queuePanel'); };
$('#queueClose').onclick = () => setPanel(null);
$('#clearQueue').onclick = () => {
  activeQueue = currentToken ? [currentToken] : [];
  resetShuffle(); renderQueue(); pruneTracks();
};
$('#clearAllQueue').onclick = () => {
  clearLocalPlayback();
  activeQueue = []; shuffleOrder = [];
  renderQueue(); pruneTracks();
};

$('#playBtn').onclick = () => {
  if (!currentToken) { const first = activeQueue[0] || queue[0]; if (first) play(first); return; }
  if (playbackController) {
    cancelPlaybackRequest(); syncPlayIcon(false);
    $('#npArtist').textContent = tracks.get(currentToken)?.singers || '';
    return;
  }
  if (!audio.getAttribute('src') || tracks.get(currentToken)?.pendingResolution) { play(currentToken); return; }
  if (audio.paused) { if (audioCtx?.state === 'suspended') audioCtx.resume(); audio.play().catch(() => toast('无法播放该曲目')); }
  else audio.pause();
};
$('#prevBtn').onclick = () => step(-1);
$('#nextBtn').onclick = () => step(1);
audio.addEventListener('ended', () => step(1, true));
audio.addEventListener('play', () => syncPlayIcon(true));
audio.addEventListener('pause', () => syncPlayIcon(Boolean(playbackController)));
audio.addEventListener('error', () => {
  const t = tracks.get(currentToken);
  if (!t || !audio.error || !audio.getAttribute('src') || playbackController) return;
  if (!t.local && !refreshAttempted) {
    refreshAttempted = true;
    play(currentToken, null, true);
  } else {
    t.pendingResolution = true;
    t.resolveError = t.local ? '文件无法播放，请从本地音乐重新选择' : '重新连接后仍无法播放，请重试或重新查找';
    syncPlayIcon(false); toast(t.resolveError); renderQueue();
  }
});

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

async function loadLyrics(token, playbackToken = token) {
  lyricLines = []; lyricActive = -1;
  const scroll = $('#lyricsScroll');
  scroll.innerHTML = '<div class="empty">加载歌词…</div>';
  try {
    const { lyric } = await fetch(`/api/lyric/${playbackToken}`).then(r => r.json());
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
  if ($('#dlDrawer').classList.contains('open')) { loadLibrary(); restoreDownloads(); }
};
$('#dlClose').onclick = () => setPanel(null);

async function loadLibrary() {
  const requestId = ++libraryRequestId;
  libraryLoading = true;
  $('#refreshLibrary').disabled = true;
  renderLibrary();
  try {
    const response = await fetch('/api/library');
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (requestId !== libraryRequestId) return;
    $('#downloadDir').textContent = data.directory;
    $('#libraryDirectory').textContent = data.directory;
    const validLocal = new Set(data.tracks.map(t => t.token));
    for (const token of libraryQueue) {
      if (!validLocal.has(token)) {
        if (currentToken === token) clearLocalPlayback();
        activeQueue = activeQueue.filter(id => id !== token);
        shuffleOrder = shuffleOrder.filter(id => id !== token);
        tracks.delete(token);
      }
    }
    reconcileLocalQueue(data.tracks);
    libraryQueue = [];
    data.tracks.forEach(t => {
      tracks.set(t.token, t);
      libraryQueue.push(t.token);
    });
    libraryLoaded = true;
    libraryErrorMessage = '';
    renderQueue();
    pruneTracks();
    scheduleDownloadMarkers();
  } catch {
    if (requestId !== libraryRequestId) return;
    libraryErrorMessage = libraryLoaded ? '读取目录失败，当前显示上次读取的文件。请点击“刷新文件”重试。' : '读取目录失败，请点击“刷新文件”重试。';
  } finally {
    if (requestId === libraryRequestId) {
      libraryLoading = false;
      $('#refreshLibrary').disabled = false;
      renderLibrary();
    }
  }
}

function reconcileLocalQueue(items) {
  const keys = new Set(items.map(t => `${t.relative}\n${t.restore_key}`));
  for (const [token, t] of tracks) {
    if (!t.local || keys.has(`${t.relative}\n${t.restore_key}`)) continue;
    if (currentToken === token) clearLocalPlayback();
    activeQueue = activeQueue.filter(id => id !== token);
    shuffleOrder = shuffleOrder.filter(id => id !== token);
    tracks.delete(token);
  }
}

function selectLibraryTracks(items, query, format, sort) {
  const fold = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  const selected = items.filter(t => {
    if (format && originalFormat(t) !== format) return false;
    const text = fold([t.song_name, t.singers, t.album, t.source_label].join(' '));
    return words.every(word => text.includes(word));
  });
  const compareText = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-CN', { numeric: true });
  return selected.sort((a, b) => {
    let result = sort === 'title' ? compareText(a.song_name, b.song_name)
      : sort === 'artist' ? compareText(a.singers, b.singers) : (b.modified || 0) - (a.modified || 0);
    return result || compareText(a.song_name, b.song_name) || compareText(a.relative, b.relative);
  });
}

function visibleLibraryTracks() {
  return selectLibraryTracks(libraryQueue.map(token => tracks.get(token)).filter(Boolean),
    $('#librarySearch').value, $('#libraryFormat').value, $('#librarySort').value);
}

function renderLibrary() {
  const list = $('#libraryList');
  const visible = visibleLibraryTracks();
  const playQueue = visible.map(t => t.token);
  const filtered = Boolean($('#librarySearch').value.trim() || $('#libraryFormat').value);
  $('#libraryCount').textContent = libraryLoading ? '正在读取…'
    : `${visible.length} / ${libraryQueue.length} 首${filtered ? ' · 已筛选' : ''}`;
  $('#clearLibraryFilters').hidden = !filtered;
  $('#playLibrary').disabled = !visible.length;
  $('#libraryError').hidden = !libraryErrorMessage;
  $('#libraryError').textContent = libraryErrorMessage;
  list.replaceChildren();
  if (!visible.length) {
    const message = libraryLoading && !libraryLoaded ? '正在读取本地音乐…'
      : !libraryLoaded && libraryErrorMessage ? '暂时无法显示本地音乐'
      : !libraryQueue.length ? '还没有本地音乐。下载完成后会出现在这里。'
      : '没有符合条件的歌曲，试试其他关键词或清除筛选。';
    list.innerHTML = `<li class="dl-empty">${message}</li>`;
    return;
  }
  visible.forEach(t => {
      const li = document.createElement('li');
      li.className = 'library-item' + (desktopReady ? ' desktop' : '') + (currentToken === t.token ? ' playing' : '');
      li.dataset.token = t.token;
      li.innerHTML = `
        <div class="library-meta">
          <div class="library-name" title="${esc(t.song_name)}">${esc(t.song_name)}</div>
          <div class="library-sub">${esc([t.singers, t.album, t.source_label || t.source].filter(Boolean).join(' · ')) || '本地音频'}</div>
        </div>
        <div class="library-format">${esc(t.ext.toUpperCase())}<small>${mb(t.file_size_bytes)}</small></div>
        <button class="library-play" type="button" aria-label="播放 ${esc(t.song_name)}">${ICON_PLAY}</button>
        <button class="library-reveal" type="button" aria-label="在文件夹中显示 ${esc(t.song_name)}" ${desktopReady ? '' : 'hidden'}>${ICON_FOLDER}</button>
        <button class="library-delete" type="button" aria-label="删除本地文件 ${esc(t.song_name)}">${ICON_TRASH}</button>
        <div class="library-actions"><button class="library-export" type="button" aria-label="导出 MP3 ${esc(t.song_name)}" ${t.ext === 'mp3' ? 'hidden' : ''}>导出 MP3</button><a href="${esc(t.stream_url)}?download=1" aria-label="保存到设备 ${esc(t.song_name)}" download>保存到设备</a></div>`;
      li.querySelector('.library-play').onclick = () => play(t.token, playQueue);
      li.querySelector('.library-export').onclick = e => exportLocalMp3(t, e.currentTarget);
      li.querySelector('.library-reveal').onclick = async () => {
        try {
          const revealed = await window.pywebview.api.reveal_downloaded_file(t.relative);
          if (!revealed) throw new Error();
        } catch {
          toast('无法定位文件');
        }
      };
      li.querySelector('.library-delete').onclick = async (e) => {
        if (!confirm(`删除“${t.song_name}”及其本地文件？`)) return;
        const button = e.currentTarget;
        button.disabled = true;
        try {
          const playing = tracks.get(currentToken);
          if (playing?.local && playing.relative === t.relative) clearLocalPlayback();
          const response = await fetch(t.delete_url, { method: 'DELETE' });
          if (!response.ok) throw new Error();
          reconcileLocalQueue([...tracks.values()].filter(item => item.local && item.relative !== t.relative));
          libraryQueue = libraryQueue.filter(token => tracks.has(token));
          renderQueue();
          await loadLibrary();
          toast('已删除：' + t.song_name);
        } catch {
          button.disabled = false;
          toast('删除失败');
        }
      };
      li.ondblclick = (e) => { if (!e.target.closest('button, a')) play(t.token, playQueue); };
      list.appendChild(li);
  });
}

$('#librarySearch').oninput = renderLibrary;
$('#libraryFormat').onchange = $('#librarySort').onchange = renderLibrary;
$('#refreshLibrary').onclick = loadLibrary;
$('#clearLibraryFilters').onclick = () => {
  $('#librarySearch').value = '';
  $('#libraryFormat').value = '';
  renderLibrary();
  $('#librarySearch').focus();
};
$('#playLibrary').onclick = () => {
  const tokens = visibleLibraryTracks().map(t => t.token);
  if (tokens.length) play(tokens[0], tokens);
};

function clearLocalPlayback() {
  cancelPlaybackRequest();
  activeQueue = activeQueue.filter(token => token !== currentToken);
  shuffleOrder = shuffleOrder.filter(token => token !== currentToken);
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  currentToken = null;
  $('#player').dataset.empty = 'true';
  $('#npTitle').textContent = '未在播放';
  $('#npArtist').textContent = '选择一首歌开始';
  $('#npCover').innerHTML = '<div class="np-cover-fallback">♪</div>';
  $('#curTime').textContent = $('#durTime').textContent = '0:00';
  $('#seekFill').style.width = $('#seekKnob').style.left = '0%';
  $('#seekTrack').setAttribute('aria-valuenow', '0');
  $('#seekTrack').setAttribute('aria-valuetext', '0:00 / 0:00');
  syncPlayIcon(false);
  showNoLyrics();
  renderQueue();
}

function invalidateLibrary() {
  ++libraryRequestId; // Ignore any response started against the previous directory.
  if (tracks.get(currentToken)?.local) clearLocalPlayback();
  const local = new Set([...tracks].filter(([, t]) => t.local).map(([token]) => token));
  activeQueue = activeQueue.filter(token => !local.has(token));
  shuffleOrder = shuffleOrder.filter(token => !local.has(token));
  for (const token of local) tracks.delete(token);
  libraryQueue = [];
  libraryLoaded = false;
  libraryLoading = false;
  libraryErrorMessage = '';
  renderLibrary();
  renderQueue();
}

window.addEventListener('pywebviewready', async () => {
  desktopReady = true;
  updateLeaveWarning();
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
    invalidateLibrary();
    $('#downloadDir').textContent = path;
    $('#libraryDirectory').textContent = path;
    await loadLibrary();
    toast('下载目录已更新');
  } catch {
    toast('无法选择下载目录');
  }
};

function originalFormat(track) {
  return String(track?.ext || '').toLowerCase().replace(/^\./, '');
}

$('#downloadFormatClose').onclick = $('#downloadFormatCancel').onclick = () => $('#downloadFormatDialog').close('cancel');

async function chooseDownloadFormat(tokens) {
  const dialog = $('#downloadFormatDialog');
  if (dialog.open || !tokens.length || tokens.some(token => !tracks.has(token))) return null;
  const songs = tokens.map(token => tracks.get(token));
  const hasFlac = songs.every(song => originalFormat(song) === 'flac');
  const needsConversion = songs.some(song => originalFormat(song) !== 'mp3');
  const mp3 = $('#downloadFormatMp3'), flac = $('#downloadFormatFlac');
  $('#downloadFormatFlacOption').hidden = !hasFlac;
  flac.disabled = !hasFlac;
  mp3.checked = true;
  flac.checked = false;
  mp3.disabled = needsConversion;
  $('#downloadFormatTrack').textContent = songs.length === 1
    ? `${songs[0].song_name} · ${songs[0].singers}` : `已选 ${songs.length} 首歌曲 · 使用同一种下载格式`;
  let capability = needsConversion ? null : true;
  const update = () => {
    $('#downloadFormatConfirm').disabled = mp3.checked && mp3.disabled;
    $('#downloadFormatHelp').textContent = flac.checked ? '直接下载原始 FLAC，保留音质。'
      : !needsConversion ? '直接下载原始 MP3，不重新编码。'
      : capability === null ? '正在检查本机转换工具…'
      : capability ? '非 MP3 音频将转换为 320 kbps MP3；转换不会提升原始音质。'
      : 'MP3 转换不可用，请确认已安装 FFmpeg 和 FFprobe 后重试。';
  };
  mp3.onchange = flac.onchange = update;
  update();
  tokens.forEach(token => formatTokens.add(token));
  dialog.returnValue = '';
  return new Promise(resolve => {
    let active = true;
    dialog.addEventListener('close', () => {
      active = false;
      tokens.forEach(token => formatTokens.delete(token));
      const format = flac.checked ? 'flac' : 'mp3';
      resolve(dialog.returnValue === 'download' && !(format === 'mp3' && mp3.disabled) ? format : null);
    }, { once: true });
    dialog.showModal();
    if (!needsConversion) return;
    fetch('/api/download/formats').then(response => {
      if (!response.ok) throw new Error();
      return response.json();
    }).then(data => {
      if (!active) return;
      capability = data.mp3_conversion === true;
      mp3.disabled = !capability;
      update();
    }).catch(() => {
      if (!active) return;
      capability = false;
      update();
    });
  });
}

async function locateFile(file) {
  if (desktopReady && file.relative) {
    try {
      if (await window.pywebview.api.reveal_downloaded_file(file.relative)) return;
    } catch {}
    toast('文件未找到，请刷新资料库');
    await loadLibrary();
    return;
  }
  const url = file.file_url || `/api/library/file/${file.relative.split('/').map(encodeURIComponent).join('/')}?download=1`;
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function downloadPlanLabel(item) {
  if (item.status === 'existing') return `已下载 ${item.format.toUpperCase()} · 默认跳过`;
  if (item.status === 'active') return '任务进行中 · 不重复添加';
  if (item.status === 'unavailable') return item.error;
  if (item.similar?.length) return '本地有同名歌曲，版本未确认 · 继续下载会保留两份';
  if (item.local_source) return '从本地 FLAC 导出 MP3 · 保留原文件';
  return item.conversion ? '需转换为 MP3' : '直接保存原始音频';
}

async function confirmDownloadPlan(items, format) {
  const dialog = $('#downloadPlanDialog');
  if (dialog.open) return null;
  const ready = items.filter(item => item.status === 'ready');
  const existing = items.filter(item => item.status === 'existing');
  const active = items.filter(item => item.status === 'active');
  const unavailable = items.filter(item => item.status === 'unavailable');
  $('#downloadPlanTitle').textContent = items.length > 1 ? '批量下载预览' : existing.length ? '这首歌已经下载过' : '下载前确认';
  $('#downloadPlanSummary').textContent = `${items.length} 首 · ${ready.filter(item => !item.conversion).length} 首直接保存 · ${ready.filter(item => item.conversion).length} 首转换 · ${existing.length} 首已有 ${format.toUpperCase()} · ${active.length} 首进行中 · ${unavailable.length} 首不可下载`;
  const list = $('#downloadPlanList');
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    const file = item.existing?.[0] || item.similar?.[0];
    li.innerHTML = `<strong>${esc(item.song_name || '曲目已过期')}</strong><span>${esc(downloadPlanLabel(item))}</span>`;
    if (file) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'plan-file';
      button.textContent = `${desktopReady ? '显示文件' : '保存已有文件'} · ${file.ext.toUpperCase()} · ${mb(file.file_size_bytes)} · ${file.relative}`;
      button.onclick = () => locateFile(file);
      li.appendChild(button);
    }
    list.appendChild(li);
  }
  const primary = $('#downloadPlanConfirm');
  primary.value = ready.length ? 'skip' : existing.length ? 'view' : active.length ? 'tasks' : 'cancel';
  primary.textContent = ready.length ? `下载 ${ready.length} 首${existing.length ? '未保存歌曲' : ''}` : existing.length ? '查看已下载' : active.length ? '查看任务' : '关闭';
  $('#downloadPlanCopy').hidden = !existing.some(item => item.can_download !== false);
  $('#downloadPlanCopy').textContent = items.length === 1 ? '另存一份' : '包含已有歌曲，另存一份';
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', async () => {
      const choice = dialog.returnValue;
      if (choice === 'view') {
        await openLibrary();
      }
      if (choice === 'tasks') { setPanel('dlDrawer'); await restoreDownloads(); }
      resolve(['skip', 'copy'].includes(choice) ? choice : null);
    }, { once: true });
    dialog.showModal();
  });
}
$('#downloadPlanClose').onclick = () => $('#downloadPlanDialog').close('cancel');

async function planDownloads(tokens, format) {
  if (downloadPlanning) return null;
  downloadPlanning = true;
  try {
    const response = await fetch('/api/download/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens, format })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法检查下载状态');
    const needsReview = data.items.length > 1 || data.items.some(item => ['existing', 'unavailable'].includes(item.status) || item.similar?.length);
    const choice = needsReview ? await confirmDownloadPlan(data.items, format) : 'skip';
    return choice ? { items: data.items, duplicate: choice === 'copy' } : null;
  } catch (err) {
    toast(err.message || '无法检查下载状态，请重试');
    return null;
  } finally {
    downloadPlanning = false;
  }
}

function scheduleDownloadMarkers() {
  clearTimeout(markerTimer);
  const requestId = ++markerRequestId;
  markerTimer = setTimeout(() => refreshDownloadMarkers(requestId), 250);
}

async function refreshDownloadMarkers(requestId) {
  if (!queue.length) return;
  const format = formatPreference.value === 'ask' ? 'mp3' : formatPreference.value;
  try {
    const response = await fetch('/api/download/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens: queue.slice(0, 200), format })
    });
    if (!response.ok) return;
    const data = await response.json();
    if (requestId !== markerRequestId) return;
    const states = new Map(data.items.map(item => [item.token, item]));
    document.querySelectorAll('.row').forEach(row => {
      const item = states.get(row.dataset.token);
      if (!item) return;
      const text = item.status === 'existing' ? `已下载 ${format.toUpperCase()}` : item.status === 'active' ? '下载中' : item.local_source ? '本地可导出' : '';
      row.querySelector('.download-state').textContent = text;
      row.querySelector('.a-dl').title = text || (formatPreference.value === 'ask' ? '选择下载格式' : `下载 ${format.toUpperCase()}`);
      row.querySelector('.a-dl').setAttribute('aria-label', `${text || `下载 ${format.toUpperCase()}`} ${item.song_name}`);
    });
  } catch {} // Preflight on click remains authoritative if background status fails.
}

async function exportLocalMp3(track, button) {
  button.disabled = true;
  pendingDownloadRequests++;
  updateLeaveWarning();
  try {
    const send = duplicate => fetch('/api/library/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relative: track.relative, format: 'mp3', duplicate })
    });
    let response = await send(false);
    let data = await response.json();
    if (data.code === 'already_downloaded') {
      const choice = await confirmDownloadPlan([data], 'mp3');
      if (choice !== 'copy') return;
      response = await send(true);
      data = await response.json();
    }
    if (!response.ok) throw new Error(data.error || '导出失败');
    if (!downloadTasks.has(data.download_id)) {
      trackDownload(data.download_id, addDlItem({ ...track, song_name: `${track.song_name} · MP3` }));
    }
    setPanel('dlDrawer');
  } catch (err) {
    toast(err.message || '导出失败');
  } finally {
    button.disabled = false;
    pendingDownloadRequests--;
    updateLeaveWarning();
  }
}

async function checkConversionTools() {
  const status = $('#conversionStatus');
  status.textContent = '检测中…';
  try {
    const response = await fetch('/api/download/formats');
    if (!response.ok) throw new Error();
    const data = await response.json();
    status.textContent = data.mp3_conversion ? '可用' : '未安装或未找到';
  } catch {
    status.textContent = '检测失败，请重试';
  }
}
$('#checkConversion').onclick = checkConversionTools;
$('.conversion-help').addEventListener('toggle', e => { if (e.target.open) checkConversionTools(); });

async function requestDownload(token, btn) {
  if (downloadingTokens.has(token)) { setPanel('dlDrawer'); return; }
  if (downloadPlanning || $('#downloadFormatDialog').open) return;
  formatTokens.add(token);
  try {
    const format = formatPreference.value === 'ask' ? await chooseDownloadFormat([token]) : formatPreference.value;
    if (!format) return;
    const plan = await planDownloads([token], format);
    if (!plan) return;
    const item = plan.items[0];
    if (item.status === 'active') { setPanel('dlDrawer'); await restoreDownloads(); return; }
    if (item.status === 'ready' || (item.status === 'existing' && plan.duplicate && item.can_download !== false)) {
      await startDownload(token, btn, format, plan.duplicate);
    }
  } finally {
    formatTokens.delete(token);
  }
}

async function startDownload(token, btn, format = 'mp3', duplicate = false) {
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
  pendingDownloadRequests++;
  updateLeaveWarning();
  try {
    const res = await fetch('/api/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, format, duplicate })
    }).then(r => r.json());
    if (res.error || !res.download_id) { toast(res.error || '下载启动失败'); release(); return false; }
    if (downloadTasks.has(res.download_id)) { release(); setPanel('dlDrawer'); return true; }
    const item = addDlItem({ ...t, song_name: `${t.song_name} · ${format.toUpperCase()}` });
    trackDownload(res.download_id, item, btn, release);
    setPanel('dlDrawer');
    return true;
  } catch {
    toast('下载启动失败'); release(); return false;
  } finally {
    pendingDownloadRequests--;
    updateLeaveWarning();
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
    <div class="dl-stat"><span class="prog">准备中…</span><span class="s"></span></div>
    <p class="dl-error" hidden></p>
    <div class="dl-actions"><button class="dl-retry" type="button" hidden>重试</button><button class="dl-open" type="button" hidden>${desktopReady ? '显示文件' : '保存到设备'}</button></div>`;
  list.prepend(li);
  dlCount++; fab.classList.add('has'); fab.querySelector('.badge').textContent = dlCount;
  return li;
}

function removeDlItem(item) {
  if (!item.isConnected) return;
  if (item.dataset.downloadId) downloadTasks.delete(item.dataset.downloadId);
  item.remove();
  refreshTaskCounts();
}

function unfinishedDownloadCount() {
  return [...downloadTasks.values()].filter(task => !['done', 'error', 'cancelled'].includes(task.status)).length;
}

function handleBeforeUnload(event) {
  if (desktopReady || (!unfinishedDownloadCount() && !pendingDownloadRequests)) return;
  event.preventDefault();
  event.returnValue = ''; // Browsers show their own text, not an application message.
}

function updateLeaveWarning() {
  const count = unfinishedDownloadCount();
  const active = count > 0 || pendingDownloadRequests > 0;
  const enabled = active && !desktopReady;
  if (enabled !== leaveWarningEnabled) {
    window[enabled ? 'addEventListener' : 'removeEventListener']('beforeunload', handleBeforeUnload);
    leaveWarningEnabled = enabled;
  }
  const prefix = count ? `还有 ${count} 项下载或转换未完成。` : pendingDownloadRequests ? '正在提交任务，请等待确认。' : '';
  const message = prefix + (desktopReady
    ? '退出声轨会中断未完成任务，重新打开后需要重新添加。已完成文件会保留；可最小化窗口继续等待。'
    : '关闭此页面不会停止已提交的任务，但请保持后台程序运行。停止后台后，未完成任务需要重新添加。');
  const notice = $('#downloadExitNotice');
  if (notice.textContent !== message) notice.textContent = message;
  notice.dataset.active = String(active);
}

function refreshTaskCounts() {
  updateLeaveWarning();
  dlCount = [...downloadTasks.values()].filter(task => !['done', 'cancelled'].includes(task.status)).length;
  fab.querySelector('.badge').textContent = dlCount;
  fab.classList.toggle('has', dlCount > 0);
  $('#retryFailed').disabled = ![...downloadTasks.values()].some(task => task.status === 'error');
  for (const [id, message] of [['#dlList', '暂无下载任务'], ['#recentList', '完成后可在这里找到文件']]) {
    if (!$(id).querySelector('.dl-item')) $(id).innerHTML = `<li class="dl-empty">${message}</li>`;
  }
}

async function retryDownloadTask(id) {
  const task = downloadTasks.get(id);
  if (!task || task.status !== 'error') return false;
  const button = task.item.querySelector('.dl-retry');
  if (button.disabled) return false;
  button.disabled = true;
  pendingDownloadRequests++;
  updateLeaveWarning();
  try {
    const response = await fetch(`/api/download/${id}/retry`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '重试失败');
    const record = task.record;
    removeDlItem(task.item);
    if (!downloadTasks.has(data.download_id)) {
      trackDownload(data.download_id, addDlItem({ song_name: record.song_name || record.name, singers: record.singers || '' }));
    }
    return true;
  } catch (err) {
    task.item.querySelector('.dl-error').textContent = err.message;
    toast(err.message || '重试失败');
    return false;
  } finally {
    button.disabled = false;
    pendingDownloadRequests--;
    updateLeaveWarning();
  }
}

$('#retryFailed').onclick = async () => {
  const ids = [...downloadTasks].filter(([, task]) => task.status === 'error').map(([id]) => id);
  let started = 0;
  for (const id of ids) if (await retryDownloadTask(id)) started++;
  toast(`已重新添加 ${started} / ${ids.length} 项失败任务`);
};

async function restoreDownloads() {
  const terminal = new Map([...downloadTasks].filter(([, task]) => ['done', 'error'].includes(task.status)));
  try {
    const response = await fetch('/api/downloads');
    if (!response.ok) throw new Error();
    const data = await response.json();
    const present = new Set(data.tasks.map(record => record.download_id));
    for (const [id, task] of terminal) {
      if (!present.has(id) && downloadTasks.get(id) === task) removeDlItem(task.item);
    }
    for (const record of data.tasks.reverse()) {
      const existing = downloadTasks.get(record.download_id);
      if (existing) {
        // Active tasks use SSE; terminal tasks must refresh file availability and other-tab changes.
        if (terminal.get(record.download_id) === existing && (record.updated || 0) >= (existing.record.updated || 0)) {
          existing.restore(record);
        }
        continue;
      }
      const item = addDlItem({ song_name: record.song_name || record.name, singers: record.singers || '' });
      trackDownload(record.download_id, item, null, () => {}, record);
    }
  } catch {
    toast('任务列表读取失败，重新打开下载面板可重试');
  }
}

function trackDownload(id, item, btn, release = () => {}, initial = null) {
  let restoring = Boolean(initial);
  const es = initial && ['done', 'error', 'cancelled'].includes(initial.status)
    ? { close() {} } : new EventSource(`/api/download/${id}/progress`);
  item.dataset.downloadId = id;
  const task = { item, status: initial?.status || 'queued', record: initial || {} };
  downloadTasks.set(id, task);
  item.querySelector('.dl-retry').onclick = () => retryDownloadTask(id);
  item.querySelector('.dl-delete').onclick = async (e) => {
    if (task.status !== 'done' && !confirm('移除这个任务？未完成的下载会取消并清理临时文件。')) return;
    const button = e.currentTarget;
    button.disabled = true;
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
      button.disabled = false;
      toast('删除失败');
    }
  };
  const update = d => {
    if (task.status !== d.status) scheduleDownloadMarkers();
    task.status = d.status;
    task.record = d;
    refreshTaskCounts();
    item.classList.remove('error');
    const bar = item.querySelector('.dl-bar i');
    const prog = item.querySelector('.prog');
    const s = item.querySelector('.s');
    if (d.status === 'error') {
      item.classList.add('error'); prog.textContent = '失败';
      s.textContent = '';
      item.querySelector('.dl-error').hidden = false;
      item.querySelector('.dl-error').textContent = d.message || '下载失败，请重试';
      item.querySelector('.dl-retry').hidden = false;
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
    if (['checking', 'waiting_conversion', 'converting', 'tagging'].includes(d.status)) {
      const labels = { checking: '检测格式…', waiting_conversion: '等待转换…', converting: '转换为 MP3…', tagging: '保存歌曲信息…' };
      prog.textContent = labels[d.status];
      const pct = Math.floor(d.conversion_progress || 0);
      bar.style.width = (d.status === 'converting' ? pct : 0) + '%';
      s.textContent = d.status === 'converting' && pct ? `${pct}%` : '';
      return;
    }
    const total = d.total || 0, done = d.downloaded || 0;
    const pct = total ? Math.min(100, done / total * 100) : 0;
    bar.style.width = (total ? pct : 8) + '%';
    prog.textContent = mb(done) + (total ? ' / ' + mb(total) : '');
    if (d.status === 'downloading' && d.speed) s.textContent = mb(d.speed) + '/s';
    if (d.status === 'done') {
      prog.textContent = `已完成 · ${(d.format || '').toUpperCase()} · ${mb(d.downloaded || 0)}`;
      s.textContent = '';
      item.querySelector('.dl-bar').hidden = true;
      item.querySelector('.dl-delete').setAttribute('aria-label', '移除此完成记录，保留音乐文件');
      const open = item.querySelector('.dl-open');
      open.hidden = !d.file_url;
      open.textContent = desktopReady && d.relative ? '显示文件' : '保存到设备';
      open.onclick = () => locateFile(d);
      const list = $('#recentList');
      list.querySelector('.dl-empty')?.remove();
      list.prepend(item);
      refreshTaskCounts();
      release();
      if (!restoring) loadLibrary();
      es.close(); if (btn) btn.classList.remove('busy');
      if (!restoring) toast('下载完成：' + (d.name || ''));
    }
  };
  task.restore = record => {
    restoring = true;
    update(record);
    restoring = false;
  };
  if (es.addEventListener) es.addEventListener('progress', ev => update(JSON.parse(ev.data)));
  if (initial) update(initial);
  restoring = false;
  refreshTaskCounts();
  scheduleDownloadMarkers();
  es.onerror = ev => {
    if (ev?.data) {
      es.close(); release(); removeDlItem(item);
      toast('任务已移除');
      return;
    }
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
  if (e.target.closest('dialog')) return;
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
updateLeaveWarning();
restoreSession();
loadSources();
restoreDownloads();
