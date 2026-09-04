import { z } from 'zod';
import {
  PLANNER_DOCUMENT_VERSION,
  SceneDocumentSchema,
  type SceneDocument
} from './plannerDocument';

export const PLANNER_STORAGE_VERSION = 1 as const;
export const PLANNER_STORAGE_PREFIX = 'nestometry:planner';

const StoredPlannerDocumentSchema = z
  .object({
    storage_version: z.literal(PLANNER_STORAGE_VERSION),
    saved_at: z.string().datetime(),
    document: SceneDocumentSchema
  })
  .strict();

export type PlannerStorageLoadResult =
  | { status: 'missing' }
  | { status: 'ok'; document: SceneDocument; saved_at: string | null; migrated: boolean }
  | { status: 'incompatible'; reason: 'room' | 'scene_revision' | 'version' }
  | { status: 'invalid'; message: string };

export type PlannerStorageWriteResult =
  | { ok: true; key: string }
  | { ok: false; key: string; message: string };

export function plannerStorageKey(roomId: string): string {
  return `${PLANNER_STORAGE_PREFIX}:v${PLANNER_STORAGE_VERSION}:${encodeURIComponent(roomId)}`;
}

function checkCompatibility(
  document: SceneDocument,
  roomId: string,
  sceneRevision: string
): PlannerStorageLoadResult | null {
  if (document.document_version !== PLANNER_DOCUMENT_VERSION) {
    return { status: 'incompatible', reason: 'version' };
  }
  if (document.room_id !== roomId) return { status: 'incompatible', reason: 'room' };
  if (document.scene_revision !== sceneRevision) {
    return { status: 'incompatible', reason: 'scene_revision' };
  }
  return null;
}

export function loadPlannerDocument(
  storage: Pick<Storage, 'getItem'>,
  roomId: string,
  sceneRevision: string
): PlannerStorageLoadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(plannerStorageKey(roomId));
  } catch (error) {
    return {
      status: 'invalid',
      message: error instanceof Error ? error.message : 'planner storage could not be read'
    };
  }
  if (raw === null) return { status: 'missing' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', message: 'saved planner data is not valid json' };
  }

  const envelope = StoredPlannerDocumentSchema.safeParse(parsed);
  if (envelope.success) {
    const compatibility = checkCompatibility(envelope.data.document, roomId, sceneRevision);
    if (compatibility) return compatibility;
    return {
      status: 'ok',
      document: envelope.data.document,
      saved_at: envelope.data.saved_at,
      migrated: false
    };
  }

  // Early local prototypes stored an unwrapped v1 document. Accept it once and
  // let the next autosave migrate it into the versioned envelope.
  const unwrapped = SceneDocumentSchema.safeParse(parsed);
  if (unwrapped.success) {
    const compatibility = checkCompatibility(unwrapped.data, roomId, sceneRevision);
    if (compatibility) return compatibility;
    return {
      status: 'ok',
      document: unwrapped.data,
      saved_at: null,
      migrated: true
    };
  }

  const storedVersion =
    typeof parsed === 'object' && parsed !== null && 'storage_version' in parsed
      ? (parsed as { storage_version?: unknown }).storage_version
      : undefined;
  if (storedVersion !== undefined && storedVersion !== PLANNER_STORAGE_VERSION) {
    return { status: 'incompatible', reason: 'version' };
  }
  return { status: 'invalid', message: 'saved planner data failed validation' };
}

export function savePlannerDocument(
  storage: Pick<Storage, 'setItem'>,
  document: SceneDocument,
  now: Date = new Date()
): PlannerStorageWriteResult {
  const key = plannerStorageKey(document.room_id);
  try {
    const validated = SceneDocumentSchema.parse(document);
    storage.setItem(
      key,
      JSON.stringify({
        storage_version: PLANNER_STORAGE_VERSION,
        saved_at: now.toISOString(),
        document: validated
      })
    );
    return { ok: true, key };
  } catch (error) {
    return {
      ok: false,
      key,
      message: error instanceof Error ? error.message : 'planner storage could not be written'
    };
  }
}

export function removePlannerDocument(
  storage: Pick<Storage, 'removeItem'>,
  roomId: string
): boolean {
  try {
    storage.removeItem(plannerStorageKey(roomId));
    return true;
  } catch {
    return false;
  }
}
