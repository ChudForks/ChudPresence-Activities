import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const activityRoot = path.join(root, 'activities');
const catalogPath = path.join(root, 'catalog.json');
const checkOnly = process.argv.includes('--check');
const idPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const activityKinds = new Set(['music', 'video', 'streaming', 'generic']);
const metadataFields = new Set([
  'id', 'name', 'description', 'version', 'apiVersion', 'author', 'category',
  'matches', 'entry', 'icon', 'executionWorld', 'repository', 'homepage', 'presence',
]);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validMatchPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 256) return false;
  const match = pattern.match(/^https:\/\/([^/]+)\/(.*)$/i);
  if (!match || !match[1] || match[1].includes('*') && !match[1].startsWith('*.')) return false;
  const host = match[1].startsWith('*.') ? match[1].slice(2) : match[1];
  if (!host || host.length > 253 || host.includes('*') || host.split('.').some((label) =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  )) return false;
  const route = match[2];
  return Boolean(route) && !route.includes('\\') && !/[?#]/.test(route) &&
    /^[-a-z0-9_.*%!$&'()+,;=:@/]*$/i.test(route);
}

function validateMetadata(metadata, directoryName, metadataText) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${directoryName}: metadata must be a JSON object.`);
  }
  if (Buffer.byteLength(metadataText, 'utf8') > 64 * 1024) throw new Error(`${directoryName}: metadata exceeds 64 KB.`);
  const unknown = Object.keys(metadata).find((key) => !metadataFields.has(key));
  if (unknown) throw new Error(`${directoryName}: unsupported metadata field ${unknown}.`);
  if (metadata.id !== directoryName || !idPattern.test(metadata.id)) {
    throw new Error(`${directoryName}: metadata ID must match the directory name and ID format.`);
  }
  if (typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 80 ||
      typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 500) {
    throw new Error(`${directoryName}: name and description are required and must fit their size limits.`);
  }
  const versionMatch = (metadata.version || '').match(versionPattern);
  const validPrerelease = !versionMatch?.[4] || versionMatch[4].split('.').every((part) =>
    !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'),
  );
  if (!versionMatch || !validPrerelease || metadata.apiVersion !== 1) {
    throw new Error(`${directoryName}: version or Activity API version is unsupported.`);
  }
  if (metadata.entry !== 'activity.js' || !Array.isArray(metadata.matches) ||
      metadata.matches.length < 1 || metadata.matches.length > 32 ||
      new Set(metadata.matches).size !== metadata.matches.length || !metadata.matches.every(validMatchPattern)) {
    throw new Error(`${directoryName}: entry or HTTPS website matches are invalid.`);
  }
  if (metadata.icon !== undefined && metadata.icon !== 'icon.png') {
    throw new Error(`${directoryName}: icon must be package-local icon.png.`);
  }
  if (metadata.category !== undefined &&
      (typeof metadata.category !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(metadata.category))) {
    throw new Error(`${directoryName}: category must be a short lowercase identifier.`);
  }
  if (metadata.executionWorld !== undefined && metadata.executionWorld !== 'USER_SCRIPT') {
    throw new Error(`${directoryName}: only USER_SCRIPT execution is supported.`);
  }
  if (metadata.author !== undefined &&
      (!metadata.author || typeof metadata.author.name !== 'string' || !metadata.author.name.trim() ||
       metadata.author.name.length > 80 || Object.keys(metadata.author).some((key) => !['name', 'url'].includes(key)))) {
    throw new Error(`${directoryName}: author must have a name and may have a URL.`);
  }
  if (metadata.presence !== undefined &&
      (!metadata.presence || typeof metadata.presence !== 'object' || Array.isArray(metadata.presence) ||
       Object.keys(metadata.presence).some((key) => key !== 'kind') ||
       (metadata.presence.kind !== undefined && !activityKinds.has(metadata.presence.kind)))) {
    throw new Error(`${directoryName}: presence kind is invalid.`);
  }
  for (const field of ['homepage', 'repository']) {
    if (metadata[field] !== undefined) {
      try {
        if (new URL(metadata[field]).protocol !== 'https:') throw new Error();
      } catch {
        throw new Error(`${directoryName}: ${field} must be an HTTPS URL.`);
      }
    }
  }
}

async function readPackage(directoryName) {
  if (!idPattern.test(directoryName)) throw new Error(`Invalid Activity directory name: ${directoryName}`);
  const directory = path.join(activityRoot, directoryName);
  const metadataText = await fs.readFile(path.join(directory, 'metadata.json'), 'utf8');
  const metadata = JSON.parse(metadataText);
  validateMetadata(metadata, directoryName, metadataText);
  const source = await fs.readFile(path.join(directory, 'activity.js'), 'utf8');
  if (!source.trim() || Buffer.byteLength(source, 'utf8') > 512 * 1024) {
    throw new Error(`${directoryName}: activity.js is empty or exceeds 512 KB.`);
  }
  const entry = {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    apiVersion: metadata.apiVersion,
    ...(metadata.category ? { category: metadata.category } : {}),
    matches: metadata.matches,
    entry: `activities/${directoryName}/activity.js`,
    metadata: `activities/${directoryName}/metadata.json`,
    sha256: digest(source),
    metadataSha256: digest(metadataText),
  };
  try {
    await fs.access(path.join(directory, 'icon.png'));
    entry.icon = `activities/${directoryName}/icon.png`;
  } catch {
    // An icon is optional.
  }
  return entry;
}

const directories = (await fs.readdir(activityRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const activities = await Promise.all(directories.map(readPackage));
const generated = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  activities,
};

if (checkOnly) {
  const current = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  if (current.schemaVersion !== generated.schemaVersion ||
      JSON.stringify(current.activities) !== JSON.stringify(generated.activities)) {
    throw new Error('catalog.json is stale. Run node tools/build-catalog.mjs and commit the result.');
  }
  console.log(`Validated ${activities.length} Activities and catalog hashes.`);
} else {
  await fs.writeFile(catalogPath, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(`Wrote catalog.json with ${activities.length} Activities.`);
}
