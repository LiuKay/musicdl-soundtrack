const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const load = (file, name) => vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\n' + name);
const model = load('static/search-model.js', 'SearchModel');
const media = load('static/media-controls.js', 'MediaControls');
const song = { token: 'a', song_name: 'Song (Live)', singers: 'Artist', album: 'Live 2026',
  duration: '3:20', ext: 'mp3', bitrate_kbps: 128, source_id: 'A', identity: 'one' };
const plain = value => JSON.parse(JSON.stringify(value));

test('matching recordings group across sources, prefer lossless, and retain exact identities', () => {
  const second = { ...song, token: 'b', source_id: 'B', identity: 'two', ext: 'flac', lossless: true };
  const groups = model.groups([song, second]);
  assert.equal(groups.length, 1);
  assert.deepEqual(plain(groups[0].items.map(track => track.token)), ['b', 'a']);
  assert.equal(groups[0].items[0].identity, 'two');
  assert.equal(song.identity, 'one');
});

test('recording versions, artists, albums, unknown durations and previews cannot merge', () => {
  for (const change of [{ song_name: 'Song' }, { song_name: 'Song (Instrumental)' }, { singers: 'Other' },
    { album: 'Another' }, { duration: '3:25' }, { duration: '' }, { preview: true }, { singers: '未知艺人' }]) {
    assert.equal(model.groups([song, { ...song, ...change, token: 'b' }]).length, 2);
  }
  assert.equal(model.groups([song, { ...song, token: 'b', duration: '3:22' },
    { ...song, token: 'c', duration: '3:24' }]).length, 2, 'duration tolerance must not accumulate');
});

test('filters compose, keep unknown quality honest, and put suspected clips after unmarked tracks', () => {
  const clip = { ...song, token: 'clip', duration: '0:30', preview_suspected: true };
  const lossless = { ...song, token: 'lossless', lossless: true, ext: 'flac' };
  const items = [clip, song, lossless];
  assert.equal(model.groups(items)[0].items[0].token, 'lossless');
  assert.equal(model.groups(items).at(-1).items[0].token, 'clip');
  assert.equal(model.groups(items, { lossless: true, preview: true }).length, 1);
  assert.equal(model.groups(items, { lossless: true, downloaded: true }, new Set(['lossless'])).length, 0);
  assert.equal(model.groups([song], { downloaded: true }, new Set(['other'])).length, 1);
  assert.equal(model.quality({ ext: 'mp3' }), 'MP3');
  assert.equal(model.quality(song), 'MP3 · 128 kbps');
  assert.equal(model.quality(lossless), 'FLAC · 无损');
  assert.equal(model.duration('01:02:03'), 3723);
  assert.equal(model.duration('NULL'), 0);
});

test('media controls tolerate missing API and independently unsupported actions', () => {
  const empty = media.connect({}, {}, {});
  empty.metadata(song); empty.state(true); empty.position(); empty.clear();
  const actions = {};
  const session = { setActionHandler(name, callback) { if (name === 'stop') throw Error(); actions[name] = callback; } };
  const audio = { duration: 100, currentTime: 95, playbackRate: 1 };
  const calls = [];
  const controls = media.connect(audio, { play: () => calls.push('play'), next: () => calls.push('next') },
    { navigator: { mediaSession: session }, MediaMetadata: function(data) { Object.assign(this, data); } });
  controls.metadata(song, '/cover');
  assert.equal(session.metadata.title, song.song_name);
  assert.equal(session.metadata.artwork[0].src, '/cover');
  actions.play(); actions.nexttrack();
  assert.deepEqual(calls, ['play', 'next']);
  actions.seekforward({}); assert.equal(audio.currentTime, 100);
  actions.seekto({ seekTime: -4 }); assert.equal(audio.currentTime, 0);
  actions.seekto({ seekTime: Infinity }); assert.equal(audio.currentTime, 0);
  controls.state(true); assert.equal(session.playbackState, 'playing');
  controls.clear(); assert.equal(session.metadata, null); assert.equal(session.playbackState, 'none');
});

test('position state resets between tracks and rejects non-finite durations', () => {
  const positions = [];
  const audio = { currentTime: 300, duration: 200, playbackRate: 1 };
  const session = { setActionHandler() {}, setPositionState: value => positions.push(plain(value ?? null)) };
  const controls = media.connect(audio, {}, { navigator: { mediaSession: session } });
  controls.position();
  assert.deepEqual(positions[0], { duration: 200, playbackRate: 1, position: 200 });
  audio.duration = Infinity; controls.position(); assert.equal(positions[1], null);
  audio.duration = NaN; controls.position(); assert.equal(positions[2], null);
});

test('Shift+F10 explicitly opens the selected result menu on webviews without a native context event', () => {
  const app = fs.readFileSync('static/app.js', 'utf8');
  const row = { dataset: { token: 'selected' } }, calls = [];
  const shortcut = vm.runInNewContext('(' + app.match(/function handleShortcuts\([^]*?\n\}/)[0] + ')', {
    document: { body: { dataset: { view: 'search' } } }, visibleSearchTokens: [], focusedResultToken: null,
    openTrackMenu: (...args) => calls.push(args)
  });
  const event = { key: 'F10', shiftKey: true, target: { closest: selector => selector === '.row' ? row : null }, preventDefault() {} };
  shortcut(event);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'selected');
  assert.equal(calls[0][2], row);
});

test('late pause events after clearing the queue leave the system media session empty', () => {
  const source = fs.readFileSync('static/app.js', 'utf8');
  const calls = [];
  const sync = vm.runInNewContext('(' + source.match(/function syncPlayIcon\([^]*?\n\}/)[0] + ')', {
    $: () => ({ toggleAttribute() {}, setAttribute() {} }), currentToken: null, audio: { paused: true },
    document: { body: { classList: { toggle() {} } } },
    mediaControls: { state: () => calls.push('state'), clear: () => calls.push('clear') }
  });
  sync(false);
  assert.deepEqual(calls, ['clear']);
});

test('update UI distinguishes a new release from an unavailable check and always allows retry', async () => {
  const source = fs.readFileSync('static/app.js', 'utf8');
  const nodes = new Map(), messages = [];
  const context = vm.createContext({
    updateChecking: false, AbortSignal, toast: text => messages.push(text),
    $: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    fetch: async url => {
      assert.equal(url, '/api/version?check=1');
      assert.equal(nodes.get('#checkUpdate').disabled, true);
      return { ok: true, json: async () => ({ current: '0.8.0', latest: '0.9.0', status: 'available' }) };
    }
  });
  vm.runInContext(source.match(/async function checkForUpdate\([^]*?\n\}/)[0], context);
  await context.checkForUpdate();
  assert.equal(nodes.get('#updateDot').hidden, false);
  assert.match(nodes.get('#updateStatus').textContent, /0.9.0/);
  assert.equal(messages.length, 1);
  assert.equal(nodes.get('#checkUpdate').disabled, false);
  context.fetch = async () => { throw Error('offline'); };
  await context.checkForUpdate();
  assert.match(nodes.get('#updateStatus').textContent, /无法检查/);
  assert.doesNotMatch(nodes.get('#updateStatus').textContent, /已是最新/);
  assert.equal(nodes.get('#checkUpdate').disabled, false);
});

test('a better version arriving in the stream retains focus on the group toggle', () => {
  const source = fs.readFileSync('static/app.js', 'utf8'), nodes = new Map();
  const element = () => ({ hidden: false, classList: { toggle() {} }, setAttribute() {} });
  const document = {};
  const oldRow = element(), newRow = element();
  oldRow.dataset = { token: 'old' }; newRow.dataset = { token: 'new' };
  const oldButton = { ...element(), isConnected: true, classList: { contains: () => true },
    closest: () => oldButton.isConnected ? oldRow : null,
    remove() { this.isConnected = false; document.activeElement = null; } };
  const newButton = { ...element(), focus() { document.activeElement = this; } };
  oldRow.querySelector = () => oldButton; newRow.querySelector = () => newButton;
  document.activeElement = oldButton;
  const list = { ...element(), children: [oldRow, newRow], insertBefore(row, before) {
    this.children = this.children.filter(item => item !== row);
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, row);
  } };
  nodes.set('#results', list);
  const items = [{ token: 'new', song_name: 'Song' }, { token: 'old', song_name: 'Song' }];
  const context = vm.createContext({
    document, searchRows: new Map([['old', oldRow], ['new', newRow]]), queue: ['old', 'new'],
    tracks: new Map(items.map(item => [item.token, item])), expandedVersions: new Set(), downloadedSearchTokens: new Set(),
    focusedResultToken: 'old', searchFilters: () => ({}), SearchModel: { groups: () => [{ id: 'old', items }] },
    updateSelection() {}, $: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
  });
  vm.runInContext(source.match(/function renderSearchResults\([^]*?\n\}/)[0], context);
  context.renderSearchResults();
  assert.equal(document.activeElement, newButton);
});

test('expanding source choices keeps the context menu within the viewport', async () => {
  const source = fs.readFileSync('static/app.js', 'utf8');
  const menu = { style: { top: '480px' }, offsetHeight: 480 };
  const list = { replaceChildren() {}, appendChild() {}, querySelector: () => ({ focus() {} }) };
  const handler = vm.runInNewContext('(' + source.match(/\$\('#trackMenu'\)\.onclick = (async event => \{[^]*?\n\});/)[1] + ')', {
    menuToken: 'song', tracks: new Map([['song', { source_id: 'A' }]]), innerHeight: 812,
    sources: [{ id: 'B', label: 'Other' }], $: id => id === '#trackMenu' ? menu : list,
    document: { createElement: () => ({ setAttribute() {} }) }
  });
  await handler({ target: { closest: () => ({ dataset: { trackAction: 'research' } }), setAttribute() {} } });
  assert.ok(parseFloat(menu.style.top) + menu.offsetHeight <= 804);
});
