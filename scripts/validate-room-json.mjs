#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [, , fileArg] = process.argv;
if (!fileArg) {
  console.error('Usage: corepack pnpm validate:room <path-to-room-json>');
  process.exit(1);
}

const target = path.resolve(fileArg);
const json = JSON.parse(fs.readFileSync(target, 'utf8'));

// Load the TypeScript schema through tsx, as invoked by the package script.
try {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const mod = await import(pathToFileURL(path.join(repoRoot, 'packages/room-schema/src/schema.ts')).href);
  const result = mod.RoomSchema.safeParse(json);
  if (!result.success) {
    console.error('Room schema validation failed:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }
  console.log(`Room schema valid: ${target}`);
} catch (error) {
  console.error('Could not load the TypeScript schema. Run this command through the package script.');
  console.error(String(error));
  process.exit(1);
}
