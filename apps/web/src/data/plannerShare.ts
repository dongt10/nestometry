import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate';
import { z } from 'zod';
import {
  PLANNER_DOCUMENT_VERSION,
  SceneDocumentSchema,
  reconcileDocumentWithCanonical,
  type SceneDocument
} from './plannerDocument';
import { loadPlannerDocument } from './plannerPersistence';
import {
  DECOR_GROUP,
  FURNITURE_GROUP_PREFIXES,
  type FurnitureGroup
} from './furnitureGroups';

export const PLANNER_SHARE_VERSION = 1 as const;
export const PLANNER_SHARE_PREFIX = '#layout=v1.';
export const MAX_SHARE_FRAGMENT_CHARS = 8_000;
export const MAX_SHARE_DOCUMENT_BYTES = 32 * 1024;

const ShareEnvelopeSchema = z
  .object({
    version: z.literal(PLANNER_SHARE_VERSION),
    document: SceneDocumentSchema
  })
  .strict();

export class PlannerShareError extends Error {
  readonly code: 'too_large' | 'invalid';

  constructor(code: 'too_large' | 'invalid', message: string) {
    super(message);
    this.name = 'PlannerShareError';
    this.code = code;
  }
}

export type PlannerShareDecodeResult =
  | { status: 'missing' }
  | { status: 'ok'; document: SceneDocument }
  | { status: 'too_large'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'incompatible'; reason: 'room' | 'scene_revision' | 'version' };

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new PlannerShareError('invalid', 'shared plan has an invalid encoding');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '='
  );
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new PlannerShareError('invalid', 'shared plan has an invalid encoding');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function fragmentValue(fragmentOrUrl: string): { version: number; encoded: string } | null {
  const hashIndex = fragmentOrUrl.indexOf('#');
  const fragment = hashIndex === -1 ? fragmentOrUrl : fragmentOrUrl.slice(hashIndex);
  const match = fragment.match(/^#layout=v(\d+)\.(.*)$/u);
  if (!match) return null;
  return { version: Number(match[1]), encoded: match[2] };
}

export function encodePlannerShareFragment(document: SceneDocument): string {
  const shareableDocument =
    document.view.mode === 'walk'
      ? { ...document, view: { ...document.view, mode: '3d' as const } }
      : document;
  const envelope = ShareEnvelopeSchema.parse({
    version: PLANNER_SHARE_VERSION,
    document: shareableDocument
  });
  const serialized = strToU8(JSON.stringify(envelope));
  if (serialized.byteLength > MAX_SHARE_DOCUMENT_BYTES) {
    throw new PlannerShareError(
      'too_large',
      'shared plan is larger than the 32 kb safety limit'
    );
  }
  const fragment = `${PLANNER_SHARE_PREFIX}${toBase64Url(zlibSync(serialized, { level: 9 }))}`;
  if (fragment.length > MAX_SHARE_FRAGMENT_CHARS) {
    throw new PlannerShareError(
      'too_large',
      'shared plan is larger than the 8,000 character url limit'
    );
  }
  return fragment;
}

export function decodePlannerShareFragment(
  fragmentOrUrl: string,
  expected?: { room_id?: string; scene_revision?: string }
): PlannerShareDecodeResult {
  const fragment = fragmentValue(fragmentOrUrl);
  if (fragment === null) return { status: 'missing' };
  if (fragment.version !== PLANNER_SHARE_VERSION) {
    return { status: 'incompatible', reason: 'version' };
  }
  const encoded = fragment.encoded;
  if (encoded.length === 0) return { status: 'missing' };
  if (fragmentOrUrl.slice(fragmentOrUrl.indexOf('#')).length > MAX_SHARE_FRAGMENT_CHARS) {
    return { status: 'too_large', message: 'shared plan url is too long' };
  }

  try {
    const compressed = fromBase64Url(encoded);
    // Bound allocation before parsing; fflate truncates into this caller-owned
    // buffer, so a compressed payload cannot expand into an unbounded result.
    const decompressed = unzlibSync(compressed, {
      out: new Uint8Array(MAX_SHARE_DOCUMENT_BYTES + 1)
    });
    if (decompressed.byteLength > MAX_SHARE_DOCUMENT_BYTES) {
      return { status: 'too_large', message: 'shared plan expands beyond the 32 kb safety limit' };
    }
    const parsed: unknown = JSON.parse(strFromU8(decompressed));
    const envelope = ShareEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      const candidateVersion =
        typeof parsed === 'object' && parsed !== null && 'version' in parsed
          ? (parsed as { version?: unknown }).version
          : undefined;
      return candidateVersion !== PLANNER_SHARE_VERSION
        ? { status: 'incompatible', reason: 'version' }
        : { status: 'invalid', message: 'shared plan failed validation' };
    }
    if (expected?.room_id && envelope.data.document.room_id !== expected.room_id) {
      return { status: 'incompatible', reason: 'room' };
    }
    if (
      expected?.scene_revision &&
      envelope.data.document.scene_revision !== expected.scene_revision
    ) {
      return { status: 'incompatible', reason: 'scene_revision' };
    }
    if (envelope.data.document.document_version !== PLANNER_DOCUMENT_VERSION) {
      return { status: 'incompatible', reason: 'version' };
    }
    return { status: 'ok', document: envelope.data.document };
  } catch (error) {
    if (error instanceof PlannerShareError) {
      return { status: error.code, message: error.message };
    }
    return { status: 'invalid', message: 'shared plan could not be decoded' };
  }
}

function hasLegacyPlannerState(params: URLSearchParams): boolean {
  return ['hall', 'room', 'mode', 'show', 'decor', 'dims'].some((key) => params.has(key));
}

/** Read-only compatibility for URLs written by the pre-planner interface. */
export function applyLegacyPlannerQuery(document: SceneDocument, search: string): SceneDocument {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!hasLegacyPlannerState(params)) return document;
  const room = params.get('room');
  if (room !== null && room !== document.room_id) return document;

  const hidden = new Set<string>();
  const visibleValue = params.get('show');
  if (visibleValue !== null) {
    const visible = new Set(visibleValue.split(',').filter(Boolean));
    for (const group of FURNITURE_GROUP_PREFIXES) {
      if (group !== DECOR_GROUP && !visible.has(group)) hidden.add(group);
    }
  }
  if (params.get('decor') === '0') hidden.add(DECOR_GROUP);

  return {
    ...document,
    view: {
      ...document.view,
      mode: params.get('mode') === '2d' ? '2d' : '3d',
      dimensions_visible: params.get('dims') === '1',
      // Old links omitted decor when it was on by default.
      staging_visible: params.get('decor') !== '0',
      hidden_group_ids:
        visibleValue !== null || params.has('decor')
          ? [...hidden].sort()
          : document.view.hidden_group_ids
    }
  };
}

export type PlannerInitialResolution = {
  document: SceneDocument;
  source: 'shared' | 'local' | 'canonical';
  share_status: Exclude<PlannerShareDecodeResult['status'], 'ok'> | null;
  local_migrated: boolean;
};

/** Resolve shared state, then a compatible local save, then canonical state. */
export function resolveInitialPlannerDocument(input: {
  canonical: SceneDocument;
  fragment?: string;
  search?: string;
  storage?: Pick<Storage, 'getItem'>;
}): PlannerInitialResolution {
  let shareStatus: PlannerInitialResolution['share_status'] = null;
  if (input.fragment) {
    const shared = decodePlannerShareFragment(input.fragment, {
      room_id: input.canonical.room_id,
      scene_revision: input.canonical.scene_revision
    });
    if (shared.status === 'ok') {
      const reconciled = reconcileDocumentWithCanonical(input.canonical, shared.document);
      if (reconciled) {
        return {
          document: reconciled,
          source: 'shared',
          share_status: null,
          local_migrated: false
        };
      }
      shareStatus = 'incompatible';
    } else if (shared.status !== 'missing') {
      shareStatus = shared.status;
    }
  }

  if (input.storage) {
    const saved = loadPlannerDocument(
      input.storage,
      input.canonical.room_id,
      input.canonical.scene_revision
    );
    if (saved.status === 'ok') {
      const reconciled = reconcileDocumentWithCanonical(input.canonical, saved.document);
      if (reconciled) {
        return {
          document: applyLegacyPlannerQuery(reconciled, input.search ?? ''),
          source: 'local',
          share_status: shareStatus,
          local_migrated: saved.migrated
        };
      }
    }
  }

  return {
    document: applyLegacyPlannerQuery(input.canonical, input.search ?? ''),
    source: 'canonical',
    share_status: shareStatus,
    local_migrated: false
  };
}

/** Remove only Nestometry's planner fragment, preserving path and query. */
export function withoutPlannerShareFragment(href: string): string {
  const absolute = /^[a-z][a-z\d+.-]*:/iu.test(href);
  const url = new URL(href, 'https://nestometry.local');
  if (!/^#layout=v\d+\./u.test(url.hash)) return href;
  url.hash = '';
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}

/** Group visibility type helper for consumers adapting the legacy contract. */
export function visibleLegacyFurnitureGroups(document: SceneDocument): FurnitureGroup[] {
  const hidden = new Set(document.view.hidden_group_ids);
  return FURNITURE_GROUP_PREFIXES.filter((group) => !hidden.has(group));
}
