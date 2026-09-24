import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function runActivity(id, { url, title = '', metadata = null, selectors = {}, selectorLookup = null }) {
  const source = await fs.readFile(path.join(root, 'activities', id, 'activity.js'), 'utf8');
  const reports = [];
  const cleanups = [];
  let settingsChanged;
  let navigationChanged;
  let mediaChanged;
  let heartbeat;
  let now = 2000;
  const location = new URL(url);
  const document = {
    title,
    documentElement: {},
    querySelector(selector) { return selectors[selector] || selectorLookup?.(selector) || null; },
    querySelectorAll(selector) { return selector === 'script[type="application/ld+json"]' && metadata
      ? [{ textContent: JSON.stringify(metadata) }] : []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const ChudPresence = {
    report(report) { reports.push(report); return Promise.resolve(); },
    clear() { reports.push(null); return Promise.resolve(); },
    lifecycle: {
      signal: { aborted: false },
      interval(callback) { heartbeat = callback; },
      onCleanup(callback) { cleanups.push(callback); },
    },
    navigation: { onChange(callback) { navigationChanged = callback; } },
    media: { find() { return null; }, snapshot() { return null; }, onChange(callback) { mediaChanged = callback; } },
    dom: { observe() {} },
    settings: {
      getAll() { return Promise.resolve({}); },
      onChange(callback) { settingsChanged = callback; },
    },
  };
  class DateAt extends Date { static now() { return now; } }
  class MutationObserver { observe() {} disconnect() {} }
  vm.runInNewContext(source, {
    ChudPresence, Date: DateAt, MutationObserver, URL, URLSearchParams,
    document, location,
    navigator: { mediaSession: { playbackState: 'playing', metadata: metadata?.mediaSession || metadata } },
  }, { filename: `${id}/activity.js` });
  return {
    reports,
    settings(event) { now += 2000; settingsChanged(event); },
    navigate(href) { now += 500; location.href = href; navigationChanged(); },
    mediaChange() { now += 500; mediaChanged(); },
    advance() { now += 2000; heartbeat(); },
    cleanup() { for (const callback of cleanups) callback(); },
  };
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
