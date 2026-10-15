# ChudPresence Activity API v1

For programmable sandboxed V2 packages and Prime Video, use the separate
[V2 repository and guide](https://github.com/ChudForks/ChudPresence-Activities-V2/blob/main/ACTIVITY_API_V2.md).

Activity API V1 is a trusted, first-party runtime for official ChudPresence
Activities. It provides broad website-observation capabilities to support
service integrations, including DOM access, page-context inspection, and
declared external networking. V1 packages are installed from the official
ChudPresence Activities repository or through the extension's Developer mode.

Activities run in an isolated `USER_SCRIPT` world and use the
restricted `ChudPresence` runtime. The extension owns Discord formatting,
credentials, transport, and publishing. Activities do not receive Discord
OAuth/session credentials, extension storage, or unrestricted `browser.*`
access.

The canonical package and report contract is
[`schemas/activity-api-v1.json`](schemas/activity-api-v1.json). Its generated
schemas, runtime constants, and TypeScript declarations are checked in under
`schemas/`. Runtime behavior below reflects the companion Chromium Activity
Lab implementation, which currently supports API version 1; browser-specific
permission setup is described at the end.

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
and match `^[a-z0-9][a-z0-9-]{1,63}$`. Keep the `activity.js` entry
self-contained and at most 512 KiB.

Registered-script `matches` applies separately to each page frame. Metadata may
set `"frames": "all"` to run the same bundled `activity.js` in every matching
frame; it defaults to `"top"`. Use `ChudPresence.runtime.frame.isTop` and the
current page URL to decide which frame should report. For example, declare both
the service page and embedded player host in `matches` to let a child frame
report playback for the parent service.

Optional discovery fields include `category`, searchable `aliases` and `tags`,
`contributors`, `author`, `homepage`, `repository`, `serviceUrl`, and
`defaultMediaKind`. `excludeMatches` removes URLs from the runtime scope even
when they also match `matches`. Match, exclude, and network patterns are HTTPS
URLs with a host and path: each list allows at most 32 unique patterns, each up
to 256 characters. Hosts may be exact or start with `*.` to include the base
host and its subdomains; a bare `*` host is rejected. Paths may use `*`, but
patterns cannot contain a query string, fragment, or backslash. The runtime
matches the URL path and query together, so a trailing `*` also covers query
parameters. A package builds to one self-contained `activity.js` entry;
`frames: "all"` applies it to each matching frame. Metadata is limited to 64 KB
and an optional icon to 256 KB. Metadata, source, and icon limits are separate
file limits.

Optional `presence.kind` may be `music`, `video`, `streaming`, or `generic`.
The runtime accepts that field but does not copy it onto the published track.
Discord's activity type follows the report kind, described below.

Starting in companion extension **2.0.4**, optional `presence.navigationGraceMs`
is an integer from 0 to 5000 ms, defaulting to zero. For example,
`"presence": { "kind": "video", "navigationGraceMs": 4000 }` retains the last
presence during a confirmed Navigation API transition to a new top-level
document within `matches` and outside `excludeMatches`. Declare
`minExtensionVersion: "2.0.4"` for this V1 feature. V2 has supported the same
metadata option since extension 2.0.1.

The old script stops at document exit; only presence removal is deferred.
A replacement report cancels the deadline. Repeated exit signals cannot extend
it, and tab closure, out-of-scope navigation or Activity teardown still clear
immediately. Missing or aborted navigation hints keep ordinary clears.
Focus/visibility clears during a pending valid handoff defer to document exit.
Restoring an opted-in document from the back/forward cache restarts its runtime.
For SPA route changes, report the replacement directly without clearing first.

An Activity can label the popup's three Status display choices with optional
`settingsUi.statusLabels` metadata:

```json
{
  "settingsUi": {
    "statusLabels": {
      "app": "YouTube Music",
      "artist": "Artist",
      "track": "Song title"
    }
  }
}
```

Each key is optional. Missing labels keep the generic popup wording. Labels
must be non-empty strings of at most 80 characters. They change only the
choice text; the `app`, `artist`, and `track` preference values and Discord
presence formatting remain the same. These are extension preferences, not
Activity settings, and `ChudPresence.settings` does not return them.

On Chromium, registered scripts run at `document_end`, once the DOM exists.
Chromium does not start a registered user script when a same-document History
API navigation newly matches an Activity. The extension injects enabled
Activities on those tab URL updates, including an update that also reports
`status: loading`. Installing, enabling, reloading, or restoring an Activity
also injects it into already-open tabs whose top URL matches. Discarded tabs are
skipped during open-tab discovery. Explicit injection targets the top frame
or, for `frames: "all"`, all available frames in that tab; it does not filter
the execution target by each frame's URL. The runtime still checks every
request against that frame's sender URL and rejects excluded or out-of-scope
frames. Activities should check their page URL before observing or reporting.
Injecting the same installed package into a document that is already running
that package does not run the script again. Use `navigation.onChange()` for
later route changes in that document. Reload and a new install capability run
the script again.

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

Call `ChudPresence.clear()` when the page has no current activity. It clears the
current frame's report. Ordinary reports and clears schedule publication after
250 ms; when no eligible presence remains, the extension allows a further
1.5 seconds for playback to resume before publishing the clear. A returning
report cancels that pending clear. On `pagehide` or `beforeunload`, the runtime
attempts an internal closing clear before aborting the lifecycle and running
Activity cleanup callbacks. Closing clears and tab removal use the immediate
publication path. Activity code does not need to pass a closing option to
`clear()`.

`report()` and `clear()` return Promises for structured runtime responses. A
successful report has `ok: true` and `data.accepted: true`; a clear returns
`data.cleared` and `data.stale`. Validation and rate-limit failures return
`ok: false` with an `error` containing `code` and `message`. Check `ok` when the
Activity needs confirmation that a report was accepted.

Reports use the nested `kind`, `media`, `playback`, `display`, `artwork`, `buttons`, and
`visibility` model in `schemas/activity-report.schema.json`. `kind` and
`media.title` are required. Supported media fields are `title`, `subtitle`,
`artist`, `album`, `series`, `season`, `episode`, `creator`, `channel`,
`category`, `game`, and `playlist`. Undeclared fields are rejected, including
in nested objects. If `display` is omitted, songs default to title / artist,
episodes to series or title / episode title, movies to title, streams and videos to title /
creator or channel, games to the game name or title / category, and other kinds
to title / subtitle. `display.statusDisplay` defaults to `details` and may be
`name`, `details`, or `state`. Playback defaults to playing at position zero,
duration zero, not live, and rate one. Visibility defaults to `normal`.
Supported values are `normal`, `idle`, `private`, and `ad`; only normal reports
are published.

Optional `display.detailsUrl` and `display.stateUrl` make the corresponding
presence text clickable. `artwork.largeUrl` makes the large image clickable
when `artwork.large` is present. For a song, use the song URL as `detailsUrl`,
the displayed artist or album URL as `stateUrl`, and the album URL as
`largeUrl` when available. These links are independent of the two-button limit
and must be HTTPS URLs.
Set `artwork.largeText` to an empty string to omit the artwork text (the third
line in Discord's music card). Omitting the field uses album or title text.

Starting in extension **2.0.3**, both API V1 and V2 reports support two opt-in
display controls. `display.statusDisplayOverride` accepts `name`, `details`, or
`state` and overrides the saved status-line selection for that report only.
Omit it on playback reports to resume the user's saved series/episode choice.
`display.hideState: true` omits the second text line, its link, fallback app or
creator text, and Live/Paused markers. Omit it or use `false` for existing
behavior. Neither option changes saved preferences or artwork/button settings.
Packages using these options should declare `minExtensionVersion: '2.0.3'`.

```js
ChudPresence.report({
  kind: 'generic', media: { title: 'Browsing Example' },
  display: { details: 'Browsing Example', statusDisplayOverride: 'name', hideState: true },
  artwork: { large: 'https://example.com/logo.png', largeText: 'Example' },
});
```

Report URLs must use HTTPS, contain no credentials, and be at most 2048
characters. Text fields are limited to 256 characters. `season` and `episode`
are integers from 0 to 10000; playback `position` and `duration` are finite
numbers from 0 to 31536000 seconds; `rate` is from 0 to 16. Playback states are
`playing`, `paused`, and `stopped`. Buttons are limited to two with non-empty
labels up to 32 characters, and the normalized serialized report is limited
to 16 KB. Supported kinds are `video`, `movie`,
`episode`, `song`, `stream`, `game`, and `generic`. Discord's activity type
follows that kind: `song` is listening, `stream` is watching, `game` and
`generic` are playing, and the other kinds are watching. Presence details,
timestamps, artwork, and buttons are derived from generic report fields.
Extension core does not format reports by Activity ID.

`ChudPresence.runtime` exposes the registered `activityId`, package
`activityVersion`, `apiVersion`, `extensionVersion`, a frame descriptor, and
`has(feature)`.
`lifecycle` provides an abort signal, cleanup callbacks, and managed timers.
`navigation.current` and `navigation.onChange()` observe SPA URL changes
without replacing History API methods. A change callback receives
`{ oldUrl, newUrl, type }` after the URL settles; rapid changes in one turn are
coalesced. `media.find()`, `media.findAll()`, `media.snapshot()`, and
`media.onChange()` work with ordinary audio and video elements. `find()` prefers
a playing, visible element that has not ended. `snapshot()` returns `playing`,
`paused`, `ended`, `currentTime`, `duration`, `playbackRate`, `volume`, and
`muted`, or `null`. `onChange()` can filter by `element` or event `type`, emit
the current element when `immediate` is true, and stop on `signal`. Runtime
capabilities can be checked with `runtime.has(feature)`. The `frames`
namespace is currently empty; `runtime.frame.isTop` is the exposed frame flag.

`lifecycle.onUpgrade(({ fromVersion, toVersion }) => ...)` runs for a
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

The function cannot use Activity-scope closures and must return synchronously.
A returned Promise is rejected. Arguments must be an array;
the function source and serialized arguments are each limited to 16384
characters, and a serialized result is limited to 65536 characters. Results cross a JSON serialization
boundary, so functions, cyclic values, `undefined`, and other non-JSON results
are rejected. A thrown exception rejects the call with an `Error` carrying its
`name`, `message`, and `code`. The runtime targets the requesting document by
its browser document ID and reports a stale-document error if navigation
replaces it before execution returns.

Page scripts can see and interfere with code and data passed through
`page.execute`. The bridge is unavailable on Discord pages. It runs in the
browser's `MAIN` world, which has no WebExtension-only APIs, and does not
expose ChudPresence's Discord credentials or extension storage.
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
request body; choose `responseType: 'json'` (the default) or `'text'`. Do not
set both `body` and `json`. GET requests cannot include a body. `timeoutMs`
must be an integer from 100 to 15000 and defaults to 10000. URLs must be HTTPS
without credentials or fragments. Headers are a plain object of at most 32
string values, 8 KB in total, with each value limited to 2048 characters.
Cookie, host, content-length, origin, referer, `sec-*`, and `proxy-*` headers
are rejected. A completed call resolves to `{ status, ok, contentType, data }`.
The Library requests the declared network host permissions during installation,
and each request must match a declared pattern. Requests omit cookies and
referrers, reject redirects, and cannot target Discord domains. Activities do
not receive an extension `Response` object, browser APIs, or Discord OAuth
material. Request bodies are limited to 64 KB, response bodies to 1 MB, and
concurrency is capped at two requests per Activity and four for the extension.
Failures reject with an `Error` carrying `name`, `message`, and `code`; HTTP
error statuses resolve normally with `ok: false`. Developer Mode records each
request with its Activity, frame, sanitized URL path, status, size, and timing.
Query strings are omitted from diagnostics. `runtime.has('netFetch')` reports
this feature.

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
present or added later. Selectors are limited to 512 characters. It accepts
`root`, `timeoutMs` (default 10 seconds, maximum 5 minutes; `0` rejects
immediately), and `signal`; timeout and cancellation reject with `TimeoutError`
or `AbortError`. `dom.observe(selector, callback, options)` calls back with each
matching element found immediately or added later. The callback receives the
element and `{ type: 'added' }`. Set `immediate: false` to skip existing
elements, `attributes: true` to observe selector changes caused by attributes,
and an optional `attributeFilter` when attributes are observed. Pass `root` or
`signal` to scope or cancel it. Both helpers use `MutationObserver` and clean up
with the Activity lifecycle. `runtime.has('dom')` reports this feature.

`log.debug()`, `log.info()`, `log.warn()`, and `log.error()` write structured
diagnostic entries for the current Activity. Pass up to eight JSON-compatible
values per call; a log entry is limited to 4 KB. Entries include the Activity
identity, tab, frame, document, and timestamp. Developer Mode keeps a bounded
recent log list and redacts common credential fields, bearer/JWT tokens, and
URL query strings before display. `runtime.has('log')` reports this feature.

Use ordinary DOM and media APIs when possible. Do not call Discord, read
extension storage, load remote code, or assume another Activity is installed.
Activity identity comes from the installed package's capability and, when
Chromium provides it, its registered user-script world. It does not come from
report data. The runtime routes calls through structured messages and validates
every report. It checks the sending world, page URL, report shape, field sizes,
and request rate. Each Activity may send 30 runtime
requests per tab in a 10-second window. Each report remains tied to its tab,
frame, document, and sender URL. Keep sending reports while playback continues:
a frame that has not reported for more than 90 seconds is dropped during
stale-report pruning, and its presence is cleared. This leaves room for
Chromium's throttled background-tab timers. If the extension runtime
disconnects, the script retries the connection and resubmits its last report
after reconnecting; ten consecutive connection failures or disconnects end
the Activity lifecycle.

A same-document History API URL change keeps that document eligible to report,
including queued playback transitions. On Chromium, a tab loading update
preserves the report and document ID, so the same document can continue
reporting immediately. Its report remains valid until an Activity clear,
document exit, replacement, discard, closure, or stale-report pruning. A report
with a different document ID retires the previous document. Replacing the top document also
retires reports from its child frames. Discarding or closing a tab retires its
documents. The runtime ignores reports and clears from a retired document.
Developer Mode shows frame state (`active`, `loading`, or `retired`), frame
IDs, URLs, and document IDs. Activities do not receive direct `browser.*` or
`chrome.*` API references. Review of repository source and user approval of
site access remain important parts of the trust model.

## Permissions and compatibility

The Chromium lab declares `userScripts` at install time and requires Chrome
135 or newer. Chrome 138 or newer also requires **Allow User Scripts** on the
extension's details page; older supported versions use Developer mode.
Firefox may request `userScripts` permission separately from the Activity's
declared site and network origins. The Library requests the validated host
patterns before downloading a repository package. Hash verification detects
mismatched or corrupted downloads; review of the Activity source determines
whether to trust it.

Catalogs may contain Activities for a newer runtime API. ChudPresence keeps
those entries visible with a compatibility message while allowing supported
Activities in the same catalog to install. Set `minExtensionVersion` when an
Activity needs a specific extension release. Repository installs pin the
catalog and package files to one immutable Git revision and save that revision
with the installed metadata, script, and optional icon hashes. Updates preserve
settings and per-Activity storage; a failed pre-commit update restores the old
package and its live documents. Changes to an Activity's package files
require a strictly higher semantic version; repository CI checks this rule.
