# Presence assets

Shared images for Discord activity artwork. These files are not part of an
Activity package. Discord fetches them from this repository, so an Activity
references a raw URL instead of bundling the image.

```text
https://raw.githubusercontent.com/ChudForks/ChudPresence-Activities/main/presence-assets/<file>
```

| File | Use |
| --- | --- |
| `pause.png` | Small image on album art while playback is paused |
| `play.png` | Small image for a playing badge, when an Activity wants one |

The current YouTube Music package uses `pause.png` when cover art is available
and playback is paused. `play.png` is available for authors; no current official
package references it. Use the URL as `artwork.small` and supply a short
`artwork.smallText` label in an Activity report.

These `main` branch image URLs are independent of the immutable Git revision
and hashes saved for installed Activity packages. The catalog hashes cover
`metadata.json`, `activity.js`, and optional `icon.png`, not shared presence
assets.

Both are original 512×512 PNGs with the mark kept inside the circle Discord
crops onto the corner of the large image. Add other shared badges here rather
than inside an Activity directory.
