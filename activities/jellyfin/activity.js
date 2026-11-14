// First-party Activity API V1 integration for explicitly approved Jellyfin Web
// servers. Inspired by PreMiD's Jellyfin presentation; uses ChudPresence's own
// lifecycle, page bridge, network broker, and structured media reports.
const JELLYFIN_LOGO = 'https://raw.githubusercontent.com/jellyfin/jellyfin-ux/master/branding/web/icon-transparent.png';
const MUSICBRAINZ_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shared project key, the same one the 67Movies Activity uses.
const TMDB_API_KEY = 'a46c50a0ccb1bafe2b15665df7fad7e1';
const TMDB_IMAGE_PATH = /^\/[A-Za-z0-9_-]{1,128}\.(?:jpe?g|png|webp)$/i;
const TMDB_NUMERIC_ID = /^\d{1,10}$/;
const TMDB_TV_TYPES = ['Series', 'Season', 'Episode'];
const UPLOAD_ENDPOINT = 'https://litterbox.catbox.moe/resources/internals/api.php';
const UPLOADED_URL = /^https:\/\/litter\.catbox\.moe\/[A-Za-z0-9]{1,32}\.(?:jpe?g|png|webp)$/;
const serverUrl = ChudPresence.runtime.siteUrl;
const defaults = { showBrowsing: true, privacyMode: false, showMovies: true, showSeries: true,
  showMusic: true, showLiveTv: true, showOverview: false, jellyfinLogoOnly: false, shareServerArtwork: true, uploadServerArtwork: false };
let settings = { ...defaults };
let running = false;
let pending = false;
let revision = 0;
let clientKey = '';
let serverInfo = null;
let serverCheckedAt = 0;
let sessionCache = null;
let sessionCheckedAt = 0;
let lastReport = '';
let lastReportedAt = 0;
let observedPlayer = null;
let observedSource = '';
let lastDiagnostic = '';
const items = new Map();
const artworkCache = new Map();
const artworkPending = new Set();

function diagnose(reason, details = {}) {
  const value = JSON.stringify({ reason, ...details });
  if (value === lastDiagnostic) return;
  lastDiagnostic = value;
  // Never log client identities, credentials, media URLs, or response bodies.
  void ChudPresence.log?.debug('Jellyfin detection', { reason, ...details }).catch(() => {});
}

function text(value, maximum = 256) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
}

function itemId(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,128}$/i.test(value) ? value : '';
}

function route() {
  return (location.hash.split('?')[0] || '').replace(/^#!?\/?/, '').replace(/\.html$/, '');
}

function sameServer(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      url.href.replace(/\/+$/, '') === serverUrl.replace(/\/+$/, '');
  } catch { return false; }
}

async function request(path, client) {
  const headers = {};
  if (client) {
    const escape = value => String(value).replace(/[\\"]/g, '\\$&');
    headers.Authorization = `MediaBrowser Client="Jellyfin Web", DeviceId="${escape(client.deviceId)}", Token="${escape(client.token)}"`;
  }
  try {
    const response = await ChudPresence.net.fetch(new URL(path, serverUrl).href,
      { headers, responseType: 'json', timeoutMs: 4000 });
    return response.ok ? response.data : null;
  } catch { return null; }
}

async function identifyServer() {
  if (serverCheckedAt && Date.now() - serverCheckedAt < (serverInfo ? 300000 : 30000)) return serverInfo;
  serverCheckedAt = Date.now();
  const info = await request('System/Info/Public');
  serverInfo = info && /jellyfin/i.test(info.ProductName || '') && itemId(info.Id) ? info : null;
  return serverInfo;
}

// Self-contained so the page bridge can also read this when the Activity's
// isolated world cannot access website storage. Never persist the result.
function storedClient(serverId) {
  try {
    const credentials = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
    const stored = Array.isArray(credentials.Servers) ? credentials.Servers.find(server => server.Id === serverId) : null;
    const deviceId = localStorage.getItem('_deviceId2') || '';
    if (stored?.AccessToken && stored.UserId && deviceId) {
      return { token: stored.AccessToken, userId: stored.UserId, deviceId };
    }
  } catch {}
  return null;
}

async function readClient(info) {
  const stored = storedClient(info.Id);
  if (stored) return stored;
  try {
    const pageStored = await ChudPresence.page.execute(storedClient, [info.Id]);
    if (pageStored?.token && pageStored.userId && pageStored.deviceId) return pageStored;
  } catch {}
  // Some Jellyfin clients do not persist a login. Read only the current
  // client's identity, and accept it only when it targets this approved server.
  try {
    const page = await ChudPresence.page.execute(() => {
      const api = window.ApiClient;
      const name = api?._appName || (typeof api?.appName === 'function' ? api.appName() : api?.appName);
      if (!api || decodeURIComponent(name || '') !== 'Jellyfin Web') return null;
      return { address: api.serverAddress?.() || api._serverAddress || '',
        token: api.accessToken?.() || api._serverInfo?.AccessToken || '',
        userId: api.getCurrentUserId?.() || api._serverInfo?.UserId || '',
        deviceId: api.deviceId?.() || api._deviceId || '' };
    });
    if (page && sameServer(page.address) && page.token && page.userId && page.deviceId) return page;
  } catch {}
  return null;
}

async function mediaItem(id, client) {
  if (!itemId(id) || !itemId(client.userId)) return null;
  if (items.has(id)) return items.get(id);
  const item = await request(`Users/${encodeURIComponent(client.userId)}/Items/${encodeURIComponent(id)}`, client);
  if (!item || item.Id !== id || !text(item.Name)) return null;
  if (items.size >= 64) items.delete(items.keys().next().value);
  items.set(id, item);
  return item;
}

function sourceItemId(element) {
  try {
    const url = new URL(element.currentSrc || element.src, serverUrl);
    const server = new URL(serverUrl);
    if (url.origin !== server.origin || !url.pathname.startsWith(server.pathname)) return '';
    return itemId(url.pathname.match(/\/(?:Audio|Videos)\/([^/]+)\//i)?.[1]);
  } catch { return ''; }
}

async function currentSession(client) {
  if (sessionCheckedAt && Date.now() - sessionCheckedAt < 5000) return sessionCache;
  sessionCheckedAt = Date.now();
  const sessions = await request(`Sessions?DeviceId=${encodeURIComponent(client.deviceId)}`, client);
  sessionCache = Array.isArray(sessions) ? sessions.find(session =>
    session.DeviceId === client.deviceId && session.UserId === client.userId &&
    (!session.Client || session.Client === 'Jellyfin Web') && session.NowPlayingItem?.Id) || null : null;
  return sessionCache;
}

// True for HTTPS servers on a public domain or public IP address. Discord must
// be able to load the poster itself, so LAN, loopback, link-local, carrier-NAT,
// reserved, and private-only names are excluded.
function publicServer() {
  let url;
  try { url = new URL(serverUrl); } catch { return false; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if ([a, b, c, d].some(part => part > 255)) return false;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (host.startsWith('[')) return /^\[[23][0-9a-f]{0,3}:/.test(host) && !/^\[2001:0?db8:/.test(host);
  return host.includes('.') && !host.endsWith('.ts.net') &&
    !/(?:^|\.)(?:localhost|local|lan|internal|intranet|corp|home|private|localdomain|test|invalid|example|arpa)$/.test(host);
}

function serverImage(item) {
  const pick = (id, tag) => itemId(id) && typeof tag === 'string' && /^[a-z0-9]{1,64}$/i.test(tag) ? { id, tag } : null;
  if (item.Type === 'Audio') return pick(item.AlbumId, item.AlbumPrimaryImageTag) || pick(item.Id, item.ImageTags?.Primary);
  if (item.Type === 'Episode') return pick(item.SeriesId, item.SeriesPrimaryImageTag) || pick(item.Id, item.ImageTags?.Primary);
  return pick(item.Id, item.ImageTags?.Primary);
}

function serverImageUrl(image) {
  const url = new URL(`Items/${encodeURIComponent(image.id)}/Images/Primary`, serverUrl);
  url.search = new URLSearchParams({ tag: image.tag, maxWidth: '512', maxHeight: '512', quality: '90' }).toString();
  return url.href;
}

// The poster is linked token-free, and only when Jellyfin reports that the
// item actually has one; otherwise the next artwork source is tried.
function publicArtwork(item) {
  const image = settings.shareServerArtwork && publicServer() ? serverImage(item) : null;
  return image ? serverImageUrl(image) : '';
}

function musicBrainzRelease(item) {
  const id = item?.ProviderIds?.MusicBrainzAlbum;
  return typeof id === 'string' && MUSICBRAINZ_ID.test(id.trim()) ? id.trim().toLowerCase() : '';
}

// Public Cover Art Archive images need no upload. Only the release ID that
// Jellyfin stored for the album is sent to MusicBrainz to confirm a front cover.
async function coverArtArchive(item, client) {
  if (item.Type !== 'Audio' && item.Type !== 'MusicAlbum') return '';
  try {
    let release = musicBrainzRelease(item);
    if (!release && item.Type === 'Audio' && itemId(item.AlbumId)) release = musicBrainzRelease(await mediaItem(item.AlbumId, client));
    if (!release) return '';
    const response = await ChudPresence.net.fetch(`https://musicbrainz.org/ws/2/release/${release}?fmt=json`,
      { responseType: 'json', timeoutMs: 6000 });
    return response?.ok && response.data?.id === release && response.data['cover-art-archive']?.front === true
      ? `https://coverartarchive.org/release/${release}/front-500` : '';
  } catch { return ''; }
}

async function tmdb(path, query = {}) {
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.search = new URLSearchParams({ ...query, api_key: TMDB_API_KEY, language: 'en-US' }).toString();
  const response = await ChudPresence.net.fetch(url.href, { responseType: 'json', timeoutMs: 6000 });
  return response?.ok && response.data && typeof response.data === 'object' ? response.data : null;
}

function tmdbImage(result) {
  const path = [result?.poster_path, result?.backdrop_path].find(value => typeof value === 'string' && TMDB_IMAGE_PATH.test(value));
  return path ? `https://image.tmdb.org/t/p/w500${path}` : '';
}

// Public TMDB posters need no upload. TMDB keeps movie and TV IDs in separate
// namespaces, so the endpoint follows the Jellyfin item type. Seasons and
// episodes use their series: an episode's own Tmdb ID is not the show's. Only
// the ID Jellyfin stored is sent; libraries without a TMDB ID fall back to the
// stored IMDb ID (movies and shows) or TVDB ID (shows) through TMDB's find.
async function tmdbPoster(item, client) {
  const kind = item.Type === 'Movie' ? 'movie' : TMDB_TV_TYPES.includes(item.Type) ? 'tv' : '';
  if (!kind) return '';
  try {
    const target = item.Type === 'Season' || item.Type === 'Episode'
      ? itemId(item.SeriesId) ? await mediaItem(item.SeriesId, client) : null : item;
    const ids = target?.ProviderIds || {};
    const id = typeof ids.Tmdb === 'string' ? ids.Tmdb.trim() : '';
    if (TMDB_NUMERIC_ID.test(id)) {
      const result = await tmdb(`${kind}/${id}`);
      return String(result?.id) === id ? tmdbImage(result) : '';
    }
    const imdb = typeof ids.Imdb === 'string' ? ids.Imdb.trim() : '';
    const tvdb = typeof ids.Tvdb === 'string' ? ids.Tvdb.trim() : '';
    const [external, source] = kind === 'tv' && TMDB_NUMERIC_ID.test(tvdb) ? [tvdb, 'tvdb_id']
      : /^tt\d{1,15}$/.test(imdb) ? [imdb, 'imdb_id'] : [];
    if (!external) return '';
    const found = await tmdb(`find/${external}`, { external_source: source });
    const results = found?.[kind === 'movie' ? 'movie_results' : 'tv_results'];
    return Array.isArray(results) ? tmdbImage(results[0]) : '';
  } catch { return ''; }
}

// Opt-in only. Reads the poster from this approved server without the login
// token and uploads that image alone to an expiring public host so Discord can
// load it. Runs in this world because the page bridge and network broker
// cannot carry binary bodies.
async function uploadServerImage(item) {
  const image = serverImage(item);
  if (!image || typeof fetch !== 'function' || typeof FormData !== 'function') return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(serverImageUrl(image), { credentials: 'same-origin', signal: controller.signal });
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
    if (!response.ok || !extension) return '';
    const blob = await response.blob();
    if (!blob.size || blob.size > 4194304) return '';
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', '24h');
    form.append('fileToUpload', blob, `artwork.${extension}`);
    const uploaded = await fetch(UPLOAD_ENDPOINT, { method: 'POST', body: form, credentials: 'omit',
      referrerPolicy: 'no-referrer', signal: controller.signal });
    const url = (await uploaded.text()).trim();
    return uploaded.ok && UPLOADED_URL.test(url) ? url : '';
  } catch { return ''; }
  finally { clearTimeout(timer); }
}

// Public cover lookups that need no upload: MusicBrainz for music, TMDB for
// movies and shows.
function publicLookup(item) {
  if (item.Type === 'Audio' || item.Type === 'MusicAlbum') return coverArtArchive;
  return item.Type === 'Movie' || TMDB_TV_TYPES.includes(item.Type) ? tmdbPoster : null;
}

// Order: public server poster, MusicBrainz cover or TMDB poster, opt-in upload,
// Jellyfin logo. Returns the best artwork known now and resolves anything
// missing in the background, so playback presence is never delayed by an
// external lookup.
function artworkFor(item, client, upload) {
  if (settings.privacyMode || settings.jellyfinLogoOnly) return JELLYFIN_LOGO;
  const shared = publicArtwork(item);
  if (shared) return shared;
  if (!client) return JELLYFIN_LOGO;
  const lookup = publicLookup(item);
  if (!upload && !lookup) return JELLYFIN_LOGO;
  const id = item.Type === 'Audio' ? itemId(item.AlbumId) || item.Id : item.Type === 'Episode' ? itemId(item.SeriesId) || item.Id : item.Id;
  const key = `${upload ? 'upload' : 'lookup'}:${id}`;
  const cached = artworkCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.url || JELLYFIN_LOGO;
  if (!artworkPending.has(key)) {
    artworkPending.add(key);
    const owner = clientKey;
    void (async () => {
      const found = lookup ? await lookup(item, client) : '';
      const uploaded = found || !upload ? '' : await uploadServerImage(item);
      return { url: found || uploaded, lifetime: found ? 86400000 : uploaded ? 82800000 : 600000 };
    })().catch(() => ({ url: '', lifetime: 600000 })).then(({ url, lifetime }) => {
      // A changed login or teardown already cleared this key; do not touch a newer lookup.
      if (owner !== clientKey || ChudPresence.lifecycle.signal.aborted) return;
      artworkPending.delete(key);
      if (artworkCache.size >= 64) artworkCache.delete(artworkCache.keys().next().value);
      artworkCache.set(key, { url, expires: Date.now() + lifetime });
      if (url) { lastReport = ''; void tick(); }
    });
  }
  return JELLYFIN_LOGO;
}

function buildMediaReport(item, snapshot, client) {
  const kind = item.Type === 'Audio' ? 'song' : item.Type === 'Episode' ? 'episode'
    : item.Type === 'Movie' ? 'movie' : item.Type === 'TvChannel' ? 'stream' : 'video';
  if ((kind === 'song' && !settings.showMusic) || (kind === 'episode' && !settings.showSeries) ||
      (kind === 'movie' && !settings.showMovies) || (kind === 'stream' && !settings.showLiveTv)) return null;
  const live = kind === 'stream';
  const playback = { state: snapshot.playing ? 'playing' : 'paused', live,
    position: Math.max(0, snapshot.currentTime || 0), rate: snapshot.playbackRate || 1 };
  if (!live) playback.duration = snapshot.duration > 0 ? snapshot.duration : Math.max(0, (item.RunTimeTicks || 0) / 10000000);
  const report = { kind, media: { title: text(item.Name) }, playback,
    artwork: { large: artworkFor(item, client, settings.uploadServerArtwork) },
    display: { details: text(item.Name) } };
  if (settings.privacyMode) {
    const label = kind === 'song' ? 'Listening to music' : kind === 'episode' ? 'Watching a TV episode'
      : kind === 'stream' ? 'Watching live TV' : 'Watching a movie';
    report.media.title = label;
    report.display = { details: label, hideState: true, statusDisplayOverride: 'name' };
    report.playback = { state: playback.state, live };
    return report;
  }
  if (kind === 'song') {
    const artist = text(item.Artists?.filter(value => typeof value === 'string').join(', ') || item.AlbumArtist);
    if (artist) report.media.artist = artist;
    if (text(item.Album)) report.media.album = text(item.Album);
    report.display.state = artist;
  } else if (kind === 'episode') {
    if (text(item.SeriesName)) report.media.series = text(item.SeriesName);
    if (Number.isInteger(item.ParentIndexNumber) && item.ParentIndexNumber >= 0 && item.ParentIndexNumber <= 10000) report.media.season = item.ParentIndexNumber;
    if (Number.isInteger(item.IndexNumber) && item.IndexNumber >= 0 && item.IndexNumber <= 10000) report.media.episode = item.IndexNumber;
    const number = [report.media.season !== undefined ? `S${String(report.media.season).padStart(2, '0')}` : '',
      report.media.episode !== undefined ? `E${String(report.media.episode).padStart(2, '0')}` : ''].join('');
    report.display.details = report.media.series || report.media.title;
    report.display.state = text([number, report.media.title].filter(Boolean).join(' • '));
  } else {
    report.display.state = text([item.ProductionYear, ...(Array.isArray(item.Genres) ? item.Genres.slice(0, 2) : []),
      Number.isFinite(item.CommunityRating) ? `★ ${item.CommunityRating.toFixed(1)}` : ''].filter(Boolean).join(' • '));
  }
  if (settings.showOverview && text(item.Overview)) report.display.state = text(item.Overview);
  const imdb = item.ProviderIds?.Imdb;
  if (/^tt\d{1,15}$/.test(imdb || '')) report.buttons = [{ label: 'View on IMDb', url: `https://www.imdb.com/title/${imdb}/` }];
  return report;
}

function browsingReport(item, client) {
  if (!settings.showBrowsing) return null;
  const labels = { home: 'Home', search: 'Searching the library', movies: 'Movies', tv: 'TV series', music: 'Music',
    livetv: 'Live TV', login: 'Signing in', selectserver: 'Choosing a server', dashboard: 'Server dashboard' };
  const label = settings.privacyMode ? 'Browsing Jellyfin' : item ? text(item.Name) : labels[route()] || 'Browsing Jellyfin';
  return { kind: 'generic', media: { title: label }, focusPolicy: 'foreground',
    display: { details: label, state: 'Browsing Jellyfin', statusDisplayOverride: 'name', hideState: settings.privacyMode },
    // Browsing never uploads; only public server, Cover Art Archive, or TMDB images.
    artwork: { large: item ? artworkFor(item, client, false) : JELLYFIN_LOGO } };
}

async function publish(report, epoch) {
  if (epoch !== revision || ChudPresence.lifecycle.signal.aborted) return;
  const serialized = JSON.stringify(report);
  if (serialized === lastReport && Date.now() - lastReportedAt < 15000) return;
  if (report) await ChudPresence.report(report);
  else await ChudPresence.clear();
  lastReport = serialized;
  lastReportedAt = Date.now();
}

async function tick() {
  if (ChudPresence.lifecycle.signal.aborted || !serverUrl) return;
  if (running) { pending = true; return; }
  running = true;
  const epoch = revision;
  let stage = 'server';
  try {
    const info = await identifyServer();
    if (!info) { diagnose('server_unidentified'); return await publish(null, epoch); }
    stage = 'media';
    const element = ChudPresence.media.find();
    observedPlayer = element;
    observedSource = element?.currentSrc || element?.src || '';
    const snapshot = element ? ChudPresence.media.snapshot(element) : null;
    const hasPlayer = snapshot && !snapshot.ended && (element.currentSrc || element.src) &&
      (snapshot.duration > 0 || snapshot.currentTime > 0 || snapshot.playing || route() === 'video');
    const needsClient = hasPlayer || (settings.showBrowsing && !settings.privacyMode && route() === 'details');
    stage = 'client';
    const client = needsClient ? await readClient(info) : null;
    const key = client ? `${info.Id}:${client.userId}:${client.deviceId}:${client.token}` : '';
    if (key !== clientKey) {
      clientKey = key;
      items.clear();
      artworkCache.clear();
      artworkPending.clear();
      sessionCache = null;
      sessionCheckedAt = 0;
    }
    if (hasPlayer) {
      // Publish only this tab's player. Server sessions alone never activate
      // playback presence for a remote client or another household member.
      if (!client) { diagnose('client_identity_unavailable'); return await publish(null, epoch); }
      stage = 'session';
      const sourceId = sourceItemId(element);
      const session = sourceId ? null : await currentSession(client);
      const id = sourceId || itemId(session?.NowPlayingItem?.Id);
      stage = 'metadata';
      const item = id ? await mediaItem(id, client) : null;
      const latest = ChudPresence.media.snapshot(element);
      if (element !== ChudPresence.media.find() || sourceItemId(element) !== sourceId || latest?.ended) return;
      stage = 'report';
      const report = item ? buildMediaReport(item, latest || snapshot, client) : null;
      diagnose(item ? report ? 'playback' : 'media_category_hidden' : id ? 'metadata_unavailable' : 'current_session_unavailable', { source: sourceId ? 'media_url' : 'session' });
      return await publish(report, epoch);
    }
    let detail = null;
    if (client && settings.showBrowsing && !settings.privacyMode && route() === 'details') {
      const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
      detail = await mediaItem(id, client);
    }
    diagnose('browsing');
    await publish(browsingReport(detail, client), epoch);
  } catch { diagnose('detection_failed', { stage }); await publish(null, epoch).catch(() => {}); }
  finally {
    running = false;
    if (pending && !ChudPresence.lifecycle.signal.aborted) {
      pending = false;
      ChudPresence.lifecycle.timeout(tick, 50);
    }
  }
}

ChudPresence.settings.onChange(event => { settings = { ...defaults, ...event.settings }; revision += 1; lastReport = ''; void tick(); });
ChudPresence.navigation.onChange(() => { revision += 1; lastReport = ''; sessionCheckedAt = 0; void tick(); });
ChudPresence.media.onChange(event => {
  if (['timeupdate', 'volumechange'].includes(event.type)) return;
  const element = ChudPresence.media.find();
  const source = element?.currentSrc || element?.src || '';
  if (event.type === 'media-elements-changed' && element === observedPlayer && source === observedSource) return;
  observedPlayer = element;
  observedSource = source;
  revision += 1;
  lastReport = '';
  if (['loadedmetadata', 'media-elements-changed', 'ended'].includes(event.type)) sessionCheckedAt = 0;
  void tick();
});
ChudPresence.lifecycle.interval(tick, 2000);
ChudPresence.lifecycle.onCleanup(() => { revision += 1; items.clear(); artworkCache.clear(); artworkPending.clear(); clientKey = ''; serverInfo = null; sessionCache = null; observedPlayer = null; observedSource = ''; });
void ChudPresence.settings.getAll().then(values => { settings = { ...defaults, ...values }; void tick(); }).catch(() => tick());
