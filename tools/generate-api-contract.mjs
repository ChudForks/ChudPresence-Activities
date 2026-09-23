import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = path.join(root, 'schemas');
const canonicalPath = path.join(schemaRoot, 'activity-api-v1.json');
const checkOnly = process.argv.includes('--check');
const contract = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));

if (contract.schemaVersion !== 1 || !Number.isInteger(contract.apiVersion) ||
    !Array.isArray(contract.supportedApiVersions) || !contract.supportedApiVersions.includes(contract.apiVersion) ||
    !contract.limits || !contract.metadataSchema?.properties || !contract.reportSchema?.properties) {
  throw new Error('The canonical Activity API contract is incomplete.');
}

const metadata = contract.metadataSchema;
const report = contract.reportSchema;
const media = report.properties.media;
const playback = report.properties.playback;
const display = report.properties.display;
const artwork = report.properties.artwork;
const enumAt = (schema) => schema?.enum || [];
const quote = (value) => JSON.stringify(value);
const arrayExport = (name, values) => `export const ${name} = Object.freeze(${JSON.stringify(values)});`;
const runtimeModule = [
  `export const ACTIVITY_API_VERSION = ${contract.apiVersion};`,
  arrayExport('SUPPORTED_ACTIVITY_API_VERSIONS', contract.supportedApiVersions),
  `export const MAX_ACTIVITY_METADATA_BYTES = ${contract.limits.metadataBytes};`,
  `export const MAX_ACTIVITY_REPORT_BYTES = ${contract.limits.reportBytes};`,
  `export const MAX_ACTIVITY_SOURCE_BYTES = ${contract.limits.sourceBytes};`,
  `export const MAX_ACTIVITY_ICON_BYTES = ${contract.limits.iconBytes};`,
  `export const MAX_ACTIVITY_TEXT_LENGTH = ${report.$defs.text.maxLength};`,
  `export const MAX_ACTIVITY_URL_LENGTH = ${report.$defs.httpsUrl.maxLength};`,
  `export const ACTIVITY_ID_PATTERN = ${quote(metadata.properties.id.pattern)};`,
  `export const ACTIVITY_SEMVER_PATTERN = ${quote(metadata.properties.version.pattern)};`,
  arrayExport('ACTIVITY_METADATA_FIELDS', Object.keys(metadata.properties)),
  arrayExport('ACTIVITY_KIND_VALUES', enumAt(report.properties.kind)),
  arrayExport('PRESENCE_KIND_VALUES', enumAt(metadata.properties.presence?.properties?.kind)),
  arrayExport('REPORT_MEDIA_FIELDS', Object.keys(media?.properties || {})),
  arrayExport('REPORT_PLAYBACK_FIELDS', Object.keys(playback?.properties || {})),
  arrayExport('REPORT_DISPLAY_FIELDS', Object.keys(display?.properties || {})),
  arrayExport('REPORT_ARTWORK_FIELDS', Object.keys(artwork?.properties || {})),
  arrayExport('REPORT_VISIBILITY_VALUES', enumAt(report.properties.visibility)),
  arrayExport('REPORT_PLAYBACK_STATE_VALUES', enumAt(playback?.properties?.state)),
  arrayExport('REPORT_STATUS_DISPLAY_VALUES', enumAt(display?.properties?.statusDisplay)),
  '',
].join('\n');

function resolveRef(reference) {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported external schema reference ${reference}.`);
  return reference.slice(2).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], { ...report, ...metadata, $defs: report.$defs });
}

function toType(schema, depth = 0) {
  if (!schema || depth > 12) return 'unknown';
  if (schema.$ref) return toType(resolveRef(schema.$ref), depth + 1);
  if (schema.const !== undefined) return quote(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(quote).join(' | ') || 'never';
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((entry) => toType(entry, depth + 1)).join(' | ');
  if (schema.type === 'array') return `Array<${toType(schema.items, depth + 1)}>`;
  if (schema.type === 'object') {
    const required = new Set(schema.required || []);
    const properties = Object.entries(schema.properties || {}).map(([key, value]) =>
      `  ${quote(key)}${required.has(key) ? '' : '?'}: ${toType(value, depth + 1)};`,
    );
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      properties.push(`  [key: string]: ${toType(schema.additionalProperties, depth + 1)};`);
    }
    return properties.length ? `{\n${properties.join('\n')}\n}` : 'Record<string, never>';
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  return 'unknown';
}

const declarations = [
  '// Generated from schemas/activity-api-v1.json. Do not edit by hand.',
  `export type ActivityMetadata = ${toType(metadata)};`,
  `export type ActivityReport = ${toType(report)};`,
  `export type ActivityKind = ${enumAt(report.properties.kind).map(quote).join(' | ')};`,
  `export type PresenceKind = ${enumAt(metadata.properties.presence?.properties?.kind).map(quote).join(' | ')};`,
  '',
].join('\n');

const outputs = new Map([
  [path.join(schemaRoot, 'activity.schema.json'), `${JSON.stringify(metadata, null, 2)}\n`],
  [path.join(schemaRoot, 'activity-report.schema.json'), `${JSON.stringify(report, null, 2)}\n`],
  [path.join(schemaRoot, 'activity-contract.generated.js'), runtimeModule],
  [path.join(schemaRoot, 'activity-api-v1.d.ts'), declarations],
]);

let extensionRoot;
let workspaceRoot;
const candidateExtensionRoot = path.resolve(root, '..', 'extension');
try {
  await fs.access(path.join(candidateExtensionRoot, 'core', 'activity-validator.js'));
  extensionRoot = candidateExtensionRoot;
  workspaceRoot = path.resolve(root, '..');
  outputs.set(path.join(extensionRoot, 'core', 'activity-contract.generated.js'), runtimeModule);
  outputs.set(path.join(workspaceRoot, 'schemas', 'activity-api-v1.json'), `${JSON.stringify(contract, null, 2)}\n`);
  outputs.set(path.join(workspaceRoot, 'schemas', 'activity.schema.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  outputs.set(path.join(workspaceRoot, 'schemas', 'activity-report.schema.json'), `${JSON.stringify(report, null, 2)}\n`);
} catch {
  // The Activities repository can build and validate independently.
}

for (const [file, content] of outputs) {
  if (checkOnly) {
    let current;
    try { current = await fs.readFile(file, 'utf8'); }
    catch { throw new Error(`${path.relative(root, file)} is missing. Run node tools/generate-api-contract.mjs.`); }
    if (current !== content) throw new Error(`${path.relative(root, file)} is stale. Run node tools/generate-api-contract.mjs.`);
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

console.log(`${checkOnly ? 'Checked' : 'Generated'} Activity API v${contract.apiVersion} schemas, runtime constants, and TypeScript definitions.`);
