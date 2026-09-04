import { describe, expect, it } from 'vitest';
import {
  CUSTOM_BLOCK_LIMIT,
  PLANNER_HISTORY_LIMIT,
  SceneDocumentSchema,
  createCustomBlock,
  createCustomBlockFromPreset,
  createPlannerState,
  createSceneDocumentFromRoom,
  isPlannerLayoutDirty,
  nextCustomBlockId,
  plannerReducer,
  reconcileDocumentWithCanonical,
  type CanonicalPlannerRoom,
  type PlannerState
} from './plannerDocument';
import { plannerTestDocument } from './plannerTestFixtures';

function move(state: PlannerState, x: number): PlannerState {
  return plannerReducer(state, {
    type: 'move-instance',
    instance_id: 'chair_1',
    position_m: { x, y: 0.123, z: 0 }
  });
}

describe('planner document adapter and validation', () => {
  it('adapts the schema-backed canonical scene with clean imperial defaults', () => {
    const room = {
      room_id: 'unit-3-double',
      visualization_scene: {
        revision: 'double-r1',
        coordinate_system: {
          units: 'meters',
          origin: 'room_center_floor',
          handedness: 'right_handed',
          axes: { x: 'right', y: 'toward_window', z: 'up' }
        },
        cameras: {
          orbit: {
            position_m: { x: 4, y: -4, z: 3 },
            target_m: { x: 0, y: 0, z: 0.8 },
            fov_deg: 45
          },
          plan: {
            position_m: { x: 0, y: 0, z: 8 },
            target_m: { x: 0, y: 0, z: 0 },
            orthographic_size_m: 5
          }
        },
        instances: [
          {
            id: 'desk_1',
            object_id: 'desk_group',
            instance_index: 1,
            label: 'Desk 1',
            role: 'movable',
            removable: true,
            pose: {
              position_m: { x: 0, y: 0, z: 0 },
              rotation_deg: { x: 0, y: 0, z: 90 }
            },
            source_id: 'official',
            confidence: 'high',
            placement_basis: 'official_published_3d',
            notes: 'official representative pose'
          }
        ]
      }
    } as unknown as CanonicalPlannerRoom;

    const document = createSceneDocumentFromRoom(room);
    expect(document).toMatchObject({
      room_id: 'unit-3-double',
      scene_revision: 'double-r1',
      view: { units: 'imperial', staging_visible: false, snap_enabled: false }
    });
    expect(document.layout.instances[0].original_pose).toEqual(
      document.layout.instances[0].pose
    );
    expect(document.layout.instances[0].original_pose).not.toBe(
      document.layout.instances[0].pose
    );
  });

  it('rejects duplicate object ids and invalid removal inventory', () => {
    const document = plannerTestDocument();
    const duplicate = structuredClone(document);
    duplicate.layout.instances[1].id = duplicate.layout.instances[0].id;
    expect(SceneDocumentSchema.safeParse(duplicate).success).toBe(false);

    const invalidInventory = structuredClone(document);
    invalidInventory.layout.removed_instance_ids = ['closet_1'];
    expect(SceneDocumentSchema.safeParse(invalidInventory).success).toBe(false);
  });
});

describe('planner reducer', () => {
  it('moves freely, then snaps committed poses to 5 cm when enabled', () => {
    let state = createPlannerState(plannerTestDocument());
    state = move(state, 0.123);
    expect(state.document.layout.instances[0].pose.position_m).toEqual({
      x: 0.123,
      y: 0.123,
      z: 0
    });

    state = plannerReducer(state, { type: 'set-snap-enabled', enabled: true });
    state = move(state, 0.126);
    expect(state.document.layout.instances[0].pose.position_m).toEqual({
      x: 0.15,
      y: 0.1,
      z: 0
    });
  });

  it('rotates movable furniture in 90 degree steps but never moves built-ins', () => {
    let state = createPlannerState(plannerTestDocument());
    state = plannerReducer(state, { type: 'rotate-instance', instance_id: 'chair_1' });
    expect(state.document.layout.instances[0].pose.rotation_deg.z).toBe(90);
    state = plannerReducer(state, {
      type: 'rotate-instance',
      instance_id: 'chair_1',
      direction: -1
    });
    expect(state.document.layout.instances[0].pose.rotation_deg.z).toBe(0);

    const unchanged = plannerReducer(state, {
      type: 'move-instance',
      instance_id: 'closet_1',
      position_m: { x: 0, y: 0, z: 0 }
    });
    expect(unchanged).toBe(state);
  });

  it('supports undo, redo, and clears redo after a new command', () => {
    let state = move(createPlannerState(plannerTestDocument()), 0);
    state = move(state, 0.5);
    expect(state.document.layout.instances[0].pose.position_m.x).toBe(0.5);

    state = plannerReducer(state, { type: 'undo' });
    expect(state.document.layout.instances[0].pose.position_m.x).toBe(0);
    state = plannerReducer(state, { type: 'redo' });
    expect(state.document.layout.instances[0].pose.position_m.x).toBe(0.5);
    state = plannerReducer(state, { type: 'undo' });
    state = move(state, 1);
    expect(state.future).toHaveLength(0);
  });

  it('caps layout history at 100 commands and excludes view preferences', () => {
    let state = createPlannerState(plannerTestDocument());
    for (let index = 0; index < PLANNER_HISTORY_LIMIT + 8; index += 1) {
      state = move(state, index / 10);
    }
    expect(state.past).toHaveLength(PLANNER_HISTORY_LIMIT);

    const past = state.past;
    state = plannerReducer(state, { type: 'set-units', units: 'metric' });
    state = plannerReducer(state, { type: 'set-mode', mode: '2d' });
    expect(state.past).toBe(past);
    expect(state.document.view).toMatchObject({ units: 'metric', mode: '2d' });
  });

  it('removes and restores supplied furniture but rejects built-in removal', () => {
    let state = createPlannerState(plannerTestDocument());
    state = plannerReducer(state, { type: 'remove-instance', instance_id: 'chair_1' });
    expect(state.document.layout.removed_instance_ids).toEqual(['chair_1']);
    state = plannerReducer(state, { type: 'remove-instance', instance_id: 'closet_1' });
    expect(state.document.layout.removed_instance_ids).toEqual(['chair_1']);
    state = plannerReducer(state, { type: 'restore-instance', instance_id: 'chair_1' });
    expect(state.document.layout.removed_instance_ids).toEqual([]);
  });

  it('creates lowercase translucent blocks and enforces the 20 item limit', () => {
    let state = createPlannerState(plannerTestDocument());
    expect(nextCustomBlockId(state.document)).toBe('custom_1');
    for (let index = 0; index < CUSTOM_BLOCK_LIMIT + 2; index += 1) {
      const block = createCustomBlock(`custom_${index + 1}`, {
        label: `My Item ${index + 1}`,
        dimensions_m: { width: 0.5, depth: 0.4, height: 0.3 }
      });
      state = plannerReducer(state, { type: 'add-custom-block', block });
    }
    expect(state.document.layout.custom_blocks).toHaveLength(CUSTOM_BLOCK_LIMIT);
    expect(state.document.layout.custom_blocks[0]).toMatchObject({
      label: 'my item 1',
      material: 'translucent_neutral'
    });
    expect(createCustomBlockFromPreset('preset_1', 'mini-fridge')).toMatchObject({
      label: 'mini fridge',
      dimensions_m: { width: 0.48, depth: 0.52, height: 0.84 }
    });
  });

  it('moves, snaps, rotates, and removes custom blocks through layout history', () => {
    let state = createPlannerState(plannerTestDocument());
    state = plannerReducer(state, {
      type: 'add-custom-block',
      block: createCustomBlockFromPreset('custom_1', 'table')
    });
    state = plannerReducer(state, { type: 'set-snap-enabled', enabled: true });
    state = plannerReducer(state, {
      type: 'move-custom-block',
      block_id: 'custom_1',
      position_m: { x: 0.126, y: -0.126, z: 0 }
    });
    state = plannerReducer(state, {
      type: 'rotate-custom-block',
      block_id: 'custom_1',
      direction: -1
    });
    expect(state.document.layout.custom_blocks[0].pose).toMatchObject({
      position_m: { x: 0.15, y: -0.15, z: 0 },
      rotation_deg: { z: 270 }
    });
    state = plannerReducer(state, { type: 'remove-custom-block', block_id: 'custom_1' });
    expect(state.document.layout.custom_blocks).toEqual([]);
    state = plannerReducer(state, { type: 'undo' });
    expect(state.document.layout.custom_blocks).toHaveLength(1);
  });

  it('resets every supplied pose, inventory item, and custom block in one undoable command', () => {
    let state = createPlannerState(plannerTestDocument());
    state = move(state, 0.5);
    state = plannerReducer(state, { type: 'remove-instance', instance_id: 'desk_1' });
    state = plannerReducer(state, {
      type: 'add-custom-block',
      block: createCustomBlockFromPreset('custom_1', 'storage-bin')
    });
    state = plannerReducer(state, { type: 'reset-layout' });
    expect(state.document.layout.instances[0].pose).toEqual(
      state.document.layout.instances[0].original_pose
    );
    expect(state.document.layout.removed_instance_ids).toEqual([]);
    expect(state.document.layout.custom_blocks).toEqual([]);

    state = plannerReducer(state, { type: 'undo' });
    expect(state.document.layout.removed_instance_ids).toEqual(['desk_1']);
    expect(state.document.layout.custom_blocks).toHaveLength(1);
  });
});

describe('canonical reconciliation', () => {
  it('accepts editable state but restores canonical roles, provenance, and built-ins', () => {
    const canonical = plannerTestDocument();
    const candidate = structuredClone(canonical);
    candidate.layout.instances[0].pose.position_m.x = 0.4;
    candidate.layout.instances[0].role = 'built_in';
    candidate.layout.instances[0].notes = 'forged';
    candidate.layout.instances[2].pose.position_m.x = -99;
    candidate.layout.removed_instance_ids = ['chair_1'];

    const reconciled = reconcileDocumentWithCanonical(canonical, candidate);
    expect(reconciled?.layout.instances[0]).toMatchObject({
      role: 'movable',
      notes: 'representative placement',
      pose: { position_m: { x: 0.4 } }
    });
    expect(reconciled?.layout.instances[2].pose).toEqual(
      canonical.layout.instances[2].pose
    );
    expect(reconciled?.layout.removed_instance_ids).toEqual(['chair_1']);
  });

  it('rejects a different room or scene revision', () => {
    const canonical = plannerTestDocument();
    expect(
      reconcileDocumentWithCanonical(canonical, { ...canonical, room_id: 'another-room' })
    ).toBeNull();
    expect(
      reconcileDocumentWithCanonical(canonical, { ...canonical, scene_revision: 'new' })
    ).toBeNull();
  });

  it('rejects a schema-valid candidate that replaces a canonical id with a custom block', () => {
    const canonical = plannerTestDocument();
    const candidate = structuredClone(canonical);
    candidate.layout.instances = candidate.layout.instances.filter(
      (instance) => instance.id !== 'closet_1'
    );
    candidate.layout.custom_blocks = [
      createCustomBlock('closet_1', {
        label: 'crafted block',
        dimensions_m: { width: 0.4, depth: 0.4, height: 0.4 }
      })
    ];

    expect(SceneDocumentSchema.safeParse(candidate).success).toBe(true);
    expect(() => reconcileDocumentWithCanonical(canonical, candidate)).not.toThrow();
    expect(reconcileDocumentWithCanonical(canonical, candidate)).toBeNull();
  });
});

describe('layout honesty', () => {
  it('tracks actual canonical equivalence through undo, redo, remove, restore, and custom items', () => {
    let state = createPlannerState(plannerTestDocument());
    expect(isPlannerLayoutDirty(state.document)).toBe(false);

    state = move(state, 0.4);
    expect(isPlannerLayoutDirty(state.document)).toBe(true);
    state = plannerReducer(state, { type: 'undo' });
    expect(isPlannerLayoutDirty(state.document)).toBe(false);
    state = plannerReducer(state, { type: 'redo' });
    expect(isPlannerLayoutDirty(state.document)).toBe(true);
    state = plannerReducer(state, { type: 'reset-layout' });
    expect(isPlannerLayoutDirty(state.document)).toBe(false);

    state = plannerReducer(state, { type: 'remove-instance', instance_id: 'chair_1' });
    expect(isPlannerLayoutDirty(state.document)).toBe(true);
    state = plannerReducer(state, { type: 'restore-instance', instance_id: 'chair_1' });
    expect(isPlannerLayoutDirty(state.document)).toBe(false);

    state = plannerReducer(state, {
      type: 'add-custom-block',
      block: createCustomBlockFromPreset('custom_1', 'table')
    });
    expect(isPlannerLayoutDirty(state.document)).toBe(true);
    state = plannerReducer(state, { type: 'remove-custom-block', block_id: 'custom_1' });
    expect(isPlannerLayoutDirty(state.document)).toBe(false);
  });
});
