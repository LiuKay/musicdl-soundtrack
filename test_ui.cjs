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
    attributes, hidden: false, inert: true, textContent: '', style: {}, listeners: {}, dataset: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
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
  return vm.runInNewContext(`(${match[0]})`, { pendingDownloadRequests: 0, updateLeaveWarning() {}, ...context });
}

function cacheContext(fetch, confirm = () => true) {
  const nodes = Object.fromEntries(['clearCache', 'refreshCache', 'cacheUsage', 'cacheStatus'].map(id => ['#' + id, element()]));
  const messages = [];
  const context = vm.createContext({ $: id => nodes[id], cacheLoading: false, fetch, confirmCacheCleanup: confirm,
    cacheSize: helper('cacheSize'), toast: value => messages.push(value) });
  vm.runInContext(source.match(/async function loadCache\([^]*?\n\}/)[0], context);
  return { context, nodes, messages };
}

function conversionContext(fetch) {
  const nodes = Object.fromEntries(['conversionStatus', 'conversionHelp', 'conversionTroubleshooting',
    'checkConversion'].map(id => ['#' + id, element()]));
  const context = vm.createContext({ $: id => nodes[id], conversionRequestId: 0, fetch });
  vm.runInContext(source.match(/async function checkConversionTools\([^]*?\n\}/)[0], context);
  return { context, nodes };
}

test('bundled conversion is ready without installation advice; recheck forces a fresh probe', async () => {
  const { context, nodes } = conversionContext(async url => {
    assert.equal(url, '/api/download/formats?refresh=1');
    return { ok: true, json: async () => ({ mp3_conversion: true, tool_source: 'bundled' }) };
  });
  await context.checkConversionTools(true);
  assert.equal(nodes['#conversionStatus'].textContent, '已就绪');
  assert.match(nodes['#conversionHelp'].textContent, /无需额外安装/);
  assert.equal(nodes['#conversionTroubleshooting'].hidden, true);
  assert.equal(nodes['#checkConversion'].disabled, false);
});

test('conversion tool failure and service failure have distinct recovery guidance', async () => {
  const { context, nodes } = conversionContext(async () => ({ ok: true,
    json: async () => ({ mp3_conversion: false, tool_source: 'missing' }) }));
  await context.checkConversionTools();
  assert.equal(nodes['#conversionStatus'].textContent, '暂不可用');
  assert.equal(nodes['#conversionTroubleshooting'].hidden, false);
  context.fetch = async () => { throw Error('offline'); };
  await context.checkConversionTools();
  assert.equal(nodes['#conversionStatus'].textContent, '检测失败，请重试');
  assert.equal(nodes['#conversionTroubleshooting'].hidden, true);
  assert.equal(nodes['#checkConversion'].disabled, false);
});

test('late conversion status cannot overwrite the latest check', async () => {
  let finish;
  const { context, nodes } = conversionContext(() => new Promise(resolve => { finish = resolve; }));
  const previous = context.checkConversionTools();
  context.fetch = async () => ({ ok: true, json: async () => ({ mp3_conversion: true, tool_source: 'bundled' }) });
  await context.checkConversionTools(true);
  finish({ ok: true, json: async () => ({ mp3_conversion: false }) });
  await previous;
  assert.equal(nodes['#conversionStatus'].textContent, '已就绪');
  assert.equal(nodes['#conversionTroubleshooting'].hidden, true);
});

test('cache cleanup cancellation sends no request or state change', async () => {
  const { context, nodes } = cacheContext(() => assert.fail('no request after cancel'), () => false);
  await context.loadCache(true);
  assert.equal(context.cacheLoading, false);
  assert.equal(nodes['#cacheUsage'].textContent, '');
});

test('cache confirmation resets previous consent and only accepts an explicit clear', async () => {
  const dialog = element();
  dialog.showModal = () => { dialog.open = true; };
  const confirmCleanup = helper('confirmCacheCleanup', { $: () => dialog });
  for (const choice of ['', 'cancel', 'clear']) {
    dialog.open = false;
    dialog.returnValue = 'clear';
    const result = confirmCleanup();
    assert.equal(dialog.returnValue, '');
    assert.equal(await confirmCleanup(), false);
    dialog.returnValue = choice;
    dialog.open = false;
    dialog.listeners.close();
    assert.equal(await result, choice === 'clear');
  }
});

test('cache loading blocks duplicate actions and reports retained files after cleanup', async () => {
  let resolve;
  let calls = 0;
  const { context, nodes, messages } = cacheContext((url, options) => {
    calls++; assert.equal(url, '/api/cache'); assert.equal(options.method, 'DELETE');
    return new Promise(done => { resolve = done; });
  });
  const pending = context.loadCache(true);
  await context.loadCache(); await context.loadCache(true);
  assert.equal(calls, 1);
  assert.equal(nodes['#clearCache'].disabled, true);
  resolve({ ok: true, json: async () => ({ bytes: 2048, files: 1, partial_bytes: 1024, active_jobs: 1,
    removable_files: 1, removed: 2, freed_bytes: 4096, failed: 1 }) });
  await pending;
  assert.equal(nodes['#cacheUsage'].textContent, '2.0 KB');
  assert.match(messages[0], /释放 4.0 KB/);
  assert.match(messages[0], /1 个文件未能清理/);
  assert.match(messages[0], /正在缓存的歌曲已保留/);
  assert.equal(nodes['#clearCache'].disabled, false);
  assert.equal(context.cacheLoading, false);
});

test('cache errors disable deletion but allow refreshing again', async () => {
  const { context, nodes } = cacheContext(async () => ({ ok: false, json: async () => ({ error: '目录无法访问' }) }));
  await context.loadCache();
  assert.equal(nodes['#cacheStatus'].textContent, '目录无法访问');
  assert.equal(nodes['#clearCache'].disabled, true);
  assert.equal(nodes['#refreshCache'].disabled, false);
  context.fetch = async () => ({ ok: true, json: async () => ({ bytes: 0, files: 0, partial_bytes: 0, active_jobs: 0, removable_files: 0 }) });
  await context.loadCache();
  assert.equal(nodes['#cacheUsage'].textContent, '0 B');
  assert.equal(nodes['#clearCache'].disabled, true);
});

function leaveWarningContext() {
  const notice = element();
  const listeners = new Map();
  const context = vm.createContext({ downloadTasks: new Map(), pendingDownloadRequests: 0,
    desktopReady: false, leaveWarningEnabled: false, $: () => notice,
    window: { addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: name => listeners.delete(name) } });
  for (const name of ['unfinishedDownloadCount', 'handleBeforeUnload', 'updateLeaveWarning']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], context);
  }
  return { context, notice, listeners };
}

test('leave warning covers every active stage but not completed, failed or cancelled tasks', () => {
  const { context, notice, listeners } = leaveWarningContext();
  for (const status of ['queued', 'downloading', 'checking', 'waiting_conversion', 'converting', 'tagging', 'cancelling']) {
    context.downloadTasks.set('job', { status }); context.updateLeaveWarning();
    assert.equal(listeners.has('beforeunload'), true);
    assert.match(notice.textContent, /还有 1 项/);
    assert.match(notice.textContent, /保持后台程序运行/);
  }
  for (const status of ['done', 'error', 'cancelled']) {
    context.downloadTasks.set('job', { status }); context.updateLeaveWarning();
    assert.equal(listeners.has('beforeunload'), false);
    assert.equal(notice.dataset.active, 'false');
  }
});

test('pending submissions warn immediately and desktop bridge prevents duplicate browser dialogs', () => {
  const { context, notice, listeners } = leaveWarningContext();
  context.pendingDownloadRequests = 1; context.updateLeaveWarning();
  const event = { preventDefault() { this.prevented = true; } };
  listeners.get('beforeunload')(event);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, '');
  assert.match(notice.textContent, /正在提交/);
  context.desktopReady = true; context.updateLeaveWarning();
  assert.equal(listeners.has('beforeunload'), false);
  assert.match(notice.textContent, /退出声轨会中断/);
  assert.match(notice.textContent, /已完成文件会保留/);
  const desktopEvent = { preventDefault() { assert.fail('desktop uses native confirmation'); } };
  context.handleBeforeUnload(desktopEvent);
});

test('failed download submissions remove the leave guard without leaving phantom work', async () => {
  const { context, listeners } = leaveWarningContext();
  let reject;
  Object.assign(context, { tracks: new Map([['song', {}]]), downloadingTokens: new Set(),
    fetch: () => new Promise((_, fail) => { reject = fail; }), toast() {} });
  vm.runInContext(source.match(/async function startDownload\([^]*?\n\}/)[0], context);
  const pending = context.startDownload('song', null);
  assert.equal(listeners.has('beforeunload'), true);
  reject(Error('offline')); await pending;
  assert.equal(context.pendingDownloadRequests, 0);
  assert.equal(listeners.has('beforeunload'), false);
});

function revealHandler(reveal, toast = () => {}) {
  const match = source.match(/li\.querySelector\('\.library-reveal'\)\.onclick = (async \([^)]*\) => \{[^]*?\n      \});/);
  assert.ok(match, 'library reveal handler is present');
  return vm.runInNewContext(`(${match[1]})`, {
    t: { relative: 'Migu/歌曲.mp3' }, toast,
    window: { pywebview: { api: { reveal_downloaded_file: reveal } } }
  });
}

test('reveal button stays enabled while desktop call is pending', async () => {
  let finish;
  const handler = revealHandler(() => new Promise(resolve => { finish = resolve; }));
  const button = { disabled: false };
  const event = { currentTarget: button };
  const pending = handler(event);
  const disabledDuringCall = button.disabled;
  event.currentTarget = null; // DOM clears currentTarget after synchronous dispatch.
  finish(true);
  await pending;
  assert.equal(disabledDuringCall, false);
  assert.equal(button.disabled, false);
});

test('reveal supports repeated clicks without locking the button', async () => {
  const calls = [];
  const handler = revealHandler(async relative => { calls.push(relative); return true; });
  const button = { disabled: false };
  for (let i = 0; i < 2; i++) {
    const event = { currentTarget: button };
    const pending = handler(event);
    event.currentTarget = null;
    await pending;
  }
  assert.deepEqual(calls, ['Migu/歌曲.mp3', 'Migu/歌曲.mp3']);
  assert.equal(button.disabled, false);
});

test('reveal failures show feedback and leave the button usable', async () => {
  for (const reveal of [async () => false, async () => { throw Error('bridge failure'); }]) {
    const messages = [];
    const handler = revealHandler(reveal, message => messages.push(message));
    const button = { disabled: false };
    const event = { currentTarget: button };
    const pending = handler(event);
    event.currentTarget = null;
    await pending;
    assert.deepEqual(messages, ['无法定位文件']);
    assert.equal(button.disabled, false);
  }
});

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
  const nodes = Object.fromEntries(['lyricsPanel', 'lyricsToggle', 'lyricsClose', 'dlDrawer', 'downloadsButton', 'dlClose', 'queuePanel', 'queueToggle', 'queueClose', 'cachePanel', 'cacheManage', 'cacheClose'].map(id => ['#' + id, element()]));
  const setPanel = helper('setPanel', { $: id => nodes[id], document: { activeElement: null } });
  for (const id of ['lyricsPanel', 'dlDrawer', 'queuePanel', 'cachePanel']) {
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
  const nodes = Object.fromEntries(['lyricsPanel', 'lyricsToggle', 'lyricsClose', 'dlDrawer', 'downloadsButton', 'dlClose', 'queuePanel', 'queueToggle', 'queueClose', 'cachePanel', 'cacheManage', 'cacheClose'].map(id => ['#' + id, element()]));
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
    activeSources: () => ['MiguMusicClient'], setStatus() {}, setView() {}, rememberSearch() {},
    EventSource: function() { this.addEventListener = () => {}; },
    selectedTokens: new Set(), sourceStates: new Map(),
    pruneTracks() {}, updateSelection() {}, setSourceState() {}, renderSourceStates() {}
  })();
  assert.equal(tracks.has('old-b'), true, 'the next song must remain playable');
});

test('track pruning retains search, playback, current song and active batch references', () => {
  const tracks = new Map(['search', 'play', 'current', 'download', 'batch', 'library', 'format', 'stale'].map(t => [t, {}]));
  helper('pruneTracks', { tracks, queue: ['search'], activeQueue: ['play'], libraryQueue: ['library'],
    currentToken: 'current', downloadingTokens: new Set(['download']), batchTokens: new Set(['batch']), formatTokens: new Set(['format']) })();
  assert.equal(tracks.has('stale'), false);
  assert.equal(tracks.size, 7);
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
    downloadPlanning: false, formatPreference: { value: 'ask' },
    planDownloads: async tokens => ({ items: tokens.map(token => ({ token, status: 'ready' })), duplicate: false }),
    chooseDownloadFormat: async () => 'mp3',
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

function formatDialogHarness(exts, capability = true) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const dialog = $('#downloadFormatDialog');
  dialog.showModal = () => { dialog.open = true; };
  const tokens = exts.map((_, i) => String(i));
  const formatTokens = new Set();
  const choose = helper('chooseDownloadFormat', {
    $, tracks: new Map(exts.map((ext, i) => [String(i), { ext, song_name: 'Song', singers: 'Artist' }])),
    originalFormat: helper('originalFormat'), formatTokens,
    fetch: async () => ({ ok: true, json: async () => ({ mp3_conversion: capability }) })
  });
  const close = value => {
    dialog.returnValue = value; dialog.open = false; dialog.listeners.close();
  };
  return { $, choose, tokens, close, formatTokens };
}

test('FLAC is offered only for wholly original FLAC selections', async () => {
  for (const [exts, visible] of [[['flac'], true], [['.FLAC', 'flac'], true], [['mp3'], false], [['flac', 'mp3'], false], [['wav'], false]]) {
    const h = formatDialogHarness(exts);
    const result = h.choose(h.tokens);
    assert.equal(h.$('#downloadFormatFlacOption').hidden, !visible);
    assert.equal(h.formatTokens.size, exts.length);
    h.close('cancel');
    assert.equal(await result, null);
    assert.equal(h.formatTokens.size, 0);
  }
});

test('native MP3 remains enabled without conversion tools and cancel starts nothing', async () => {
  const h = formatDialogHarness(['mp3'], false);
  const result = h.choose(h.tokens);
  assert.equal(h.$('#downloadFormatMp3').disabled, false);
  assert.equal(h.$('#downloadFormatConfirm').disabled, false);
  h.close('download');
  assert.equal(await result, 'mp3');
  let started = false;
  await helper('requestDownload', {
    downloadPlanning: false, formatTokens: new Set(), formatPreference: { value: 'ask' }, $: () => ({ open: false }),
    downloadingTokens: new Set(), chooseDownloadFormat: async () => null,
    startDownload: async () => { started = true; }
  })('track');
  assert.equal(started, false);
});

test('missing conversion tools disable MP3 but leave native FLAC usable', async () => {
  const h = formatDialogHarness(['flac'], false);
  const result = h.choose(h.tokens);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.$('#downloadFormatMp3').disabled, true);
  assert.equal(h.$('#downloadFormatFlac').disabled, false);
  h.$('#downloadFormatMp3').checked = false;
  h.$('#downloadFormatFlac').checked = true;
  h.$('#downloadFormatFlac').onchange();
  assert.equal(h.$('#downloadFormatConfirm').disabled, false);
  h.close('download');
  assert.equal(await result, 'flac');
});

test('batch cancel retains selection and does not enqueue downloads', async () => {
  const selected = new Set(['a']);
  const batch = new Set();
  await helper('downloadSelected', {
    queue: ['a'], selectedTokens: selected, batchTokens: batch, batchDownloading: false,
    downloadPlanning: false, formatPreference: { value: 'ask' },
    chooseDownloadFormat: async () => null, updateSelection() {}, pruneTracks() {},
    document: { querySelectorAll: () => [] },
    startDownload() { assert.fail('cancel must not download'); }
  })();
  assert.equal(selected.has('a'), true);
  assert.equal(batch.size, 0);
});

test('download request carries the selected format', async () => {
  let payload;
  await helper('startDownload', {
    tracks: new Map([['song', {}]]), downloadingTokens: new Set(), toast() {},
    fetch: async (_, options) => { payload = JSON.parse(options.body); return { json: async () => ({ error: 'test' }) }; }
  })('song', null, 'flac');
  assert.deepEqual(payload, { token: 'song', format: 'flac', duplicate: false });
});

test('dialog keyboard input never triggers playback shortcuts', () => {
  helper('handleShortcuts', { step() { assert.fail('must not change track'); } })({
    code: 'ArrowRight', altKey: true, target: { closest: selector => selector === 'dialog' }
  });
});

test('download tracking keeps its duplicate guard through connection loss', () => {
  let es;
  let releases = 0;
  const nodes = new Map();
  const item = { ...element(), querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
  helper('trackDownload', { EventSource: function() { es = this; this.addEventListener = () => {}; },
    downloadTasks: new Map(), refreshTaskCounts() {}, scheduleDownloadMarkers() {},
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
    downloadTasks: new Map(), setPanel() {},
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
    libraryLoading: false, libraryLoaded: false, libraryErrorMessage: '', renderLibrary() {}, pruneTracks() {}, scheduleDownloadMarkers() {},
    $: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, renderQueue() {}, reconcileLocalQueue() {},
    fetch: () => new Promise(resolve => responses.push(resolve)) });
  const old = load();
  const recent = load();
  responses[1]({ ok: true, json: async () => ({ directory: 'new', tracks: [] }) });
  await recent;
  responses[0]({ ok: true, json: async () => ({ directory: 'old', tracks: [] }) });
  await old;
  assert.equal(nodes.get('#downloadDir').textContent, 'new');
});

test('default MP3 download bypasses format selection but still performs duplicate preflight', async () => {
  const calls = [];
  const protectedTokens = new Set();
  await helper('requestDownload', {
    downloadingTokens: new Set(), downloadPlanning: false, formatTokens: protectedTokens,
    formatPreference: { value: 'mp3' }, $: () => ({ open: false }),
    chooseDownloadFormat() { assert.fail('default format should not prompt'); },
    planDownloads: async (tokens, format) => {
      assert.equal(protectedTokens.has('song'), true);
      calls.push(['plan', [...tokens], format]);
      return { items: [{ token: 'song', status: 'ready' }], duplicate: false };
    },
    startDownload: async (...args) => calls.push(['start', ...args])
  })('song', null);
  assert.deepEqual(calls, [['plan', ['song'], 'mp3'], ['start', 'song', null, 'mp3', false]]);
  assert.equal(protectedTokens.size, 0);
});

test('batch defaults skip existing and unavailable files while submitting ready tracks', async () => {
  const selected = new Set(['saved', 'native', 'blocked']);
  const started = [];
  await helper('downloadSelected', {
    queue: [...selected], selectedTokens: selected, batchTokens: new Set(), batchDownloading: false,
    downloadPlanning: false, formatPreference: { value: 'mp3' }, updateSelection() {}, pruneTracks() {}, toast() {},
    document: { querySelectorAll: () => [] },
    planDownloads: async () => ({ duplicate: false, items: [
      { token: 'saved', status: 'existing' }, { token: 'native', status: 'ready' },
      { token: 'blocked', status: 'unavailable' }
    ] }),
    startDownload: async token => { started.push(token); return true; }
  })();
  assert.deepEqual(started, ['native']);
  assert.deepEqual([...selected], ['saved', 'blocked']);
});

test('preflight failure never starts a download and releases its planning lock', async () => {
  const context = vm.createContext({ downloadPlanning: false,
    fetch: async () => ({ ok: false, json: async () => ({ error: 'cannot inspect files' }) }),
    toast() {}, confirmDownloadPlan() { assert.fail('no invalid plan confirmation'); }
  });
  vm.runInContext(source.match(/async function planDownloads\([^]*?\n\}/)[0], context);
  assert.equal(await vm.runInContext('planDownloads(["a"], "mp3")', context), null);
  assert.equal(context.downloadPlanning, false);
});

test('a single existing file requires confirmation and cancel returns no plan', async () => {
  let reviews = 0;
  const plan = helper('planDownloads', { downloadPlanning: false, toast() {},
    fetch: async () => ({ ok: true, json: async () => ({ items: [{ token: 'a', status: 'existing' }] }) }),
    confirmDownloadPlan: async () => { reviews++; return null; }
  });
  assert.equal(await plan(['a'], 'mp3'), null);
  assert.equal(reviews, 1);
});

test('restored completed tasks remain accessible without duplicate notifications or progress connections', () => {
  const nodes = new Map();
  const item = { ...element(), querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
  const completed = [];
  let release = 0;
  const tasks = new Map();
  helper('trackDownload', {
    downloadTasks: tasks, desktopReady: false, refreshTaskCounts() {}, scheduleDownloadMarkers() {}, mb: value => String(value),
    $: () => ({ querySelector: () => null, prepend: node => completed.push(node) }),
    EventSource() { assert.fail('completed tasks do not need an SSE connection'); },
    toast() { assert.fail('restoring should not repeat completion toasts'); },
    loadLibrary() { assert.fail('restoring a completed item should not reload library per item'); }
  })('done', item, null, () => release++, { status: 'done', format: 'mp3', downloaded: 100, file_url: '/api/file/done' });
  assert.equal(tasks.get('done').status, 'done');
  assert.deepEqual(completed, [item]);
  assert.equal(nodes.get('.dl-open').hidden, false);
  assert.equal(release, 1);
});

test('failure messages remain complete and expose retry', () => {
  let listener;
  const nodes = new Map();
  const item = { ...element(), querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
  const tasks = new Map();
  helper('trackDownload', {
    downloadTasks: tasks, refreshTaskCounts() {}, scheduleDownloadMarkers() {},
    EventSource: function() { this.addEventListener = (_, fn) => { listener = fn; }; this.close = () => {}; }
  })('failed', item);
  const message = '无法转换音频：请安装 FFmpeg 和 FFprobe，并在下载面板点击重新检测后再试一次';
  listener({ data: JSON.stringify({ status: 'error', message }) });
  assert.equal(nodes.get('.dl-error').textContent, message);
  assert.equal(nodes.get('.dl-retry').hidden, false);
});

test('older marker responses cannot replace the current search state', async () => {
  const states = [];
  let finish;
  const refresh = helper('refreshDownloadMarkers', {
    queue: ['new'], markerRequestId: 2, formatPreference: { value: 'mp3' },
    fetch: () => new Promise(resolve => { finish = resolve; }),
    document: { querySelectorAll() { states.push('touched'); return []; } }
  });
  const pending = refresh(1);
  finish({ ok: true, json: async () => ({ items: [] }) });
  await pending;
  assert.deepEqual(states, []);
});

test('restoring reconciles removed terminal tasks and refreshes file availability', async () => {
  const removed = [];
  const updates = [];
  const tasks = new Map([
    ['old-error', { status: 'error', item: 'old', record: {} }],
    ['done', { status: 'done', item: 'done', record: { updated: 1 }, restore: record => updates.push(record) }],
    ['active', { status: 'downloading', item: 'active' }]
  ]);
  await helper('restoreDownloads', {
    downloadTasks: tasks,
    fetch: async () => ({ ok: true, json: async () => ({ tasks: [{ download_id: 'done', status: 'done', updated: 2 }] }) }),
    removeDlItem: item => removed.push(item), toast() { assert.fail('snapshot should restore'); }
  })();
  assert.deepEqual(removed, ['old']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].file_url, undefined);
});

test('repeat local export offers and submits explicit copy despite conflict error text', async () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  $('#downloadPlanList').replaceChildren = () => {};
  $('#downloadPlanList').appendChild = () => {};
  $('#downloadPlanDialog').showModal = () => {};
  const conflict = { status: 'existing', format: 'mp3', can_download: true, error: 'already exists', code: 'already_downloaded' };
  const confirmation = helper('confirmDownloadPlan', {
    $, desktopReady: false, esc: value => value, downloadPlanLabel: () => 'existing',
    document: { createElement: () => element() }
  })([conflict], 'mp3');
  assert.equal($('#downloadPlanCopy').hidden, false);
  $('#downloadPlanDialog').returnValue = 'copy';
  $('#downloadPlanDialog').listeners.close();
  assert.equal(await confirmation, 'copy');
  const bodies = [];
  const button = {};
  await helper('exportLocalMp3', {
    downloadTasks: new Map(), confirmDownloadPlan: async () => 'copy',
    fetch: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: bodies.length > 1, json: async () => bodies.length === 1 ? conflict : { download_id: 'copy' } };
    }, addDlItem: () => ({}), trackDownload() {}, setPanel() {}, toast() { assert.fail('copy must succeed'); }
  })({ relative: 'original.flac', song_name: 'Song' }, button);
  assert.deepEqual(bodies.map(body => body.duplicate), [false, true]);
  assert.equal(button.disabled, false);
});

test('library filtering combines format and normalized words across title, artist and album', () => {
  const items = [
    { token: 'a', song_name: '晴天（现场版）', singers: 'Alice', album: 'Live 2026', ext: 'flac', modified: 1 },
    { token: 'b', song_name: '晴天', singers: 'Alice', album: 'Studio', ext: 'mp3', modified: 3 },
    { token: 'c', song_name: '夜航', singers: 'Bob', album: 'Live 2026', ext: 'flac', modified: 2 }
  ];
  const select = helper('selectLibraryTracks', { originalFormat: helper('originalFormat') });
  assert.deepEqual(Array.from(select(items, ' ＡＬＩＣＥ  live ', 'flac', 'recent'), t => t.token), ['a']);
  assert.deepEqual(Array.from(select(items, '晴天', '', 'recent'), t => t.token), ['b', 'a']);
  assert.equal(select(items, '不存在', '', 'recent').length, 0);
  assert.equal(select(items, '', 'wav', 'recent').length, 0);
  assert.deepEqual(items.map(t => t.token), ['a', 'b', 'c'], 'filtering must not mutate source order');
});

test('library sorts are deterministic and keep versions with the same title', () => {
  const items = [
    { token: 'a', song_name: 'Track 10', singers: 'Beta', relative: 'a', modified: 2 },
    { token: 'b', song_name: 'Track 2', singers: 'Alpha', relative: 'b', modified: 1 },
    { token: 'c', song_name: 'Track 2', singers: 'Alpha', relative: 'c', modified: 3 }
  ];
  const select = helper('selectLibraryTracks', { originalFormat: helper('originalFormat') });
  for (const sort of ['title', 'artist']) assert.deepEqual(Array.from(select(items, '', '', sort), t => t.token), ['b', 'c', 'a']);
  assert.deepEqual(Array.from(select(items, '', '', 'recent'), t => t.token), ['c', 'a', 'b']);
});

test('switching between search and library hides only the view and preserves playback state', () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const body = element();
  let closed = 0;
  const setView = helper('setView', { $, document: { body }, setPanel: value => { assert.equal(value, null); closed++; } });
  setView('library');
  assert.equal($('#searchView').hidden, true);
  assert.equal($('#libraryView').hidden, false);
  assert.equal($('#libraryButton').getAttribute('aria-current'), 'page');
  setView('search');
  assert.equal($('#libraryView').hidden, true);
  assert.equal($('#libraryButton').getAttribute('aria-current'), undefined);
  assert.equal(closed, 2);
});

test('library refresh failures preserve the last known queue and expose recovery', async () => {
  const context = vm.createContext({ libraryRequestId: 0, libraryLoaded: true, libraryLoading: false,
    libraryErrorMessage: '', libraryQueue: ['saved'], tracks: new Map([['saved', {}]]),
    $: () => element(), renderLibrary() {}, fetch: async () => ({ ok: false }) });
  vm.runInContext(source.match(/async function loadLibrary\([^]*?\n\}/)[0], context);
  await vm.runInContext('loadLibrary()', context);
  assert.match(context.libraryErrorMessage, /上次读取/);
  assert.equal(context.libraryLoading, false);
  assert.deepEqual(context.libraryQueue, ['saved']);
});

test('refresh removes missing local tracks even when they are filtered out', async () => {
  const context = vm.createContext({ libraryRequestId: 0, libraryLoaded: true, libraryLoading: false,
    libraryErrorMessage: '', libraryQueue: ['missing', 'kept'], currentToken: 'remote',
    activeQueue: ['remote', 'missing', 'kept'], shuffleOrder: ['missing', 'kept', 'remote'],
    tracks: new Map([['remote', {}], ['missing', {}], ['kept', {}]]),
    $: () => element(), renderLibrary() {}, renderQueue() {}, reconcileLocalQueue() {}, pruneTracks() {}, scheduleDownloadMarkers() {},
    fetch: async () => ({ ok: true, json: async () => ({ directory: '/music', tracks: [{ token: 'kept' }] }) }) });
  vm.runInContext(source.match(/async function loadLibrary\([^]*?\n\}/)[0], context);
  await vm.runInContext('loadLibrary()', context);
  assert.equal(context.tracks.has('missing'), false);
  assert.deepEqual(Array.from(context.activeQueue), ['remote', 'kept']);
  assert.deepEqual(Array.from(context.libraryQueue), ['kept']);
});

test('changing download directory invalidates old file actions even if the next read fails', async () => {
  const nodes = new Map();
  const context = vm.createContext({ libraryRequestId: 4, libraryLoaded: true, libraryLoading: false,
    libraryErrorMessage: '', libraryQueue: ['local-a'], currentToken: 'remote',
    activeQueue: ['remote', 'local-a'], shuffleOrder: ['local-a', 'remote'],
    tracks: new Map([['remote', {}], ['local-a', { local: true }]]),
    $: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    renderLibrary() {}, renderQueue() {}, fetch: async () => ({ ok: false }) });
  for (const name of ['invalidateLibrary', 'loadLibrary']) {
    vm.runInContext(source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0], context);
  }
  vm.runInContext('invalidateLibrary()', context);
  assert.equal(context.libraryRequestId, 5);
  await vm.runInContext('loadLibrary()', context);
  assert.equal(context.libraryLoaded, false);
  assert.equal(context.tracks.has('local-a'), false);
  assert.equal(context.libraryQueue.length, 0);
  assert.deepEqual(Array.from(context.activeQueue), ['remote']);
  assert.doesNotMatch(context.libraryErrorMessage, /上次读取/);
});

test('playing a filtered library uses a snapshot without including hidden tracks', () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { ...element(), value: '' }); return nodes.get(id); };
  const rows = [];
  $('#libraryList').replaceChildren = () => {};
  $('#libraryList').appendChild = row => rows.push(row);
  const calls = [];
  helper('renderLibrary', { $, libraryQueue: ['hidden', 'shown'], libraryLoading: false, libraryLoaded: true,
    libraryErrorMessage: '', currentToken: null, desktopReady: false,
    visibleLibraryTracks: () => [{ token: 'shown', song_name: '现场版', singers: '', ext: 'mp3', stream_url: '/local/shown' }],
    document: { createElement: () => {
      const buttons = new Map();
      return { ...element(), querySelector: selector => {
        if (!buttons.has(selector)) buttons.set(selector, element()); return buttons.get(selector);
      } };
    } },
    esc: value => value || '', mb: () => '1MB', ICON_PLAY: '', ICON_FOLDER: '', ICON_TRASH: '',
    play: (token, tokens) => calls.push([token, Array.from(tokens)])
  })();
  assert.equal(calls.length, 0, 'rendering a filter must not change playback');
  rows[0].querySelector('.library-play').onclick();
  assert.deepEqual(calls, [['shown', ['shown']]]);
  rows[0].ondblclick({ target: { closest: selector => selector.includes('a') } });
  assert.equal(calls.length, 1, 'saving a file must not start playback');
});
