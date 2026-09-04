import { describe, expect, it } from 'vitest';
import { strToU8, zlibSync } from 'fflate';
import {
  MAX_SHARE_DOCUMENT_BYTES,
  MAX_SHARE_FRAGMENT_CHARS,
  PLANNER_SHARE_PREFIX,
  PlannerShareError,
  applyLegacyPlannerQuery,
  decodePlannerShareFragment,
  encodePlannerShareFragment,
  resolveInitialPlannerDocument,
  visibleLegacyFurnitureGroups,
  withoutPlannerShareFragment
} from './plannerShare';
import { savePlannerDocument } from './plannerPersistence';
import { SceneDocumentSchema, createCustomBlock } from './plannerDocument';
import { plannerTestDocument } from './plannerTestFixtures';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    }
  };
}

function pseudoRandomText(length: number, seed: number): string {
  let state = seed;
  let result = '';
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    result += String.fromCharCode(33 + (state % 90));
  }
  return result;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

describe('planner share fragments', () => {
  it('round-trips a complete versioned scene without changing the query string', () => {
    const document = plannerTestDocument();
    document.view.mode = '2d';
    document.view.units = 'metric';
    document.layout.removed_instance_ids = ['chair_1'];
    const fragment = encodePlannerShareFragment(document);
    expect(fragment.startsWith(PLANNER_SHARE_PREFIX)).toBe(true);
    expect(fragment.length).toBeLessThan(MAX_SHARE_FRAGMENT_CHARS);
    expect(decodePlannerShareFragment(`https://example.test/?room=x${fragment}`)).toEqual({
      status: 'ok',
      document
    });
  });

  it('reports malformed, oversized, wrong-room, and wrong-revision fragments without throwing', () => {
    const document = plannerTestDocument();
    const fragment = encodePlannerShareFragment(document);
    expect(decodePlannerShareFragment('#layout=v1.not!base64').status).toBe('invalid');
    expect(decodePlannerShareFragment('#layout=v2.abc')).toEqual({
      status: 'incompatible',
      reason: 'version'
    });
    expect(
      decodePlannerShareFragment(`${PLANNER_SHARE_PREFIX}${'a'.repeat(MAX_SHARE_FRAGMENT_CHARS)}`)
        .status
    ).toBe('too_large');
    expect(decodePlannerShareFragment(fragment, { room_id: 'other' })).toEqual({
      status: 'incompatible',
      reason: 'room'
    });
    expect(decodePlannerShareFragment(fragment, { scene_revision: 'other' })).toEqual({
      status: 'incompatible',
      reason: 'scene_revision'
    });
  });

  it('enforces both decompressed and final-url size limits', () => {
    const tooLarge = plannerTestDocument();
    for (let index = 0; index < 12; index += 1) {
      const clone = structuredClone(tooLarge.layout.instances[0]);
      clone.id = `extra_${index}`;
      clone.object_id = `extra_object_${index}`;
      clone.notes = 'x'.repeat(3_000);
      tooLarge.layout.instances.push(clone);
    }
    expect(() => encodePlannerShareFragment(SceneDocumentSchema.parse(tooLarge))).toThrowError(
      expect.objectContaining<Partial<PlannerShareError>>({ code: 'too_large' })
    );
    expect(JSON.stringify(tooLarge).length).toBeGreaterThan(MAX_SHARE_DOCUMENT_BYTES);

    const longUrl = plannerTestDocument();
    for (let index = 0; index < 7; index += 1) {
      const clone = structuredClone(longUrl.layout.instances[0]);
      clone.id = `random_${index}`;
      clone.object_id = `random_object_${index}`;
      clone.notes = pseudoRandomText(3_000, index + 1);
      longUrl.layout.instances.push(clone);
    }
    expect(JSON.stringify(longUrl).length).toBeLessThan(MAX_SHARE_DOCUMENT_BYTES);
    expect(() => encodePlannerShareFragment(SceneDocumentSchema.parse(longUrl))).toThrowError(
      expect.objectContaining<Partial<PlannerShareError>>({ code: 'too_large' })
    );
  });

  it('rejects an externally constructed payload that expands past the decompression limit', () => {
    const compressed = zlibSync(strToU8('x'.repeat(MAX_SHARE_DOCUMENT_BYTES + 1)));
    const fragment = `${PLANNER_SHARE_PREFIX}${base64Url(compressed)}`;

    expect(fragment.length).toBeLessThan(MAX_SHARE_FRAGMENT_CHARS);
    expect(decodePlannerShareFragment(fragment)).toEqual({
      status: 'too_large',
      message: 'shared plan expands beyond the 32 kb safety limit'
    });
  });

  it('removes only planner-owned fragments from absolute and relative URLs', () => {
    const fragment = encodePlannerShareFragment(plannerTestDocument());
    expect(withoutPlannerShareFragment(`/planner?room=double${fragment}`)).toBe(
      '/planner?room=double'
    );
    expect(withoutPlannerShareFragment(`https://example.test/planner?room=double${fragment}`)).toBe(
      'https://example.test/planner?room=double'
    );
    expect(withoutPlannerShareFragment('/planner#sources')).toBe('/planner#sources');
    expect(withoutPlannerShareFragment('/planner#layout=v2.abc')).toBe('/planner');
  });

  it('normalizes walk mode because pointer lock cannot be restored from a link', () => {
    const document = plannerTestDocument();
    document.view.mode = 'walk';
    const decoded = decodePlannerShareFragment(encodePlannerShareFragment(document));
    expect(decoded.status === 'ok' ? decoded.document.view.mode : decoded.status).toBe('3d');
  });
});

describe('legacy query and initial-state resolution', () => {
  it('reads old mode, dimensions, furniture visibility, and decor semantics', () => {
    const document = applyLegacyPlannerQuery(
      plannerTestDocument(),
      '?room=unit-3-test&mode=2d&dims=1&show=desk,chair&decor=0'
    );
    expect(document.view).toMatchObject({
      mode: '2d',
      dimensions_visible: true,
      staging_visible: false
    });
    expect(document.view.hidden_group_ids).toContain('decor');
    expect(visibleLegacyFurnitureGroups(document)).toEqual(
      expect.arrayContaining(['desk', 'chair'])
    );
    expect(visibleLegacyFurnitureGroups(document)).not.toContain('dresser');
  });

  it('uses shared, then local, then canonical state in that order', () => {
    const canonical = plannerTestDocument();
    const local = structuredClone(canonical);
    local.layout.instances[0].pose.position_m.x = 0.25;
    const shared = structuredClone(canonical);
    shared.layout.instances[0].pose.position_m.x = 0.75;
    const storage = memoryStorage();
    savePlannerDocument(storage, local);

    const sharedResolution = resolveInitialPlannerDocument({
      canonical,
      storage,
      fragment: encodePlannerShareFragment(shared)
    });
    expect(sharedResolution.source).toBe('shared');
    expect(sharedResolution.document.layout.instances[0].pose.position_m.x).toBe(0.75);

    const localResolution = resolveInitialPlannerDocument({ canonical, storage });
    expect(localResolution.source).toBe('local');
    expect(localResolution.document.layout.instances[0].pose.position_m.x).toBe(0.25);
    expect(resolveInitialPlannerDocument({ canonical })).toMatchObject({
      source: 'canonical'
    });
  });

  it('falls back nonfatally when a shared scene is corrupt', () => {
    const resolved = resolveInitialPlannerDocument({
      canonical: plannerTestDocument(),
      fragment: '#layout=v1.bad!'
    });
    expect(resolved).toMatchObject({ source: 'canonical', share_status: 'invalid' });
  });

  it('falls back nonfatally when a schema-valid share replaces a canonical instance id', () => {
    const canonical = plannerTestDocument();
    const crafted = structuredClone(canonical);
    crafted.layout.instances = crafted.layout.instances.filter(
      (instance) => instance.id !== 'closet_1'
    );
    crafted.layout.custom_blocks = [
      createCustomBlock('closet_1', {
        label: 'crafted block',
        dimensions_m: { width: 0.4, depth: 0.4, height: 0.4 }
      })
    ];
    expect(SceneDocumentSchema.safeParse(crafted).success).toBe(true);
    const fragment = encodePlannerShareFragment(crafted);

    expect(() =>
      resolveInitialPlannerDocument({ canonical, fragment })
    ).not.toThrow();
    expect(resolveInitialPlannerDocument({ canonical, fragment })).toMatchObject({
      document: canonical,
      source: 'canonical',
      share_status: 'incompatible'
    });
  });
});
