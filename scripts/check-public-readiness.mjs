#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8'
})
  .split('\0')
  .filter(Boolean)
  // Deleted-but-not-yet-staged files may remain in the index during a local
  // cleanup. CI sees only files present in the committed tree.
  .filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

const failures = [];
const binaryExtensions = new Set([
  '.blend',
  '.glb',
  '.gif',
  '.gz',
  '.hdr',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.webp',
  '.zip'
]);
const maximumFileBytes = 95 * 1024 * 1024;

const privatePathMarkers = [
  '/Us' + 'ers/',
  '/private/' + 'tmp/',
  'Documents/' + 'Code' + 'x',
  'file:' + '//'
];
const credentialPatterns = [
  /AKIA[0-9A-Z]{16}/,
  /ASIA[0-9A-Z]{16}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/
];

for (const relativePath of tracked) {
  const absolutePath = path.join(repoRoot, relativePath);
  const stats = fs.lstatSync(absolutePath);

  if (stats.isSymbolicLink()) {
    failures.push(`${relativePath}: symbolic links are not allowed in the public tree`);
    continue;
  }
  if (stats.size > maximumFileBytes) {
    failures.push(`${relativePath}: exceeds the 95 MiB repository file budget`);
  }
  if (relativePath === '.env' || path.basename(relativePath).startsWith('.env.')) {
    failures.push(`${relativePath}: environment files must not be tracked`);
  }
  if (relativePath.startsWith('.claude/') || relativePath.endsWith('.blend1')) {
    failures.push(`${relativePath}: local tool or Blender backup state must not be tracked`);
  }

  if (binaryExtensions.has(path.extname(relativePath).toLowerCase())) continue;
  const contents = fs.readFileSync(absolutePath, 'utf8');
  for (const marker of privatePathMarkers) {
    if (contents.includes(marker)) {
      failures.push(`${relativePath}: contains private or non-public path marker ${JSON.stringify(marker)}`);
    }
  }
  if (credentialPatterns.some((pattern) => pattern.test(contents))) {
    failures.push(`${relativePath}: contains a credential-like signature`);
  }
}

const modelNames = ['unit-3-standard-double.glb', 'unit-3-standard-triple.glb'];
for (const modelName of modelNames) {
  const sourcePath = path.join(repoRoot, 'assets/glb/berkeley', modelName);
  const publicPath = path.join(repoRoot, 'apps/web/public/models/berkeley', modelName);
  const source = fs.readFileSync(sourcePath);
  const publicCopy = fs.readFileSync(publicPath);

  if (!source.equals(publicCopy)) {
    failures.push(`${modelName}: source and public GLB copies differ`);
  }

  const jsonLength = source.readUInt32LE(12);
  const chunkType = source.toString('ascii', 16, 20);
  if (chunkType !== 'JSON') {
    failures.push(`${modelName}: malformed GLB JSON chunk`);
    continue;
  }
  const gltf = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8'));
  const externalUris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].filter(
    (entry) => typeof entry.uri === 'string'
  );
  if (externalUris.length > 0) {
    failures.push(`${modelName}: contains ${externalUris.length} external URI(s)`);
  }

  const hash = crypto.createHash('sha256').update(source).digest('hex');
  console.log(`${modelName}: ${source.length} bytes, sha256 ${hash}`);
}

if (failures.length > 0) {
  console.error('Public-readiness check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public-readiness check passed for ${tracked.length} tracked files present in the tree.`);
