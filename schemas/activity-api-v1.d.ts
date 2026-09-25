// Generated from schemas/activity-api-v1.json. Do not edit by hand.
export type ActivityMetadata = {
  "id": string;
  "name": string;
  "description": string;
  "version": string;
  "apiVersion": number;
  "minExtensionVersion"?: string;
  "author"?: {
  "name": string;
  "url"?: string;
};
  "contributors"?: Array<{
  "name": string;
  "url"?: string;
}>;
  "category"?: string;
  "defaultMediaKind"?: "video" | "movie" | "episode" | "song" | "stream" | "game" | "generic";
  "aliases"?: Array<string>;
  "tags"?: Array<string>;
  "matches": Array<string>;
  "excludeMatches"?: Array<string>;
  "entry": "activity.js";
  "icon"?: "icon.png";
  "executionWorld"?: "USER_SCRIPT";
  "frames"?: "top" | "all";
  "network"?: Array<string>;
  "settings"?: Array<{
  "id": string;
  "type": "boolean";
  "label": string;
  "default": boolean;
} | {
  "id": string;
  "type": "select";
  "label": string;
  "default": string;
  "options": Array<{
  "label": string;
  "value": string;
}>;
} | {
  "id": string;
  "type": "string";
  "label": string;
  "default": string;
  "maxLength"?: number;
} | {
  "id": string;
  "type": "number" | "range";
  "label": string;
  "default": number;
  "min": number;
  "max": number;
  "step"?: number;
}>;
  "settingsUi"?: {
  "statusLabels"?: {
  "app"?: string;
  "artist"?: string;
  "track"?: string;
};
};
  "repository"?: string;
  "homepage"?: string;
  "serviceUrl"?: string;
  "presence"?: {
  "kind"?: "music" | "video" | "streaming" | "generic";
};
};
export type ActivityReport = {
  "kind": "video" | "movie" | "episode" | "song" | "stream" | "game" | "generic";
  "media": {
  "title": string;
  "subtitle"?: string;
  "artist"?: string;
  "album"?: string;
  "series"?: string;
  "season"?: number;
  "episode"?: number;
  "creator"?: string;
  "channel"?: string;
  "category"?: string;
  "game"?: string;
  "playlist"?: string;
};
  "playback"?: {
  "state"?: "playing" | "paused" | "stopped";
  "position"?: number;
  "duration"?: number;
  "live"?: boolean;
  "rate"?: number;
};
  "display"?: {
  "details"?: string;
  "state"?: string;
  "statusDisplay"?: "name" | "details" | "state";
};
  "artwork"?: {
  "large"?: string;
  "largeText"?: string;
  "small"?: string;
  "smallText"?: string;
};
  "buttons"?: Array<{
  "label": string;
  "url": string;
}>;
  "visibility"?: "normal" | "idle" | "private" | "ad";
};
export type ActivityKind = "video" | "movie" | "episode" | "song" | "stream" | "game" | "generic";
export type PresenceKind = "music" | "video" | "streaming" | "generic";
