(() => {
  const CHANNEL = 'chudpresence:anikoto:v1';
  const MAX_TIME = 31_536_000;
  const LOGO_URL = 'https://anikototv.to/AnikotoTheme/assets/images/favicon.png';
  let stopped = false;

  function serviceHost(host) {
    return host === 'anikototv.to' || host === 'www.anikototv.to';
  }

  function playerUrl(url) {
    return url?.hostname === 'megaplay.buzz' && /^\/(?:videojs\/)?stream\//.test(url.pathname);
  }

  function https(value, base = location.href) {
    try {
      const url = new URL(value, base);
      return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048 ? url : null;
    } catch { return null; }
  }

  function text(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 256);
  }

  function bounded(value, maximum = MAX_TIME) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : 0;
  }

  function snapshot(video) {
    if (!video) return null;
    const media = ChudPresence.media.snapshot(video);
    if (!media || !(Number.isFinite(media.duration) && media.duration > 0)) return null;
    const duration = bounded(media.duration);
    return {
      state: media.paused ? 'paused' : 'playing',
      position: Math.min(bounded(media.currentTime), duration),
      duration,
      rate: Number.isFinite(media.playbackRate) && media.playbackRate >= 0 && media.playbackRate <= 16
        ? media.playbackRate : 1,
      ended: Boolean(media.ended),
      ad: Boolean(document.querySelector('.jw-flag-ads, .jw-state-advertising')),
    };
  }

  // Only a matching child player relays playback. It never publishes a presence
  // or reads the parent's page. Origin, WindowProxy and a per-player token pair
  // its samples with the active iframe in the Anikoto top document.
  if (!ChudPresence.runtime.frame.isTop) {
    const url = https(location.href);
    if (!playerUrl(url)) return;
    // V1 wraps window.parent in a proxy. MessageEvent.source is the native
    // WindowProxy, so compare it to the DOM's native parent reference.
    const parentWindow = document.defaultView.parent;
    let parentOrigin = '';
    let token = '';
    function relay() {
      if (stopped || ChudPresence.lifecycle.signal.aborted || !token) return;
      const playback = snapshot(document.querySelector('#megaplay-player video') || ChudPresence.media.find());
      parentWindow.postMessage({ channel: CHANNEL, type: 'sample', token, playback }, parentOrigin);
    }
    function request(event) {
      const origin = https(event.origin);
      const data = event.data;
      if (event.source !== parentWindow || !origin || !serviceHost(origin.hostname) ||
          origin.origin !== event.origin || data?.channel !== CHANNEL || data.type !== 'request' ||
          typeof data.token !== 'string' || !data.token || data.token.length > 128) return;
      parentOrigin = event.origin;
      token = data.token;
      relay();
    }
    window.addEventListener('message', request);
    ChudPresence.media.onChange(relay);
    ChudPresence.lifecycle.interval(relay, 2000);
    ChudPresence.lifecycle.onCleanup(() => {
      if (token) parentWindow.postMessage({ channel: CHANNEL, type: 'sample', token, playback: null }, parentOrigin);
      stopped = true;
      window.removeEventListener('message', request);
    });
    return;
  }

  const topUrl = https(location.href);
  if (!topUrl || !serviceHost(topUrl.hostname)) return;

  let settings = { displayOrder: 'series', showArtwork: true };
  let binding = null;
  let lastSerialized = null;
  let lastSentAt = -Infinity;
  let scheduled = false;

  function route(value) {
    const url = https(value);
    if (!url || !serviceHost(url.hostname)) return null;
    const match = url.pathname.match(/^\/watch\/([^/]+)(?:\/ep-([^/]+))?\/?$/);
    if (!match) return null;
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return { url: url.href, series: match[1], episode: match[2] || '' };
  }

  function metadata() {
    const page = route(location.href);
    if (!page) return null;
    const active = document.querySelector('#w-episodes a.active');
    const selected = active && route(active.href);
    // The static <title>/og:title can describe the last episode in the series.
    // A route transition must also wait for the selected episode to catch up.
    if (!selected || selected.series !== page.series || page.episode && selected.episode !== page.episode) return null;
    const title = text(document.querySelector('#w-info h1')?.textContent);
    if (!title) return null;
    const rawNumber = active.getAttribute('data-num') || selected.episode || page.episode;
    const number = rawNumber ? Number(rawNumber) : NaN;
    const episode = Number.isInteger(number) && number >= 0 && number <= 10000 ? number : null;
    const episodeTitle = text(active?.querySelector('.d-title')?.textContent) || (episode !== null ? `Episode ${episode}` : '');
    const movie = [...document.querySelectorAll('#w-info .bmeta .meta > div')]
      .some(element => /^Type:\s*Movie\s*$/i.test(text(element.textContent)));
    const poster = document.querySelector('#w-info .poster img');
    const artwork = poster && https(poster.currentSrc || poster.src || poster.getAttribute('data-src'));
    return { key: selected?.url || page.url, title, episode, episodeTitle, movie, artwork: artwork?.href || '' };
  }

  function playerFrame() {
    for (const frame of document.querySelectorAll('#player iframe')) {
      const url = https(frame.src);
      if (playerUrl(url)) return { frame, url };
    }
    return null;
  }

  function resetBinding() {
    if (binding) binding.frame.removeEventListener('load', binding.onLoad);
    binding = null;
  }

  function ensureBinding(info) {
    const found = info && playerFrame();
    if (!found) { resetBinding(); return; }
    if (binding?.key === info.key && binding.frame === found.frame && binding.src === found.url.href) return;
    resetBinding();
    const onLoad = () => { resetBinding(); tick(); };
    binding = { key: info.key, frame: found.frame, src: found.url.href, origin: found.url.origin,
      token: crypto.randomUUID(), playback: null, updatedAt: 0, polledAt: -Infinity, onLoad };
    found.frame.addEventListener('load', onLoad);
  }

  function validPlayback(value) {
    return value && ['playing', 'paused'].includes(value.state) &&
      ['position', 'duration', 'rate'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) &&
      value.duration > 0 && value.duration <= MAX_TIME && value.position >= 0 && value.position <= value.duration &&
      value.rate >= 0 && value.rate <= 16 && typeof value.ended === 'boolean' && typeof value.ad === 'boolean';
  }

  function receive(event) {
    if (stopped || ChudPresence.lifecycle.signal.aborted || !binding) return;
    const data = event.data;
    if (event.origin !== binding.origin || event.source !== binding.frame.contentWindow ||
        data?.channel !== CHANNEL || data.type !== 'sample' || data.token !== binding.token) return;
    // Recheck the live route and iframe before accepting an in-flight sample.
    const info = metadata();
    const found = playerFrame();
    if (info?.key !== binding.key || found?.frame !== binding.frame || found?.url.href !== binding.src) {
      tick();
      return;
    }
    binding.playback = validPlayback(data.playback) ? { ...data.playback } : null;
    binding.updatedAt = Date.now();
    tick(false);
  }

  function collect(info) {
    if (!info) return null;
    const direct = document.querySelector('#player video');
    const playback = direct ? snapshot(direct) : binding && Date.now() - binding.updatedAt <= 75_000 ? binding.playback : null;
    if (!playback || playback.ended) return null;
    const episodeTitle = info.episodeTitle || info.title;
    const seriesFirst = settings.displayOrder !== 'episode';
    return {
      kind: info.movie ? 'movie' : 'episode',
      media: info.movie ? { title: info.title } : {
        title: episodeTitle, series: info.title, ...(info.episode !== null ? { episode: info.episode } : {}),
      },
      display: info.movie ? { details: info.title, state: '' } : {
        details: seriesFirst ? info.title : episodeTitle,
        state: seriesFirst ? episodeTitle : info.title,
      },
      playback: { state: playback.state, position: playback.position, duration: playback.duration, rate: playback.rate, live: false },
      artwork: settings.showArtwork ? {
        ...(info.artwork ? { large: info.artwork } : {}),
        largeText: info.movie ? info.title : text(`${info.title} • ${episodeTitle}`),
        ...(playback.state === 'paused' ? {
          small: 'https://raw.githubusercontent.com/ChudForks/ChudPresence-Activities/main/presence-assets/pause.png',
          smallText: 'Paused',
        } : {}),
      } : {},
      buttons: [
        { label: info.movie ? 'Watch movie' : 'Watch on Anikoto', url: info.key },
        { label: 'Open Anikoto', url: 'https://anikototv.to/' },
      ],
      visibility: playback.ad ? 'ad' : 'normal',
    };
  }

  function browsing() {
    const url = https(location.href);
    if (!url || !serviceHost(url.hostname) || document.visibilityState !== 'visible' || !document.hasFocus()) return null;
    return {
      kind: 'generic',
      media: { title: 'Browsing Anikoto' },
      display: { details: 'Browsing Anikoto', state: '', statusDisplayOverride: 'name', hideState: true },
      playback: { state: 'playing', position: 0, duration: 0, rate: 1, live: false },
      artwork: settings.showArtwork ? { large: LOGO_URL, largeText: 'Anikoto' } : {},
      buttons: [{ label: 'Open Anikoto', url: 'https://anikototv.to/' }],
      visibility: 'normal',
    };
  }

  function publish(report) {
    const serialized = report ? JSON.stringify(report) : '';
    const now = Date.now();
    if (serialized === lastSerialized && now - lastSentAt < 15_000) return;
    if (report && now - lastSentAt < 1500) {
      if (!scheduled) {
        scheduled = true;
        ChudPresence.lifecycle.timeout(() => { scheduled = false; tick(); }, 1500 - (now - lastSentAt));
      }
      return;
    }
    lastSerialized = serialized;
    lastSentAt = now;
    if (report) void ChudPresence.report(report).catch(() => {});
    else void ChudPresence.clear().catch(() => {});
  }

  function tick(poll = true) {
    if (stopped || ChudPresence.lifecycle.signal.aborted) return;
    const info = metadata();
    ensureBinding(info);
    if (binding && poll && Date.now() - binding.polledAt >= 2000) {
      binding.polledAt = Date.now();
      binding.frame.contentWindow?.postMessage({ channel: CHANNEL, type: 'request', token: binding.token }, binding.origin);
    }
    publish(collect(info) || browsing());
  }

  // Keep observing across replacement of the site's player/episode containers.
  const observer = new MutationObserver(() => tick());
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'src', 'data-num'] });
  window.addEventListener('message', receive);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('focus', tick);
  window.addEventListener('blur', tick);
  ChudPresence.media.onChange(() => tick());
  ChudPresence.navigation.onChange(() => {
    resetBinding();
    lastSerialized = null;
    tick();
  });
  ChudPresence.lifecycle.interval(tick, 2000);
  ChudPresence.settings.onChange(({ settings: next }) => {
    settings = { ...settings, ...next };
    tick();
  });
  ChudPresence.settings.getAll().then(next => { settings = { ...settings, ...next }; tick(); }).catch(() => {});
  ChudPresence.lifecycle.onCleanup(() => {
    stopped = true;
    resetBinding();
    observer.disconnect();
    window.removeEventListener('message', receive);
    document.removeEventListener('visibilitychange', tick);
    window.removeEventListener('focus', tick);
    window.removeEventListener('blur', tick);
    void ChudPresence.clear().catch(() => {});
  });
  tick();
})();
