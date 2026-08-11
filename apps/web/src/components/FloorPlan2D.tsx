import type { Room, RoomManifestItem, RoomObject } from '../data/assetManifest';
import { numericMeters } from '../data/dimensions';

const PX_PER_M = 80;
const MARGIN_PX = 40;
const GAP_M = 0.15;
const WALL_INSET_M = 0.02;
const TANDEM_GAP_M = 0.04;
const CHAIR_CLEARANCE_M = 0.08;

// CSS class per object type for the representative sketch fills.
const OBJECT_CLASS: Record<string, string> = {
  loft_bed: 'plan-bed',
  bunk_bed: 'plan-bed',
  twin_xl_bed: 'plan-bed',
  desk: 'plan-desk',
  chair: 'plan-chair',
  dresser: 'plan-dresser',
  closet: 'plan-closet',
  microchill: 'plan-micro'
};

export type FloorPlanRect = {
  id: string;
  label: string;
  className: string;
  xM: number;
  yM: number;
  wM: number;
  hM: number;
};

type ShellAxis = keyof Room['room_shell'];

export type RoomGeometryAxis = {
  valueM: number;
  estimated: boolean;
  usesVisualizationShell: boolean;
};

/**
 * Resolve one geometry axis without turning a visualization estimate into a
 * public measurement. A usable room_shell value wins; otherwise the required,
 * explicitly estimated visualization_shell value drives rendering only.
 */
export function resolveRoomGeometryAxis(room: Room, axis: ShellAxis): RoomGeometryAxis {
  const measuredDimension = room.room_shell[axis];
  const measuredValue =
    measuredDimension.status === 'verified' && !measuredDimension.estimated
      ? numericMeters(measuredDimension)
      : null;
  if (measuredValue !== null) {
    return {
      valueM: measuredValue,
      estimated: measuredDimension.estimated || measuredDimension.status === 'estimated',
      usesVisualizationShell: false
    };
  }

  const visualizationDimension = room.visualization_shell[axis];
  const visualizationValue = numericMeters(visualizationDimension);
  if (visualizationValue === null) {
    // RoomSchema rejects this state; keep a defensive error for callers that
    // bypass manifest parsing rather than silently inventing geometry.
    throw new Error(`Room ${room.display_name} has no usable ${axis} geometry.`);
  }

  return {
    valueM: visualizationValue,
    estimated: true,
    usesVisualizationShell: true
  };
}

/**
 * Simple non-overlapping wall-hugging layout: walk objects left-to-right along
 * the top wall, wrapping to a new row when they run out of width. This is a
 * representative sketch, NOT a measured layout.
 */
function layoutObjects(objects: RoomObject[], roomWidthM: number, roomDepthM: number): FloorPlanRect[] {
  const placed: FloorPlanRect[] = [];
  let cursorX = GAP_M;
  let rowY = GAP_M;
  let rowHeight = 0;

  for (const obj of objects) {
    const wM = numericMeters(obj.dimensions_m?.x);
    const hM = numericMeters(obj.dimensions_m?.y);
    const className = OBJECT_CLASS[obj.type];
    // Skip objects without numeric x/y dims or without a drawable type.
    if (wM === null || hM === null || !className) continue;

    // Wrap to a new row if this object would overflow the room width.
    if (cursorX + wM > roomWidthM - GAP_M && cursorX > GAP_M) {
      cursorX = GAP_M;
      rowY += rowHeight + GAP_M;
      rowHeight = 0;
    }
    // Stop if we have run out of vertical room; keep the sketch inside the shell.
    if (rowY + hM > roomDepthM - GAP_M) break;

    placed.push({
      id: obj.id,
      label: obj.label,
      className,
      xM: cursorX,
      yM: rowY,
      wM,
      hM
    });

    cursorX += wM + GAP_M;
    rowHeight = Math.max(rowHeight, hM);
  }

  return placed;
}

function isCanonicalUnit3Double(room: Room): boolean {
  return room.hall === 'Unit 3' && room.room_type === 'standard_double';
}

function requiredSizedObject(room: Room, id: string, count: number): RoomObject {
  const object = room.objects.find((candidate) => candidate.id === id);
  if (!object) {
    throw new Error(`Canonical Unit 3 double plan requires ${id}.`);
  }
  if (object.count !== count) {
    throw new Error(`Canonical Unit 3 double plan requires ${count} ${id} objects, received ${object.count}.`);
  }
  if (
    numericMeters(object.dimensions_m?.x) === null ||
    numericMeters(object.dimensions_m?.y) === null
  ) {
    throw new Error(`Canonical Unit 3 double plan requires numeric x/y dimensions for ${id}.`);
  }
  return object;
}

function footprint(object: RoomObject): { xM: number; yM: number } {
  const xM = numericMeters(object.dimensions_m?.x);
  const yM = numericMeters(object.dimensions_m?.y);
  if (xM === null || yM === null) {
    throw new Error(`Floor-plan object ${object.id} has no numeric x/y footprint.`);
  }
  return { xM, yM };
}

/**
 * Count-aware reconstruction of Berkeley's published Unit 3 double example.
 * Coordinates are visualization estimates; only the relative layout is
 * official. The window wall is y=0 and the entry wall is y=roomDepthM.
 */
function layoutCanonicalUnit3Double(
  room: Room,
  roomWidthM: number,
  roomDepthM: number
): FloorPlanRect[] {
  const door = requiredSizedObject(room, 'door_1', 1);
  const window = requiredSizedObject(room, 'window_1', 1);
  const beds = requiredSizedObject(room, 'twin_xl_bed_group', 2);
  const desks = requiredSizedObject(room, 'desk_group', 2);
  const chairs = requiredSizedObject(room, 'chair_group', 2);
  const closets = requiredSizedObject(room, 'closet_group', 2);

  const doorSize = footprint(door);
  const windowSize = footprint(window);
  const bedSize = footprint(beds);
  const deskSize = footprint(desks);
  const chairSize = footprint(chairs);
  const closetSize = footprint(closets);

  // Beds run entry-to-window, so their schema x (length) becomes plan height.
  const bedWidthM = bedSize.yM;
  const bedDepthM = bedSize.xM;
  // Desks run tandem on the centerline, so their long schema x axis also
  // becomes plan height; each student approaches from an opposite side.
  const deskWidthM = deskSize.yM;
  const deskDepthM = deskSize.xM;
  const deskX = (roomWidthM - deskWidthM) / 2;
  const deskRunDepthM = deskDepthM * desks.count + TANDEM_GAP_M * (desks.count - 1);
  const deskStartY = (roomDepthM - deskRunDepthM) / 2;

  const placed: FloorPlanRect[] = [
    {
      id: window.id,
      label: 'Window',
      className: 'plan-window',
      xM: (roomWidthM - windowSize.xM) / 2,
      yM: 0,
      wM: windowSize.xM,
      hM: windowSize.yM
    },
    {
      id: door.id,
      label: 'Door',
      className: 'plan-door',
      xM: (roomWidthM - doorSize.xM) / 2,
      yM: roomDepthM - doorSize.yM,
      wM: doorSize.xM,
      hM: doorSize.yM
    }
  ];

  for (let index = 0; index < beds.count; index += 1) {
    placed.push({
      id: `${beds.id}-${index + 1}`,
      label: `Bed ${index + 1}`,
      className: 'plan-bed',
      xM: index === 0 ? WALL_INSET_M : roomWidthM - WALL_INSET_M - bedWidthM,
      yM: WALL_INSET_M,
      wM: bedWidthM,
      hM: bedDepthM
    });
  }

  for (let index = 0; index < closets.count; index += 1) {
    placed.push({
      id: `${closets.id}-${index + 1}`,
      label: `Closet ${index + 1}`,
      className: 'plan-closet',
      xM: index === 0 ? WALL_INSET_M : roomWidthM - WALL_INSET_M - closetSize.xM,
      yM: roomDepthM - WALL_INSET_M - closetSize.yM,
      wM: closetSize.xM,
      hM: closetSize.yM
    });
  }

  for (let index = 0; index < desks.count; index += 1) {
    const yM = deskStartY + index * (deskDepthM + TANDEM_GAP_M);
    placed.push({
      id: `${desks.id}-${index + 1}`,
      label: `Desk ${index + 1}`,
      className: 'plan-desk',
      xM: deskX,
      yM,
      wM: deskWidthM,
      hM: deskDepthM
    });
  }

  for (let index = 0; index < chairs.count; index += 1) {
    const deskY = deskStartY + index * (deskDepthM + TANDEM_GAP_M);
    placed.push({
      id: `${chairs.id}-${index + 1}`,
      label: `Chair ${index + 1}`,
      className: 'plan-chair',
      xM:
        index === 0
          ? deskX - CHAIR_CLEARANCE_M - chairSize.xM
          : deskX + deskWidthM + CHAIR_CLEARANCE_M,
      yM: deskY + (deskDepthM - chairSize.yM) / 2,
      wM: chairSize.xM,
      hM: chairSize.yM
    });
  }

  return placed;
}

export function buildFloorPlanLayout(
  room: Room,
  roomWidthM: number,
  roomDepthM: number
): FloorPlanRect[] {
  return isCanonicalUnit3Double(room)
    ? layoutCanonicalUnit3Double(room, roomWidthM, roomDepthM)
    : layoutObjects(room.objects, roomWidthM, roomDepthM);
}

export function FloorPlan2D({ room: item }: { room: RoomManifestItem }) {
  const { room } = item;

  const width = resolveRoomGeometryAxis(room, 'width');
  const depth = resolveRoomGeometryAxis(room, 'depth');
  const roomWidthM = width.valueM;
  const roomDepthM = depth.valueM;

  const canonicalDouble = isCanonicalUnit3Double(room);
  const placed = buildFloorPlanLayout(room, roomWidthM, roomDepthM);

  // Any selected shell estimate or non-verified object dimension means the
  // whole plan is unverified and must carry the estimated caption.
  const anyEstimated =
    width.estimated ||
    depth.estimated ||
    room.objects.some((obj: RoomObject) => {
      if (obj.dimension_status === 'estimated') return true;
      const dims = obj.dimensions_m;
      if (!dims) return false;
      return (['x', 'y', 'z'] as const).some(
        (axis) => dims[axis].estimated || dims[axis].status === 'estimated'
      );
    });

  const roomWpx = roomWidthM * PX_PER_M;
  const roomDpx = roomDepthM * PX_PER_M;
  const svgW = Number((roomWpx + MARGIN_PX * 2).toFixed(3));
  const svgH = Number((roomDpx + MARGIN_PX * 2).toFixed(3));

  return (
    <section className="schematic">
      <h3>Schematic (estimated)</h3>
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        role="img"
        aria-label={`Representative floor plan for ${item.displayName}`}
      >
        {/* Room shell */}
        <rect
          x={MARGIN_PX}
          y={MARGIN_PX}
          width={roomWpx}
          height={roomDpx}
          rx={4}
          className="plan-room"
        />
        {placed.map((rect) => (
          <g key={rect.id} data-plan-id={rect.id}>
            <rect
              x={MARGIN_PX + rect.xM * PX_PER_M}
              y={MARGIN_PX + rect.yM * PX_PER_M}
              width={rect.wM * PX_PER_M}
              height={rect.hM * PX_PER_M}
              className={rect.className}
            />
            <text
              x={MARGIN_PX + (rect.xM + rect.wM / 2) * PX_PER_M}
              y={MARGIN_PX + (rect.yM + rect.hM / 2) * PX_PER_M}
              textAnchor="middle"
              dominantBaseline="middle"
              className="plan-label"
            >
              {rect.label}
            </text>
          </g>
        ))}
      </svg>
      {canonicalDouble ? (
        <p className="schematic-caption">
          Canonical published-3D variant — estimated geometry, not a measured plan. Dresser and
          Microchill placement is uncommitted; bookshelves, mirrors, and closet lights are omitted
          where exact footprints are unknown.
        </p>
      ) : anyEstimated ? (
        <p className="schematic-caption">Estimated plan — dimensions unverified. Representative sketch only.</p>
      ) : (
        <p className="schematic-caption">Representative sketch — furniture placement is illustrative, not measured.</p>
      )}
    </section>
  );
}
