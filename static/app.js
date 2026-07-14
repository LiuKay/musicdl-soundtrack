'use strict';

/* ------------------------------------------------------------------ */
/* state + refs                                                        */
/* ------------------------------------------------------------------ */
const $ = (s) => document.querySelector(s);
const audio = $('#audio');
const tracks = new Map();          // token -> payload
let queue = [];                    // ordered tokens (play order)
let currentToken = null;
let searchES = null;
let sources = [];

/* ------------------------------------------------------------------ */
/* sources / chips                                                     */
/* ------------------------------------------------------------------ */
async function loadSources() {
  sources = await fetch('/api/sources').then(r => r.json());
  const wrap = $('#chips');
  wrap.innerHTML = '';
  sources.forEach(src => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (src.default ? ' on' : '');
    chip.dataset.id = src.id;
    chip.innerHTML = `<span class="dot"></span>${src.label}`;
    chip.onclick = () => {
      chip.classList.toggle('on');
      if (!document.querySelectorAll('.chip.on').length) chip.classList.add('on');
    };
    wrap.appendChild(chip);
  });
}
function activeSources() {
  return [...document.querySelectorAll('.chip.on')].map(c => c.dataset.id);
}

/* ------------------------------------------------------------------ */
/* search (real-time SSE stream)                                       */
/* ------------------------------------------------------------------ */
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });

function runSearch() {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  if (searchES) { searchES.close(); searchES = null; }

  tracks.clear(); queue = [];
  $('#results').innerHTML = '';
  $('#placeholder').hidden = true;
  $('#resultsHead').hidden = false;
  $('#searchBtn').disabled = true;

  const srcs = activeSources();
  const pending = new Set(srcs);
  let count = 0;
  let finished = false;
  setStatus(true, '搜索中…');

  const url = `/api/search?q=${encodeURIComponent(q)}&sources=${srcs.join(',')}`;
  const es = new EventSource(url);
  searchES = es;

  es.addEventListener('result', (ev) => {
    const t = JSON.parse(ev.data);
    tracks.set(t.token, t);
    queue.push(t.token);
    addRow(t);
    count++;
    setStatus(true, `已找到 ${count} 首…`);
  });
  es.addEventListener('source_start', () => {});
  es.addEventListener('source_done', (ev) => {
    const d = JSON.parse(ev.data);
    pending.delete(d.source);
  });
  es.addEventListener('source_error', (ev) => {
    const d = JSON.parse(ev.data);
    pending.delete(d.source);
  });
  es.addEventListener('done', () => {
    finished = true;
    es.close(); searchES = null;
    $('#searchBtn').disabled = false;
    if (count === 0) {
      $('#resultsHead').hidden = true;
      $('#placeholder').hidden = false;
      $('#placeholder').querySelector('h2').textContent = '没有找到结果';
      $('#placeholder').querySelector('p').textContent = '换个关键词，或在上方启用更多音乐源。';
      setStatus(false, '');
    } else {
      setStatus(false, `共 ${count} 首`);
    }
  });
  es.onerror = () => {
    if (finished) return;
    es.close(); searchES = null;
    $('#searchBtn').disabled = false;
    setStatus(false, count ? `共 ${count} 首` : '');
    if (count === 0) toast('搜索连接中断，请重试');
  };
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
    ? `<img src="/api/cover/${t.token}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="ph" style="display:none">♪</span>`
    : `<span class="ph">♪</span>`;
  li.innerHTML = `
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
      <button class="a-play" title="播放">${ICON_PLAY}</button>
      <button class="a-dl" title="下载">${ICON_DL}</button>
    </div>`;
  li.querySelector('.a-play').onclick = (e) => { e.stopPropagation(); play(t.token); };
  li.querySelector('.a-dl').onclick = (e) => { e.stopPropagation(); startDownload(t.token, e.currentTarget); };
  li.ondblclick = () => play(t.token);
  $('#results').appendChild(li);
}

const ICON_PLAY = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const ICON_DL = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3v10m0 0l-4-4m4 4l4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ */
/* playback + Web Audio visualizer                                     */
/* ------------------------------------------------------------------ */
let audioCtx = null, analyser = null, srcNode = null, vizData = null, vizRAF = null;

function ensureAudioGraph() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();
  srcNode = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.8;
  srcNode.connect(analyser);
  analyser.connect(audioCtx.destination);
  vizData = new Uint8Array(analyser.frequencyBinCount);
  drawViz();
}

function play(token) {
  const t = tracks.get(token);
  if (!t) return;
  currentToken = token;
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  audio.src = `/api/stream/${token}`;
  audio.play().catch(() => toast('无法播放该曲目'));

  // now-playing meta
  $('#player').dataset.empty = 'false';
  $('#npTitle').textContent = t.song_name;
  $('#npArtist').textContent = t.singers;
  const cv = $('#npCover');
  cv.innerHTML = `<div class="np-cover-fallback">♪</div>`;
  if (t.cover_url) {
    const img = new Image();
    img.onload = () => { cv.innerHTML = ''; cv.appendChild(img); };
    img.src = `/api/cover/${token}`;
  }

  document.querySelectorAll('.row.playing').forEach(r => r.classList.remove('playing'));
  const row = document.querySelector(`.row[data-token="${token}"]`);
  if (row) row.classList.add('playing');

  loadLyrics(token);
}

function step(dir) {
  if (!currentToken) return;
  const i = queue.indexOf(currentToken);
  const next = queue[i + dir];
  if (next) play(next);
}

$('#playBtn').onclick = () => {
  if (!currentToken) { if (queue.length) play(queue[0]); return; }
  if (audio.paused) { if (audioCtx?.state === 'suspended') audioCtx.resume(); audio.play(); }
  else audio.pause();
};
$('#prevBtn').onclick = () => step(-1);
$('#nextBtn').onclick = () => step(1);
audio.addEventListener('ended', () => step(1));
audio.addEventListener('play', () => syncPlayIcon(true));
audio.addEventListener('pause', () => syncPlayIcon(false));

function syncPlayIcon(playing) {
  $('.ic-play').style.display = playing ? 'none' : 'block';
  $('.ic-pause').style.display = playing ? 'block' : 'none';
}

/* time + seek */
audio.addEventListener('loadedmetadata', () => { $('#durTime').textContent = fmt(audio.duration); });
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $('#curTime').textContent = fmt(c);
  const p = d ? (c / d) * 100 : 0;
  $('#seekFill').style.width = p + '%';
  $('#seekKnob').style.left = p + '%';
  syncLyric(c);
});
function fmt(s) { if (!isFinite(s)) return '0:00'; s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

dragControl($('#seekTrack'), (ratio) => { if (audio.duration) audio.currentTime = ratio * audio.duration; });
const volFill = $('#volFill');
audio.volume = 0.75;
dragControl($('#volTrack'), (ratio) => { audio.volume = ratio; volFill.style.width = (ratio * 100) + '%'; });

function dragControl(track, onSet) {
  const handle = (e) => {
    const rect = track.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    onSet(Math.min(1, Math.max(0, x / rect.width)));
  };
  let dragging = false;
  const down = (e) => { dragging = true; handle(e); e.preventDefault(); };
  track.addEventListener('mousedown', down);
  track.addEventListener('touchstart', down, { passive: false });
  window.addEventListener('mousemove', (e) => dragging && handle(e));
  window.addEventListener('touchmove', (e) => dragging && handle(e), { passive: false });
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('touchend', () => dragging = false);
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
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#FFB46B'); grad.addColorStop(1, '#FF6B9D');
    ctx.fillStyle = grad;
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

async function loadLyrics(token) {
  lyricLines = []; lyricActive = -1;
  const scroll = $('#lyricsScroll');
  scroll.innerHTML = '<div class="empty">加载歌词…</div>';
  try {
    const { lyric } = await fetch(`/api/lyric/${token}`).then(r => r.json());
    lyricLines = parseLRC(lyric);
    if (!lyricLines.length) { scroll.innerHTML = '<div class="empty">暂无歌词</div>'; return; }
    scroll.innerHTML = '';
    lyricLines.forEach((l, i) => {
      const d = document.createElement('div');
      d.className = 'lr'; d.dataset.i = i; d.textContent = l.text;
      d.onclick = () => { if (audio.duration) audio.currentTime = l.t; };
      scroll.appendChild(d);
    });
  } catch { scroll.innerHTML = '<div class="empty">暂无歌词</div>'; }
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
      scroll.scrollTo({ top, behavior: 'smooth' });
    }
  }
}
$('#lyricsToggle').onclick = () => {
  const p = $('#lyricsPanel');
  p.classList.toggle('open');
  $('#lyricsToggle').classList.toggle('on', p.classList.contains('open'));
  if (p.classList.contains('open')) $('#dlDrawer').classList.remove('open');
};
$('#lyricsClose').onclick = () => { $('#lyricsPanel').classList.remove('open'); $('#lyricsToggle').classList.remove('on'); };

/* ------------------------------------------------------------------ */
/* downloads                                                           */
/* ------------------------------------------------------------------ */
let dlCount = 0;
const fab = document.createElement('button');
fab.className = 'dl-fab'; fab.title = '下载列表';
fab.innerHTML = `${ICON_DL}<span class="badge">0</span>`;
fab.onclick = () => { $('#dlDrawer').classList.toggle('open'); $('#lyricsPanel').classList.remove('open'); };
document.body.appendChild(fab);
$('#dlClose').onclick = () => $('#dlDrawer').classList.remove('open');

async function startDownload(token, btn) {
  const t = tracks.get(token);
  if (!t) return;
  if (btn) btn.classList.add('busy');
  try {
    const res = await fetch('/api/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    }).then(r => r.json());
    if (res.error) { toast(res.error); if (btn) btn.classList.remove('busy'); return; }
    const item = addDlItem(t);
    trackDownload(res.download_id, item, btn);
  } catch {
    toast('下载启动失败'); if (btn) btn.classList.remove('busy');
  }
}

function addDlItem(t) {
  const list = $('#dlList');
  const empty = list.querySelector('.dl-empty'); if (empty) empty.remove();
  const li = document.createElement('li');
  li.className = 'dl-item';
  li.innerHTML = `
    <div class="dl-name">${esc(t.song_name)} · ${esc(t.singers)}</div>
    <div class="dl-bar"><i></i></div>
    <div class="dl-stat"><span class="prog">准备中…</span><span class="s"></span></div>`;
  list.prepend(li);
  dlCount++; fab.classList.add('has'); fab.querySelector('.badge').textContent = dlCount;
  return li;
}

function trackDownload(id, item, btn) {
  const es = new EventSource(`/api/download/${id}/progress`);
  es.addEventListener('progress', (ev) => {
    const d = JSON.parse(ev.data);
    const bar = item.querySelector('.dl-bar i');
    const prog = item.querySelector('.prog');
    const s = item.querySelector('.s');
    if (d.status === 'error') {
      item.classList.add('error'); prog.textContent = '失败';
      s.textContent = (d.message || '').slice(0, 24);
      es.close(); if (btn) btn.classList.remove('busy'); return;
    }
    const total = d.total || 0, done = d.downloaded || 0;
    const pct = total ? Math.min(100, done / total * 100) : 0;
    bar.style.width = (total ? pct : 8) + '%';
    prog.textContent = mb(done) + (total ? ' / ' + mb(total) : '');
    if (d.status === 'downloading' && d.speed) s.textContent = mb(d.speed) + '/s';
    if (d.status === 'done') {
      item.classList.add('done');
      bar.style.width = '100%';
      prog.textContent = mb(d.total || done);
      s.textContent = '完成';
      const a = document.createElement('a');
      a.className = 'dl-save'; a.href = `/api/file/${id}`; a.textContent = '↓ 保存到本地';
      a.setAttribute('download', '');
      item.appendChild(a);
      es.close(); if (btn) btn.classList.remove('busy');
      toast('下载完成：' + (d.name || ''));
    }
  });
  es.onerror = () => { es.close(); if (btn) btn.classList.remove('busy'); };
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
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
  if (e.code === 'ArrowRight' && e.altKey) step(1);
  if (e.code === 'ArrowLeft' && e.altKey) step(-1);
});

loadSources();
