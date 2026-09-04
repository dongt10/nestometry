import { describe, expect, it } from 'vitest';
import {
  loadPlannerDocument,
  plannerStorageKey,
  removePlannerDocument,
  savePlannerDocument
} from './plannerPersistence';
import { plannerTestDocument } from './plannerTestFixtures';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    }
  };
}

describe('planner persistence', () => {
  it('round-trips a versioned room save with its timestamp', () => {
    const storage = memoryStorage();
    const document = plannerTestDocument();
    expect(
      savePlannerDocument(storage, document, new Date('2026-08-12T20:00:00.000Z'))
    ).toEqual({ ok: true, key: plannerStorageKey(document.room_id) });

    const loaded = loadPlannerDocument(storage, document.room_id, document.scene_revision);
    expect(loaded).toMatchObject({
      status: 'ok',
      saved_at: '2026-08-12T20:00:00.000Z',
      migrated: false,
      document
    });
  });

  it('migrates an early unwrapped v1 document on read', () => {
    const storage = memoryStorage();
    const document = plannerTestDocument();
    storage.setItem(plannerStorageKey(document.room_id), JSON.stringify(document));

    expect(loadPlannerDocument(storage, document.room_id, document.scene_revision)).toMatchObject({
      status: 'ok',
      migrated: true,
      saved_at: null
    });
  });

  it('distinguishes missing, corrupt, and incompatible scene saves', () => {
    const storage = memoryStorage();
    const document = plannerTestDocument();
    expect(loadPlannerDocument(storage, document.room_id, document.scene_revision)).toEqual({
      status: 'missing'
    });

    storage.setItem(plannerStorageKey(document.room_id), '{not-json');
    expect(loadPlannerDocument(storage, document.room_id, document.scene_revision).status).toBe(
      'invalid'
    );

    savePlannerDocument(storage, document);
    expect(loadPlannerDocument(storage, document.room_id, 'new-scene')).toEqual({
      status: 'incompatible',
      reason: 'scene_revision'
    });
  });

  it('contains storage failures and supports explicit removal', () => {
    const document = plannerTestDocument();
    const failing = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('quota');
      },
      removeItem() {
        throw new Error('blocked');
      }
    };
    expect(savePlannerDocument(failing, document)).toMatchObject({ ok: false, message: 'quota' });
    expect(loadPlannerDocument(failing, document.room_id, document.scene_revision)).toMatchObject({
      status: 'invalid',
      message: 'blocked'
    });
    expect(removePlannerDocument(failing, document.room_id)).toBe(false);
  });
});
