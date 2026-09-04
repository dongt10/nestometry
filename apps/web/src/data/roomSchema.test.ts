import { describe, expect, it } from 'vitest';
import doubleJson from '../../../../packages/berkeley-data/halls/unit-3-standard-double.json';
import tripleJson from '../../../../packages/berkeley-data/halls/unit-3-standard-triple.json';
import {
  blenderToScenePosition,
  RoomSchema,
  sceneToBlenderPosition,
  sceneToSvgPoint,
  sceneToThreePosition,
  sceneYawToSvgDegrees,
  sceneYawToThreeRadians,
  svgToScenePoint,
  svgRotationToSceneYaw,
  threeYRotationToSceneYaw,
  threeToScenePosition
} from '../../../../packages/room-schema/src';

type MutableRoomJson = {
  room_id?: string;
  visualization_shell?: {
    width: {
      value_m: number | null;
      uncertainty_m?: number;
      status: string;
      estimated: boolean;
      source_id: string;
      notes?: string;
    };
  };
  visualization_scene?: {
    instances: Array<Record<string, unknown>>;
    surfaces: Array<Record<string, unknown>>;
    clearance_zones: Array<Record<string, unknown>>;
  };
  sources: Array<Record<string, unknown>>;
  layout_constraints: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function cloneRoom(): MutableRoomJson {
  return structuredClone(doubleJson) as unknown as MutableRoomJson;
}

function visualizationWidth(room: MutableRoomJson) {
  if (!room.visualization_shell) throw new Error('visualization_shell fixture is missing');
  return room.visualization_shell.width;
}

function visualizationScene(room: MutableRoomJson) {
  if (!room.visualization_scene) throw new Error('visualization_scene fixture is missing');
  return room.visualization_scene;
}

describe('RoomSchema 0.3.0', () => {
  it.each([
    { name: 'double', roomJson: doubleJson, roomId: 'unit-3-standard-double' },
    { name: 'triple', roomJson: tripleJson, roomId: 'unit-3-standard-triple' }
  ])('accepts the current Unit 3 $name room', ({ roomJson, roomId }) => {
    const room = RoomSchema.parse(roomJson);

    expect(room.schema_version).toBe('0.3.0');
    expect(room.room_id).toBe(roomId);
    expect([
      room.visualization_shell.width.value_m,
      room.visualization_shell.depth.value_m,
      room.visualization_shell.height.value_m
    ]).toEqual([4.115, 3.505, 2.44]);
    expect(
      Object.values(room.visualization_shell).every(
        (axis) =>
          axis.status === 'estimated' &&
          axis.estimated === true &&
          axis.uncertainty_m === 0.3048 &&
          axis.source_id === 'unit3_interior_model_pack_2026_07' &&
          axis.confidence === 'medium' &&
          axis.notes.includes('not a verified Berkeley measurement')
      )
    ).toBe(true);
  });

  it.each([
    { name: 'double', roomJson: doubleJson, counts: { desk_group: 2, chair_group: 2 } },
    { name: 'triple', roomJson: tripleJson, counts: { desk_group: 3, chair_group: 3 } }
  ])('provides complete independent scene instances for the $name', ({ roomJson, counts }) => {
    const room = RoomSchema.parse(roomJson);
    const instancesByObject = new Map<string, typeof room.visualization_scene.instances>();
    for (const instance of room.visualization_scene.instances) {
      const instances = instancesByObject.get(instance.object_id) ?? [];
      instances.push(instance);
      instancesByObject.set(instance.object_id, instances);
    }

    expect(room.visualization_scene.coordinate_system).toEqual({
      units: 'meters',
      origin: 'room_center_floor',
      handedness: 'right_handed',
      axes: { x: 'right', y: 'toward_window', z: 'up' }
    });
    expect(room.visualization_scene.surfaces.map(({ id }) => id).sort()).toEqual([
      'ceiling',
      'floor',
      'wall_entry',
      'wall_left',
      'wall_right',
      'wall_window'
    ]);
    expect(instancesByObject.get('desk_group')).toHaveLength(counts.desk_group);
    expect(instancesByObject.get('chair_group')).toHaveLength(counts.chair_group);
    expect(room.visualization_scene.clearance_zones.some(({ type }) => type === 'door_swing')).toBe(
      true
    );
    expect(
      room.visualization_scene.clearance_zones.some(
        (zone) => zone.type === 'circulation' && zone.geometry.shape === 'rectangle' && zone.geometry.size_m.width === 0.61
      )
    ).toBe(true);
  });

  it('keeps public room-shell measurements unknown', () => {
    const room = RoomSchema.parse(doubleJson);

    expect(
      Object.values(room.room_shell).every(
        (axis) => axis.value_m === null && axis.status === 'unknown' && axis.estimated === false
      )
    ).toBe(true);
  });

  it('records the canonical published double separately from the official tour variation', () => {
    const room = RoomSchema.parse(doubleJson);
    const sources = new Map(room.sources.map((source) => [source.id, source]));
    const constraints = new Map(
      room.layout_constraints.map((constraint) => [constraint.id, constraint])
    );

    expect(sources.get('berkeley_housing_unit3')?.notes).toContain('Verified live 2026-08-10');
    expect(sources.get('berkeley_housing_unit3_double_published_3d')?.url).toBe(
      'https://housing.berkeley.edu/wp-content/uploads/double_top-250px.jpg'
    );
    expect(sources.get('berkeley_housing_unit3_double_tour_2020')?.notes).toContain(
      'two desks side-by-side at the window'
    );
    expect(sources.get('berkeley_housing_highrise_double_analog')?.confidence).toBe('medium');
    expect(sources.has('unit_room_reference_photo_2026_07')).toBe(false);

    expect(constraints.get('center-tandem-desks-face-sides')?.description).toContain(
      'tandem end-to-end run'
    );
    expect(constraints.has('tour-variant-window-desks')).toBe(false);
    expect(room.public_notes.join(' ')).toContain('different valid window-desk arrangement');
  });

  it('uses Berkeley published triple views for canonical placement provenance', () => {
    const room = RoomSchema.parse(tripleJson);
    const source = room.sources.find(
      ({ id }) => id === 'berkeley_housing_unit3_triple_published_3d'
    );
    const instances = new Map(
      room.visualization_scene.instances.map((instance) => [instance.id, instance])
    );

    expect(source?.url).toBe(
      'https://housing.berkeley.edu/wp-content/uploads/triple_top-225px.jpg'
    );
    expect(instances.get('loft_bed_1')).toMatchObject({
      source_id: 'berkeley_housing_unit3_triple_published_3d',
      placement_basis: 'official_published_3d'
    });
    expect(instances.get('closet_2')?.label).toBe('Entry open storage');
    expect(instances.get('dresser_2')?.notes).toContain('exact offset is unverified');
  });

  it('captures closet mirrors, lights, and side bookshelves without inventing footprints', () => {
    const room = RoomSchema.parse(doubleJson);
    const objects = new Map(room.objects.map((object) => [object.id, object]));

    expect(objects.get('mirror_group')).toMatchObject({
      count: 2,
      dimension_status: 'unknown',
      confidence: 'high'
    });
    expect(objects.get('closet_light_group')).toMatchObject({
      count: 2,
      dimension_status: 'unknown',
      confidence: 'high'
    });
    expect(objects.get('bookshelf_group')).toMatchObject({
      count: 2,
      dimension_status: 'unknown',
      confidence: 'high'
    });
    expect(room.visualization_scene.instances.some(({ object_id }) => object_id === 'mirror_group')).toBe(
      false
    );
    expect(objects.get('dresser_group')?.position_hint).toContain('low-confidence representative');
    expect(objects.get('microchill_1')?.position_hint).toContain(
      'low-confidence representative'
    );
  });

  const invalidCases: Array<[string, (room: MutableRoomJson) => void]> = [
    [
      'missing stable room id',
      (room) => {
        delete room.room_id;
      }
    ],
    [
      'missing visualization_shell',
      (room) => {
        delete room.visualization_shell;
      }
    ],
    [
      'null visualization value',
      (room) => {
        visualizationWidth(room).value_m = null;
      }
    ],
    [
      'missing visualization uncertainty',
      (room) => {
        delete visualizationWidth(room).uncertainty_m;
      }
    ],
    [
      'non-estimated visualization status',
      (room) => {
        visualizationWidth(room).status = 'verified';
      }
    ],
    [
      'false estimated flag',
      (room) => {
        visualizationWidth(room).estimated = false;
      }
    ],
    [
      'missing visualization note',
      (room) => {
        delete visualizationWidth(room).notes;
      }
    ],
    [
      'unknown shell source reference',
      (room) => {
        visualizationWidth(room).source_id = 'not-declared';
      }
    ],
    [
      'missing visualization scene',
      (room) => {
        delete room.visualization_scene;
      }
    ],
    [
      'duplicate scene instance id',
      (room) => {
        const scene = visualizationScene(room);
        scene.instances[1].id = scene.instances[0].id;
      }
    ],
    [
      'unknown scene object reference',
      (room) => {
        visualizationScene(room).instances[0].object_id = 'not_an_object';
      }
    ],
    [
      'unknown scene source reference',
      (room) => {
        visualizationScene(room).instances[0].source_id = 'not-declared';
      }
    ],
    [
      'unknown layout constraint target',
      (room) => {
        room.layout_constraints[0].subject = 'not_a_declared_target';
      }
    ],
    [
      'duplicate object instance index',
      (room) => {
        const desks = visualizationScene(room).instances.filter(
          (instance) => instance.object_id === 'desk_group'
        );
        desks[1].instance_index = desks[0].instance_index;
      }
    ],
    [
      'incomplete object instance count',
      (room) => {
        const scene = visualizationScene(room);
        const index = scene.instances.findIndex((instance) => instance.id === 'desk_2');
        scene.instances.splice(index, 1);
      }
    ],
    [
      'removable built-in',
      (room) => {
        visualizationScene(room).instances[0].removable = true;
      }
    ],
    [
      'duplicate scene surface',
      (room) => {
        const surfaces = visualizationScene(room).surfaces;
        surfaces[1].id = surfaces[0].id;
      }
    ],
    [
      'unknown clearance anchor',
      (room) => {
        visualizationScene(room).clearance_zones[0].anchor_instance_id = 'not_an_instance';
      }
    ],
    [
      'unknown clearance source',
      (room) => {
        visualizationScene(room).clearance_zones[0].source_id = 'not-declared';
      }
    ],
    [
      'duplicate source id',
      (room) => {
        room.sources.push(structuredClone(room.sources[0]));
      }
    ],
    [
      'non-public source URL',
      (room) => {
        room.sources[0].url = 'javascript:alert(1)';
      }
    ]
  ];

  it.each(invalidCases)('rejects %s', (_name, mutate) => {
    const room = cloneRoom();
    mutate(room);

    expect(RoomSchema.safeParse(room).success).toBe(false);
  });
});

describe('canonical scene coordinate adapters', () => {
  it('round-trips schema coordinates through Blender and Three.js within one millimeter', () => {
    const scenePoint = { x: -1.4895, y: 0.6485, z: 0.762 };
    const blenderRoundTrip = blenderToScenePosition(sceneToBlenderPosition(scenePoint));
    const roundTrip = threeToScenePosition(sceneToThreePosition(blenderRoundTrip));

    expect(Math.abs(roundTrip.x - scenePoint.x)).toBeLessThan(0.001);
    expect(Math.abs(roundTrip.y - scenePoint.y)).toBeLessThan(0.001);
    expect(Math.abs(roundTrip.z - scenePoint.z)).toBeLessThan(0.001);
  });

  it('round-trips schema coordinates through the SVG floor plan within one millimeter', () => {
    const projection = {
      roomWidthM: 4.115,
      roomDepthM: 3.505,
      pixelsPerMeter: 96,
      originPx: { x: 24, y: 24 }
    };
    const scenePoint = { x: 1.2585, y: -1.456 };
    const roundTrip = svgToScenePoint(sceneToSvgPoint(scenePoint, projection), projection);

    expect(Math.abs(roundTrip.x - scenePoint.x)).toBeLessThan(0.001);
    expect(Math.abs(roundTrip.y - scenePoint.y)).toBeLessThan(0.001);
  });

  it('round-trips 90-degree scene rotations through Three.js and SVG conventions', () => {
    expect(threeYRotationToSceneYaw(sceneYawToThreeRadians(90))).toBeCloseTo(90);
    expect(svgRotationToSceneYaw(sceneYawToSvgDegrees(90))).toBe(90);
  });
});
