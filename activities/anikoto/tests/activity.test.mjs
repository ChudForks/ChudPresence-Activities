import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../activity.js', import.meta.url), 'utf8');
const CHANNEL = 'chudpresence:anikoto:v1';
const playerUrl = 'https://megaplay.buzz/stream/s-2/788933/sub?s=tcdn&autostart=true';
const sample = { state: 'playing', position: 140.325828, duration: 1422.045769, rate: 1, ended: false, ad: false };

function fixture() {
  const state = { title: 'Yani Neko', episode: '9', episodeTitle: 'Episode 9', type: 'TV',
    poster: 'https://cdn.anipixcdn.co/thumbnail/poster.jpg', active: true, frames: [], video: null };
  const load = new Set();
  const requests = [];
  const frame = { src: playerUrl, contentWindow: { postMessage: (data, origin) => requests.push({ data, origin }) },
    addEventListener: (type, callback) => { if (type === 'load') load.add(callback); },
    removeEventListener: (type, callback) => { if (type === 'load') load.delete(callback); } };
  state.frames.push(frame);
  const selected = {
    get href() { return `https://anikototv.to/watch/chainsmoker-cat/ep-${state.episode}`; },
    getAttribute: name => name === 'data-num' ? state.episode : null,
    querySelector: selector => selector === '.d-title' ? { textContent: state.episodeTitle } : null,
  };
  const document = {
    // This is the misleading title seen in the actual Brave tab.
    title: 'Watch Yani Neko Episode 12 Online in HD - Anikoto', documentElement: {},
    visibilityState: 'hidden',
    hasFocus: () => Boolean(state.focused),
    querySelector(selector) {
      if (selector === '#w-episodes a.active') return state.active ? selected : null;
      if (selector === '#w-info h1') return { textContent: state.title };
      if (selector === '#w-info .poster img') return { src: state.poster };
      if (selector === '#player video') return state.video;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '#player iframe') return state.frames;
      if (selector === '#w-info .bmeta .meta > div') return [{ textContent: `Type: ${state.type}` }];
      return [];
    },
  };
  return { state, frame, requests, document, load };
}

function run({ document, isTop = true, url = 'https://anikototv.to/watch/chainsmoker-cat/ep-9', parent = {}, media = null } = {}) {
  let now = 100_000;
  let tokenId = 0;
  const reports = [], listeners = new Set(), attentionListeners = new Map(), documentListeners = new Map(),
    intervals = [], cleanups = [], timers = [];
  let settingsChanged, navigationChanged, mediaChanged, mutated;
  const location = new URL(url);
  const signal = { aborted: false };
  const window = { parent,
    addEventListener: (type, callback) => {
      if (type === 'message') listeners.add(callback);
      else attentionListeners.set(type, callback);
    },
    removeEventListener: (type, callback) => {
      if (type === 'message') listeners.delete(callback);
      else if (attentionListeners.get(type) === callback) attentionListeners.delete(type);
    },
  };
  document.addEventListener = (type, callback) => documentListeners.set(type, callback);
  document.removeEventListener = (type, callback) => {
    if (documentListeners.get(type) === callback) documentListeners.delete(type);
  };
  document.defaultView = window;
  // Match the V1 runtime's safe-global wrapper. Event.source remains native.
  const safeGlobals = new WeakMap();
  function safeGlobal(target) {
    if (!target || typeof target !== 'object' && typeof target !== 'function') return target;
    if (safeGlobals.has(target)) return safeGlobals.get(target);
    const proxy = new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key, object);
      if (['window', 'self', 'top', 'parent', 'globalThis'].includes(key) && value) return safeGlobal(value);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    safeGlobals.set(target, proxy);
    return proxy;
  }
  class Clock extends Date { static now() { return now; } }
  class Observer {
    constructor(callback) { mutated = callback; }
    observe() {}
    disconnect() {}
  }
  const api = {
    runtime: { frame: { isTop } },
    report: report => { reports.push(JSON.parse(JSON.stringify(report))); return Promise.resolve(); },
    clear: () => { reports.push(null); return Promise.resolve(); },
    lifecycle: { signal, interval: callback => intervals.push(callback),
      timeout: (callback, ms) => timers.push({ callback, at: now + ms }),
      onCleanup: callback => cleanups.push(callback) },
    media: { find: () => media, snapshot: video => video && ({ currentTime: video.currentTime, duration: video.duration,
      paused: video.paused, ended: video.ended, playbackRate: video.playbackRate }),
      onChange: callback => { mediaChanged = callback; } },
    settings: { getAll: () => Promise.resolve({}), onChange: callback => { settingsChanged = callback; } },
    navigation: { onChange: callback => { navigationChanged = callback; } },
  };
  vm.runInNewContext(source, { ChudPresence: api, window: safeGlobal(window), document, location, URL, Date: Clock,
    MutationObserver: Observer, crypto: { randomUUID: () => `token-${++tokenId}` } });
  function elapse(ms) {
    const end = now + ms;
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const timer = timers.shift(); now = timer.at; timer.callback();
    }
    now = end;
  }
  return { reports, signal, listeners, location, attentionListeners, documentListeners,
    message: event => { for (const callback of [...listeners]) callback(event); },
    advance: (ms = 2000) => { elapse(ms); for (const callback of intervals) callback(); },
    elapse,
    mutate: () => mutated?.(),
    attention: type => (type === 'visibilitychange' ? documentListeners : attentionListeners).get(type)?.(),
    mediaChange: () => mediaChanged?.(),
    settings: settings => settingsChanged({ settings }),
    navigate: url => { location.href = url; navigationChanged?.(); },
    cleanup: () => { signal.aborted = true; for (const callback of cleanups) callback(); },
  };
}

function deliver(activity, f, playback = sample, overrides = {}) {
  activity.message({ origin: 'https://megaplay.buzz', source: f.frame.contentWindow,
    data: { channel: CHANNEL, type: 'sample', token: f.requests.at(-1)?.data.token, playback }, ...overrides });
}

test('Anikoto uses the actual selected episode, poster, and MegaPlay timeline', () => {
  const f = fixture(), activity = run(f);
  assert.equal(activity.reports.at(-1), null);
  assert.equal(f.requests.at(-1).origin, 'https://megaplay.buzz');
  deliver(activity, f);
  activity.advance();
  const report = activity.reports.at(-1);
  assert.deepEqual(report.media, { title: 'Episode 9', series: 'Yani Neko', episode: 9 });
  assert.deepEqual(report.display, { details: 'Yani Neko', state: 'Episode 9' });
  assert.equal(report.playback.position, sample.position);
  assert.equal(report.playback.duration, sample.duration);
  assert.equal(report.artwork.large, f.state.poster);
  assert.equal(report.buttons[0].url, 'https://anikototv.to/watch/chainsmoker-cat/ep-9');
  assert.equal(report.kind, 'episode');
  activity.cleanup();
});

test('Anikoto validates frame origin, sender, token, and numeric playback', () => {
  const f = fixture(), activity = run(f);
  deliver(activity, f, sample, { origin: 'https://evil.example' });
  deliver(activity, f, sample, { source: {} });
  deliver(activity, f, sample, { data: { channel: CHANNEL, type: 'sample', token: 'old', playback: sample } });
  activity.advance();
  assert.equal(activity.reports.at(-1), null);
  for (const invalid of [{ ...sample, duration: Infinity }, { ...sample, rate: 17 },
    { ...sample, position: -1 }, { ...sample, position: '40' }, { ...sample, duration: 0 },
    { ...sample, duration: 40 }, { ...sample, ad: 'false' }]) {
    deliver(activity, f, invalid);
    activity.advance();
    assert.equal(activity.reports.at(-1), null);
  }
  deliver(activity, f);
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  activity.cleanup();
});

test('Anikoto follows pause, seek, rate, ad, end, settings, and sample expiry', () => {
  const f = fixture(), activity = run(f);
  deliver(activity, f, { ...sample, state: 'paused', position: 500, rate: 1.5 });
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 500);
  assert.equal(activity.reports.at(-1).playback.rate, 1.5);
  assert.equal(activity.reports.at(-1).artwork.smallText, 'Paused');
  activity.settings({ displayOrder: 'episode', showArtwork: false });
  activity.advance();
  assert.equal(activity.reports.at(-1).display.details, 'Episode 9');
  assert.deepEqual(activity.reports.at(-1).artwork, {});
  deliver(activity, f, { ...sample, ad: true });
  activity.advance();
  assert.equal(activity.reports.at(-1).visibility, 'ad');
  deliver(activity, f, { ...sample, ended: true });
  assert.equal(activity.reports.at(-1), null);
  deliver(activity, f);
  activity.advance();
  assert.equal(activity.reports.at(-1).visibility, 'normal');
  activity.advance(76_000);
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});

test('Anikoto discards old episodes and player reloads, replacements, and removals', () => {
  const f = fixture(), activity = run(f);
  deliver(activity, f); activity.advance();
  const oldToken = f.requests.at(-1).data.token;
  activity.navigate('https://anikototv.to/watch/chainsmoker-cat/ep-10');
  assert.equal(activity.reports.at(-1), null);
  deliver(activity, f); activity.advance();
  assert.equal(activity.reports.at(-1), null);
  f.state.episode = '10'; f.state.episodeTitle = 'Episode 10';
  f.frame.src = playerUrl.replace('788933', '788934');
  activity.mutate();
  const newToken = f.requests.at(-1).data.token;
  assert.notEqual(newToken, oldToken);
  deliver(activity, f, sample, { data: { channel: CHANNEL, type: 'sample', token: oldToken, playback: sample } });
  assert.equal(activity.reports.at(-1), null);
  deliver(activity, f, { ...sample, position: 0 }); activity.advance();
  assert.equal(activity.reports.at(-1).media.episode, 10);
  assert.equal(activity.reports.at(-1).playback.position, 0);
  for (const callback of [...f.load]) callback();
  assert.equal(activity.reports.at(-1), null);
  assert.notEqual(f.requests.at(-1).data.token, newToken);
  deliver(activity, f); activity.advance();
  f.state.frames = [];
  activity.mutate();
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
  assert.equal(f.load.size, 0);
});

test('Anikoto supports movie and direct-video pages without inventing a season', () => {
  const f = fixture();
  f.state.type = 'Movie'; f.state.frames = [];
  f.state.video = { currentTime: 0, duration: 7200, paused: false, ended: false, playbackRate: 1 };
  const activity = run(f);
  assert.deepEqual(activity.reports.at(-1).media, { title: 'Yani Neko' });
  assert.equal(activity.reports.at(-1).kind, 'movie');
  f.state.type = 'TV';
  activity.advance();
  assert.equal(activity.reports.at(-1).kind, 'episode');
  assert.equal(activity.reports.at(-1).media.season, undefined);
  f.state.video.ended = true;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});

test('Anikoto clears browsing, missing metadata, mismatched routes, and unsafe artwork', () => {
  const f = fixture(), activity = run(f);
  f.state.active = false;
  deliver(activity, f); activity.advance();
  assert.equal(activity.reports.at(-1), null);
  f.state.active = true;
  activity.advance();
  f.state.poster = 'https://user:secret@images.example.com/private.png';
  f.state.title = 'Yani Neko'.repeat(100);
  deliver(activity, f); activity.advance();
  assert.equal(activity.reports.at(-1).media.series.length, 256);
  assert.equal(activity.reports.at(-1).artwork.large, undefined);
  assert.ok(activity.reports.at(-1).artwork.largeText.length <= 256);
  for (const url of ['https://anikototv.to/home', 'https://anikototv.to/watch/another-show/ep-9',
    'https://evil.example/watch/chainsmoker-cat/ep-9', 'http://anikototv.to/watch/chainsmoker-cat/ep-9']) {
    activity.navigate(url); activity.advance();
    assert.equal(activity.reports.at(-1), null);
  }
  activity.cleanup();
});

test('Anikoto supports a bare series URL with the selected episode link', () => {
  const f = fixture(), activity = run({ ...f, url: 'https://anikototv.to/watch/chainsmoker-cat' });
  deliver(activity, f); activity.advance();
  assert.equal(activity.reports.at(-1).media.episode, 9);
  assert.equal(activity.reports.at(-1).buttons[0].url, 'https://anikototv.to/watch/chainsmoker-cat/ep-9');
  activity.cleanup();
});

test('MegaPlay child handshakes only with its Anikoto parent and never reports directly', () => {
  const outbound = [], parent = { postMessage: (data, origin) => outbound.push({ data, origin }) };
  const video = { currentTime: 140, duration: 1422, paused: false, ended: false, playbackRate: 1 };
  const document = { querySelector: selector => selector === '#megaplay-player video' ? video : null };
  const activity = run({ isTop: false, url: playerUrl, document, parent });
  const request = { channel: CHANNEL, type: 'request', token: 'paired-token' };
  const event = { source: parent, origin: 'https://anikototv.to', data: request };
  activity.message({ ...event, origin: 'https://evil.example' });
  activity.message({ ...event, source: {} });
  activity.advance();
  assert.equal(outbound.length, 0);
  activity.message(event);
  assert.equal(outbound.at(-1).origin, 'https://anikototv.to');
  assert.equal(outbound.at(-1).data.token, 'paired-token');
  assert.equal(outbound.at(-1).data.playback.position, 140);
  video.paused = true; video.currentTime = 0; video.playbackRate = 2;
  activity.mediaChange();
  assert.equal(outbound.at(-1).data.playback.state, 'paused');
  assert.equal(outbound.at(-1).data.playback.position, 0);
  assert.equal(outbound.at(-1).data.playback.rate, 2);
  activity.cleanup();
  assert.equal(outbound.at(-1).data.playback, null);
  const count = outbound.length;
  activity.advance(); activity.message(event);
  assert.equal(outbound.length, count);
  assert.equal(activity.reports.length, 0);
  assert.equal(activity.listeners.size, 0);
});

test('Unrelated injected frames and standalone MegaPlay pages are inert', () => {
  for (const [url, isTop] of [['https://megaplay.buzz/stream/example', true],
    ['https://evil.example/stream/example', false], ['https://megaplay.buzz/other', false]]) {
    const activity = run({ url, isTop, document: {} });
    activity.advance(); activity.cleanup();
    assert.equal(activity.reports.length, 0);
    assert.equal(activity.listeners.size, 0);
  }
});

test('Anikoto coalesces frequent player messages within the V1 request budget', () => {
  const f = fixture(), activity = run(f);
  for (let i = 0; i < 100; i++) {
    deliver(activity, f, { ...sample, position: i });
    activity.elapse(100);
  }
  assert.ok(activity.reports.length < 10, `Too many reports: ${activity.reports.length}`);
  activity.cleanup();
  const count = activity.reports.length;
  activity.advance(); deliver(activity, f);
  assert.equal(activity.reports.length, count);
});

test('Anikoto reports browsing on focused visible pages and clears when attention leaves', () => {
  const f = fixture();
  f.document.visibilityState = 'visible'; f.state.focused = true; f.state.frames = [];
  const activity = run({ ...f, url: 'https://anikototv.to/home' });
  const report = activity.reports.at(-1);
  assert.equal(report.kind, 'generic');
  assert.deepEqual(report.media, { title: 'Browsing Anikoto' });
  assert.deepEqual(report.display, { details: 'Browsing Anikoto', state: '', statusDisplayOverride: 'name', hideState: true });
  assert.equal(report.playback.duration, 0);
  assert.equal(report.artwork.large, 'https://anikototv.to/AnikotoTheme/assets/images/favicon.png');
  f.state.focused = false;
  activity.attention('blur');
  assert.equal(activity.reports.at(-1), null);
  f.state.focused = true;
  activity.attention('focus'); activity.advance();
  assert.equal(activity.reports.at(-1).media.title, 'Browsing Anikoto');
  f.document.visibilityState = 'hidden';
  activity.attention('visibilitychange');
  assert.equal(activity.reports.at(-1), null);
  f.document.visibilityState = 'visible';
  activity.attention('visibilitychange'); activity.advance();
  assert.equal(activity.reports.at(-1).kind, 'generic');
  activity.navigate('https://www.anikototv.to/filter?keyword=anime'); activity.advance();
  assert.equal(activity.reports.at(-1).display.details, 'Browsing Anikoto');
  activity.cleanup();
  assert.equal(activity.attentionListeners.size, 0);
  assert.equal(activity.documentListeners.size, 0);
});

test('Anikoto browsing honors artwork settings without affecting its text controls', () => {
  const f = fixture();
  f.document.visibilityState = 'visible'; f.state.focused = true;
  const activity = run({ ...f, url: 'https://anikototv.to/home' });
  activity.settings({ showArtwork: false }); activity.advance();
  assert.deepEqual(activity.reports.at(-1).artwork, {});
  assert.equal(activity.reports.at(-1).display.statusDisplayOverride, 'name');
  assert.equal(activity.reports.at(-1).display.hideState, true);
  activity.settings({ showArtwork: true }); activity.advance();
  assert.equal(activity.reports.at(-1).artwork.large, 'https://anikototv.to/AnikotoTheme/assets/images/favicon.png');
  activity.cleanup();
});

test('Anikoto SPA browsing navigation replaces reports without clearing presence between routes', () => {
  const f = fixture();
  f.document.visibilityState = 'visible'; f.state.focused = true; f.state.frames = [];
  const activity = run({ ...f, url: 'https://anikototv.to/home' });
  activity.navigate('https://anikototv.to/filter?keyword=anime'); activity.advance();
  activity.navigate('https://anikototv.to/watch/chainsmoker-cat'); activity.advance();
  assert.ok(activity.reports.length >= 3);
  assert.ok(activity.reports.every(report => report?.display.details === 'Browsing Anikoto'));
  activity.cleanup();
});

test('Anikoto keeps playback ahead of browsing and falls back after playback ends or disappears', () => {
  const f = fixture();
  f.document.visibilityState = 'visible'; f.state.focused = true;
  const activity = run(f);
  assert.equal(activity.reports.at(-1).kind, 'generic');
  deliver(activity, f); activity.advance();
  assert.equal(activity.reports.at(-1).kind, 'episode');
  assert.equal(activity.reports.at(-1).display.statusDisplayOverride, undefined);
  assert.equal(activity.reports.at(-1).display.hideState, undefined);
  deliver(activity, f, { ...sample, state: 'paused' }); activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  assert.equal(activity.reports.at(-1).kind, 'episode');
  f.state.focused = false; f.document.visibilityState = 'hidden';
  activity.attention('visibilitychange'); activity.advance();
  assert.equal(activity.reports.at(-1).kind, 'episode');
  f.state.focused = true; f.document.visibilityState = 'visible';
  deliver(activity, f, { ...sample, ended: true }); activity.advance();
  assert.equal(activity.reports.at(-1).kind, 'generic');
  deliver(activity, f); activity.advance();
  f.state.frames = []; activity.mutate(); activity.advance();
  assert.equal(activity.reports.at(-1).kind, 'generic');
  activity.cleanup();
});

test('Anikoto browsing requires both visibility and focus and never reports off-service', () => {
  const f = fixture();
  const activity = run({ ...f, url: 'https://anikototv.to/home' });
  f.document.visibilityState = 'visible'; activity.attention('visibilitychange');
  assert.equal(activity.reports.at(-1), null);
  f.document.visibilityState = 'hidden'; f.state.focused = true; activity.attention('focus');
  assert.equal(activity.reports.at(-1), null);
  f.document.visibilityState = 'visible'; activity.attention('visibilitychange'); activity.advance();
  assert.equal(activity.reports.at(-1).kind, 'generic');
  activity.navigate('https://evil.example/home');
  assert.equal(activity.reports.at(-1), null);
  activity.navigate('http://anikototv.to/home'); activity.advance();
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});
