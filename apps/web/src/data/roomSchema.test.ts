import { describe, expect, it } from 'vitest';
import doubleJson from '../../../../packages/berkeley-data/halls/unit-3-standard-double.json';
import tripleJson from '../../../../packages/berkeley-data/halls/unit-3-standard-triple.json';
import { RoomSchema } from '../../../../packages/room-schema/src/schema';

type MutableRoomJson = {
  visualization_shell?: {
    width: {
      value_m: number | null;
      status: string;
      estimated: boolean;
      source_id: string;
      notes?: string;
    };
  };
  sources: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function cloneRoom(): MutableRoomJson {
  return structuredClone(doubleJson) as unknown as MutableRoomJson;
}

function visualizationWidth(room: MutableRoomJson) {
  if (!room.visualization_shell) throw new Error('visualization_shell fixture is missing');
  return room.visualization_shell.width;
}

describe('RoomSchema 0.2.0', () => {
  it.each([
    { name: 'double', roomJson: doubleJson, expectedShell: [4.115, 3.505, 2.44] },
    { name: 'triple', roomJson: tripleJson, expectedShell: [4.6, 3.95, 2.6] }
  ])('accepts the current Unit 3 $name room', ({ roomJson, expectedShell }) => {
    const room = RoomSchema.parse(roomJson);

    expect(room.schema_version).toBe('0.2.0');
    expect([
      room.visualization_shell.width.value_m,
      room.visualization_shell.depth.value_m,
      room.visualization_shell.height.value_m
    ]).toEqual(expectedShell);
    expect(
      Object.values(room.visualization_shell).every(
        (axis) =>
          axis.status === 'estimated' &&
          axis.estimated === true &&
          axis.source_id === 'unit3_interior_model_pack_2026_07' &&
          axis.confidence === 'medium' &&
          axis.notes.includes('not a verified Berkeley measurement')
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

  it('captures closet mirrors/lights and side bookshelves without inventing footprints', () => {
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
    expect(objects.get('dresser_group')?.position_hint).toContain('deliberately uncommitted');
    expect(objects.get('microchill_1')?.position_hint).toContain('deliberately uncommitted');
  });

  const invalidCases: Array<[string, (room: MutableRoomJson) => void]> = [
    [
      'missing visualization_shell',
      (room: MutableRoomJson) => {
        delete room.visualization_shell;
      }
    ],
    [
      'null visualization value',
      (room: MutableRoomJson) => {
        visualizationWidth(room).value_m = null;
      }
    ],
    [
      'non-estimated visualization status',
      (room: MutableRoomJson) => {
        visualizationWidth(room).status = 'verified';
      }
    ],
    [
      'false estimated flag',
      (room: MutableRoomJson) => {
        visualizationWidth(room).estimated = false;
      }
    ],
    [
      'missing visualization note',
      (room: MutableRoomJson) => {
        delete visualizationWidth(room).notes;
      }
    ],
    [
      'unknown source reference',
      (room: MutableRoomJson) => {
        visualizationWidth(room).source_id = 'not-declared';
      }
    ],
    [
      'duplicate source id',
      (room: MutableRoomJson) => {
        room.sources.push(structuredClone(room.sources[0]));
      }
    ],
    [
      'non-public source URL',
      (room: MutableRoomJson) => {
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
