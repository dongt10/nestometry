import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { RoomSchema } from '../../../../packages/room-schema/src/schema';
import doubleJson from '../../../../packages/berkeley-data/halls/unit-3-standard-double.json';
import { groupBadgeLabel, shellBadgeLabels } from '../data/dimensionBadges';
import { buildFloorPlanLayout, FloorPlan2D, resolveRoomGeometryAxis } from './FloorPlan2D';

afterEach(cleanup);

const room = RoomSchema.parse(doubleJson);
const double = {
  id: 'unit-3-standard-double',
  displayName: room.display_name,
  hall: room.hall,
  roomType: room.room_type,
  glbPath: '/models/berkeley/unit-3-standard-double.glb',
  room
};

describe('FloorPlan2D shell geometry', () => {
  it('draws with schema-backed visualization dimensions', () => {
    const width = resolveRoomGeometryAxis(double.room, 'width');
    const depth = resolveRoomGeometryAxis(double.room, 'depth');

    expect(width).toMatchObject({ valueM: 4.115, estimated: true, usesVisualizationShell: true });
    expect(depth).toMatchObject({ valueM: 3.505, estimated: true, usesVisualizationShell: true });

    render(createElement(FloorPlan2D, { room: double }));
    const plan = screen.getByRole('img', { name: `Representative floor plan for ${double.displayName}` });
    expect(plan.getAttribute('viewBox')).toBe('0 0 409.2 360.4');
    expect(
      screen.getByText(/Canonical published-3D variant — estimated geometry, not a measured plan/)
    ).toBeTruthy();
  });

  it('keeps exact shell labels unknown', () => {
    expect(shellBadgeLabels(double.room)).toEqual([
      { key: 'width', label: 'width: unknown' },
      { key: 'depth', label: 'depth: unknown' },
      { key: 'height', label: 'height: unknown' }
    ]);
    expect(groupBadgeLabel(double.room, 'bookshelf')).toEqual({
      text: 'unknown',
      approximate: true
    });
  });

  it('prefers a verified room-shell axis over its visualization estimate', () => {
    const roomJson = structuredClone(RoomSchema.parse(doubleJson));
    roomJson.room_shell.width = {
      value_m: 4.2,
      status: 'verified',
      estimated: false,
      source_id: 'berkeley_facilities_drawing_request',
      confidence: 'high',
      notes: 'Verified test fixture.'
    };
    const room = RoomSchema.parse(roomJson);

    expect(resolveRoomGeometryAxis(room, 'width')).toEqual({
      valueM: 4.2,
      estimated: false,
      usesVisualizationShell: false
    });
    expect(resolveRoomGeometryAxis(room, 'depth').valueM).toBe(3.505);
  });
});

describe('FloorPlan2D canonical Unit 3 double layout', () => {
  const layout = buildFloorPlanLayout(double.room, 4.115, 3.505);

  function rect(id: string) {
    const match = layout.find((candidate) => candidate.id === id);
    if (!match) throw new Error(`Missing floor-plan rectangle ${id}`);
    return match;
  }

  it('expands schema counts into the published door, window, bed, closet, desk, and chair plan', () => {
    expect(layout.filter(({ id }) => id.startsWith('twin_xl_bed_group-'))).toHaveLength(2);
    expect(layout.filter(({ id }) => id.startsWith('closet_group-'))).toHaveLength(2);
    expect(layout.filter(({ id }) => id.startsWith('desk_group-'))).toHaveLength(2);
    expect(layout.filter(({ id }) => id.startsWith('chair_group-'))).toHaveLength(2);
    expect(layout.filter(({ id }) => id === 'door_1')).toHaveLength(1);
    expect(layout.filter(({ id }) => id === 'window_1')).toHaveLength(1);

    expect(layout.some(({ id }) => id.startsWith('dresser_group'))).toBe(false);
    expect(layout.some(({ id }) => id.startsWith('microchill_1'))).toBe(false);
    expect(layout.some(({ id }) => id.startsWith('bookshelf_group'))).toBe(false);
    expect(layout.some(({ id }) => id.startsWith('mirror_group'))).toBe(false);
    expect(layout.some(({ id }) => id.startsWith('closet_light_group'))).toBe(false);
  });

  it('places the beds on opposite side walls with their heads at the window wall', () => {
    const leftBed = rect('twin_xl_bed_group-1');
    const rightBed = rect('twin_xl_bed_group-2');

    expect(leftBed.yM).toBe(0.02);
    expect(rightBed.yM).toBe(leftBed.yM);
    expect(leftBed.xM).toBe(0.02);
    expect(rightBed.xM + rightBed.wM).toBeCloseTo(4.115 - 0.02);
    expect(leftBed.wM).toBe(1.016);
    expect(leftBed.hM).toBe(2.083);
  });

  it('places tandem desks on one centerline with chairs on opposite access sides', () => {
    const windowDesk = rect('desk_group-1');
    const entryDesk = rect('desk_group-2');
    const leftChair = rect('chair_group-1');
    const rightChair = rect('chair_group-2');

    expect(windowDesk.xM).toBeCloseTo((4.115 - 0.61) / 2);
    expect(entryDesk.xM).toBe(windowDesk.xM);
    expect(entryDesk.yM).toBeCloseTo(windowDesk.yM + windowDesk.hM + 0.04);
    expect(leftChair.xM + leftChair.wM).toBeLessThan(windowDesk.xM);
    expect(rightChair.xM).toBeGreaterThan(entryDesk.xM + entryDesk.wM);
  });

  it('renders unique count-aware rectangles and discloses omitted placements', () => {
    render(createElement(FloorPlan2D, { room: double }));
    const plan = screen.getByRole('img', { name: `Representative floor plan for ${double.displayName}` });

    expect(plan.querySelectorAll('[data-plan-id^="desk_group-"]')).toHaveLength(2);
    expect(plan.querySelectorAll('[data-plan-id^="twin_xl_bed_group-"]')).toHaveLength(2);
    expect(screen.getByText(/Dresser and Microchill placement is uncommitted/)).toBeTruthy();
  });
});
