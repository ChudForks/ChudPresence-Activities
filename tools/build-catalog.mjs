import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_ID_PATTERN,
  ACTIVITY_KIND_VALUES,
  ACTIVITY_METADATA_FIELDS,
  ACTIVITY_SEMVER_PATTERN,
  MAX_ACTIVITY_ICON_BYTES,
  MAX_ACTIVITY_METADATA_BYTES,
  MAX_ACTIVITY_SOURCE_BYTES,
  PRESENCE_KIND_VALUES,
} from '../schemas/activity-contract.generated.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const activityRoot = path.join(root, 'activities');
const catalogPath = path.join(root, 'catalog.json');
const checkOnly = process.argv.includes('--check');
const idPattern = new RegExp(ACTIVITY_ID_PATTERN);
const versionPattern = new RegExp(ACTIVITY_SEMVER_PATTERN);
const activityKinds = new Set(PRESENCE_KIND_VALUES);
const defaultMediaKinds = new Set(ACTIVITY_KIND_VALUES);
const metadataFields = new Set(ACTIVITY_METADATA_FIELDS);

function validateSettings(settings, directoryName) {
  if (settings === undefined) return;
  if (!Array.isArray(settings) || settings.length > 32) {
    throw new Error(`${directoryName}: settings must contain at most 32 definitions.`);
  }
  const ids = new Set();
  for (const setting of settings) {
    if (!setting || typeof setting !== 'object' || Array.isArray(setting) ||
        typeof setting.id !== 'string' || !/^[a-z][A-Za-z0-9_-]{0,63}$/.test(setting.id) || ids.has(setting.id) ||
        typeof setting.label !== 'string' || !setting.label.trim() || setting.label.length > 80) {
      throw new Error(`${directoryName}: setting IDs and labels are invalid or duplicated.`);
    }
    ids.add(setting.id);
    let allowed = ['id', 'type', 'label', 'default'];
    if (setting.type === 'boolean') {
      if (typeof setting.default !== 'boolean') throw new Error(`${directoryName}: boolean setting default is invalid.`);
    } else if (setting.type === 'select') {
      allowed = [...allowed, 'options'];
      if (!Array.isArray(setting.options) || setting.options.length < 1 || setting.options.length > 32) {
        throw new Error(`${directoryName}: select setting options are invalid.`);
      }
      const values = new Set();
      for (const option of setting.options) {
        if (!option || typeof option !== 'object' || Array.isArray(option) ||
            Object.keys(option).some((key) => !['label', 'value'].includes(key)) ||
            typeof option.label !== 'string' || !option.label.trim() || option.label.length > 80 ||
            typeof option.value !== 'string' || option.value.length > 128 || values.has(option.value)) {
          throw new Error(`${directoryName}: select setting options are invalid or duplicated.`);
        }
        values.add(option.value);
      }
      if (typeof setting.default !== 'string' || !values.has(setting.default)) {
        throw new Error(`${directoryName}: select setting default must match an option.`);
      }
    } else if (setting.type === 'string') {
      allowed = [...allowed, 'maxLength'];
      const maxLength = setting.maxLength === undefined ? 256 : setting.maxLength;
      if (typeof setting.default !== 'string' || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 256 ||
          setting.default.length > maxLength) {
        throw new Error(`${directoryName}: string setting default or maxLength is invalid.`);
      }
    } else if (setting.type === 'number' || setting.type === 'range') {
      allowed = [...allowed, 'min', 'max', 'step'];
      if (typeof setting.min !== 'number' || !Number.isFinite(setting.min) ||
          typeof setting.max !== 'number' || !Number.isFinite(setting.max) || setting.min >= setting.max ||
          typeof setting.default !== 'number' || !Number.isFinite(setting.default) ||
          setting.default < setting.min || setting.default > setting.max ||
          (setting.step !== undefined && (typeof setting.step !== 'number' || !Number.isFinite(setting.step) || setting.step <= 0))) {
        throw new Error(`${directoryName}: numeric setting bounds, step, or default are invalid.`);
      }
      if (setting.step !== undefined && Math.abs((setting.default - setting.min) / setting.step -
          Math.round((setting.default - setting.min) / setting.step)) >= 1e-8) {
        throw new Error(`${directoryName}: numeric setting default does not align with its step.`);
      }
    } else {
      throw new Error(`${directoryName}: setting type is unsupported.`);
    }
    if (Object.keys(setting).some((key) => !allowed.includes(key))) {
      throw new Error(`${directoryName}: setting contains an unsupported field.`);
    }
  }
}

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

function reservedNetworkPattern(pattern) {
  const host = String(pattern).match(/^https:\/\/([^/]+)\//i)?.[1]?.toLowerCase().replace(/^\*\./, '');
  return ['discord.com', 'discordapp.com', 'discordapp.net'].some((domain) => host === domain || host?.endsWith(`.${domain}`));
}

export function validateMetadata(metadata, directoryName, metadataText = JSON.stringify(metadata)) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${directoryName}: metadata must be a JSON object.`);
  }
  if (Buffer.byteLength(metadataText, 'utf8') > MAX_ACTIVITY_METADATA_BYTES) throw new Error(`${directoryName}: metadata exceeds its size limit.`);
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
  if (!versionMatch || !validPrerelease || !Number.isInteger(metadata.apiVersion) || metadata.apiVersion < 1) {
    throw new Error(`${directoryName}: version or Activity API version is unsupported.`);
  }
  if (metadata.minExtensionVersion !== undefined) {
    const minimum = String(metadata.minExtensionVersion).match(versionPattern);
    const validMinimum = !minimum?.[4] || minimum[4].split('.').every((part) =>
      !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'),
    );
    if (!minimum || !validMinimum) throw new Error(`${directoryName}: minExtensionVersion must be a semantic version.`);
  }
  if (metadata.entry !== 'activity.js' || !Array.isArray(metadata.matches) ||
      metadata.matches.length < 1 || metadata.matches.length > 32 ||
      new Set(metadata.matches).size !== metadata.matches.length || !metadata.matches.every(validMatchPattern)) {
    throw new Error(`${directoryName}: entry or HTTPS website matches are invalid.`);
  }
  if (metadata.frames !== undefined && !['top', 'all'].includes(metadata.frames)) {
    throw new Error(`${directoryName}: frames must be top or all.`);
  }
  for (const [field, maximum, pattern] of [
    ['aliases', 32, null],
    ['tags', 32, /^[a-z0-9][a-z0-9-]{0,31}$/],
  ]) {
    const values = metadata[field];
    if (values !== undefined && (!Array.isArray(values) || values.length > maximum ||
        new Set(values).size !== values.length || values.some((value) => typeof value !== 'string' || !value.trim() ||
          value !== value.trim() || value.length > (field === 'tags' ? 32 : 80) || (pattern && !pattern.test(value))))) {
      throw new Error(`${directoryName}: ${field} must contain up to ${maximum} unique valid strings.`);
    }
  }
  if (metadata.excludeMatches !== undefined &&
      (!Array.isArray(metadata.excludeMatches) || metadata.excludeMatches.length > 32 ||
       new Set(metadata.excludeMatches).size !== metadata.excludeMatches.length || !metadata.excludeMatches.every(validMatchPattern))) {
    throw new Error(`${directoryName}: excludeMatches must contain at most 32 unique HTTPS patterns.`);
  }
  if (metadata.contributors !== undefined &&
      (!Array.isArray(metadata.contributors) || metadata.contributors.length > 16 || metadata.contributors.some((person) =>
        !person || typeof person !== 'object' || Array.isArray(person) || typeof person.name !== 'string' || !person.name.trim() ||
        person.name.length > 80 || Object.keys(person).some((key) => !['name', 'url'].includes(key)) ||
        (person.url !== undefined && (!/^https:\/\//.test(person.url) || new URL(person.url).protocol !== 'https:'))))) {
    throw new Error(`${directoryName}: contributors must contain up to 16 names with optional HTTPS URLs.`);
  }
  if (metadata.network !== undefined &&
      (!Array.isArray(metadata.network) || metadata.network.length > 32 ||
       new Set(metadata.network).size !== metadata.network.length || !metadata.network.every(validMatchPattern) ||
       metadata.network.some(reservedNetworkPattern))) {
    throw new Error(`${directoryName}: network HTTPS patterns are invalid or target a reserved Discord host.`);
  }
  if (metadata.icon !== undefined && metadata.icon !== 'icon.png') {
    throw new Error(`${directoryName}: icon must be package-local icon.png.`);
  }
  if (metadata.category !== undefined &&
      (typeof metadata.category !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(metadata.category))) {
    throw new Error(`${directoryName}: category must be a short lowercase identifier.`);
  }
  if (metadata.defaultMediaKind !== undefined && !defaultMediaKinds.has(metadata.defaultMediaKind)) {
    throw new Error(`${directoryName}: defaultMediaKind is unsupported.`);
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
  validateSettings(metadata.settings, directoryName);
  for (const field of ['homepage', 'repository', 'serviceUrl']) {
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
  if (!source.trim() || Buffer.byteLength(source, 'utf8') > MAX_ACTIVITY_SOURCE_BYTES) {
    throw new Error(`${directoryName}: activity.js is empty or exceeds ${Math.round(MAX_ACTIVITY_SOURCE_BYTES / 1024)} KB.`);
  }
  const entry = {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    apiVersion: metadata.apiVersion,
    ...(metadata.minExtensionVersion ? { minExtensionVersion: metadata.minExtensionVersion } : {}),
    ...(metadata.category ? { category: metadata.category } : {}),
    ...(metadata.author ? { author: metadata.author } : {}),
    ...Object.fromEntries(['aliases', 'tags', 'excludeMatches', 'contributors', 'serviceUrl', 'homepage', 'repository', 'presence', 'defaultMediaKind', 'frames', 'network', 'settings']
      .filter((field) => metadata[field] !== undefined)
      .map((field) => [field, metadata[field]])),
    matches: metadata.matches,
    entry: `activities/${directoryName}/activity.js`,
    metadata: `activities/${directoryName}/metadata.json`,
    sha256: digest(source),
    metadataSha256: digest(metadataText),
  };
  if (metadata.icon === 'icon.png') {
    const icon = await fs.readFile(path.join(directory, 'icon.png'));
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (icon.length > MAX_ACTIVITY_ICON_BYTES || !icon.subarray(0, 8).equals(signature)) {
      throw new Error(`${directoryName}: icon.png must be a PNG up to ${Math.round(MAX_ACTIVITY_ICON_BYTES / 1024)} KB.`);
    }
    entry.icon = `activities/${directoryName}/icon.png`;
    entry.iconSha256 = digest(icon);
  }
  return entry;
}

async function main() {
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
