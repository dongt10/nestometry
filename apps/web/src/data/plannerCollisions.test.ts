import { describe, expect, it } from 'vitest';
import doubleColliderJson from '../../../../assets/colliders/berkeley/unit-3-standard-double.colliders.json';
import tripleColliderJson from '../../../../assets/colliders/berkeley/unit-3-standard-triple.colliders.json';
import doubleRoomJson from '../../../../packages/berkeley-data/halls/unit-3-standard-double.json';
import tripleRoomJson from '../../../../packages/berkeley-data/halls/unit-3-standard-triple.json';
import { RoomSchema } from '@nestometry/room-schema';
import {
  SOLID_CONFLICT_TOLERANCE_M,
  SceneColliderManifestSchema,
  evaluatePlannerConflicts,
  hasErrorSeverityConflict,
  loadSceneColliderManifest,
  plannerInstanceFootprint,
  plannerClearanceZonesFromRoom,
  plannerShellFromRoom,
  type PlannerClearanceZone
} from './plannerCollisions';
import { createCustomBlock, createSceneDocumentFromRoom } from './plannerDocument';
import { plannerTestDocument, plannerTestManifest } from './plannerTestFixtures';

const shell = { width_m: 4, depth_m: 3.5, height_m: 2.44 };

function rectangleZone(): PlannerClearanceZone {
  return {
    id: 'entry-swing',
    type: 'door_swing',
    anchor_instance_id: 'closet_1',
    geometry: {
      shape: 'rectangle',
      center_m: { x: -0.75, y: 0 },
      size_m: { width: 0.8, depth: 0.8 },
      rotation_deg: 0
    },
    source_id: 'official_source',
    confidence: 'medium',
    estimated: true,
    notes: 'estimated swing'
  };
}

describe('planner solid and room-boundary conflicts', () => {
  it('derives an offset, rotated 2d footprint from local component colliders', () => {
    const instance = plannerTestDocument().layout.instances[0];
    instance.pose.position_m = { x: 1, y: 2, z: 0 };
    instance.pose.rotation_deg.z = 90;
    const footprint = plannerInstanceFootprint(instance, [
      {
        id: 'offset-box',
        center_m: { x: 0.5, y: 0, z: 0.5 },
        size_m: { width: 1, depth: 0.4, height: 1 },
        rotation_deg: 90
      }
    ]);
    expect(footprint).toMatchObject({
      center_m: { x: 1, y: 2.5 },
      rotation_deg: 90
    });
    expect(footprint?.size_m.width).toBeCloseTo(0.4, 6);
    expect(footprint?.size_m.depth).toBeCloseTo(1, 6);
  });

  it('validates the versioned local collider manifest contract', () => {
    expect(SceneColliderManifestSchema.safeParse(plannerTestManifest()).success).toBe(true);
    const duplicate = plannerTestManifest();
    duplicate.instances.push(structuredClone(duplicate.instances[0]));
    expect(SceneColliderManifestSchema.safeParse(duplicate).success).toBe(false);
  });

  it('loads and validates a collider manifest response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(plannerTestManifest()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    try {
      await expect(loadSceneColliderManifest('/models/test.colliders.json')).resolves.toEqual(
        plannerTestManifest()
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ['double', doubleRoomJson, doubleColliderJson],
    ['triple', tripleRoomJson, tripleColliderJson]
  ])('accepts the generated Unit 3 %s manifest and canonical layout', (_name, roomJson, manifestJson) => {
    const room = RoomSchema.parse(roomJson);
    const manifest = SceneColliderManifestSchema.parse(manifestJson);
    const conflicts = evaluatePlannerConflicts({
      document: createSceneDocumentFromRoom(room),
      shell: plannerShellFromRoom(room),
      collider_manifest: manifest,
      clearance_zones: plannerClearanceZonesFromRoom(room)
    });
    expect(conflicts).toEqual([]);
  });

  it('reports penetration over 2 mm and allows touching or sub-tolerance overlap', () => {
    const document = plannerTestDocument();
    document.layout.instances[0].pose.position_m.x = 0;
    document.layout.instances[1].pose.position_m.x = 0.747;
    const conflicts = evaluatePlannerConflicts({
      document,
      shell,
      collider_manifest: plannerTestManifest(),
      clearance_zones: []
    });
    const overlap = conflicts.find((conflict) => conflict.kind === 'solid_overlap');
    expect(overlap).toMatchObject({
      severity: 'error',
      instance_ids: ['chair_1', 'desk_1']
    });
    expect(overlap?.penetration_m).toBeCloseTo(0.003, 6);
    expect(hasErrorSeverityConflict(conflicts)).toBe(true);

    document.layout.instances[1].pose.position_m.x = 0.749;
    expect(
      evaluatePlannerConflicts({
        document,
        shell,
        collider_manifest: plannerTestManifest(),
        clearance_zones: []
      }).filter((conflict) => conflict.kind === 'solid_overlap')
    ).toEqual([]);
    expect(SOLID_CONFLICT_TOLERANCE_M).toBe(0.002);
  });

  it('uses 3d bounds so vertically separated boxes do not conflict', () => {
    const document = plannerTestDocument();
    document.layout.instances[0].pose.position_m = { x: 0, y: 0, z: 1.01 };
    document.layout.instances[1].pose.position_m = { x: 0, y: 0, z: 0 };
    expect(
      evaluatePlannerConflicts({
        document,
        shell: { ...shell, height_m: 4 },
        collider_manifest: plannerTestManifest(),
        clearance_zones: []
      }).filter((conflict) => conflict.kind === 'solid_overlap')
    ).toEqual([]);
  });

  it('keeps attached fixtures in solid collision checks', () => {
    const document = plannerTestDocument();
    const fixture = document.layout.instances.find((instance) => instance.id === 'closet_1')!;
    fixture.role = 'attached';
    fixture.pose.position_m.x = document.layout.instances.find((instance) => instance.id === 'desk_1')!.pose.position_m.x;

    const overlaps = evaluatePlannerConflicts({
      document,
      shell,
      collider_manifest: plannerTestManifest(),
      clearance_zones: []
    }).filter((conflict) => conflict.kind === 'solid_overlap');

    expect(overlaps.some((conflict) => conflict.instance_ids.includes('closet_1'))).toBe(true);
  });

  it.each(['door_1', 'window_1'])('keeps the installed %s in solid collision checks', (openingId) => {
    const document = plannerTestDocument();
    const opening = structuredClone(document.layout.instances[2]);
    opening.id = openingId;
    opening.object_id = openingId.replace(/_1$/u, '');
    opening.label = openingId.replaceAll('_', ' ');
    opening.role = 'built_in';
    opening.removable = false;
    opening.pose.position_m.x = 0;
    opening.original_pose = structuredClone(opening.pose);
    document.layout.instances.push(opening);
    document.layout.instances[1].pose.position_m.x = 0;

    const manifest = plannerTestManifest();
    manifest.instances.push({
      instance_id: openingId,
      colliders: [{
        id: `${openingId}_box`,
        center_m: { x: 0, y: 0, z: 1 },
        size_m: { width: 0.8, depth: 0.12, height: 2 }
      }]
    });

    const overlaps = evaluatePlannerConflicts({
      document,
      shell,
      collider_manifest: manifest,
      clearance_zones: []
    }).filter((conflict) => conflict.kind === 'solid_overlap');

    expect(overlaps).toContainEqual(expect.objectContaining({
      severity: 'error',
      instance_ids: ['desk_1', openingId].sort()
    }));
  });

  it('reports horizontal and vertical room crossing once per instance', () => {
    const document = plannerTestDocument();
    document.layout.instances[0].pose.position_m.x = 1.8;
    document.layout.instances[1].pose.position_m.z = 2;
    const crossings = evaluatePlannerConflicts({
      document,
      shell,
      collider_manifest: plannerTestManifest(),
      clearance_zones: []
    }).filter((conflict) => conflict.kind === 'wall_crossing');
    expect(crossings.map((conflict) => conflict.instance_ids[0])).toEqual([
      'chair_1',
      'desk_1'
    ]);
  });

  it('excludes inventory furniture but includes translucent custom blocks', () => {
    const document = plannerTestDocument();
    document.layout.instances[0].pose.position_m.x = 0;
    document.layout.instances[1].pose.position_m.x = 0;
    document.layout.removed_instance_ids = ['chair_1'];
    expect(
      evaluatePlannerConflicts({
        document,
        shell,
        collider_manifest: plannerTestManifest(),
        clearance_zones: []
      }).some((conflict) => conflict.instance_ids.includes('chair_1'))
    ).toBe(false);

    document.layout.custom_blocks.push(
      createCustomBlock('custom_1', {
        label: 'box',
        dimensions_m: { width: 0.5, depth: 0.5, height: 1 },
        position_m: { x: 0, y: 0, z: 0 }
      })
    );
    expect(
      evaluatePlannerConflicts({
        document,
        shell,
        collider_manifest: plannerTestManifest(),
        clearance_zones: []
      }).some(
        (conflict) =>
          conflict.kind === 'solid_overlap' && conflict.instance_ids.includes('custom_1')
      )
    ).toBe(true);
  });

  it('still evaluates geometry hidden by visual layers', () => {
    const document = plannerTestDocument();
    document.view.hidden_group_ids = ['chair'];
    document.layout.instances[0].pose.position_m.x = 0;
    document.layout.instances[1].pose.position_m.x = 0;
    expect(
      evaluatePlannerConflicts({
        document,
        shell,
        collider_manifest: plannerTestManifest(),
        clearance_zones: []
      }).some((conflict) => conflict.kind === 'solid_overlap')
    ).toBe(true);
  });

  it('rejects a collider manifest for another scene', () => {
    const manifest = plannerTestManifest();
    manifest.scene_revision = 'old';
    expect(() =>
      evaluatePlannerConflicts({
        document: plannerTestDocument(),
        shell,
        collider_manifest: manifest,
        clearance_zones: []
      })
    ).toThrow('collider manifest does not match');
  });
});

describe('planner clearance conflicts', () => {
  it('warns for rectangular door swings without treating the anchor as an obstruction', () => {
    const conflicts = evaluatePlannerConflicts({
      document: plannerTestDocument(),
      shell,
      collider_manifest: plannerTestManifest(),
      clearance_zones: [rectangleZone()]
    }).filter((conflict) => conflict.kind === 'door_swing');
    expect(conflicts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        instance_ids: ['chair_1'],
        zone_id: 'entry-swing'
      })
    ]);
    expect(conflicts.some((conflict) => conflict.instance_ids.includes('closet_1'))).toBe(false);
  });

  it('warns when furniture enters a sector circulation zone', () => {
    const zone: PlannerClearanceZone = {
      ...rectangleZone(),
      id: 'access-sector',
      type: 'circulation',
      anchor_instance_id: null,
      geometry: {
        shape: 'sector',
        center_m: { x: 0, y: 0 },
        radius_m: 1,
        start_angle_deg: 330,
        end_angle_deg: 30
      }
    };
    const warnings = evaluatePlannerConflicts({
      document: plannerTestDocument(),
      shell,
      collider_manifest: plannerTestManifest(),
      clearance_zones: [zone]
    }).filter((conflict) => conflict.kind === 'circulation');
    expect(warnings.some((conflict) => conflict.instance_ids.includes('desk_1'))).toBe(true);
  });

  it('translates and rotates a clearance zone with its movable anchor', () => {
    const document = plannerTestDocument();
    const chair = document.layout.instances[0];
    const desk = document.layout.instances[1];
    const zone: PlannerClearanceZone = {
      ...rectangleZone(),
      id: 'chair-access',
      type: 'circulation',
      anchor_instance_id: 'chair_1',
      geometry: {
        shape: 'rectangle',
        center_m: { x: chair.original_pose.position_m.x + 0.5, y: 0 },
        size_m: { width: 0.4, depth: 0.4 },
        rotation_deg: 0
      }
    };
    chair.pose.position_m = { x: 0.25, y: 0.25, z: 0 };
    chair.pose.rotation_deg.z = 90;
    desk.pose.position_m = { x: 0.25, y: 0.75, z: 0 };

    const warnings = evaluatePlannerConflicts({
      document,
      shell,
      collider_manifest: plannerTestManifest(),
      clearance_zones: [zone]
    }).filter((conflict) => conflict.zone_id === 'chair-access');
    expect(warnings.some((conflict) => conflict.instance_ids.includes('desk_1'))).toBe(true);
  });
});
