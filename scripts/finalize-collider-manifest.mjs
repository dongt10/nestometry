#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const [manifestPath, glbPath] = process.argv.slice(2);
if (!manifestPath || !glbPath) {
  console.error('usage: node scripts/finalize-collider-manifest.mjs <manifest.json> <scene.glb>');
  process.exit(2);
}

const [manifestRaw, glb] = await Promise.all([
  readFile(manifestPath, 'utf8'),
  readFile(glbPath)
]);
const manifest = JSON.parse(manifestRaw);
manifest.asset_sha256 = createHash('sha256').update(glb).digest('hex');

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Finalized collider manifest: ${manifestPath}`);
