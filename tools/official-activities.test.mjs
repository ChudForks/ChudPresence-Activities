import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function runActivity(id, {
  url, title = '', metadata = null, selectors = {}, selectorLookup = null,
  selectorAllLookup = null, frames = [], storage = {}, netFetch = null, pageExecute = null,
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
    runtime: { has(feature) { return feature === 'pageExecute'; } },
    page: { execute(fn, args) { return Promise.resolve(pageExecute?.(fn, args) ?? null); } },
    lifecycle: {
      signal: { aborted: false },
      interval(callback) { heartbeat = callback; },
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
  }, { filename: `${id}/activity.js` });
  return {
    reports,
    settings(event) { now += 2000; settingsChanged(event); },
    navigate(href) { now += 500; location.href = href; navigationChanged(); },
    mediaChange() { now += 500; mediaChanged(); },
    message(event) {
      for (const listener of windowListeners) {
        if (listener.type === 'message') listener.callback(event);
      }
    },
    advance() { now += 2000; heartbeat(); },
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
    '[data-testid="player-metadata"] .PlayerMetadata__titleText': { textContent: 'BLEACH: Thousand-Year Blood War' },
    '[data-testid="player-metadata"] .PlayerMetadata__seasonEpisodeText': { textContent: 'S1 E2' },
    '[data-testid="player-metadata"] .PlayerMetadata__subTitleText': { textContent: '(Sub) FOUNDATION STONES' },
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

test('YouTube package reports a Short through the page bridge and clears advertisements', async () => {
  const video = { currentTime: 5, duration: 20, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: 'A Short', author: 'A Creator', position: 5,
    duration: 20, state: 1, live: false, ad: false };
  const activity = await runActivity('youtube', {
    url: 'https://www.youtube.com/shorts/abcdefghijk',
    title: 'A Short - YouTube',
    selectors: {
      '#shorts-player video.html5-main-video': video,
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
      '#movie_player video.html5-main-video': video,
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

test('YouTube package reports live playback and ignores a stale player after navigation', async () => {
  const video = { currentTime: 90, duration: 600, paused: false, ended: false, playbackRate: 1 };
  const page = { videoId: 'abcdefghijk', title: 'Live now', author: 'A Channel', position: 90,
    duration: 0, state: 1, live: true, ad: false };
  const activity = await runActivity('youtube', {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    title: 'Live now - YouTube',
    selectors: { '#movie_player video.html5-main-video': video },
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
