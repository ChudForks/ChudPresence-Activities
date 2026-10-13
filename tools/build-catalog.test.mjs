import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMetadata } from './build-catalog.mjs';

const metadata = {
  id: 'example', name: 'Example', description: 'Example playback', version: '1.0.0',
  apiVersion: 1, matches: ['https://example.com/*'], entry: 'activity.js',
};

test('catalog validation rejects profile and service URLs the extension cannot install', () => {
  for (const url of ['http://example.com/', 'https://user:secret@example.com/', 'https://example.com/' + 'a'.repeat(2048)]) {
    for (const fields of [
      { author: { name: 'Author', url } },
      { contributors: [{ name: 'Contributor', url }] },
      { homepage: url }, { repository: url }, { serviceUrl: url },
    ]) {
      assert.throws(() => validateMetadata({ ...metadata, ...fields }, metadata.id), /HTTPS URL/);
    }
  }
});

test('catalog validation accepts optional HTTPS profile and service URLs', () => {
  assert.doesNotThrow(() => validateMetadata({
    ...metadata, author: { name: 'Author', url: 'https://example.com/author' },
    contributors: [{ name: 'Contributor', url: 'https://example.com/contributor' }],
    homepage: 'https://example.com/', repository: 'https://example.com/repo', serviceUrl: 'https://example.com/play',
  }, metadata.id));
});

test('catalog validation rejects leading zeroes in the first numeric prerelease identifier', () => {
  for (const field of ['version', 'minExtensionVersion']) {
    for (const invalid of ['1.0.0-01', '1.0.0-01.beta', '1.0.0-alpha.01']) {
      assert.throws(() => validateMetadata({ ...metadata, [field]: invalid }, metadata.id), /version/i);
    }
    for (const valid of ['1.0.0-0', '1.0.0-1.beta', '1.0.0-alpha.0', '1.0.0-01alpha']) {
      assert.doesNotThrow(() => validateMetadata({ ...metadata, [field]: valid }, metadata.id));
    }
  }
});
