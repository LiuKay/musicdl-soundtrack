// Dependency-free regression checks for the redesigned interface helpers.
// Run: node --test test_ui.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.UI_SOURCE || 'static/app.js', 'utf8');

function element() {
  const attributes = new Map();
  const classes = new Set();
  return {
    attributes, hidden: false, inert: true, textContent: '', style: {}, listeners: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    toggleAttribute(name, value) { if (value) attributes.set(name, ''); else attributes.delete(name); },
    contains() { return false; },
    focus() {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    getBoundingClientRect() { return { left: 0, width: 100 }; }
  };
}

function helper(name, context = {}) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[0]})`, context);
}

test('initialization failures are not mislabeled as network failures', () => {
  const message = helper('sourceErrorMessage');
  assert.match(message({ code: 'initialization_failed' }), /初始化失败/);
  assert.match(message({}), /连接失败/);
});

test('play and pause SVGs use hidden attributes, never display both', () => {
  const nodes = Object.fromEntries(['.ic-play', '.ic-pause', '#playBtn'].map(id => [id, element()]));
  const sync = helper('syncPlayIcon', { $: id => nodes[id], document: { body: element() } });
  sync(true);
  assert.equal(nodes['.ic-play'].attributes.has('hidden'), true);
  assert.equal(nodes['.ic-pause'].attributes.has('hidden'), false);
  assert.equal(nodes['#playBtn'].getAttribute('aria-label'), '暂停');
  sync(false);
  assert.equal(nodes['.ic-play'].attributes.has('hidden'), false);
  assert.equal(nodes['.ic-pause'].attributes.has('hidden'), true);
});

test('drawers are mutually exclusive and closed drawers are inert', () => {
  const nodes = Object.fromEntries(['lyricsPanel', 'lyricsToggle', 'lyricsClose', 'dlDrawer', 'downloadsButton', 'dlClose', 'queuePanel', 'queueToggle', 'queueClose'].map(id => ['#' + id, element()]));
  const setPanel = helper('setPanel', { $: id => nodes[id], document: { activeElement: null } });
  for (const id of ['lyricsPanel', 'dlDrawer', 'queuePanel']) {
    setPanel(id);
    assert.equal(nodes['#' + id].inert, false);
    assert.equal(nodes['#' + id].classList.contains('open'), true);
    const other = id === 'lyricsPanel' ? 'dlDrawer' : 'lyricsPanel';
    assert.equal(nodes['#' + other].inert, true);
  }
  setPanel(null);
  assert.equal(nodes['#lyricsPanel'].inert, true);
  assert.equal(nodes['#dlDrawer'].inert, true);
  assert.equal(nodes['#downloadsButton'].getAttribute('aria-expanded'), 'false');
});

test('drawer close restores focus to its trigger', () => {
  const nodes = Object.fromEntries(['lyricsPanel', 'lyricsToggle', 'lyricsClose', 'dlDrawer', 'downloadsButton', 'dlClose', 'queuePanel', 'queueToggle', 'queueClose'].map(id => ['#' + id, element()]));
  let focused;
  nodes['#lyricsPanel'].contains = () => true;
  nodes['#lyricsToggle'].focus = () => { focused = 'lyricsToggle'; };
  helper('setPanel', { $: id => nodes[id], document: { activeElement: {} } })(null);
  assert.equal(focused, 'lyricsToggle');
});

test('sliders support keyboard steps and clamp at the endpoints', () => {
  const slider = element();
  let value;
  slider.setAttribute('aria-valuenow', '75');
  helper('dragControl', { window: { addEventListener() {} } })(slider, ratio => { value = ratio; });
  const press = key => slider.listeners.keydown({ key, preventDefault() {} });
  press('ArrowRight'); assert.equal(value, .8);
  press('Home'); assert.equal(value, 0);
  press('ArrowLeft'); assert.equal(value, 0);
  press('End'); assert.equal(value, 1);
  press('ArrowUp'); assert.equal(value, 1);
});

test('search empty/error messages show the placeholder and hide the table header', () => {
  const nodes = Object.fromEntries(['#resultsHead', '#placeholder', '#placeholder h2', '#placeholder p'].map(id => [id, element()]));
  helper('showSearchMessage', { $: id => nodes[id] })('连接暂时中断', '请重新搜索');
  assert.equal(nodes['#resultsHead'].hidden, true);
  assert.equal(nodes['#placeholder'].hidden, false);
  assert.equal(nodes['#placeholder h2'].textContent, '连接暂时中断');
});

test('late artwork responses cannot replace the next search spotlight', () => {
  const nodes = Object.fromEntries(['#spotlight', '#spotlightTitle', '#spotlightArtist', '#spotlightCover', '#spotlightPlay'].map(id => [id, element()]));
  const queue = ['first'];
  let image;
  let replaced = false;
  nodes['#spotlightCover'].replaceChildren = () => { replaced = true; };
  helper('showSpotlight', {
    $: id => nodes[id], queue, ICON_PLAY: '', play() {}, Image: function() { image = this; }
  })({ token: 'first', song_name: '<img onerror=bad>', singers: 'Artist', cover_url: 'yes' });
  assert.equal(nodes['#spotlightTitle'].textContent, '<img onerror=bad>');
  queue[0] = 'second';
  image.onload();
  assert.equal(replaced, false);
});

test('Alt track shortcuts still work with a button or slider focused', () => {
  const steps = [];
  const shortcuts = helper('handleShortcuts', { step: value => steps.push(value) });
  for (const tag of ['button', '[role="slider"]']) {
    let prevented = false;
    shortcuts({ code: 'ArrowRight', altKey: true,
      target: { closest: selector => selector.includes(tag) },
      preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.deepEqual(steps, [1, 1]);
});

test('Space on a button keeps its native activation instead of toggling playback', () => {
  let played = false;
  const shortcuts = helper('handleShortcuts', { $: () => ({ click() { played = true; } }) });
  shortcuts({ code: 'Space', target: { closest: selector => selector.includes('button') } });
  assert.equal(played, false);
});

test('searching again preserves tracks referenced by the current playback queue', () => {
  const tracks = new Map([['old-a', { song_name: 'A' }], ['old-b', { song_name: 'B' }]]);
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { ...element(), value: 'new search', innerHTML: '' });
    return nodes.get(id);
  };
  helper('runSearch', {
    $, tracks, queue: ['old-a', 'old-b'], activeQueue: ['old-a', 'old-b'], currentToken: 'old-a', searchES: null,
    activeSources: () => ['MiguMusicClient'], setStatus() {},
    EventSource: function() { this.addEventListener = () => {}; },
    selectedTokens: new Set(), sourceStates: new Map(),
    pruneTracks() {}, updateSelection() {}, setSourceState() {}, renderSourceStates() {}
  })();
  assert.equal(tracks.has('old-b'), true, 'the next song must remain playable');
});

test('track pruning retains search, playback, current song and active batch references', () => {
  const tracks = new Map(['search', 'play', 'current', 'download', 'batch', 'library', 'stale'].map(t => [t, {}]));
  helper('pruneTracks', { tracks, queue: ['search'], activeQueue: ['play'], libraryQueue: ['library'],
    currentToken: 'current', downloadingTokens: new Set(['download']), batchTokens: new Set(['batch']) })();
  assert.equal(tracks.has('stale'), false);
  assert.equal(tracks.size, 6);
});

test('repeat off stops, repeat all wraps, and repeat one applies only to automatic advance', () => {
  const next = helper('nextToken');
  assert.equal(next(['a', 'b'], 'b', 1, 'off'), null);
  assert.equal(next(['a', 'b'], 'b', 1, 'all'), 'a');
  assert.equal(next(['a', 'b'], 'a', -1, 'all'), 'b');
  assert.equal(next(['a', 'b'], 'a', 1, 'one', true), 'a');
  assert.equal(next(['a', 'b'], 'a', 1, 'one', false), 'b');
  assert.equal(next([], 'a', 1, 'all'), null);
});

test('shuffle produces a permutation with the current track first', () => {
  const context = vm.createContext({ activeQueue: ['a', 'b', 'c', 'd'], currentToken: 'c', shuffleOrder: [] });
  const fn = source.match(/function resetShuffle\([^]*?\n\}/)[0];
  vm.runInContext(fn + '\nresetShuffle();', context);
  assert.equal(context.shuffleOrder[0], 'c');
  assert.deepEqual([...context.shuffleOrder].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(context.activeQueue, ['a', 'b', 'c', 'd']);
});

test('next-up moves a queued track without duplicates and preserves shuffle priority', () => {
  const context = vm.createContext({ tracks: new Map(['a', 'b', 'c'].map(t => [t, {}])),
    activeQueue: ['a', 'b', 'c'], shuffleOrder: ['a', 'c', 'b'], currentToken: 'a', renderQueue() {}, toast() {} });
  vm.runInContext(source.match(/function enqueueNext\([^]*?\n\}/)[0] + '\nenqueueNext("c");', context);
  assert.deepEqual([...context.activeQueue], ['a', 'c', 'b']);
  assert.deepEqual([...context.shuffleOrder], ['a', 'c', 'b']);
});

test('batch selection becomes indeterminate when additional results stream in', () => {
  const nodes = new Map();
  helper('updateSelection', { $: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    queue: ['a', 'b'], selectedTokens: new Set(['a']), batchDownloading: false })();
  assert.equal(nodes.get('#selectAll').indeterminate, true);
  assert.equal(nodes.get('#selectAll').checked, false);
  assert.equal(nodes.get('#downloadSelected').disabled, false);
});

test('duplicate active downloads are ignored and failed starts unlock retry', async () => {
  const tokens = new Set(['busy']);
  let requests = 0;
  const start = helper('startDownload', { tracks: new Map([['busy', {}], ['new', {}]]), downloadingTokens: tokens,
    fetch: async () => { requests++; throw Error('offline'); }, toast() {} });
  assert.equal(await start('busy'), false);
  assert.equal(requests, 0);
  assert.equal(await start('new'), false);
  assert.equal(tokens.has('new'), false);
  assert.equal(requests, 1);
});

test('batch download snapshots selection, handles failures, and releases protection', async () => {
  const selected = new Set(['a', 'b']);
  const batch = new Set();
  const started = [];
  const context = vm.createContext({ queue: ['a', 'b'], selectedTokens: selected, batchTokens: batch, batchDownloading: false,
    updateSelection() {}, pruneTracks() {}, toast() {}, document: { querySelectorAll: () => [] },
    startDownload: async token => { assert.equal(batch.size, 2); started.push(token); return token === 'a'; }
  });
  const fn = source.match(/async function downloadSelected\([^]*?\n\}/)[0];
  await vm.runInContext(fn + '\ndownloadSelected();', context);
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual([...selected], ['b']);
  assert.equal(batch.size, 0);
  assert.equal(context.batchDownloading, false);
});

test('download tracking keeps its duplicate guard through connection loss', () => {
  let es;
  let releases = 0;
  const nodes = new Map();
  const item = { ...element(), querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
  helper('trackDownload', { EventSource: function() { es = this; this.addEventListener = () => {}; },
    fetch() {}, toast() {}, mb() {}, removeDlItem() {}, loadLibrary() {}
  })('job', item, null, () => releases++);
  es.onerror();
  assert.equal(releases, 0);
  assert.match(nodes.get('.prog').textContent, /重连/);
});

test('an old download release cannot unlock a newer retry of the same track', async () => {
  const tokens = new Set();
  const releases = [];
  const start = helper('startDownload', { tracks: new Map([['a', {}]]), downloadingTokens: tokens,
    fetch: async () => ({ json: async () => ({ download_id: 'job' }) }), toast() {},
    addDlItem: () => ({}), trackDownload: (id, item, btn, release) => releases.push(release) });
  await start('a'); releases[0]();
  await start('a'); releases[0]();
  assert.equal(tokens.has('a'), true);
  releases[1]();
  assert.equal(tokens.has('a'), false);
});

test('a slow older library response cannot overwrite the latest library', async () => {
  const responses = [];
  const nodes = new Map();
  const load = helper('loadLibrary', { libraryRequestId: 0, libraryQueue: [], activeQueue: [], shuffleOrder: [], tracks: new Map(),
    $: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, renderQueue() {},
    fetch: () => new Promise(resolve => responses.push(resolve)) });
  const old = load();
  const recent = load();
  responses[1]({ json: async () => ({ directory: 'new', tracks: [] }) });
  await recent;
  responses[0]({ json: async () => ({ directory: 'old', tracks: [] }) });
  await old;
  assert.equal(nodes.get('#downloadDir').textContent, 'new');
});
