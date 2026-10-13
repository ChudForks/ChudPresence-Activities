import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions } from './check-version-bumps.mjs';

test('version gate follows SemVer ASCII prerelease precedence', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let index = 1; index < versions.length; index += 1) {
    assert.equal(compareVersions(versions[index - 1], versions[index]), -1);
    assert.equal(compareVersions(versions[index], versions[index - 1]), 1);
  }
  assert.equal(compareVersions('1.0.0-Z', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('1.0.0-A', '1.0.0-a'), -1);
  assert.equal(compareVersions('1.0.0-a-b', '1.0.0-a0'), -1);
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
});

test('version gate compares arbitrarily large numeric identifiers without rounding', () => {
  for (const [older, newer] of [
    ['9007199254740992.0.0', '9007199254740993.0.0'],
    ['1.0.0-9007199254740992', '1.0.0-9007199254740993'],
    ['1.0.0-9999999999999999999999999999999999999999', '1.0.0-10000000000000000000000000000000000000000'],
  ]) {
    assert.equal(compareVersions(older, newer), -1);
    assert.equal(compareVersions(newer, older), 1);
  }
});

test('version gate rejects malformed semantic versions', () => {
  for (const invalid of ['01.0.0', '1.0.0-01', '1.0.0-alpha..1', '1.0.0+bad+build']) {
    assert.throws(() => compareVersions(invalid, '1.0.0'), /Invalid semantic version/);
  }
});
