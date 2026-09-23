# ChudPresence Activity API v1

Activity API V1 is a trusted, first-party runtime for official ChudPresence
Activities. It provides broad website-observation capabilities to support
service integrations, including DOM access, page-context inspection, and
declared external networking. V1 packages are installed from the official
ChudPresence Activities repository or through the extension's Developer mode.

Activities run in an isolated Firefox `USER_SCRIPT` world and use the
restricted `ChudPresence` runtime. The extension owns Discord formatting,
credentials, transport, and publishing. Activities do not receive Discord
OAuth/session credentials, extension storage, or unrestricted `browser.*`
access.

V1 is intended for trusted first-party code. A future public/community API may
use a different trust and permission model. This document does not define that
model or a V2 contract.

## Package

```text
activities/<activity-id>/
├── metadata.json
├── activity.js
└── icon.png (optional; declare as "icon": "icon.png")
```

Metadata requires `id`, `name`, `description`, semantic `version`,
`apiVersion: 1`, HTTPS `matches`, and `entry: "activity.js"`. IDs are permanent
and match `^[a-z0-9][a-z0-9-]{1,63}$`. Keep the Activity self-contained and
under 512 KB.

`matches` applies separately to each page frame. Metadata may set
`"frames": "all"` to run the same bundled `activity.js` in every matching
frame; it defaults to `"top"`. Use `ChudPresence.runtime.frame.isTop` and the
current page URL to decide which frame should report. For example, declare both
the service page and embedded player host in `matches` to let a child frame
report playback for the parent service.

Optional discovery fields include `category`, searchable `aliases` and `tags`,
`contributors`, `homepage`, `repository`, `serviceUrl`, and
`defaultMediaKind`. `excludeMatches` removes URLs from the runtime scope even
when they also match `matches`. A package builds to one self-contained
`activity.js` entry; `frames: "all"` applies it to each matching frame.

## Report

```js
ChudPresence.report({
  kind: 'episode',
  media: {
    title: 'Episode title',
    series: 'Series name',
    season: 1,
    episode: 3,
  },
  playback: { state: 'playing', position: 120, duration: 1440 },
  artwork: { large: 'https://cdn.example.com/episode.jpg' },
  buttons: [{ label: 'Watch', url: location.href }],
});
```

Call `ChudPresence.clear()` when the page has no current activity. Reports use
the nested `kind`, `media`, `playback`, `display`, `artwork`, `buttons`, and
`visibility` model in `schemas/activity-report.schema.json`. `media.title` is
required. If `display` is omitted, songs default to title / artist, episodes to
series / episode title, movies to title, and streams to title / creator.
Playback defaults to playing at position zero and rate one. Visibility supports
`normal`, `idle`, `private`, and `ad`; only normal reports are published.

URLs must be HTTPS. Text fields are limited to 256 characters, playback values
are bounded, buttons are limited to two with 32-character labels, and the
serialized report is limited to 16 KB. Supported kinds are `video`, `movie`,
`episode`, `song`, `stream`, `game`, and `generic`. Presence details, timestamps,
artwork, and buttons are derived from generic report fields. Extension core does
not format reports by Activity ID.

`ChudPresence.runtime` exposes the registered `activityId`, Activity and API
versions, extension version, a frame descriptor, and `has(feature)`.
`lifecycle` provides an abort signal, cleanup callbacks, and managed timers.
`navigation.current` and `navigation.onChange()` observe SPA URL changes
without replacing History API methods. `media.find()`, `media.findAll()`,
`media.snapshot()`, and `media.onChange()` work with ordinary audio and video
elements. Runtime capabilities can be checked with
`runtime.has(feature)`.

`lifecycle.onUpgrade(({ fromVersion, toVersion }) => ...)` runs once for a
pending Activity version transition. Use it for migrations in this Activity's
isolated storage. A completed transition is persisted; a migration error stays
pending and appears in Developer diagnostics. A normal browser restart does
not create an upgrade transition.

`page.execute(fn, args = [])` runs a self-contained, synchronous function in
the current document's page `MAIN` world and resolves to its JSON-compatible
return value:

```js
const title = await ChudPresence.page.execute(
  (key) => window[key]?.title ?? null,
  ['playerState'],
);
```

The function cannot use Activity-scope closures. Arguments must be an array;
the function source and serialized arguments are each limited to 16 KB, and a
serialized result is limited to 64 KB. Results cross a JSON serialization
boundary, so functions, cyclic values, `undefined`, and other non-JSON results
are rejected. A thrown exception rejects the call with an `Error` carrying its
`name`, `message`, and `code`. The runtime targets the requesting document by
its browser document ID and reports a stale-document error if navigation
replaces it before execution returns.

Page scripts can see and interfere with code and data passed through
`page.execute`. The bridge is unavailable on Discord pages. It runs in
Firefox's `MAIN` world, which has no WebExtension-only APIs, and does not expose
ChudPresence's Discord credentials or extension storage.
`runtime.has('pageExecute')` reports whether this capability is present.

`net.fetch(url, options)` makes a bounded request from the extension context.
Declare allowed HTTPS URL patterns in metadata:

```json
{
  "network": ["https://api.example.com/v1/*"]
}
```

```js
const response = await ChudPresence.net.fetch(
  'https://api.example.com/v1/search',
  { method: 'POST', json: { query: 'episode' }, responseType: 'json' },
);
console.log(response.status, response.data);
```

Only `GET` and `POST` are supported. Use `body` for text or `json` for a JSON
request body; choose `responseType: 'json'` (the default) or `'text'`. The
Library requests the declared network host permissions during installation,
and each request must match a declared pattern. Requests omit cookies and
referrers, reject redirects, and cannot target Discord domains. Activities do
not receive an extension `Response` object, browser APIs, or Discord OAuth
material. Request bodies are limited to 64 KB, response bodies to 1 MB, the
default timeout is 10 seconds (maximum 15 seconds), and concurrency is capped
at two requests per Activity and four for the extension. Failures reject with
an `Error` carrying `name`, `message`, and `code`; HTTP error statuses resolve
normally with `ok: false`. Developer Mode records each request with its
Activity, frame, sanitized URL path, status, size, and timing. Query strings
are omitted from diagnostics. `runtime.has('netFetch')` reports this feature.

`storage` provides per-Activity JSON storage:

```js
const choice = await ChudPresence.storage.get('choice');
await ChudPresence.storage.set('choice', { mode: 'compact' });
const removed = await ChudPresence.storage.remove('choice');
const clearedCount = await ChudPresence.storage.clear();
```

Keys are non-empty strings up to 128 characters. A missing key returns `null`;
`set()` resolves to `true`, `remove()` resolves to whether a value existed, and
`clear()` resolves to the number of removed keys. Values must be JSON-compatible
and each Activity has a 64 KB quota. Storage is isolated by the registered
Activity ID, survives package updates, and is deleted when the Activity is
uninstalled. Failures reject with an `Error` carrying `name`, `message`, and
`code`. `runtime.has('storage')` reports this feature.

Activities can declare up to 32 settings in `metadata.json`. Supported types are
`boolean`, `select`, `string`, `number`, and `range`; numeric settings declare
`min` and `max`, with an optional positive `step`. The Library renders the
matching control and saves values with the Activity. Activity code can read
settings and listen for changes:

```js
const displayMode = await ChudPresence.settings.get('displayMode');
const values = await ChudPresence.settings.getAll();
const unsubscribe = ChudPresence.settings.onChange(({ id, value, settings }) => {
  if (id === 'displayMode') updateDisplay(value, settings);
});
```

Change listeners are removed with the Activity lifecycle. Values persist across
updates when the new setting definition still accepts them; changed or removed
values fall back to their new defaults. Invalid setting IDs or values are
rejected. `runtime.has('settings')` reports this feature.

`dom.waitFor(selector, options)` resolves to the first matching element already
present or added later. It accepts `root`, `timeoutMs` (default 10 seconds,
maximum 5 minutes), and `signal`; timeout and cancellation reject with
`TimeoutError` or `AbortError`. `dom.observe(selector, callback, options)` calls
back with each matching element found immediately or added later. Set
`immediate: false` to skip existing elements, `attributes: true` to observe
selector changes caused by attributes, and pass `root` or `signal` to scope or
cancel it. Both helpers use `MutationObserver` and clean up with the Activity
lifecycle. `runtime.has('dom')` reports this feature.

`log.debug()`, `log.info()`, `log.warn()`, and `log.error()` write structured
diagnostic entries for the current Activity. Pass up to eight JSON-compatible
values per call; a log entry is limited to 4 KB. Entries include the Activity
identity, tab, frame, document, and timestamp. Developer Mode keeps a bounded
recent log list and redacts common credential fields, bearer/JWT tokens, and
URL query strings before display. `runtime.has('log')` reports this feature.

Use ordinary DOM and media APIs when possible. Do not call Discord, read
extension storage, load remote code, or assume another Activity is installed.
The runtime assigns Activity identity, routes calls through structured
messages, and validates every report. Each report remains tied to its tab,
frame, document, and sender URL. The runtime ignores reports and clears from a
document after it has observed a replacement document in that frame. Replacing
the top document also retires reports from its child frames. Developer Mode
shows active frame IDs, URLs, and document IDs. Activities do not receive
direct `browser.*` or `chrome.*` API references. Review of repository source
and user approval of site access remain important parts of the trust model.

Catalogs may contain Activities for a newer runtime API. ChudPresence keeps
those entries visible with a compatibility message while allowing supported
Activities in the same catalog to install. Set `minExtensionVersion` when an
Activity needs a specific extension release. Repository installs pin the
catalog and package files to one immutable Git revision and save that revision
with the installed source hashes. Changes to an Activity's package files
require a strictly higher semantic version; repository CI checks this rule.
