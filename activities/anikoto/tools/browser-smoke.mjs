import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.CHUDPRESENCE_LAB_ROOT || path.resolve(packageRoot, '../../..');
let playwright;
try {
  playwright = createRequire(process.env.CHUDPRESENCE_TEST_NODE_MODULES
    ? path.join(path.resolve(process.env.CHUDPRESENCE_TEST_NODE_MODULES), 'package.json') : import.meta.url)('playwright');
} catch {
  playwright = createRequire(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json'))('playwright');
}
const { chromium } = playwright;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anikoto-v1-browser-'));
const extension = path.join(temporary, 'extension');
await fs.cp(path.join(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
// Test-only copy: supply optional website permissions without touching the
// workspace manifest or the user's Brave profile.
manifest.host_permissions.push('https://anikototv.to/*', 'https://www.anikototv.to/*', 'https://megaplay.buzz/*');
await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const pkg = { metadata: JSON.parse(await fs.readFile(path.join(packageRoot, 'metadata.json'), 'utf8')),
  source: await fs.readFile(path.join(packageRoot, 'activity.js'), 'utf8'),
  icon: `data:image/png;base64,${(await fs.readFile(path.join(packageRoot, 'icon.png'))).toString('base64')}` };
const wav = Buffer.alloc(44 + 8000 * 300);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40); wav.fill(128, 44);
let context;
let navigationGate;
async function until(operation, predicate, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  let result;
  do {
    result = await operation();
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 120));
  } while (Date.now() < end);
  throw Error(`${label}: ${JSON.stringify(result)}`);
}
try {
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath: process.env.CHUDPRESENCE_TEST_BROWSER || (process.platform === 'win32'
      ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : chromium.executablePath()),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'],
  });
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('hold') === '1' && navigationGate) {
      navigationGate.entered = true;
      await navigationGate.ready;
    }
    if (url.hostname === 'anikototv.to') {
      if (!url.pathname.startsWith('/watch/')) {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Anikoto</title><h1>Anikoto home</h1>' });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Watch Yani Neko Episode 12 Online - Anikoto</title>
        <div id="w-info"><h1>Yani Neko</h1><div class="poster"><img src="https://images.invalid/poster.jpg"></div>
        <div class="bmeta"><div class="meta"><div>Type: <span>TV</span></div></div></div></div>
        <div id="w-episodes"><a class="active" data-num="9" href="/watch/chainsmoker-cat/ep-9"><span class="d-title">Episode 9</span></a></div>
        <div id="player"><iframe src="https://megaplay.buzz/stream/s-2/788933/sub" allow="autoplay"></iframe></div>` });
    } else if (url.hostname === 'megaplay.buzz' && url.pathname.endsWith('.wav')) {
      await route.fulfill({ contentType: 'audio/wav', body: wav, headers: { 'Accept-Ranges': 'bytes' } });
    } else if (url.hostname === 'megaplay.buzz') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="megaplay-player"><video src="/fixture.wav" muted autoplay controls width="640" height="360"></video></div>' });
    } else if (url.hostname === 'outside.invalid') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Outside Anikoto</title>' });
    } else await route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const preferences = await context.newPage();
  await preferences.goto(`chrome://extensions/?id=${extensionId}`);
  await preferences.evaluate(async extensionId => {
    await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, userScriptsAccess: true });
  }, extensionId);
  await preferences.close();
  await worker.evaluate(() => chrome.storage.local.set({ enabled: false }));
  const controls = await context.newPage();
  await controls.goto(`chrome-extension://${extensionId}/activities.html`);
  const send = message => controls.evaluate(message => chrome.runtime.sendMessage(message), message);
  const installed = await send({ type: 'ACTIVITY_INSTALL', activityPackage: pkg });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const savedPreferences = await send({ type: 'ACTIVITY_SET_PREFERENCES', id: 'anikoto', preferences: { statusDisplay: 'track' } });
  assert.equal(savedPreferences.ok, true);
  console.log('Installed actual Anikoto V1 package in the existing runtime.');
  let page = await context.newPage();
  // Playwright forces every page to look focused/visible by default. Disable
  // that override so native tab attention changes exercise the Activity.
  const pageSession = await context.newCDPSession(page);
  await pageSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://anikototv.to/watch/chainsmoker-cat/ep-9');
  await page.bringToFront();
  const activity = async () => {
    const value = (await send({ type: 'ACTIVITY_LIBRARY_STATE' })).result.installed.find(item => item.id === 'anikoto');
    if (value) delete value.icon;
    return value;
  };
  const formatted = record => controls.evaluate(async record => {
    const { createPresenceIntent } = await import('./core/presence.js');
    const { buildHeadlessActivity } = await import('./discord/activity-builder.js');
    return buildHeadlessActivity(createPresenceIntent(record.normalizedReport, Date.now(), record.preferences), '1549066134706323548');
  }, record);
  let record = await until(activity, value => value?.status === 'detected' && value?.rawReport?.media.episode === 9, 'No accepted cross-frame report');
  assert.equal(record.rawReport.media.episode, 9);
  assert.equal(record.rawReport.media.series, 'Yani Neko');
  assert.equal(record.rawReport.playback.duration, 300);
  assert.equal(record.lastReport.frameId, 0);
  assert.equal((await formatted(record)).status_display_type, 2);
  console.log('Accepted top-frame Episode 9 report with real child-video progress (300 seconds).');
  const player = () => page.frames().find(frame => frame.url().startsWith('https://megaplay.buzz/'));
  await player().evaluate(() => { const video = document.querySelector('video'); video.pause(); video.currentTime = 125; video.playbackRate = 1.5; });
  record = await until(activity, value => value?.rawReport?.playback.state === 'paused' && value.rawReport.playback.position === 125, 'Pause/seek not accepted');
  assert.equal(record.rawReport.playback.rate, 1.5);
  assert.equal(record.rawReport.artwork.smallText, 'Paused');
  console.log('Accepted pause, seek to 125 seconds, 1.5x speed, and paused artwork.');
  await player().evaluate(() => { const video = document.querySelector('video'); video.currentTime = 0; video.playbackRate = 1; return video.play(); });
  await until(activity, value => value?.rawReport?.playback.state === 'playing' && value.rawReport.playback.position < 10, 'Replay/seek-to-zero not accepted');
  await page.evaluate(() => {
    history.pushState({}, '', '/watch/chainsmoker-cat/ep-10');
    document.querySelector('#player iframe').remove();
  });
  await until(activity, value => value?.status === 'detected' && value?.rawReport?.kind === 'generic', 'Old episode was not replaced by browsing');
  await page.evaluate(() => {
    const selected = document.querySelector('#w-episodes a'); selected.href = '/watch/chainsmoker-cat/ep-10';
    selected.setAttribute('data-num', '10'); selected.querySelector('span').textContent = 'Episode 10';
    const frame = document.createElement('iframe'); frame.allow = 'autoplay';
    frame.src = 'https://megaplay.buzz/videojs/stream/s-2/788934/sub'; document.querySelector('#player').append(frame);
  });
  record = await until(activity, value => value?.status === 'detected' && value?.rawReport?.media.episode === 10, 'Video.js replacement did not report');
  assert.equal(record.lastReport.frameId, 0);
  console.log('Cleared old episode and accepted Episode 10 through the alternate Video.js route.');
  await page.evaluate(() => document.querySelector('#player iframe').remove());
  record = await until(activity, value => value?.status === 'detected' && value?.rawReport?.kind === 'generic', 'Removed iframe did not switch to browsing');
  assert.equal(record.rawReport.display.details, 'Browsing Anikoto');
  const browsing = await formatted(record);
  assert.equal(browsing.name, 'Anikoto');
  assert.equal(browsing.status_display_type, 0);
  assert.equal(browsing.assets.large_image, 'https://anikototv.to/AnikotoTheme/assets/images/favicon.png');
  assert.equal(Object.hasOwn(browsing, 'state'), false);
  assert.equal(record.preferences.statusDisplay, 'track');
  await page.goto('https://anikototv.to/home');
  await page.bringToFront();
  // A cross-process navigation can reapply Playwright's default override.
  await pageSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await until(activity, value => value?.status === 'detected' && value?.rawReport?.kind === 'generic' &&
    value?.lastReport?.senderUrl === 'https://anikototv.to/home', 'Home page did not report browsing');
  // Switch the actual browser tab; headless Page.bringToFront alone does not
  // change Chromium's selected tab on every supported browser.
  const browsingTabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => tab.url === 'https://anikototv.to/home');
    if (!tab) throw Error('Anikoto browser tab was not found');
    await chrome.tabs.create({ windowId: tab.windowId, url: 'about:blank', active: true });
    return tab.id;
  });
  assert.equal(await page.evaluate(() => document.hasFocus()), false);
  await until(activity, value => value?.status === 'waiting', 'Browsing did not clear after tab switch');
  await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), browsingTabId);
  await until(activity, value => value?.status === 'detected' && value?.rawReport?.display.details === 'Browsing Anikoto', 'Browsing did not resume on tab focus');
  assert.deepEqual(errors, []);
  console.log('Player removal and home navigation show Browsing Anikoto; tab switch clears it and focus restores it.');
  console.log('Browsing includes the site logo, forces app-name status, and omits the second line; playback retains the saved media-line preference.');
  assert.equal((await send({ type: 'SET_ENABLED', enabled: true })).ok, true);
  const state = () => send({ type: 'ACTIVITY_LIBRARY_STATE' });
  await until(state, value => value.result.finalPresenceIntent?.details === 'Browsing Anikoto', 'Browsing presence was not selected');
  async function holdNavigation(destination, submit = false) {
    let release;
    navigationGate = { entered: false, ready: new Promise(resolve => { release = resolve; }), release: () => release() };
    await page.evaluate(({ destination, submit }) => {
      if (submit) {
        const form = document.createElement('form'), url = new URL(destination);
        form.action = url.origin + url.pathname;
        for (const [name, value] of url.searchParams) {
          const input = document.createElement('input');
          input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
        }
        const button = document.createElement('button');
        button.id = 'navigation-test-link'; button.textContent = 'Search'; form.append(button); document.body.append(form);
      } else {
        const link = document.createElement('a');
        link.id = 'navigation-test-link'; link.href = destination; link.textContent = 'Next page'; document.body.append(link);
      }
    }, { destination, submit });
    const navigating = page.waitForURL(destination).then(() => ({ ok: true }), error => ({ error: error.message }));
    await page.locator('#navigation-test-link').click({ noWaitAfter: true });
    await until(async () => navigationGate.entered, Boolean, 'Navigation request did not reach the fixture', 2000);
    const held = await until(state, value => value.result.installed.find(item => item.id === 'anikoto').activeFrames.length === 0,
      'Outgoing V1 document was not retired', 2000);
    return { held, navigating, release };
  }
  let transition = await holdNavigation('https://anikototv.to/filter?keyword=anime&hold=1');
  assert.equal(transition.held.result.finalPresenceIntent?.details, 'Browsing Anikoto');
  const samplingUntil = Date.now() + 1200;
  while (Date.now() < samplingUntil) {
    assert.equal((await state()).result.finalPresenceIntent?.details, 'Browsing Anikoto', 'Presence dropped during document handoff');
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  transition.release();
  assert.equal((await transition.navigating).ok, true);
  await until(activity, value => value?.activeFrames.some(frame => frame.senderUrl.includes('/filter?keyword=anime')), 'Replacement document did not report');
  assert.equal((await state()).result.finalPresenceIntent?.details, 'Browsing Anikoto');
  console.log('A clicked link keeps browsing presence continuously while the replacement document is delayed.');
  transition = await holdNavigation('https://anikototv.to/filter?keyword=slow&hold=1', true);
  assert.equal(transition.held.result.finalPresenceIntent?.details, 'Browsing Anikoto');
  await until(state, value => value.result.finalPresenceIntent === null, 'Navigation grace did not expire', 5000);
  transition.release();
  assert.equal((await transition.navigating).ok, true);
  await until(activity, value => value?.activeFrames.some(frame => frame.senderUrl.includes('keyword=slow')), 'Late replacement document did not report');
  await until(state, value => value.result.finalPresenceIntent?.details === 'Browsing Anikoto', 'Late replacement did not restore presence');
  console.log('Form navigation uses the same handoff; a stalled document clears after the bounded four-second grace.');
  transition = await holdNavigation('https://outside.invalid/?hold=1');
  await until(state, value => value.result.finalPresenceIntent === null, 'Leaving Anikoto retained its presence', 1500);
  transition.release();
  assert.equal((await transition.navigating).ok, true);
  await page.goto('https://anikototv.to/home');
  await page.bringToFront();
  await until(state, value => value.result.finalPresenceIntent?.details === 'Browsing Anikoto', 'Return to Anikoto did not report');
  transition = await holdNavigation('https://anikototv.to/filter?keyword=closed&hold=1');
  assert.equal(transition.held.result.finalPresenceIntent?.details, 'Browsing Anikoto');
  await page.close();
  transition.release();
  await transition.navigating;
  await until(state, value => value.result.finalPresenceIntent === null, 'Closing the tab retained held presence', 1500);
  console.log('Leaving Anikoto or closing its tab clears immediately, including a tab closed during the handoff.');
  navigationGate = null;
  page = await context.newPage();
  await page.goto('https://anikototv.to/home');
  // Verify that the same controls are available to a real sandboxed V2 guest.
  assert.equal((await send({ type: 'ACTIVITY_SET_ENABLED', id: 'anikoto', enabled: false })).ok, true);
  const v2Id = 'anikoto-display-v2-fixture';
  const v2Package = {
    metadata: { id: v2Id, name: 'V2 display fixture', description: 'Shared presentation controls fixture.',
      version: '1.0.0', apiVersion: 2, minExtensionVersion: '2.0.3', entry: 'activity.js',
      matches: ['https://anikototv.to/home'], pageAccess: {} },
    source: `ChudPresence.onUpdate(async () => {
      await ChudPresence.report({ kind: 'generic', media: { title: 'Browsing V2 fixture' },
        display: { details: 'Browsing V2 fixture', statusDisplayOverride: 'name', hideState: true } });
    });`,
  };
  assert.equal((await send({ type: 'ACTIVITY_INSTALL', activityPackage: v2Package })).ok, true);
  assert.equal((await send({ type: 'ACTIVITY_SET_PREFERENCES', id: v2Id, preferences: { statusDisplay: 'track' } })).ok, true);
  const v2Record = await until(async () => (await send({ type: 'ACTIVITY_LIBRARY_STATE' })).result.installed.find(item => item.id === v2Id),
    value => value?.normalizedReport?.media.title === 'Browsing V2 fixture', 'Real V2 guest did not report display controls');
  const v2Formatted = await formatted(v2Record);
  assert.equal(v2Formatted.status_display_type, 0);
  assert.equal(v2Formatted.name, 'V2 display fixture');
  assert.equal(v2Formatted.details, 'Browsing V2 fixture');
  assert.equal(Object.hasOwn(v2Formatted, 'state'), false);
  assert.equal(v2Record.preferences.statusDisplay, 'track');
  assert.equal((await send({ type: 'ACTIVITY_SET_ENABLED', id: v2Id, enabled: false })).ok, true);
  console.log('Real V2 QuickJS guest also accepts and formats both presentation controls.');
  console.log('No page errors. Browser smoke test passed.');
} finally {
  navigationGate?.release();
  await context?.close();
  const relative = path.relative(os.tmpdir(), temporary);
  assert.ok(relative && !relative.startsWith('..') && path.basename(temporary).startsWith('anikoto-v1-browser-'));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
