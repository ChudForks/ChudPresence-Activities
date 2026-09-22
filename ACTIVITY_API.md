# ChudPresence Activity API v1

An Activity observes website state and reports normalized presence data. It runs
in an isolated Firefox `USER_SCRIPT` world with access to its approved site's
DOM and a narrow report API. Discord formatting and publishing stay in the
ChudPresence extension.

## Package

```text
activities/<activity-id>/
├── metadata.json
└── activity.js
```

Metadata requires `id`, `name`, `description`, semantic `version`,
`apiVersion: 1`, HTTPS `matches`, and `entry: "activity.js"`. IDs are permanent
and match `^[a-z0-9][a-z0-9-]{1,63}$`. Keep the Activity self-contained and
under 512 KB.

## Report

```js
ChudPresence.report({
  title: 'Episode title',
  artist: 'Series name',
  url: location.href,
  playing: true,
  position: 120,
  duration: 1440,
  kind: 'episode',
});
```

Call `ChudPresence.clear()` when the page has no current activity. A report must
have a title and may include `artist`, `album`, `artwork`, `url`, `playing`,
`position`, `duration`, `kind`, `details`, `state`, and up to two buttons with
`label` and `url`. URLs must be HTTPS. Strings are limited to 256 characters,
button labels to 32 characters, and the serialized report to 16 KB. Supported
kinds are `video`, `movie`, `episode`, `song`, `stream`, `game`, and `generic`.

Use ordinary DOM and media APIs when possible. Do not call Discord, read
extension storage, load remote code, or request permissions beyond the sites in
your metadata. The runtime assigns Activity identity and validates every
report. Review of repository source and user approval of site access remain
important parts of the trust model.
