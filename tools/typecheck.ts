import type { ActivityMetadata, ActivityReport } from '@chudpresence/activity-sdk/types';

// Keep the package-level typecheck meaningful when no Activity uses TypeScript yet.
export const sampleMetadata: ActivityMetadata = {
  id: 'typecheck-sample',
  name: 'Typecheck sample',
  description: 'Checks the generated Activity API declarations.',
  version: '1.0.0',
  apiVersion: 1,
  matches: ['https://example.com/*'],
  entry: 'activity.js',
  settings: [{ id: 'showArtwork', type: 'boolean', label: 'Show artwork', default: true }],
};

export const sampleReport: ActivityReport = {
  kind: 'song',
  media: { title: 'Track', artist: 'Artist' },
  playback: { state: 'playing', position: 12, duration: 180 },
};
