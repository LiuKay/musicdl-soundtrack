const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/favorites.js', 'utf8');
const app = fs.readFileSync('static/app.js', 'utf8');
const track = { song_name: 'Song (Live)', singers: 'Singer', album: 'Album', ext: 'flac', source_id: 'A', identity: 'live-lossless' };
function storage(initial = null) {
  let raw = initial;
  return { getItem: () => raw, setItem: (_, value) => { raw = value; } };
}
function state(localStorage = storage()) {
  return vm.runInNewContext(source + '\nFavoritesState', { localStorage });
}
function helper(name, context) {
  return vm.runInNewContext(`(${app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]})`, context);
}

test('favorites survive reload without persisting temporary URLs, tokens or credentials', () => {
  const store = storage(), favorites = state(store);
  assert.equal(favorites.add([{ ...track, token: 'SECRET', stream_url: 'SECRET', cookies: 'SECRET', lyric: 'SECRET', relative: 'SECRET' }]).added, 1);
  assert.doesNotMatch(store.getItem(), /SECRET/);
  assert.equal(state(store).read().items[0].song_name, track.song_name);
});
test('local favorites retain file identity but omit remote identity, URLs and absolute paths', () => {
  const store = storage(), favorites = state(store);
  favorites.add([{ ...track, local: true, relative: 'Album/song.wav', restore_key: 'file-version',
    path: '/private/SECRET', stream_url: 'SECRET', cover_url: 'SECRET' }]);
  const item = favorites.read().items[0];
  assert.equal(item.relative, 'Album/song.wav');
  assert.equal(item.restore_key, 'file-version');
  assert.equal(item.identity, undefined);
  assert.equal(item.source_id, undefined);
  assert.doesNotMatch(store.getItem(), /SECRET/);
});
test('duplicate favorites keep distinct provider, quality and local file versions', () => {
  const favorites = state();
  const local = { ...track, local: true, relative: 'song.mp3', restore_key: 'first' };
  assert.equal(favorites.add([track, track, { ...track, identity: 'mp3' }, { ...track, source_id: 'B' }, local, { ...local, restore_key: 'replaced' }]).added, 5);
  assert.equal(favorites.add([track]).added, 0);
  assert.equal(favorites.remove(track).items.length, 4);
  assert.equal(favorites.remove(track).removed, 0);
});
test('invalid and overlong identities are skipped without truncating into a different identity', () => {
  const favorites = state();
  const result = favorites.add([{}, { ...track, identity: '' }, { ...track, identity: 'a'.repeat(501) }, { ...track, source_id: 'A&B' }, { ...track, local: true }]);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 5);
});
test('200 favorites cap refuses additions without evicting an existing favorite', () => {
  const favorites = state();
  const result = favorites.add(Array.from({ length: 202 }, (_, i) => ({ ...track, identity: String(i) })));
  assert.equal(result.items.length, 200);
  assert.equal(result.skipped, 2);
  assert.equal(favorites.add([track]).skipped, 1);
  assert.ok(favorites.read().items.some(item => item.identity === '0'));
});
test('corrupt, unknown version and malformed records are preserved without writes', () => {
  for (const raw of ['{', 'null', '{"version":2,"items":[]}', '{"version":1,"items":[null]}']) {
    const store = storage(raw), favorites = state(store);
    assert.ok(favorites.read().error);
    assert.ok(favorites.add([track]).error);
    assert.ok(favorites.remove(track).error);
    assert.equal(store.getItem(), raw);
  }
});
test('quota and blocked storage do not report success or lose previously saved records', () => {
  const store = storage(), favorites = state(store);
  favorites.add([track]);
  const original = store.getItem();
  store.setItem = () => { throw Error('quota'); };
  for (const result of [favorites.add([{ ...track, identity: 'other' }]), favorites.remove(track)]) {
    assert.ok(result.error);
    assert.equal(result.items.length, 1);
    assert.equal(result.added, 0);
    assert.equal(store.getItem(), original);
  }
  assert.ok(state({ getItem() { throw Error(); } }).add([track]).error);
});
test('sequential changes in separate tabs read current storage before writing', () => {
  const store = storage(), first = state(store), second = state(store);
  first.add([track]);
  second.add([{ ...track, identity: 'other' }]);
  first.remove(track);
  assert.equal(second.read().items.length, 1);
  assert.equal(second.read().items[0].identity, 'other');
});
test('favorites filtering matches combined metadata and preserves saved ordering', () => {
  const items = [track, { ...track, singers: 'Other' }];
  const filter = helper('filteredFavorites', { $: () => ({ value: 'live singer' }) });
  assert.deepEqual(Array.from(filter(items)), [track]);
  assert.equal(items.length, 2);
});
test('playing favorites creates a separate queue of unresolved safe aliases and reuses pending tracks', () => {
  const tracks = new Map(), calls = [];
  const play = helper('playFavorites', { tracks, FavoritesState: state(), play: (...args) => calls.push(args) });
  play([track, { ...track, identity: 'other' }], 1);
  assert.equal(tracks.size, 2);
  assert.equal(calls[0][0], calls[0][1][1]);
  const first = tracks.values().next().value;
  assert.equal(first.pendingResolution, true);
  assert.doesNotMatch(first.token, /["<>\s]/);
  first.resolveError = 'Source offline';
  play([track]);
  assert.equal(tracks.get(first.token), first);
  assert.equal(first.resolveError, 'Source offline');
});
test('player favorite control reflects saved state and becomes unavailable after clearing playback', () => {
  const favorites = state(), tracks = new Map([['playing', track]]), attrs = new Map();
  const button = { setAttribute: (key, value) => attrs.set(key, value) };
  const update = helper('updateFavoriteCurrent', { tracks, currentToken: 'playing', FavoritesState: favorites, $: () => button });
  update();
  assert.equal(attrs.get('aria-pressed'), 'false');
  assert.equal(button.disabled, false);
  favorites.add([track]); update();
  assert.equal(attrs.get('aria-pressed'), 'true');
  assert.match(attrs.get('aria-label'), /取消收藏 Song/);
  tracks.clear(); update();
  assert.equal(button.disabled, true);
  assert.equal(attrs.get('aria-pressed'), 'false');
});
