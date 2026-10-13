import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_SEMVER_PATTERN } from '../schemas/activity-contract.generated.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = typeof value === 'string' && value.match(new RegExp(ACTIVITY_SEMVER_PATTERN));
    const pre = match?.[4]?.slice(1).split('.') || null;
    if (!match || pre?.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
    return { core: match.slice(1, 4), pre };
  };
  const compareNumeric = (a, b) => a.length !== b.length ? Math.sign(a.length - b.length) : a === b ? 0 : a < b ? -1 : 1;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error(`Invalid semantic version: ${!a ? left : right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return compareNumeric(a.core[index], b.core[index]);
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    if (a.pre[index] === undefined) return -1;
    if (b.pre[index] === undefined) return 1;
    if (a.pre[index] === b.pre[index]) continue;
    const an = /^\d+$/.test(a.pre[index]);
    const bn = /^\d+$/.test(b.pre[index]);
    if (an && bn) return compareNumeric(a.pre[index], b.pre[index]);
    if (an !== bn) return an ? -1 : 1;
    return a.pre[index] < b.pre[index] ? -1 : 1;
  }
  return 0;
}

async function main() {
  const suppliedBase = process.argv.find((argument) => argument.startsWith('--base='))?.slice('--base='.length);
  const eventBase = process.env.GITHUB_EVENT_BEFORE;
  const pullRequestBase = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '';
  const baseRef = suppliedBase || (eventBase && !/^0+$/.test(eventBase) ? eventBase : pullRequestBase) || 'HEAD^';
  const base = git('merge-base', baseRef, 'HEAD');
  const changed = git('diff', '--name-only', `${base}..HEAD`, '--', 'activities')
    .split(/\r?\n/)
    .filter((path) => /^activities\/[^/]+\/(?:activity\.js|metadata\.json|icon\.png)$/.test(path));
  const activityIds = new Set(changed.map((path) => path.split('/')[1]));
  const failures = [];

  for (const id of activityIds) {
    let previous;
    try {
      previous = JSON.parse(git('show', `${base}:activities/${id}/metadata.json`));
    } catch {
      continue;
    }
    const current = JSON.parse(await fs.readFile(new URL(`../activities/${id}/metadata.json`, import.meta.url), 'utf8'));
    if (compareVersions(current.version, previous.version) <= 0) {
      failures.push(`${id}: package files changed, so version must increase above ${previous.version} (currently ${current.version}).`);
    }
  }

  if (failures.length) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Activity version bumps verified for ${activityIds.size} changed package(s).\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
