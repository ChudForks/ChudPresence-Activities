import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors SoundCloud's October 2026 miniplayer DOM: audio is detached, title
// text includes a screen-reader duplicate, and the timeline uses seconds.
function soundcloudPlayer() {
  const state = { title: 'First song', artist: 'Test artist', href: '/test-artist/first-song',
    artistHref: '/test-artist', position: '61', duration: '263', playing: true,
    visible: true, ad: false, background: 'url("https://i1.sndcdn.com/artworks-example-t50x50.jpg")' };
  const titleLink = {
    get href() { return state.href; },
    get textContent() { return `Current track: ${state.title}${state.title}`; },
    getAttribute(name) { return name === 'title' ? state.title : null; },
    querySelector() { return { textContent: state.title }; },
  };
  const artistLink = {
    get href() { return state.artistHref; },
    get textContent() { return state.artist; },
    getAttribute(name) { return name === 'title' ? state.artist : null; },
  };
  const control = { classList: { contains(name) { return name === 'playing' && state.playing; } } };
  const progress = { getAttribute(name) {
    return { 'aria-valuenow': state.position, 'aria-valuemax': state.duration }[name] ?? null;
  } };
  const bar = {
    classList: { contains(name) { return name === 'm-visible' && state.visible; } },
    getAttribute() { return null; },
    matches() { return state.ad; },
    querySelector(selector) {
      return {
        '.playbackSoundBadge__titleLink': titleLink,
        '.playbackSoundBadge__lightLink': artistLink,
        '.playControls__play': control,
        '.playbackTimeline__progressWrapper': progress,
        '.playbackSoundBadge__avatar .image__full': { style: { backgroundImage: state.background } },
      }[selector] || null;
    },
  };
  return { state, bar };
}

test('SoundCloud reports the miniplayer song while browsing Discover', async () => {
  const { bar } = soundcloudPlayer();
  const activity = await runActivity('soundcloud', {
    url: 'https://soundcloud.com/discover', selectors: { '.playControls': bar },
    metadata: { title: 'Unrelated Media Session title', artist: 'Unrelated artist' },
  });
  const report = activity.reports.at(-1);
  assert.equal(report.kind, 'song');
  assert.equal(report.media.title, 'First song');
  assert.equal(report.media.artist, 'Test artist');
  assert.equal(report.playback.position, 61);
  assert.equal(report.playback.duration, 263);
  assert.equal(report.display.detailsUrl, 'https://soundcloud.com/test-artist/first-song');
  assert.equal(report.display.stateUrl, 'https://soundcloud.com/test-artist');
  assert.equal(report.artwork.large, 'https://i1.sndcdn.com/artworks-example-t500x500.jpg');
  assert.equal(report.artwork.largeUrl, report.display.detailsUrl);
  assert.equal(report.artwork.largeText, '');
  assert.equal(report.media.album, undefined);
  assert.equal(report.buttons.length, 2);
  activity.navigate('https://soundcloud.com/search?q=unrelated');
  activity.advance();
  assert.equal(activity.reports.at(-1).display.detailsUrl, report.display.detailsUrl);
});

test('SoundCloud follows pause, resume, seek, and queue changes', async () => {
  const { state, bar } = soundcloudPlayer();
  const activity = await runActivity('soundcloud', {
    url: 'https://soundcloud.com/', selectors: { '.playControls': bar },
    mediaSessionState: 'playing',
  });
  state.playing = false;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  assert.equal(activity.reports.at(-1).artwork.smallText, 'Paused');
  state.playing = true;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  assert.equal(activity.reports.at(-1).artwork.small, undefined);
  state.position = '120';
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 120);
  state.title = 'Second song';
  state.href = '/test-artist/second-song?in=test-artist/sets/mix#t=0:00';
  state.position = '0';
  state.duration = '180';
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).media.title, 'Second song');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 180);
  assert.equal(activity.reports.at(-1).display.detailsUrl, 'https://soundcloud.com/test-artist/second-song');
});

test('SoundCloud advances frozen background progress and accepts seeks and pauses', async () => {
  const { state, bar } = soundcloudPlayer();
  const activity = await runActivity('soundcloud', {
    url: 'https://soundcloud.com/', selectors: { '.playControls': bar },
  });
  activity.document.hidden = true;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 63);
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 65);
  state.position = '10';
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 10);
  state.playing = false;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 10);
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 10);
  state.playing = true;
  state.position = '262';
  activity.advance();
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 263);
});

test('SoundCloud clears absent, hidden, advertising, ended, and private players', async () => {
  for (const change of [
    (state) => { state.visible = false; },
    (state) => { state.ad = true; },
    (state) => { state.playing = false; state.position = state.duration; },
    (state) => { state.href = '/test-artist/first-song?secret_token=s-private'; },
    (state) => { state.href = '/test-artist/first-song/s-private'; },
    (state) => { state.href = 'https://example.com/test-artist/first-song'; },
    (state) => { state.href = 'http://soundcloud.com/test-artist/first-song'; },
    (state) => { state.href = 'https://user:password@soundcloud.com/test-artist/first-song'; },
    (state) => { state.href = '/test-artist/sets'; },
    (state) => { state.title = ''; },
  ]) {
    const { state, bar } = soundcloudPlayer();
    const activity = await runActivity('soundcloud', {
      url: 'https://soundcloud.com/', selectors: { '.playControls': bar },
    });
    assert.ok(activity.reports.at(-1));
    change(state);
    activity.mediaChange();
    assert.equal(activity.reports.at(-1), null);
  }
  const idle = await runActivity('soundcloud', {
    url: 'https://soundcloud.com/test-artist/first-song',
    metadata: { title: 'Metadata alone is not playback' },
  });
  assert.equal(idle.reports.at(-1), null);
});

test('SoundCloud settings, malformed timelines, and unsafe artwork stay within V1', async () => {
  const { state, bar } = soundcloudPlayer();
  const activity = await runActivity('soundcloud', {
    url: 'https://www.soundcloud.com/', selectors: { '.playControls': bar },
  });
  activity.settings({ settings: { showArtwork: false } });
  assert.equal(Object.keys(activity.reports.at(-1).artwork).length, 0);
  state.position = 'Infinity';
  state.duration = '-10';
  state.artist = 'Artist'.repeat(100);
  state.title = 'Title'.repeat(100);
  state.background = 'url("javascript:alert(1)")';
  state.artistHref = 'https://example.com/artist';
  activity.settings({ settings: { showArtwork: true } });
  const report = activity.reports.at(-1);
  assert.equal(report.playback.position, 0);
  assert.equal(report.playback.duration, 0);
  assert.equal(report.media.title.length, 256);
  assert.equal(report.media.artist.length, 256);
  assert.equal(report.artwork.large, undefined);
  assert.equal(report.display.stateUrl, undefined);
  assert.equal(report.buttons.length, 1);
  activity.cleanup();
  assert.equal(activity.reports.at(-1), null);
});

test('SoundCloud coalesces progress events and keeps paused reports alive', async () => {
  const { state, bar } = soundcloudPlayer();
  const activity = await runActivity('soundcloud', {
    url: 'https://soundcloud.com/', selectors: { '.playControls': bar },
  });
  state.position = '62';
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).playback.position, 61);
  activity.elapse(500);
  assert.equal(activity.reports.at(-1).playback.position, 62);
  state.playing = false;
  activity.mediaChange();
  const count = activity.reports.length;
  for (let index = 0; index < 4; index += 1) activity.advance();
  assert.equal(activity.reports.length, count + 1);
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
});

function youtubePlayer(video) {
  return { querySelector(selector) { return selector.startsWith('video') ? video : null; } };
}

async function runActivity(id, {
  url, title = '', metadata = null, selectors = {}, selectorLookup = null,
  selectorAllLookup = null, frames = [], storage = {}, netFetch = null, pageFetch = null, pageExecute = null,
  mediaSessionState = 'playing',
} = {}) {
  const source = await fs.readFile(path.join(root, 'activities', id, 'activity.js'), 'utf8');
  const reports = [];
  const cleanups = [];
  const windowListeners = [];
  let settingsChanged;
  let navigationChanged;
  let mediaChanged;
  let heartbeat;
  let now = 2000;
  const timeouts = [];
  function elapse(ms) {
    const target = now + ms;
    while (true) {
      const next = timeouts.reduce((first, timer) =>
        timer.at <= target && (!first || timer.at < first.at) ? timer : first, null);
      if (!next) break;
      timeouts.splice(timeouts.indexOf(next), 1);
      now = next.at;
      next.callback();
    }
    now = target;
  }
  const location = new URL(url);
  const store = {};
  const document = {
    title,
    hidden: false,
    documentElement: {},
    querySelector(selector) { return selectors[selector] || selectorLookup?.(selector) || null; },
    querySelectorAll(selector) {
      if (selector === 'script[type="application/ld+json"]' && metadata) {
        return [{ textContent: JSON.stringify(metadata) }];
      }
      if (selector === 'iframe') return frames;
      const found = selectorAllLookup?.(selector);
      if (found) return found;
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const pageWindow = {
    addEventListener(type, callback) { windowListeners.push({ type, callback }); },
    removeEventListener(type, callback) {
      const index = windowListeners.findIndex((item) => item.type === type && item.callback === callback);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
  const ChudPresence = {
    report(report) { reports.push(report); return Promise.resolve(); },
    clear() { reports.push(null); return Promise.resolve(); },
    runtime: { has(feature) { return feature === 'pageExecute' && typeof pageExecute === 'function'; } },
    page: { execute(fn, args) { return Promise.resolve(pageExecute?.(fn, args) ?? null); } },
    lifecycle: {
      signal: { aborted: false },
      interval(callback) { heartbeat = callback; },
      timeout(callback, delay) { timeouts.push({ callback, at: now + delay }); },
      onCleanup(callback) { cleanups.push(callback); },
    },
    navigation: { onChange(callback) { navigationChanged = callback; } },
    media: { find() { return null; }, snapshot() { return null; }, onChange(callback) { mediaChanged = callback; } },
    dom: { observe() {} },
    net: {
      fetch(requestUrl, options) {
        if (typeof netFetch === 'function') return netFetch(requestUrl, options);
        return Promise.reject(Object.assign(new Error('Network unavailable'), { code: 'network_unavailable' }));
      },
    },
    settings: {
      getAll() { return Promise.resolve({}); },
      onChange(callback) { settingsChanged = callback; },
    },
    storage: {
      get(key) { return Promise.resolve(Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null); },
      set(key, value) { store[key] = value; return Promise.resolve(true); },
      remove(key) {
        const had = Object.prototype.hasOwnProperty.call(store, key);
        delete store[key];
        return Promise.resolve(had);
      },
      clear() {
        const count = Object.keys(store).length;
        for (const key of Object.keys(store)) delete store[key];
        return Promise.resolve(count);
      },
    },
  };
  class DateAt extends Date { static now() { return now; } }
  class MutationObserver { observe() {} disconnect() {} }
  vm.runInNewContext(source, {
    ChudPresence, Date: DateAt, MutationObserver, URL, URLSearchParams,
    document, location, window: pageWindow,
    localStorage: {
      getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    },
    navigator: { mediaSession: { playbackState: mediaSessionState, metadata: metadata?.mediaSession || metadata } },
    ...(typeof pageFetch === 'function' ? { fetch: pageFetch } : {}),
  }, { filename: `${id}/activity.js` });
  return {
    reports,
    settings(event) { elapse(2000); settingsChanged(event); },
    navigate(href) { elapse(500); location.href = href; navigationChanged(); },
    mediaChange() { elapse(500); mediaChanged(); },
    message(event) {
      for (const listener of windowListeners) {
        if (listener.type === 'message') listener.callback(event);
      }
    },
    advance() { elapse(2000); heartbeat(); },
    elapse,
    cleanup() { for (const callback of cleanups) callback(); },
    document,
    storage: store,
  };
}

test('Hulu reads dedicated player metadata, artwork, and timeline values', async () => {
  const video = { currentTime: 1259, duration: Infinity, paused: false, ended: false, playbackRate: 1 };
  const timeline = {
    getAttribute(name) {
      return { 'aria-valuenow': '1259', 'aria-valuemax': '1476' }[name] || null;
    },
  };
  const label = {
    getAttribute(name) {
      return name === 'aria-label'
        ? 'You are watching - BLEACH: Thousand-Year Blood War S1 E2 (Sub) FOUNDATION STONES TV14 For more actions, you can press the space key.'
        : null;
    },
  };
  const playerSelectors = {
    video,
    '.PlayerMetadata__titleText': { textContent: 'BLEACH: Thousand-Year Blood War' },
    '.PlayerMetadata__seasonEpisodeText': { textContent: 'S1 E2' },
    '.PlayerMetadata__subTitleText': { textContent: '(Sub) FOUNDATION STONES' },
    '[aria-label="Timeline"][aria-valuenow], .Timeline__slider[aria-valuenow]': timeline,
  };
  const root = {
    querySelector(selector) { return playerSelectors[selector] || null; },
    querySelectorAll(selector) { return selector === '[aria-label]' ? [label] : []; },
  };
  const seriesId = '02a3c8c0-4f1d-4610-bbb4-5b8e9468d7b1';
  const cover = {
    alt: 'Cover art for BLEACH: Thousand-Year Blood War.',
    currentSrc: `https://img3.hulu.com/user/v3/artwork/${seriesId}`,
  };
  const episodeArtwork = 'https://img3.hulu.com/user/v3/artwork/f5d452e7-424d-43b4-ab7b-4dd1c7373dff' +
    '?base_image_bucket_name=image_manager\\u0026base_image=921908ce-7fc2-4fd3-8f46-d3366f4e5f87';
  const activity = await runActivity('hulu', {
    url: 'https://www.hulu.com/watch/f5d452e7-424d-43b4-ab7b-4dd1c7373dff',
    selectors: { '#web-player-app': root },
    selectorAllLookup(selector) {
      if (selector === 'img') return [cover];
      return null;
    },
    netFetch(requestUrl, options) {
      assert.equal(requestUrl,
        `https://www.hulu.com/series/bleach-thousand-year-blood-war-${seriesId}`);
      assert.equal(options.responseType, 'text');
      assert.equal(options.timeoutMs, 3000);
      return Promise.resolve({
        ok: true,
        status: 200,
        data: `{"id":"f5d452e7-424d-43b4-ab7b-4dd1c7373dff","type":"episode","name":"(Sub) FOUNDATION STONES","season":1,"number":2,"duration":1476,"seriesName":"BLEACH: Thousand-Year Blood War","artwork":{"horizontalHero":{"path":"${episodeArtwork}"}}}`,
      });
    },
  });
  await flushActivity();
  activity.advance();
  const report = activity.reports.at(-1);
  assert.equal(report.kind, 'episode');
  assert.equal(report.media.title, 'FOUNDATION STONES');
  assert.equal(report.media.series, 'BLEACH: Thousand-Year Blood War');
  assert.equal(report.media.season, 1);
  assert.equal(report.media.episode, 2);
  assert.equal(report.display.details, 'FOUNDATION STONES');
  assert.equal(report.display.state, 'BLEACH: Thousand-Year Blood War');
  assert.equal(report.playback.state, 'playing');
  assert.equal(report.playback.position, 1259);
  assert.equal(report.playback.duration, 1476);
  assert.match(report.artwork.large, /^https:\/\/img3\.hulu\.com\/user\/v3\/artwork\/f5d452e7/);
  assert.match(report.artwork.large, /operations=/);
  assert.notEqual(report.artwork.large, cover.currentSrc);
  assert.equal(report.artwork.largeText, 'Season 1, Episode 2 • FOUNDATION STONES');
  activity.cleanup();
});

test('Hulu movie ignores rating guidance and Up Next episode metadata', async () => {
  const video = { currentTime: 118, duration: 6404, paused: false, ended: false, playbackRate: 1 };
  const onNow = {
    querySelector(selector) {
      return selector === '.PlayerMetadata__titleText' ? { textContent: 'Tropic Thunder' } : null;
    },
  };
  const label = {
    getAttribute(name) {
      return name === 'aria-label'
        ? 'You are watching   -  Tropic Thunder\n      R  For more actions, you can press the space key\n' +
          'to expand the hidden region. Once the hidden region been expand, you can press the tab key for more details'
        : null;
    },
    closest() { return onNow; },
  };
  const root = {
    querySelector(selector) {
      if (selector === 'video') return video;
      if (selector === '[data-testid="player-metadata"].OnNowMetadata') return onNow;
      if (selector === '.PlayerMetadata__seasonEpisodeText') return { textContent: 'S1 E6' };
      if (selector === '.PlayerMetadata__titleText') return { textContent: 'BLEACH: Thousand-Year Blood War' };
      return null;
    },
    querySelectorAll(selector) { return selector === '[aria-label]' ? [label] : []; },
  };
  const activity = await runActivity('hulu', {
    url: 'https://www.hulu.com/watch/73ed908e-b3b0-4033-8937-1d91b1a12e94',
    selectors: { '#web-player-app': root },
    pageFetch(requestUrl, options) {
      assert.equal(requestUrl, 'https://www.hulu.com/movie/73ed908e-b3b0-4033-8937-1d91b1a12e94');
      assert.equal(options.credentials, 'omit');
      return Promise.resolve({
        ok: true,
        text: async () => '<meta property="og:image" content="https://img.hulu.com/user/v3/artwork/' +
          '73ed908e-b3b0-4033-8937-1d91b1a12e94?base_image_bucket_name=image_manager&amp;' +
          'base_image=21498ad6-d19f-461d-90f8-1d9266608b19&amp;size=1200x630&amp;format=webp"/>',
      });
    },
  });
  await flushActivity();
  activity.advance();
  const report = activity.reports.at(-1);
  assert.equal(report.kind, 'movie');
  assert.equal(report.media.title, 'Tropic Thunder');
  assert.equal(report.media.series, undefined);
  assert.equal(report.media.season, undefined);
  assert.equal(report.media.episode, undefined);
  assert.equal(report.display, undefined);
  assert.match(report.artwork.large,
    /^https:\/\/img\.hulu\.com\/user\/v3\/artwork\/73ed908e-b3b0-4033-8937-1d91b1a12e94\?/);
  assert.match(report.artwork.large, /base_image=21498ad6-d19f-461d-90f8-1d9266608b19/);
  assert.match(report.artwork.large, /operations=/);
  assert.equal(report.artwork.largeText, 'Tropic Thunder');
  activity.cleanup();
});

test('Hulu reports promptly from watch-page metadata before the player DOM appears', async () => {
  const id = 'd8502813-7e68-4d8f-8660-31f28e29587b';
  const seriesId = '02a3c8c0-4f1d-4610-bbb4-5b8e9468d7b1';
  const activity = await runActivity('hulu', {
    url: `https://www.hulu.com/watch/${id}`,
    selectors: {
      'meta[property="og:title"], meta[name="og:title"]': {
        content: 'BLEACH: Thousand-Year Blood War | Hulu',
      },
      'meta[property="og:image"], meta[name="og:image"]': {
        content: `https://img3.hulu.com/user/v3/artwork/${seriesId}`,
      },
    },
    netFetch(requestUrl) {
      assert.equal(requestUrl,
        `https://www.hulu.com/series/bleach-thousand-year-blood-war-${seriesId}`);
      return Promise.resolve({
        ok: true,
        status: 200,
        data: `{"id":"${id}","type":"episode","name":"(Sub) MARCH OF THE STARCROSS","season":1,"number":3,"duration":1477,"seriesName":"BLEACH: Thousand-Year Blood War","artwork":{"horizontalHero":{"path":"https://img3.hulu.com/user/v3/artwork/${id}?base_image_bucket_name=image_manager\\u0026base_image=921908ce-7fc2-4fd3-8f46-d3366f4e5f87"}}}`,
      });
    },
  });
  await flushActivity();
  activity.advance();
  const report = activity.reports.at(-1);
  assert.equal(report.media.title, 'MARCH OF THE STARCROSS');
  assert.equal(report.media.series, 'BLEACH: Thousand-Year Blood War');
  assert.equal(report.media.season, 1);
  assert.equal(report.media.episode, 3);
  assert.equal(report.playback.duration, 1477);
  assert.match(report.artwork.large, new RegExp(`/artwork/${id}`));
  activity.cleanup();
});

test('Hulu reads series metadata from the page before the extension fetch', async () => {
  const id = 'd6c09933-2ab0-4a70-b33a-b7cb1e7b406e';
  const seriesId = '02a3c8c0-4f1d-4610-bbb4-5b8e9468d7b1';
  let extensionCalled = false;
  const activity = await runActivity('hulu', {
    url: `https://www.hulu.com/watch/${id}`,
    selectors: {
      'meta[property="og:title"], meta[name="og:title"]': {
        content: 'BLEACH: Thousand-Year Blood War | Hulu',
      },
      'meta[property="og:image"], meta[name="og:image"]': {
        content: `https://img3.hulu.com/user/v3/artwork/${seriesId}`,
      },
    },
    pageFetch(requestUrl, options) {
      assert.equal(requestUrl, `https://www.hulu.com/series/bleach-thousand-year-blood-war-${seriesId}`);
      assert.equal(options.credentials, 'omit');
      return Promise.resolve({
        ok: true,
        text: async () => `{"id":"${id}","type":"episode","name":"(Sub) WRATH AS A LIGHTNING","season":1,"number":5,"duration":1472,"seriesName":"BLEACH: Thousand-Year Blood War","artwork":{"horizontalHero":{"path":"https://img.hulu.com/user/v3/artwork/${id}?base_image=6be21b65"}}}`,
      });
    },
    netFetch() {
      extensionCalled = true;
      return Promise.reject(new Error('extension fetch should not run'));
    },
  });
  await flushActivity();
  activity.advance();
  const report = activity.reports.at(-1);
  assert.equal(extensionCalled, false);
  assert.equal(report.media.title, 'WRATH AS A LIGHTNING');
  assert.equal(report.media.episode, 5);
  assert.match(report.artwork.large, new RegExp(`/artwork/${id}`));
  activity.cleanup();
});

test('Hulu falls back to the extension fetch when the page cannot read the series page', async () => {
  const id = 'd8502813-7e68-4d8f-8660-31f28e29587b';
  const seriesId = '02a3c8c0-4f1d-4610-bbb4-5b8e9468d7b1';
  const activity = await runActivity('hulu', {
    url: `https://www.hulu.com/watch/${id}`,
    selectors: {
      'meta[property="og:title"], meta[name="og:title"]': {
        content: 'BLEACH: Thousand-Year Blood War | Hulu',
      },
      'meta[property="og:image"], meta[name="og:image"]': {
        content: `https://img3.hulu.com/user/v3/artwork/${seriesId}`,
      },
    },
    pageFetch() {
      return Promise.reject(new TypeError('Page fetch failed.'));
    },
    netFetch(requestUrl) {
      assert.equal(requestUrl, `https://www.hulu.com/series/bleach-thousand-year-blood-war-${seriesId}`);
      return Promise.resolve({
        ok: true,
        status: 200,
        data: `{"id":"${id}","type":"episode","name":"(Sub) MARCH OF THE STARCROSS","season":1,"number":3,"duration":1477,"seriesName":"BLEACH: Thousand-Year Blood War","artwork":{"horizontalHero":{"path":"https://img3.hulu.com/user/v3/artwork/${id}?base_image=921908ce"}}}`,
      });
    },
  });
  await flushActivity();
  activity.advance();
  assert.equal(activity.reports.at(-1).media.title, 'MARCH OF THE STARCROSS');
  activity.cleanup();
});

test('Hulu retries incomplete episode metadata with backoff', async () => {
  const id = 'de474f6a-d168-41da-aa1c-2b66b8bac295';
  const seriesId = '02a3c8c0-4f1d-4610-bbb4-5b8e9468d7b1';
  let calls = 0;
  const activity = await runActivity('hulu', {
    url: `https://www.hulu.com/watch/${id}`,
    metadata: {
      '@type': 'TVEpisode',
      name: 'THE FIRE',
      episodeNumber: 6,
      partOfSeries: { name: 'BLEACH: Thousand-Year Blood War' },
      partOfSeason: { seasonNumber: 1 },
    },
    selectors: {
      'meta[property="og:title"], meta[name="og:title"]': {
        content: 'BLEACH: Thousand-Year Blood War | Hulu',
      },
      'meta[property="og:image"], meta[name="og:image"]': {
        content: `https://img3.hulu.com/user/v3/artwork/${seriesId}`,
      },
    },
    netFetch(requestUrl) {
      calls += 1;
      assert.equal(requestUrl, `https://www.hulu.com/series/bleach-thousand-year-blood-war-${seriesId}`);
      const data = calls < 3
        ? `{"id":"${id}","type":"episode","name":"(Sub) THE FIRE","season":1,"number":6,"duration":1476,"seriesName":"BLEACH: Thousand-Year Blood War"}`
        : `{"id":"${id}","type":"episode","name":"(Sub) THE FIRE","season":1,"number":6,"duration":1476,"seriesName":"BLEACH: Thousand-Year Blood War","artwork":{"horizontalHero":{"path":"https://img3.hulu.com/user/v3/artwork/${id}?base_image=019f96a4"}}}`;
      return Promise.resolve({ ok: true, status: 200, data });
    },
  });
  await flushActivity();
  assert.equal(calls, 1);
  assert.match(activity.reports.at(-1).artwork.large, new RegExp(`/artwork/${seriesId}`));

  activity.advance();
  await flushActivity();
  assert.equal(calls, 2);
  activity.advance();
  await flushActivity();
  assert.equal(calls, 2, 'the failed lookup waits for its backoff before retrying');
  activity.advance();
  await flushActivity();
  assert.equal(calls, 2);
  activity.advance();
  await flushActivity();
  assert.equal(calls, 3);
  assert.match(activity.reports.at(-1).artwork.large, new RegExp(`/artwork/${id}`));
  assert.equal(activity.reports.at(-1).artwork.largeText, 'Season 1, Episode 6 • THE FIRE');
  activity.cleanup();
});

async function flushActivity() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test('Crunchyroll package reports an episode and reacts to V1 settings changes', async () => {
  const activity = await runActivity('crunchyroll', {
    url: 'https://www.crunchyroll.com/watch/ABC123',
    title: 'Series Episode 2 - Episode One | Crunchyroll',
    metadata: { '@type': 'TVEpisode', name: 'Episode One', episodeNumber: 2,
      partOfSeries: { name: 'Series' } },
  });
  assert.equal(activity.reports.at(-1).kind, 'episode');
  assert.equal(activity.reports.at(-1).media.series, 'Series');
  assert.equal(activity.reports.at(-1).display.details, 'Series');
  assert.equal(activity.reports.at(-1).display.state, 'Episode 2');
  activity.settings({ id: 'displayOrder', value: 'episode', settings: { displayOrder: 'episode' } });
  assert.equal(activity.reports.at(-1).display.details, 'Episode One');
  assert.equal(activity.reports.at(-1).display.state, 'Series');
  activity.navigate('https://www.crunchyroll.com/series/ABC123');
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});

test('Crunchyroll does not mistake header and loading test IDs for an advertisement', async () => {
  const activity = await runActivity('crunchyroll', {
    url: 'https://www.crunchyroll.com/watch/ABC123/episode-one',
    title: 'Episode One - Watch on Crunchyroll',
    metadata: { '@type': 'TVEpisode', name: 'Episode One', partOfSeries: { name: 'Series' } },
    selectorLookup(selector) {
      // A site-wide header or loading marker matched the old substring selector.
      return selector.includes('[data-testid*="ad" i]') ? { textContent: 'Header' } : null;
    },
  });
  assert.equal(activity.reports.at(-1).visibility, 'normal');
  activity.cleanup();
});

test('YouTube Music package reports a song and applies V1 presentation settings', async () => {
  const selectors = {};
  const session = { title: 'Track', artist: 'Artist', album: 'Album',
    artwork: [{ src: 'https://example.com/cover.png', sizes: '512x512' }] };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    selectors,
    metadata: { mediaSession: session },
  });
  assert.equal(activity.reports.at(-1).kind, 'song');
  assert.equal(activity.reports.at(-1).media.artist, 'Artist');
  assert.equal(activity.reports.at(-1).display.state, 'Artist');
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  assert.equal(activity.reports.at(-1).artwork.large, 'https://example.com/cover.png');
  assert.equal(activity.reports.at(-1).artwork.small, undefined);
  assert.equal(activity.reports.at(-1).buttons[0].url, 'https://music.youtube.com/watch?v=abcdefghijk');
  activity.settings({ id: 'displayMode', value: 'album',
    settings: { displayMode: 'album', showArtwork: false } });
  assert.equal(activity.reports.at(-1).display.state, 'Album');
  assert.deepEqual(Object.keys(activity.reports.at(-1).artwork), []);
  session.title = 'Queued Track';
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  activity.advance();
  assert.equal(activity.reports.at(-1).media.title, 'Queued Track');
  assert.equal(activity.reports.at(-1).buttons[0].url, 'https://music.youtube.com/watch?v=lmnopqrstuv');
  selectors['.ad-showing'] = {};
  activity.mediaChange();
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
  assert.equal(activity.reports.at(-1), null);
});

test('YouTube Music keeps presence through brief player layout and playback changes', async () => {
  const video = { currentTime: 51, duration: 327, paused: false, ended: false, playbackRate: 1 };
  const bar = {
    querySelector(selector) {
      if (selector === '.title') return { textContent: 'So Far Away' };
      if (selector === '.time-info') return { textContent: '0:51 / 5:27' };
      return null;
    },
    querySelectorAll() { return []; },
  };
  const selectors = { 'ytmusic-player-bar': bar, video };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    selectors,
    mediaSessionState: 'paused',
  });
  assert.equal(activity.reports.at(-1).playback.state, 'playing');

  const initialCount = activity.reports.length;
  delete selectors['ytmusic-player-bar'];
  activity.mediaChange();
  assert.equal(activity.reports.length, initialCount);
  activity.elapse(500);
  selectors['ytmusic-player-bar'] = bar;
  activity.mediaChange();
  activity.elapse(1250);
  assert.equal(activity.reports.includes(null), false);

  video.paused = true;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  video.paused = false;
  activity.mediaChange();
  activity.elapse(1250);
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  assert.equal(activity.reports.some((report) => report?.playback.state === 'paused'), false);

  video.paused = true;
  activity.mediaChange();
  activity.elapse(1250);
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  video.paused = false;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).playback.state, 'playing');

  delete selectors['ytmusic-player-bar'];
  activity.mediaChange();
  activity.elapse(1250);
  assert.equal(activity.reports.at(-1), null);
  selectors['ytmusic-player-bar'] = bar;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  activity.cleanup();
});

function musicPlayerReader(page) {
  const player = {
    getVideoData() { return { video_id: page.videoId, title: page.title }; },
    getPlayerResponse() { return { videoDetails: {
      videoId: page.responseVideoId || page.videoId, lengthSeconds: String(page.metadataDuration),
    } }; },
    getDuration() { return page.duration; },
    getCurrentTime() { return page.position; },
  };
  return (fn) => vm.runInNewContext(`(${fn.toString()})()`, {
    document: { querySelector(selector) { return selector === '#movie_player' ? player : null; } },
  });
}

function musicSeekSlider(clock) {
  return {
    value: '', max: '',
    getAttribute(name) {
      return name === 'aria-valuenow' ? String(clock.position)
        : name === 'aria-valuemax' ? String(clock.duration) : null;
    },
  };
}

for (const bridge of [false, true]) {
  test(`YouTube Music reacts to home-page song clicks with a stale canonical URL${bridge ? ' through the page bridge' : ''}`, async () => {
    const session = { title: 'Previous song', artist: 'Previous artist' };
    const clock = { position: 180, duration: 278 };
    const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
    const canonical = { href: 'https://music.youtube.com/watch?v=0d9Oqm0Dt60' };
    const playerLink = { href: canonical.href };
    const page = { videoId: '0d9Oqm0Dt60', title: session.title, position: 180, duration: 278, metadataDuration: 278 };
    const activity = await runActivity('youtube-music', {
      url: 'https://music.youtube.com/', metadata: { mediaSession: session },
      selectors: { video, '#progress-bar': musicSeekSlider(clock),
        'link[rel="canonical"]': canonical, 'ytmusic-player a[href*="watch"]': playerLink },
      ...(bridge ? { pageExecute: musicPlayerReader(page) } : {}),
    });
    await flushActivity();
    assert.equal(activity.reports.at(-1).media.title, 'Previous song');
    session.title = "I'm Like A Lawyer With The Way I'm Always Trying To Get You Off (Me & You)";
    session.artist = 'Fall Out Boy';
    playerLink.href = 'https://music.youtube.com/watch?list=RDAMVM9QubKb7pjps&v=9QubKb7pjps';
    clock.position = 0;
    clock.duration = 212;
    video.currentTime = 0;
    video.duration = 212;
    Object.assign(page, { videoId: '9QubKb7pjps', title: session.title, position: 0, duration: 212, metadataDuration: 212 });
    activity.mediaChange();
    await flushActivity();
    activity.elapse(1000);
    await flushActivity();
    const clicked = activity.reports.at(-1);
    assert.equal(clicked.media.title, session.title);
    assert.equal(clicked.media.artist, 'Fall Out Boy');
    assert.equal(clicked.playback.position, 0);
    assert.equal(clicked.playback.duration, 212);
    assert.equal(clicked.display.detailsUrl, 'https://music.youtube.com/watch?v=9QubKb7pjps');
    assert.equal(canonical.href, 'https://music.youtube.com/watch?v=0d9Oqm0Dt60');
    clock.position = 3;
    video.currentTime = 3;
    page.position = 3;
    activity.advance();
    await flushActivity();
    assert.equal(activity.reports.at(-1).playback.position, 3);
    assert.equal(activity.reports.at(-1).playback.duration, 212);
    activity.cleanup();
  });
}

test('YouTube Music tracks home-page playback by title when no current song ID is available', async () => {
  const session = { title: 'Previous song', artist: 'Artist' };
  const clock = { position: 180, duration: 278 };
  const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock),
      'link[rel="canonical"]': { href: 'https://music.youtube.com/watch?v=0d9Oqm0Dt60' } },
  });
  clock.position = 182;
  video.currentTime = 665;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 182);
  session.title = 'Clicked song';
  clock.position = 0;
  clock.duration = 212;
  video.currentTime = 0;
  video.duration = 212;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).media.title, 'Clicked song');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 212);
  clock.position = 5;
  video.currentTime = 5;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 5);
  clock.position = 0;
  video.currentTime = 0;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 0, 'the title identity must also allow real seeks');
  activity.cleanup();
});

test('YouTube Music uses the playing song link while the watch URL preloads or remains on another song', async () => {
  const session = { title: 'Previous song' };
  const clock = { position: 202, duration: 218 };
  const video = { currentTime: 444, duration: 700, paused: false, ended: false, playbackRate: 1 };
  const playerLink = { href: 'https://music.youtube.com/watch?v=abcdefghijk' };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock), 'ytmusic-player a[href*="watch"]': playerLink },
  });
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  assert.equal(activity.reports.at(-1).media.title, 'Previous song');
  assert.equal(activity.reports.at(-1).display.detailsUrl, playerLink.href);
  video.currentTime = 446;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 204);
  session.title = 'Clicked song';
  playerLink.href = 'https://music.youtube.com/watch?v=woz5qvDdMRM';
  clock.position = 0;
  clock.duration = 278;
  video.currentTime = 0;
  video.duration = 278;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).media.title, 'Clicked song');
  assert.equal(activity.reports.at(-1).display.detailsUrl, playerLink.href);
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 278);
  activity.cleanup();
});

for (const hidden of [false, true]) {
  test(`YouTube Music does not anchor a new home-page song to the previous elapsed value${hidden ? ' in the background' : ''}`, async () => {
    const session = { title: 'Previous song', artist: 'Fall Out Boy' };
    const clock = { position: 180, duration: 278 };
    const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
    const playerLink = { href: 'https://music.youtube.com/watch?v=abcdefghijk' };
    const activity = await runActivity('youtube-music', {
      url: 'https://music.youtube.com/', metadata: { mediaSession: session },
      selectors: { video, '#progress-bar': musicSeekSlider(clock), 'ytmusic-player a[href*="watch"]': playerLink },
    });
    activity.document.hidden = hidden;
    session.title = 'Love From The Other Side';
    playerLink.href = 'https://music.youtube.com/watch?v=kxVLScacNyY';
    clock.duration = 280;
    video.currentTime = 784;
    video.duration = 1023;
    activity.mediaChange();
    assert.equal(activity.reports.at(-1).media.title, 'Previous song', 'a new maximum alone does not confirm its elapsed value');
    clock.position = 1;
    video.currentTime = 785;
    activity.advance();
    assert.equal(activity.reports.at(-1).media.title, 'Love From The Other Side');
    assert.equal(activity.reports.at(-1).playback.position, 1);
    assert.equal(activity.reports.at(-1).playback.duration, 280);
    clock.position = 113;
    video.currentTime = 897;
    activity.advance();
    assert.equal(activity.reports.at(-1).playback.position, 113);
    assert.equal(activity.reports.at(-1).playback.duration, 280);
    session.title = 'From Now On We Are Enemies';
    playerLink.href = 'https://music.youtube.com/watch?v=lmnopqrstuv';
    clock.duration = 217;
    clock.position = 0;
    video.currentTime = 1064;
    activity.mediaChange();
    assert.equal(activity.reports.at(-1).media.title, session.title);
    assert.equal(activity.reports.at(-1).playback.position, 0);
    assert.equal(activity.reports.at(-1).playback.duration, 217, 'the shorter third song still gets its own clock');
    activity.cleanup();
  });
}

test('YouTube Music repairs a home-page offset when the media timeline changes after the new seek clock', async () => {
  const session = { title: 'Previous song', artist: 'Fall Out Boy' };
  const clock = { position: 180, duration: 278 };
  const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
  const playerLink = { href: 'https://music.youtube.com/watch?v=abcdefghijk' };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock), 'ytmusic-player a[href*="watch"]': playerLink },
  });
  session.title = 'Love From The Other Side';
  playerLink.href = 'https://music.youtube.com/watch?v=kxVLScacNyY';
  clock.position = 0;
  clock.duration = 280;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  clock.position = 1;
  video.currentTime = 785;
  video.duration = 1023;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 1);
  assert.equal(activity.reports.at(-1).playback.duration, 280);
  clock.position = 113;
  video.currentTime = 897;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 113);
  activity.document.hidden = true;
  video.currentTime = 900;
  video.duration = 1400;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 116, 'a frozen slider must not keep rebasing the offset');
  assert.equal(activity.reports.at(-1).playback.duration, 280);
  activity.cleanup();
});

test('YouTube Music does not carry a new home-page maximum while the previous elapsed clock keeps advancing', async () => {
  const session = { title: 'Previous song' };
  const clock = { position: 180, duration: 278 };
  const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
  const playerLink = { href: 'https://music.youtube.com/watch?v=abcdefghijk' };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock), 'ytmusic-player a[href*="watch"]': playerLink },
  });
  session.title = 'Love From The Other Side';
  playerLink.href = 'https://music.youtube.com/watch?v=kxVLScacNyY';
  clock.duration = 280;
  activity.mediaChange();
  clock.position = 183;
  video.currentTime = 666;
  activity.advance();
  assert.equal(activity.reports.at(-1).media.title, 'Previous song');
  clock.position = 2;
  video.currentTime = 786;
  activity.advance();
  assert.equal(activity.reports.at(-1).media.title, 'Love From The Other Side');
  assert.equal(activity.reports.at(-1).playback.position, 2);
  assert.equal(activity.reports.at(-1).playback.duration, 280);
  activity.cleanup();
});

test('YouTube Music preserves elapsed playback across a delayed home-page timeline switch with a frozen seek clock', async () => {
  const session = { title: 'Previous song' };
  const clock = { position: 180, duration: 278 };
  const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
  const playerLink = { href: 'https://music.youtube.com/watch?v=abcdefghijk' };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock), 'ytmusic-player a[href*="watch"]': playerLink },
  });
  activity.document.hidden = true;
  session.title = 'Love From The Other Side';
  playerLink.href = 'https://music.youtube.com/watch?v=kxVLScacNyY';
  clock.position = 0;
  clock.duration = 280;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  video.currentTime = 786;
  video.duration = 1023;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 2, 'a timeline offset jump is not two minutes of playback');
  video.currentTime = 788;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 4);
  assert.equal(activity.reports.at(-1).playback.duration, 280);
  clock.position = 6;
  video.currentTime = 790;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 6);
  activity.cleanup();
});

test('YouTube Music accepts a genuinely resumed song even when its elapsed value resembles the previous song', async () => {
  const session = { title: 'Previous song' };
  const clock = { position: 180, duration: 278 };
  const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
  const playerLink = { href: 'https://music.youtube.com/watch?v=abcdefghijk' };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock), 'ytmusic-player a[href*="watch"]': playerLink },
  });
  session.title = 'Resumed song';
  playerLink.href = 'https://music.youtube.com/watch?v=lmnopqrstuv';
  video.currentTime = 180;
  video.duration = 278;
  activity.mediaChange();
  assert.equal(activity.reports.at(-1).media.title, 'Resumed song');
  assert.equal(activity.reports.at(-1).playback.position, 180);
  assert.equal(activity.reports.at(-1).playback.duration, 278);
  activity.cleanup();
});

test('YouTube Music reads song timing from seek attributes instead of the cumulative playlist video', async () => {
  const clock = { position: 180, duration: 278 };
  const video = { currentTime: 662.884159, duration: 759.897777, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=woz5qvDdMRM',
    metadata: { mediaSession: { title: 'Beneath the Mask', artist: 'Lyn' } },
    selectors: { video, '#progress-bar': musicSeekSlider(clock) },
    pageExecute: () => null,
  });
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 180);
  assert.equal(activity.reports.at(-1).playback.duration, 278);
  video.currentTime += 2;
  video.duration = 1139.275554;
  clock.position = 182;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 182);
  assert.equal(activity.reports.at(-1).playback.duration, 278, 'buffering more songs cannot extend this song');
  activity.cleanup();
});

test('YouTube Music advances a frozen background slider with a fixed song duration', async () => {
  const clock = { position: 218, duration: 241 };
  const video = { currentTime: 460, duration: 482, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    metadata: { mediaSession: { title: 'No More What Ifs' } },
    selectors: { video, '#progress-bar': musicSeekSlider(clock) },
  });
  activity.document.hidden = true;
  video.currentTime = 464;
  video.duration = 760;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 222);
  assert.equal(activity.reports.at(-1).playback.duration, 241);
  activity.elapse(4000);
  video.currentTime = 470;
  video.duration = 1000;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 228);
  assert.equal(activity.reports.at(-1).playback.duration, 241);
  clock.position = 230;
  video.currentTime = 472;
  activity.document.hidden = false;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 230);
  assert.equal(activity.reports.at(-1).playback.duration, 241);
  activity.cleanup();
});

test('YouTube Music waits for the new song clock then recalibrates across cumulative playlist songs', async () => {
  const session = { title: 'No More What Ifs' };
  const clock = { position: 218, duration: 241 };
  const video = { currentTime: 460, duration: 482, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock) },
  });
  activity.document.hidden = true;
  session.title = 'Beneath the Mask';
  video.currentTime = 462;
  video.duration = 759.897777;
  activity.navigate('https://music.youtube.com/watch?v=woz5qvDdMRM');
  assert.equal(activity.reports.at(-1).media.title, 'No More What Ifs');
  assert.equal(activity.reports.at(-1).playback.duration, 241);
  clock.position = 0;
  clock.duration = 278;
  video.currentTime = 482.897777;
  activity.advance();
  assert.equal(activity.reports.at(-1).media.title, 'Beneath the Mask');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 278);
  activity.elapse(11000);
  video.currentTime += 13;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 13);
  session.title = 'KOMM, SUSSER TOD';
  clock.position = 2;
  clock.duration = 467;
  video.currentTime = 761.897777;
  video.duration = 1139.275554;
  activity.navigate('https://music.youtube.com/watch?v=rQiHzcdUPAU');
  assert.equal(activity.reports.at(-1).media.title, session.title);
  assert.equal(activity.reports.at(-1).playback.position, 2);
  assert.equal(activity.reports.at(-1).playback.duration, 467);
  activity.cleanup();
});

test('YouTube Music ignores a preloaded slider reset until the current audio actually changes', async () => {
  const session = { title: 'Taking Off' };
  const clock = { position: 202, duration: 218 };
  const video = { currentTime: 444, duration: 700, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock) },
  });
  clock.position = 0;
  video.currentTime = 446;
  activity.advance();
  assert.equal(activity.reports.at(-1).media.title, 'Taking Off');
  assert.equal(activity.reports.at(-1).playback.position, 204);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  clock.duration = 240;
  video.currentTime = 448;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 206);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  session.title = 'Next song';
  video.currentTime = 460;
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  assert.equal(activity.reports.at(-1).media.title, 'Next song');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 240);
  activity.cleanup();
});

test('YouTube Music handles a seek and a real repeat on a cumulative playlist clock', async () => {
  const clock = { position: 202, duration: 218 };
  const video = { currentTime: 444, duration: 700, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    metadata: { mediaSession: { title: 'Taking Off' } },
    selectors: { video, '#progress-bar': musicSeekSlider(clock) },
  });
  clock.position = 0;
  video.currentTime = 242;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  clock.position = 217;
  video.currentTime = 459;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 217);
  clock.position = 0;
  video.currentTime = 460;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  video.currentTime = 462;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 2);
  activity.cleanup();
});

test('YouTube Music keeps the calibrated clock when the seek control disappears temporarily', async () => {
  const clock = { position: 180, duration: 278 };
  const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
  const selectors = { video, '#progress-bar': musicSeekSlider(clock) };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', selectors,
    metadata: { mediaSession: { title: 'Beneath the Mask' } },
  });
  delete selectors['#progress-bar'];
  video.currentTime = 667;
  video.duration = 1139;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 184);
  assert.equal(activity.reports.at(-1).playback.duration, 278);
  activity.cleanup();
});

test('YouTube Music waits for actual playback after an ended cumulative media clock resets', async () => {
  const clock = { position: 202, duration: 218 };
  const video = { currentTime: 444, duration: 700, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    metadata: { mediaSession: { title: 'Taking Off' } },
    selectors: { video, '#progress-bar': musicSeekSlider(clock) },
  });
  clock.position = 0;
  video.currentTime = 0;
  video.ended = true;
  activity.advance();
  assert.ok(activity.reports.at(-1).playback.position >= 202);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  video.ended = false;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  activity.cleanup();
});

test('YouTube Music recovers when the new seek clock appears before the old video clock resets', async () => {
  const session = { title: 'Previous song' };
  const clock = { position: 217, duration: 218 };
  const video = { currentTime: 459, duration: 700, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video, '#progress-bar': musicSeekSlider(clock) },
  });
  session.title = 'Beneath the Mask';
  clock.position = 0;
  clock.duration = 278;
  activity.navigate('https://music.youtube.com/watch?v=woz5qvDdMRM');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  video.currentTime = 0;
  video.duration = 278;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  clock.position = 2;
  video.currentTime = 2;
  activity.advance();
  assert.equal(activity.reports.at(-1).media.title, 'Beneath the Mask');
  assert.equal(activity.reports.at(-1).playback.position, 2);
  assert.equal(activity.reports.at(-1).playback.duration, 278);
  activity.cleanup();
});

test('YouTube Music recalibrates when the same song switches from a playlist timeline to its own video', async () => {
  const clock = { position: 180, duration: 278 };
  const video = { currentTime: 663, duration: 760, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    metadata: { mediaSession: { title: 'Beneath the Mask' } },
    selectors: { video, '#progress-bar': musicSeekSlider(clock) },
  });
  video.currentTime = 182;
  video.duration = 278;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.duration, 278);
  clock.position = 184;
  video.currentTime = 184;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 184);
  assert.equal(activity.reports.at(-1).playback.duration, 278);
  activity.cleanup();
});

test('YouTube Music keeps the current clock when metadata duration changes near the end', async () => {
  const session = { title: 'Taking Off', artist: 'ONE OK ROCK' };
  const page = { videoId: 'abcdefghijk', title: session.title, duration: 218, metadataDuration: 218, position: 202 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    pageExecute: musicPlayerReader(page),
  });
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 202);
  page.metadataDuration = 221;
  page.position = 204;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Taking Off');
  assert.equal(activity.reports.at(-1).playback.position, 204);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  activity.cleanup();
});

test('YouTube Music keeps the old song and progress while the next URL and player data preload', async () => {
  const session = { title: 'Taking Off', artist: 'ONE OK ROCK' };
  const video = { currentTime: 202, duration: 218, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: session.title, duration: 218, metadataDuration: 218, position: 202 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video }, pageExecute: musicPlayerReader(page),
  });
  await flushActivity();
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Taking Off');
  assert.ok(activity.reports.at(-1).playback.position >= 202);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  page.videoId = 'lmnopqrstuv';
  page.title = 'Next song';
  page.metadataDuration = 240;
  page.position = 204;
  video.currentTime = 204;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Taking Off');
  assert.ok(activity.reports.at(-1).playback.position >= 202);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  assert.equal(activity.reports.at(-1).buttons[0].url, 'https://music.youtube.com/watch?v=abcdefghijk');
  session.title = page.title;
  page.duration = 240;
  page.position = 0;
  video.duration = 240;
  video.currentTime = 0;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Next song');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 240);
  activity.cleanup();
});

test('YouTube Music uses the media clock instead of zero when a player read is incomplete', async () => {
  const session = { title: 'Taking Off' };
  const video = { currentTime: 202, duration: 218, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: session.title, duration: 218, metadataDuration: 218, position: 202 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video }, pageExecute: musicPlayerReader(page),
  });
  await flushActivity();
  activity.document.hidden = true;
  page.duration = undefined;
  page.position = undefined;
  video.currentTime = 204;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 204);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  activity.cleanup();
});

test('YouTube Music ignores a premature player clock reset while the current audio still plays', async () => {
  const session = { title: 'Taking Off' };
  const video = { currentTime: 202, duration: 218, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: session.title, duration: 218, metadataDuration: 218, position: 202 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video }, pageExecute: musicPlayerReader(page),
  });
  await flushActivity();
  page.position = 0;
  page.responseVideoId = 'lmnopqrstuv';
  video.currentTime = 204;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Taking Off');
  assert.equal(activity.reports.at(-1).playback.position, 204);
  assert.equal(activity.reports.at(-1).playback.duration, 218);
  activity.cleanup();
});

test('YouTube Music accepts a real seek to zero within the same song', async () => {
  const session = { title: 'Taking Off' };
  const video = { currentTime: 202, duration: 218, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: session.title, duration: 218, metadataDuration: 218, position: 202 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video }, pageExecute: musicPlayerReader(page),
  });
  await flushActivity();
  page.position = 0;
  video.currentTime = 0;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Taking Off');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  activity.cleanup();
});

test('YouTube Music keeps an ended song at its old progress until a real repeat starts', async () => {
  const session = { title: 'Taking Off' };
  const video = { currentTime: 202, duration: 218, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: session.title, duration: 218, metadataDuration: 218, position: 202 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    selectors: { video }, pageExecute: musicPlayerReader(page),
  });
  await flushActivity();
  video.ended = true;
  video.currentTime = 0;
  page.position = 0;
  activity.advance();
  await flushActivity();
  assert.ok(activity.reports.at(-1).playback.position >= 202);
  video.ended = false;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  activity.cleanup();
});

test('YouTube Music uses the current player clock while a background player bar is stale', async () => {
  const session = { title: 'Previous song', artist: 'Artist' };
  const clock = { textContent: '2:55 / 2:55' };
  const video = { currentTime: 175, duration: 175, paused: false, ended: false, playbackRate: 1 };
  const player = { videoId: 'abcdefghijk', position: 175, duration: 175 };
  const bar = {
    querySelector(selector) { return selector === '.time-info' ? clock : null; },
    querySelectorAll() { return []; },
  };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    selectors: { 'ytmusic-player-bar': bar, video },
    metadata: { mediaSession: session },
    pageExecute: () => ({ ...player }),
  });
  await flushActivity();
  activity.document.hidden = true;
  session.title = 'Right In Two';
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Previous song');
  assert.equal(activity.reports.at(-1).playback.duration, 175, 'keep the confirmed song until its replacement is ready');
  player.videoId = 'lmnopqrstuv';
  player.position = 0;
  player.duration = 535;
  activity.mediaChange();
  await flushActivity();
  activity.elapse(1000);
  await flushActivity();
  const next = activity.reports.at(-1);
  assert.equal(next.playback.position, 0, 'zero is a valid new-track position');
  assert.equal(next.playback.duration, 535);
  player.position = 12;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 12);
  assert.equal(activity.reports.at(-1).playback.duration, 535);
  assert.equal(clock.textContent, '2:55 / 2:55');
  activity.cleanup();
});

test('YouTube Music rejects an old media clock while player metadata changes', async () => {
  const session = { title: 'Previous song', artist: 'Artist' };
  const page = { id: 'abcdefghijk', responseId: 'abcdefghijk', length: '175', duration: 175, position: 174 };
  const player = {
    getVideoData() { return { video_id: page.id }; },
    getPlayerResponse() { return { videoDetails: { videoId: page.responseId, lengthSeconds: page.length } }; },
    getDuration() { return page.duration; },
    getCurrentTime() { return page.position; },
  };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    metadata: { mediaSession: session },
    pageExecute(fn) {
      return vm.runInNewContext(`(${fn.toString()})()`, {
        document: { querySelector(selector) { return selector === '#movie_player' ? player : null; } },
      });
    },
  });
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.duration, 175);
  page.id = 'lmnopqrstuv';
  session.title = 'Right In Two';
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Previous song');
  assert.equal(activity.reports.at(-1).playback.duration, 175);
  page.responseId = page.id;
  page.length = '535';
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Previous song');
  assert.equal(activity.reports.at(-1).playback.duration, 175);
  page.duration = 535;
  page.position = 5;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 5);
  activity.cleanup();
});

test('YouTube Music waits for the clock to reset when consecutive songs have the same duration', async () => {
  const session = { title: 'Previous song' };
  const player = { videoId: 'abcdefghijk', duration: 175, position: 70 };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    pageExecute: () => ({ ...player }),
  });
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 70);
  session.title = 'Next song';
  player.videoId = 'lmnopqrstuv';
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Previous song');
  assert.ok(activity.reports.at(-1).playback.position >= 70);
  assert.equal(activity.reports.at(-1).playback.duration, 175);
  player.position = 0;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).media.title, 'Next song');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  player.position = 5;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 5);
  activity.cleanup();
});

test('YouTube Music discards a player read that completes after navigation', async () => {
  const session = { title: 'Previous song', artist: 'Artist' };
  let finishRead;
  let reads = 0;
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk', metadata: { mediaSession: session },
    pageExecute() {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { finishRead = resolve; });
      return { videoId: 'lmnopqrstuv', duration: 535, position: 0 };
    },
  });
  session.title = 'Right In Two';
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  finishRead({ videoId: 'abcdefghijk', duration: 175, position: 174 });
  await flushActivity();
  assert.equal(activity.reports.length, 1);
  assert.equal(activity.reports[0].media.title, 'Right In Two');
  assert.equal(activity.reports[0].playback.duration, 535);
  assert.equal(activity.reports[0].playback.position, 0);
  activity.cleanup();
});

test('YouTube Music suppresses stale fallback clocks after a skip and recovers without the page bridge', async () => {
  const session = { title: 'Previous song', artist: 'Artist' };
  const clock = { textContent: '2:55 / 2:55' };
  const video = { currentTime: 175, duration: 175, paused: false, ended: false, playbackRate: 1 };
  const bar = {
    querySelector(selector) { return selector === '.time-info' ? clock : null; },
    querySelectorAll() { return []; },
  };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    selectors: { 'ytmusic-player-bar': bar, video }, metadata: { mediaSession: session },
  });
  activity.document.hidden = true;
  session.title = 'Right In Two';
  activity.navigate('https://music.youtube.com/watch?v=lmnopqrstuv');
  assert.equal(activity.reports.at(-1).media.title, 'Previous song');
  assert.equal(activity.reports.at(-1).playback.duration, 175);
  video.currentTime = 0;
  video.duration = 535;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.duration, 535);
  video.currentTime = 12;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 12);
  clock.textContent = '0:14 / 8:55';
  activity.document.hidden = false;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.position, 14);
  assert.equal(activity.reports.at(-1).playback.duration, 535);
  activity.cleanup();
});

test('YouTube Music links song, displayed artist or album, and cover art', async () => {
  const artistUrl = 'https://music.youtube.com/channel/artist';
  const albumUrl = 'https://music.youtube.com/playlist?list=album';
  const links = [
    { textContent: 'Artist', href: artistUrl },
    { textContent: 'Album', href: albumUrl },
  ];
  const bar = {
    querySelector() { return null; },
    querySelectorAll() { return links; },
  };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    selectors: { 'ytmusic-player-bar': bar },
    metadata: { mediaSession: {
      title: 'Track', artist: 'Artist', album: 'Album',
      artwork: [{ src: 'https://example.com/cover.png', sizes: '512x512' }],
    } },
  });
  const playing = activity.reports.at(-1);
  assert.equal(playing.display.detailsUrl, 'https://music.youtube.com/watch?v=abcdefghijk');
  assert.equal(playing.display.stateUrl, artistUrl);
  assert.equal(playing.artwork.largeUrl, albumUrl);

  activity.settings({ id: 'displayMode', value: 'album', settings: { displayMode: 'album' } });
  assert.equal(activity.reports.at(-1).display.state, 'Album');
  assert.equal(activity.reports.at(-1).display.stateUrl, albumUrl);

  links[1].href = 'javascript:alert(1)';
  activity.advance();
  assert.equal(activity.reports.at(-1).display.stateUrl, undefined);
  assert.equal(activity.reports.at(-1).artwork.largeUrl, undefined);
  activity.cleanup();
});

test('YouTube Music adds a pause badge to album art while paused', async () => {
  const session = {
    title: 'Track', artist: 'Artist', album: 'Album',
    artwork: [{ src: 'https://example.com/cover.png', sizes: '512x512' }],
  };
  const activity = await runActivity('youtube-music', {
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
    mediaSessionState: 'paused',
    metadata: { mediaSession: session },
  });
  const paused = activity.reports.at(-1);
  assert.equal(paused.playback.state, 'paused');
  assert.equal(paused.artwork.large, 'https://example.com/cover.png');
  assert.equal(paused.artwork.smallText, 'Paused');
  assert.equal(
    paused.artwork.small,
    'https://raw.githubusercontent.com/ChudForks/ChudPresence-Activities/main/presence-assets/pause.png',
  );
  const pauseIcon = await fs.readFile(path.join(root, 'presence-assets/pause.png'));
  assert.equal(pauseIcon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  session.artwork = [];
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  assert.equal(activity.reports.at(-1).artwork.small, undefined);

  activity.settings({ id: 'showArtwork', value: false, settings: { showArtwork: false } });
  session.artwork = [{ src: 'https://example.com/cover.png', sizes: '512x512' }];
  activity.advance();
  assert.deepEqual(Object.keys(activity.reports.at(-1).artwork), []);
  activity.cleanup();
});

test('YouTube package reports a Short through the page bridge and clears advertisements', async () => {
  const video = { currentTime: 5, duration: 20, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: 'A Short', author: 'A Creator', position: 5,
    duration: 20, state: 1, live: false, ad: false };
  const activity = await runActivity('youtube', {
    url: 'https://www.youtube.com/shorts/abcdefghijk',
    title: 'A Short - YouTube',
    selectors: {
      'ytd-reel-video-renderer[is-active] #shorts-player, ytd-reel-video-renderer[is-active] .html5-video-player, #shorts-player:not(ytd-reel-video-renderer:not([is-active]) #shorts-player)': youtubePlayer(video),
      '#owner #channel-name a': { textContent: 'A Creator', href: 'https://www.youtube.com/@creator' },
    },
    pageExecute: () => page,
  });
  await flushActivity();
  const short = activity.reports.at(-1);
  assert.equal(short.kind, 'video');
  assert.equal(short.media.title, 'A Short');
  assert.equal(short.media.creator, 'A Creator');
  assert.equal(short.playback.position, 5);
  assert.equal(short.buttons[0].label, 'Watch Short');
  assert.equal(short.buttons[1].url, 'https://www.youtube.com/@creator');
  page.ad = true;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});

test('YouTube package treats a regular video as watching when a reusable live badge is in the DOM', async () => {
  const video = { currentTime: 24, duration: 480, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube', {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    title: 'A recorded video - YouTube',
    selectors: {
      '#movie_player': youtubePlayer(video),
      '#movie_player .ytp-live-badge, #shorts-player .ytp-live-badge': { hidden: false },
      'ytd-watch-flexy': {
        hasAttribute(name) { return name === 'is-live-video'; },
        getAttribute(name) { return name === 'is-live-video' ? '' : null; },
      },
    },
    pageExecute: () => ({ videoId: 'abcdefghijk', title: 'A recorded video',
      author: 'A Creator', position: 24, duration: 480, state: 1, live: false, ad: false }),
  });
  await flushActivity();
  const report = activity.reports.at(-1);
  assert.equal(report.kind, 'video');
  assert.equal(report.playback.live, false);
  assert.equal(report.playback.duration, 480);
  activity.cleanup();
});

test('YouTube trusts a player seek to zero and paused state over stale DOM playback', async () => {
  const video = { currentTime: 90, duration: 480, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: 'A recorded video', position: 0,
    duration: 480, state: 2, live: false, ad: false };
  const activity = await runActivity('youtube', {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    selectors: { '#movie_player': youtubePlayer(video) },
    pageExecute: () => page,
  });
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 0);
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  page.state = 0;
  page.position = 480;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});

test('YouTube falls back to DOM playback when player timing and state are unavailable', async () => {
  const video = { currentTime: 90, duration: 480, paused: false, ended: false, playbackRate: 1 };
  const player = { getVideoData() { return { video_id: 'abcdefghijk', title: 'A recorded video' }; } };
  const activity = await runActivity('youtube', {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    selectors: { '#movie_player': youtubePlayer(video) },
    pageExecute(fn, args) {
      return vm.runInNewContext(`(${fn.toString()})(...args)`, {
        args,
        document: { querySelector() { return player; } },
      });
    },
  });
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.position, 90);
  assert.equal(activity.reports.at(-1).playback.duration, 480);
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  activity.cleanup();
});

test('YouTube package reports live playback and ignores a stale player after navigation', async () => {
  const video = { currentTime: 90, duration: 600, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: 'Live now', author: 'A Channel', position: 90,
    duration: 0, state: 1, live: true, ad: false };
  const activity = await runActivity('youtube', {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    title: 'Live now - YouTube',
    selectors: { '#movie_player': youtubePlayer(video) },
    pageExecute: () => page,
  });
  await flushActivity();
  const live = activity.reports.at(-1);
  assert.equal(live.kind, 'stream');
  assert.equal(live.playback.live, true);
  assert.equal(live.playback.duration, 0);
  assert.equal(live.buttons[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
  activity.navigate('https://www.youtube.com/watch?v=lmnopqrstuv');
  await flushActivity();
  assert.equal(activity.reports.at(-1), null);
  page.videoId = 'lmnopqrstuv';
  page.title = 'Next video';
  page.live = false;
  video.duration = 180;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).kind, 'video');
  assert.equal(activity.reports.at(-1).media.title, 'Next video');
  activity.cleanup();
});

test('YouTube ignores browsing previews even with player data and stale media metadata', async () => {
  const video = { currentTime: 12, duration: 100, paused: false, ended: false, playbackRate: 1 };
  for (const path of ['/', '/results?search_query=test', '/feed/subscriptions', '/@creator']) {
    const activity = await runActivity('youtube', {
      url: `https://www.youtube.com${path}`,
      metadata: { title: 'Preview video' },
      selectors: {
        '#movie_player video.html5-main-video': video,
        'ytd-player video.html5-main-video': video,
        'link[rel="canonical"]': { href: 'https://www.youtube.com/watch?v=abcdefghijk' },
      },
      pageExecute: () => ({ videoId: 'abcdefghijk', title: 'Preview video', state: 1 }),
    });
    await flushActivity();
    assert.equal(activity.reports.at(-1), null);
    activity.cleanup();
  }
});

test('YouTube clears an ended DOM video without the page bridge and allows replay', async () => {
  const video = { currentTime: 99, duration: 100, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('youtube', {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    title: 'A video - YouTube',
    selectors: { '#movie_player': youtubePlayer(video) },
  });
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  video.ended = true;
  video.paused = true;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1), null);
  video.ended = false;
  video.paused = false;
  video.currentTime = 0;
  activity.advance();
  await flushActivity();
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  assert.equal(activity.reports.at(-1).playback.position, 0);
  activity.cleanup();
});

test('Kick package reports a live channel through the Activity API and clears off-channel', async () => {
  const video = { duration: Infinity, currentTime: 75, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('kick', {
    url: 'https://kick.com/streamer',
    title: 'Kick',
    selectors: {
      'video[data-testid="video-player"], .vjs-tech, .video-js video, video': video,
      '[data-testid="livestream-title"]': { textContent: 'Live stream title' },
      'meta[property="og:image"], meta[name="og:image"]': { content: 'https://images.kick.com/live.jpg' },
    },
  });
  const live = activity.reports.at(-1);
  assert.equal(live.kind, 'stream');
  assert.equal(live.media.title, 'Live stream title');
  assert.equal(live.media.creator, 'streamer');
  assert.equal(live.playback.live, true);
  assert.equal(live.playback.state, 'playing');
  assert.equal(live.artwork.large, 'https://images.kick.com/live.jpg');
  assert.equal(live.buttons[0].url, 'https://kick.com/streamer');
  activity.navigate('https://kick.com/browse');
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});

test('Kick package treats a recorded video as VOD even if a live badge is visible', async () => {
  const video = { duration: 300, currentTime: 40, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('kick', {
    url: 'https://kick.com/streamer/videos/01234567-89ab-cdef-0123-456789abcdef',
    title: 'Kick',
    selectors: {
      'video[data-testid="video-player"], .vjs-tech, .video-js video, video': video,
      '[data-testid="video-title"]': { textContent: 'Past broadcast' },
      '[data-testid="live-badge"], [data-testid="livestream-badge"], [data-testid="stream-is-live"], .live-badge': {},
    },
  });
  const vod = activity.reports.at(-1);
  assert.equal(vod.kind, 'video');
  assert.equal(vod.playback.live, false);
  assert.equal(vod.playback.position, 40);
  assert.equal(vod.playback.duration, 300);
  assert.deepEqual(Object.keys(vod.artwork), []);
  assert.equal(vod.buttons[0].label, 'Watch on Kick');
  assert.equal(vod.buttons[1].url, 'https://kick.com/streamer');
  video.paused = true;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  activity.cleanup();
});

test('Twitch package reports a live channel and clears on a browsing route', async () => {
  const video = { duration: Infinity, currentTime: 75, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('twitch', {
    url: 'https://www.twitch.tv/streamer',
    title: 'Twitch',
    selectors: {
      'video[data-a-target="player-video"], .video-player video, video': video,
      '[data-a-target="stream-title"]': { textContent: 'Ranked with friends' },
      'meta[property="og:image"], meta[name="og:image"]': { content: 'https://static-cdn.jtvnw.net/preview.jpg' },
    },
  });
  const live = activity.reports.at(-1);
  assert.equal(live.kind, 'stream');
  assert.equal(live.media.title, 'Ranked with friends');
  assert.equal(live.media.creator, 'streamer');
  assert.equal(live.playback.live, true);
  assert.equal(live.playback.state, 'playing');
  assert.equal(live.artwork.large, 'https://static-cdn.jtvnw.net/preview.jpg');
  assert.equal(live.buttons[0].url, 'https://www.twitch.tv/streamer');
  activity.navigate('https://www.twitch.tv/directory');
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});

test('Twitch package reports a VOD despite a channel live indicator', async () => {
  const video = { duration: 300, currentTime: 40, paused: false, ended: false, playbackRate: 1 };
  const activity = await runActivity('twitch', {
    url: 'https://www.twitch.tv/streamer/video/123456',
    title: 'Twitch',
    metadata: { '@type': 'VideoObject', name: 'Past broadcast' },
    selectors: {
      'video[data-a-target="player-video"], .video-player video, video': video,
      '[data-a-target="stream-title"], [data-a-target="player-live-badge"], [data-test-selector="live-indicator"]': {},
    },
  });
  const vod = activity.reports.at(-1);
  assert.equal(vod.kind, 'video');
  assert.equal(vod.media.title, 'Past broadcast');
  assert.equal(vod.playback.live, false);
  assert.equal(vod.playback.position, 40);
  assert.equal(vod.playback.duration, 300);
  assert.deepEqual(Object.keys(vod.artwork), []);
  assert.equal(vod.buttons[0].url, 'https://www.twitch.tv/streamer/video/123456');
  assert.equal(vod.buttons[1].url, 'https://www.twitch.tv/streamer');
  video.paused = true;
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  activity.cleanup();
});

for (const [id, videoSelector, titleSelector, badgeSelector, url] of [
  ['kick', 'video[data-testid="video-player"], .vjs-tech, .video-js video, video',
    '[data-testid="livestream-title"]',
    '[data-testid="live-badge"], [data-testid="livestream-badge"], [data-testid="stream-is-live"], .live-badge',
    'https://kick.com/streamer'],
  ['twitch', 'video[data-a-target="player-video"], .video-player video, video',
    '[data-a-target="stream-title"]',
    '[data-a-target="player-live-badge"], [data-test-selector="live-indicator"]',
    'https://www.twitch.tv/streamer'],
]) {
  test(`${id} reports a finite live DVR window as a stream`, async () => {
    const activity = await runActivity(id, {
      url,
      selectors: {
        [videoSelector]: { duration: 300, currentTime: 295, paused: false, ended: false, playbackRate: 1 },
        [titleSelector]: { textContent: 'Live stream title' },
        [badgeSelector]: {},
      },
    });
    assert.equal(activity.reports.at(-1).kind, 'stream');
    assert.equal(activity.reports.at(-1).playback.live, true);
    assert.equal(activity.reports.at(-1).playback.duration, 0);
    activity.cleanup();
  });
}

test('67Movies package reports a movie from the watch URL and TMDB metadata', async () => {
  const fetches = [];
  const activity = await runActivity('67movies', {
    url: 'https://67movies.st/watch/movie/456?ref=home',
    storage: {
      'progress:m456': JSON.stringify({ position: 40, duration: 7200 }),
      continueWatching: JSON.stringify({
        'movie-456': { title: 'Stored Movie', progress: { watched: 40, duration: 7200 } },
      }),
    },
    netFetch(requestUrl) {
      fetches.push(requestUrl);
      return Promise.resolve({
        ok: true,
        status: 200,
        data: {
          title: 'Example Movie',
          release_date: '2024-01-02',
          poster_path: '/poster.jpg',
          runtime: 120,
        },
      });
    },
  });
  await flushActivity();
  activity.advance();
  const movie = activity.reports.at(-1);
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.media.title, 'Example Movie');
  assert.equal(movie.media.subtitle, '2024');
  assert.equal(movie.display.details, 'Example Movie');
  assert.equal(movie.display.state, '');
  assert.equal(movie.playback.state, 'paused');
  assert.equal(movie.playback.position, 40);
  assert.equal(movie.playback.duration, 7200);
  assert.equal(movie.artwork.large, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.equal(movie.buttons[0].label, 'Watch movie');
  assert.equal(movie.buttons[0].url, 'https://67movies.st/watch/movie/456');
  assert.equal(movie.buttons[1].label, 'Open 67Movies');
  assert.equal(movie.buttons[1].url, 'https://67movies.st/');
  assert.match(fetches[0], /^https:\/\/api\.themoviedb\.org\/3\/movie\/456\?/);
  activity.navigate('https://67movies.st/');
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
  assert.equal(activity.reports.at(-1), null);
});

test('67Movies reads the embedded TV route and applies V1 display settings', async () => {
  const frames = [];
  const activity = await runActivity('67movies', {
    url: 'https://67movies.st/watch/tv/123',
    frames,
    storage: {
      continueWatching: JSON.stringify({
        'tv-123-2-4': { title: 'Stored Episode', progress: { watched: 12, duration: 1440 } },
      }),
    },
    netFetch(requestUrl) {
      if (requestUrl.includes('/season/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            episodes: [{ episode_number: 4, name: 'The Pilot', still_path: '/still.jpg', runtime: 24 }],
          },
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { name: 'Example Show', poster_path: '/poster.jpg', episode_run_time: [24] },
      });
    },
  });
  assert.equal(activity.reports.at(-1), null);
  frames.push({ src: 'https://player.videasy.net/embed/tv/123/2/4', contentWindow: {} });
  activity.advance();
  await flushActivity();
  activity.advance();
  const episode = activity.reports.at(-1);
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.media.title, 'The Pilot');
  assert.equal(episode.media.series, 'Example Show');
  assert.equal(episode.media.season, 2);
  assert.equal(episode.media.episode, 4);
  assert.equal(episode.display.details, 'Example Show');
  assert.equal(episode.display.state, 'The Pilot');
  assert.equal(episode.artwork.largeText, 'Season 2, Episode 4 • The Pilot');
  assert.equal(episode.artwork.large, 'https://image.tmdb.org/t/p/w500/still.jpg');
  assert.equal(episode.buttons[0].label, 'Watch on 67Movies');
  assert.equal(episode.buttons[0].url, 'https://67movies.st/watch/tv/123/2/4');
  activity.settings({
    id: 'displayOrder',
    value: 'episode',
    settings: { displayOrder: 'episode' },
  });
  assert.equal(activity.reports.at(-1).display.details, 'The Pilot');
  assert.equal(activity.reports.at(-1).display.state, 'Example Show');
  assert.equal(activity.reports.at(-1).artwork.large, 'https://image.tmdb.org/t/p/w500/still.jpg');
  activity.cleanup();
});

test('67Movies trusts player messages only from the embedded player frame', async () => {
  const playerWindow = {};
  const frames = [{
    src: 'https://111movies.net/embed/movie/456',
    contentWindow: playerWindow,
  }];
  const activity = await runActivity('67movies', {
    url: 'https://67movies.st/watch/movie/456',
    frames,
    storage: {
      continueWatching: JSON.stringify({ 'movie-456': { title: 'Example Movie' } }),
    },
    netFetch() {
      return Promise.reject(Object.assign(new Error('offline'), { code: 'network_error' }));
    },
  });
  await flushActivity();
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  activity.message({
    origin: 'https://evil.example',
    source: playerWindow,
    data: { event: 'playing', data: { currentTime: 90, duration: 5400 } },
  });
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  activity.message({
    origin: 'https://111movies.net',
    source: {},
    data: { event: 'playing', data: { currentTime: 90, duration: 5400 } },
  });
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  activity.message({
    origin: 'https://111movies.net',
    source: playerWindow,
    data: { event: 'playing', data: { currentTime: 15, duration: 5400 } },
  });
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'playing');
  assert.equal(activity.reports.at(-1).playback.position, 15);
  assert.equal(activity.reports.at(-1).playback.duration, 5400);
  activity.message({
    origin: 'https://111movies.net',
    source: playerWindow,
    data: { event: 'pause', data: { currentTime: 16, duration: 5400 } },
  });
  activity.advance();
  assert.equal(activity.reports.at(-1).playback.state, 'paused');
  activity.cleanup();
});

test('67Movies treats a /movie URL as a movie even when TV history is newer-looking', async () => {
  const activity = await runActivity('67movies', {
    url: 'https://67movies.st/watch/movie/1423191',
    frames: [{ src: 'https://player.vidlove.cc/embed/movie/1423191?poster=true', contentWindow: {} }],
    storage: {
      continueWatching: JSON.stringify({
        'tv-250203-1-1': {
          id: '250203', type: 'tv', season: 1, episode: 1, title: 'Brothers', updatedAt: 50,
        },
        'movie-1423191': {
          id: '1423191', type: 'movie', title: 'Resident Evil', updatedAt: 99,
        },
      }),
    },
    netFetch(requestUrl) {
      assert.match(requestUrl, /\/movie\/1423191\?/);
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { title: 'Resident Evil', poster_path: '/resident-movie.jpg', release_date: '2002-03-15', runtime: 100 },
      });
    },
  });
  await flushActivity();
  activity.advance();
  const movie = activity.reports.at(-1);
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.media.title, 'Resident Evil');
  assert.equal(movie.media.series, undefined);
  assert.equal(movie.display.details, 'Resident Evil');
  assert.equal(movie.display.state, '');
  assert.equal(movie.buttons[0].label, 'Watch movie');
  assert.equal(movie.buttons[0].url, 'https://67movies.st/watch/movie/1423191');
  assert.equal(movie.artwork.large, 'https://image.tmdb.org/t/p/w500/resident-movie.jpg');
  activity.document.hidden = true;
  activity.advance();
  assert.equal(activity.reports.at(-1).kind, 'movie');
  assert.equal(activity.reports.at(-1).artwork.large, 'https://image.tmdb.org/t/p/w500/resident-movie.jpg');
  activity.cleanup();
});

test('67Movies keeps the poster when a background tab loses the embed', async () => {
  const frames = [{ src: 'https://111movies.net/embed/tv/123/2/4', contentWindow: {} }];
  const activity = await runActivity('67movies', {
    url: 'https://67movies.st/watch/tv/123',
    frames,
    storage: {
      continueWatching: JSON.stringify({
        'tv-123-2-4': { title: 'Resident Evil', progress: { watched: 24, duration: 1440 } },
      }),
    },
    netFetch(requestUrl) {
      if (requestUrl.includes('/season/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { episodes: [{ episode_number: 4, name: 'Outbreak', still_path: '/still.jpg', runtime: 24 }] },
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { name: 'Resident Evil', poster_path: '/poster.jpg', episode_run_time: [24] },
      });
    },
  });
  await flushActivity();
  activity.advance();
  assert.equal(activity.reports.at(-1).artwork.large, 'https://image.tmdb.org/t/p/w500/still.jpg');
  activity.document.hidden = true;
  frames.splice(0, frames.length);
  activity.advance();
  const hidden = activity.reports.at(-1);
  assert.equal(hidden.media.series, 'Resident Evil');
  assert.equal(hidden.artwork.large, 'https://image.tmdb.org/t/p/w500/still.jpg');
  assert.notEqual(hidden, null);
  activity.document.hidden = false;
  activity.advance();
  assert.equal(activity.reports.at(-1), null);
  activity.cleanup();
});
