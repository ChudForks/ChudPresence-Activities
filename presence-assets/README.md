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

Both are original 512×512 PNGs with the mark kept inside the circle Discord
crops onto the corner of the large image. Add other shared badges here rather
than inside an Activity directory.
