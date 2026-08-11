import tripleJson from '@nestometry/berkeley-data/halls/unit-3-standard-triple.json';
import doubleJson from '@nestometry/berkeley-data/halls/unit-3-standard-double.json';
import { RoomSchema, type Room, type RoomObject, type Source } from '@nestometry/room-schema';

// Re-export schema types from a relative module so components can import them
// without depending on Next's package-path resolution in the type-check worker.
export type { Room, RoomObject, Source };

// Parse once at module scope so components always read validated schema data.
// The parsed `room` is the single source of truth: accuracy tier, variation
// warnings, sources, dimensions, and public notes are all derived from it in
// components rather than duplicated here.
const triple: Room = RoomSchema.parse(tripleJson);
const double: Room = RoomSchema.parse(doubleJson);

export type RoomManifestItem = {
  id: string;
  displayName: string;
  hall: string;
  roomType: string;
  glbPath: string;
  room: Room;
};

export const roomManifest: RoomManifestItem[] = [
  {
    id: 'unit-3-standard-triple',
    displayName: triple.display_name,
    hall: triple.hall,
    roomType: triple.room_type,
    glbPath: '/models/berkeley/unit-3-standard-triple.glb',
    room: triple
  },
  {
    id: 'unit-3-standard-double',
    displayName: double.display_name,
    hall: double.hall,
    roomType: double.room_type,
    glbPath: '/models/berkeley/unit-3-standard-double.glb',
    room: double
  }
];

/**
 * How many students each bed object sleeps. Derived from bed type, not from a
 * per-room constant: a bunk sleeps two (stacked bunks), a loft or twin XL sleeps
 * one each. So a triple's loft_bed + bunk_bed => 1 + 2 = 3, and a double's two
 * twin_xl_bed objects => 2.
 */
const SLEEPERS_PER_BED: Record<string, number> = {
  loft_bed: 1,
  twin_xl_bed: 1,
  bunk_bed: 2
};

/**
 * Derive an honest occupancy summary from schema objects. Bed count is read from
 * the room's objects, never hardcoded per room. The "dimensions unverified"
 * phrase is fixed: room_shell width is `unknown` for every current room, so we
 * never imply a measured footprint.
 */
export function roomSummary(room: Room): string {
  let sleepers = 0;
  for (const obj of room.objects) {
    const per = SLEEPERS_PER_BED[obj.type];
    if (per) {
      sleepers += per * (obj.count ?? 1);
    }
  }
  const sleeps = sleepers > 0 ? `Sleeps ${sleepers}` : 'Occupancy varies';
  return `${sleeps} · dimensions unverified`;
}

/** Unique hall names, in manifest order, for the hall selector. */
export function uniqueHalls(): string[] {
  const seen = new Set<string>();
  const halls: string[] = [];
  for (const item of roomManifest) {
    if (!seen.has(item.hall)) {
      seen.add(item.hall);
      halls.push(item.hall);
    }
  }
  return halls;
}
