const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const moduleSource = fs.readFileSync('static/session.js', 'utf8');
const appSource = fs.readFileSync('static/app.js', 'utf8');
function session(context = {}) {
  return vm.runInNewContext(moduleSource + '\nSessionState', { setTimeout, clearTimeout, URLSearchParams, DOMException, ...context });
}
const plain = value => JSON.parse(JSON.stringify(value));

test('snapshots are bounded, versioned, and never store tokens, URLs or credentials', () => {
  const state = session().normalize({ version: 1, items: Array.from({ length: 250 }, () => ({
    song_name: '歌 (Live)', identity: 'id', source_id: 'MiguMusicClient', token: 'expired',
    stream_url: 'https://signed.invalid', cover_url: 'secret', cookies: 'secret', lyric: 'private'
  })), current: 300, order: [3, 3, -1, 900], history: ['  song ', 'song', null, '<script>'], repeat: 'bogus' });
  assert.equal(state.items.length, 200);
  assert.equal(state.current, null);
  assert.equal(state.repeat, 'off');
  assert.equal(state.order.length, 200);
  assert.equal(state.order[0], 3);
  assert.deepEqual(plain(state.history), ['song', '<script>']);
  assert.doesNotMatch(JSON.stringify(state), /expired|https|secret|private/);
  assert.equal(session().normalize({ version: 2, items: [{}] }).items.length, 0);
});

test('malformed JSON, null items and blocked storage degrade without breaking startup', () => {
  for (const getItem of [() => '{', () => { throw Error('blocked'); }]) {
    const s = session({ localStorage: { getItem, setItem() { throw Error('quota'); } } });
    assert.equal(s.read().items.length, 0);
    assert.equal(s.write({ version: 1 }), false);
  }
  assert.equal(session().normalize({ version: 1, items: [null, 4, {}] }).items.length, 3);
});

test('valid source preferences survive; removed sources fall back to an available source', () => {
  const select = session().sourceSelection;
  const sources = [{ id: 'A', default: true }, { id: 'B' }];
  assert.deepEqual(plain(select(['B', 'deleted'], sources)), ['B']);
  assert.deepEqual(plain(select(['deleted'], sources)), ['A']);
  assert.deepEqual(plain(select([], [{ id: 'B' }])), ['B']);
});

function resolver() {
  let es;
  const s = session({ EventSource: class {
    constructor(url) { this.url = url; this.events = {}; this.closed = false; es = this; }
    addEventListener(name, callback) { this.events[name] = callback; }
    close() { this.closed = true; }
  } });
  return { s, get es() { return es; }, emit(name, data) { es.events[name]?.({ data: JSON.stringify(data) }); } };
}
const track = { song_name: 'Song (Live)', singers: 'Artist', source_id: 'A', identity: 'exact-version' };
test('resolution ignores same-title recordings and other sources, closes on exact identity', async () => {
  const r = resolver();
  const pending = r.s.resolveRemote(track, new AbortController().signal);
  r.emit('result', { ...track, identity: 'studio', token: 'wrong' });
  r.emit('result', { ...track, source_id: 'B', token: 'wrong' });
  assert.equal(r.es.closed, false);
  r.emit('result', { ...track, token: 'fresh' });
  assert.equal((await pending).token, 'fresh');
  assert.equal(r.es.closed, true);
  assert.match(r.es.url, /sources=A/);
});
test('missing identity, source failure, no match and cancellation are recoverable errors', async () => {
  await assert.rejects(session().resolveRemote({}, new AbortController().signal), /身份/);
  for (const event of ['source_error', 'done', 'abort', 'error']) {
    const r = resolver(), controller = new AbortController();
    const pending = r.s.resolveRemote(track, controller.signal);
    if (event === 'abort') controller.abort();
    else if (event === 'error') r.es.onerror();
    else r.emit(event, {});
    await assert.rejects(pending);
    assert.equal(r.es.closed, true);
  }
});
test('local restore rejects a same-name file in another directory or replaced file', async () => {
  const original = { local: true, relative: 'A/song.mp3', restore_key: 'old' };
  for (const restore_key of ['new-root', 'changed-file', 'old']) {
    const s = session({ fetch: async () => ({ ok: true, json: async () => ({ tracks: [{ ...original, restore_key, token: 'fresh' }] }) }) });
    const pending = s.resolveLocal(original, new AbortController().signal);
    if (restore_key === 'old') assert.equal((await pending).token, 'fresh');
    else await assert.rejects(pending, /更改或移走/);
  }
});

function appFunctions(names, context) {
  const ctx = vm.createContext(context);
  for (const name of names) vm.runInContext(appSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0], ctx);
  return ctx;
}
test('restoring retains order, current selection and modes without autoplay or network', () => {
  const ctx = appFunctions(['restoreSession'], {
    savedSession: session().normalize({ version: 1, items: [track, { ...track, identity: 'two' }],
      current: 1, order: [1, 0], shuffle: true, repeat: 'all' }),
    tracks: new Map(), activeQueue: [], $: () => ({ setAttribute() {} }),
    syncRepeatMode() {}, syncPlayIcon() {}, showNowPlaying() {}, renderHistory() {}, renderQueue() {}
  });
  ctx.restoreSession();
  assert.deepEqual(plain(ctx.shuffleOrder), ['saved-1', 'saved-0']);
  assert.equal(ctx.currentToken, 'saved-1');
  assert.equal(ctx.repeatMode, 'all');
  assert.equal(ctx.tracks.get('saved-1').pendingResolution, true);
});
test('switching or cancelling during resolution cannot start the old song', async () => {
  const deferred = [];
  const played = [];
  const ctx = appFunctions(['cancelPlaybackRequest', 'play'], {
    playbackRequest: 0, playbackController: null, currentToken: null, refreshAttempted: false,
    tracks: new Map(['a', 'b'].map(token => [token, { ...track, token, pendingResolution: true }])),
    activeQueue: ['a', 'b'], queue: ['a', 'b'], shuffleOrder: ['a', 'b'],
    AbortController, SessionState: { resolveRemote: () => new Promise(resolve => deferred.push(resolve)) },
    audio: { pause() {}, removeAttribute() {}, load() {}, play() { played.push(this.src); return Promise.resolve(); } },
    audioCtx: { state: 'running' }, ensureAudioGraph() {}, cacheToggle: { checked: false },
    showNowPlaying() {}, showNoLyrics() {}, renderQueue() {}, loadLyrics() {}, syncPlayIcon() {}, $: () => ({}), toast() {}
  });
  const first = ctx.play('a'), second = ctx.play('b');
  deferred[0]({ ...track, token: 'fresh-a' });
  await first;
  assert.equal(played.length, 0);
  deferred[1]({ ...track, token: 'fresh-b' });
  await second;
  assert.deepEqual(played, ['/api/stream/fresh-b']);
  ctx.tracks.get('a').pendingResolution = true;
  const cancelled = ctx.play('a'); ctx.cancelPlaybackRequest();
  deferred[2]({ ...track, token: 'fresh-a' }); await cancelled;
  assert.equal(played.length, 1);
});

test('library refresh invalidates restored aliases when the file is deleted or replaced', () => {
  for (const items of [[], [{ relative: 'song.mp3', restore_key: 'replacement' }]]) {
    const ctx = appFunctions(['reconcileLocalQueue'], {
      tracks: new Map([['saved-0', { local: true, relative: 'song.mp3', restore_key: 'original' }],
        ['remote', track]]), activeQueue: ['saved-0', 'remote'], shuffleOrder: ['remote', 'saved-0'],
      currentToken: 'saved-0', stopped: false
    });
    vm.runInContext('function clearLocalPlayback() { stopped = true; currentToken = null; }', ctx);
    ctx.reconcileLocalQueue(items);
    assert.equal(ctx.stopped, true);
    assert.equal(ctx.tracks.has('saved-0'), false);
    assert.deepEqual(plain(ctx.activeQueue), ['remote']);
    assert.deepEqual(plain(ctx.shuffleOrder), ['remote']);
  }
});

test('a broken remote stream refreshes once, then exposes manual recovery without a retry loop', () => {
  const calls = [];
  let handler;
  const ctx = vm.createContext({ tracks: new Map([['song', { ...track }]]), currentToken: 'song',
    playbackController: null, refreshAttempted: false,
    audio: { error: { code: 4 }, getAttribute: () => '/api/stream/expired', addEventListener: (_, fn) => { handler = fn; } },
    play: (...args) => calls.push(args), syncPlayIcon() {}, toast() {}, renderQueue() {}
  });
  vm.runInContext(appSource.match(/audio\.addEventListener\('error', \(\) => \{[^]*?\n\}\);/)[0], ctx);
  handler(); handler(); handler();
  assert.deepEqual(calls, [['song', null, true]]);
  assert.equal(ctx.tracks.get('song').pendingResolution, true);
  assert.match(ctx.tracks.get('song').resolveError, /重新查找/);
});

test('recent searches deduplicate in recency order and retain only ten entries', () => {
  const ctx = appFunctions(['rememberSearch'], { searchHistory: [], renderHistory() {}, saveSession() {} });
  for (let i = 0; i < 15; i++) ctx.rememberSearch('Song ' + i);
  ctx.rememberSearch('Song 10');
  assert.equal(ctx.searchHistory.length, 10);
  assert.equal(ctx.searchHistory[0], 'Song 10');
  assert.equal(ctx.searchHistory.filter(q => q === 'Song 10').length, 1);
});
