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
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[0]})`, context);
}

test('play and pause SVGs use hidden attributes, never display both', () => {
  const nodes = Object.fromEntries(['.ic-play', '.ic-pause', '#playBtn'].map(id => [id, element()]));
  const sync = helper('syncPlayIcon', { $: id => nodes[id] });
  sync(true);
  assert.equal(nodes['.ic-play'].attributes.has('hidden'), true);
  assert.equal(nodes['.ic-pause'].attributes.has('hidden'), false);
  assert.equal(nodes['#playBtn'].getAttribute('aria-label'), '暂停');
  sync(false);
  assert.equal(nodes['.ic-play'].attributes.has('hidden'), false);
  assert.equal(nodes['.ic-pause'].attributes.has('hidden'), true);
});

test('drawers are mutually exclusive and closed drawers are inert', () => {
  const nodes = Object.fromEntries(['lyricsPanel', 'lyricsToggle', 'lyricsClose', 'dlDrawer', 'downloadsButton', 'dlClose'].map(id => ['#' + id, element()]));
  const setPanel = helper('setPanel', { $: id => nodes[id], document: { activeElement: null } });
  for (const id of ['lyricsPanel', 'dlDrawer']) {
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
  const nodes = Object.fromEntries(['lyricsPanel', 'lyricsToggle', 'lyricsClose', 'dlDrawer', 'downloadsButton', 'dlClose'].map(id => ['#' + id, element()]));
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
