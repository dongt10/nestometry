import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createSceneDocumentFromRoom } from '../data/plannerDocument';
import { roomManifest } from '../data/assetManifest';
import doubleColliderJson from '../../../../assets/colliders/berkeley/unit-3-standard-double.colliders.json';
import { SceneColliderManifestSchema } from '../data/plannerCollisions';
import { PlannerFloorPlan } from './PlannerFloorPlan';

afterEach(cleanup);

const room = roomManifest.find((candidate) => candidate.id === 'unit-3-standard-double')!;

function documentWithCustomBlock() {
  const document = createSceneDocumentFromRoom(room.room);
  document.layout.custom_blocks.push({
    id: 'custom-storage-bin',
    label: 'Storage Bin',
    dimensions_m: { width: 0.6, depth: 0.4, height: 0.35 },
    pose: {
      position_m: { x: 0, y: 0, z: 0 },
      rotation_deg: { x: 0, y: 0, z: 0 }
    },
    material: 'translucent_neutral'
  });
  return document;
}

function renderPlan(dispatch = vi.fn(), arrangeOn = true) {
  const result = render(
    <PlannerFloorPlan
      room={room}
      document={documentWithCustomBlock()}
      arrangeOn={arrangeOn}
      selectedId={null}
      warnings={[]}
      onSelect={vi.fn()}
      dispatch={dispatch}
    />
  );
  const svg = screen.getByRole('application', {
    name: `editable floor plan for ${room.displayName.toLocaleLowerCase()}`
  });
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 400,
    bottom: 400,
    left: 0,
    width: 400,
    height: 400,
    toJSON: () => ({})
  });
  return { ...result, svg, dispatch };
}

describe('PlannerFloorPlan interactions', () => {
  it('commits one custom-block move after a completed drag', () => {
    const { svg, dispatch } = renderPlan();
    const block = screen.getByRole('button', { name: 'select storage bin' });
    const rect = block.querySelector('rect');
    if (!rect) throw new Error('missing custom block rectangle');

    fireEvent.pointerDown(rect, { pointerId: 7, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(svg, { pointerId: 7, clientX: 240, clientY: 180 });
    expect(block).toHaveAttribute('transform');
    fireEvent.pointerUp(svg, { pointerId: 7, clientX: 240, clientY: 180 });

    expect(block).not.toHaveAttribute('transform');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'move-custom-block',
      block_id: 'custom-storage-bin',
      position_m: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), z: 0 })
    });
  });

  it('does not commit a click or a cancelled drag', () => {
    const { svg, dispatch } = renderPlan();
    const block = screen.getByRole('button', { name: 'select storage bin' });
    const rect = block.querySelector('rect');
    if (!rect) throw new Error('missing custom block rectangle');

    fireEvent.pointerDown(rect, { pointerId: 8, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(svg, { pointerId: 8, clientX: 200, clientY: 200 });
    expect(dispatch).not.toHaveBeenCalled();

    fireEvent.pointerDown(rect, { pointerId: 9, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(svg, { pointerId: 9, clientX: 220, clientY: 220 });
    fireEvent.pointerCancel(svg, { pointerId: 9, clientX: 220, clientY: 220 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(block).not.toHaveAttribute('transform');
  });

  it('derives estimated dimension labels and leaves main-stage ownership to the shell', () => {
    const { container } = renderPlan();

    expect(screen.getByText('~13 ft 6 in ± 1 ft · estimated')).toBeInTheDocument();
    expect(screen.getByText('~11 ft 6 in ± 1 ft · estimated')).toBeInTheDocument();
    expect(container.querySelector('#main-stage')).toBeNull();
  });

  it('hides estimated dimension labels when the dimensions layer is off', () => {
    render(
      <PlannerFloorPlan
        room={room}
        document={documentWithCustomBlock()}
        arrangeOn={false}
        selectedId={null}
        warnings={[]}
        dimensionsVisible={false}
        onSelect={vi.fn()}
        dispatch={vi.fn()}
      />
    );

    expect(screen.queryByText(/13 ft 6 in/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/11 ft 6 in/u)).not.toBeInTheDocument();
  });

  it('renders architectural wall openings and the estimated door swing outside arrange mode', () => {
    const { container } = renderPlan(vi.fn(), false);

    expect(container.querySelectorAll('.plan-wall').length).toBeGreaterThan(4);
    expect(container.querySelector('.plan-opening')).toBeInTheDocument();
    expect(container.querySelector('.plan-door-swing')).toBeInTheDocument();
    expect(container.querySelectorAll('.plan-clearance')).toHaveLength(1);
  });

  it('uses collider footprints and hides visual layers without removing their geometry state', () => {
    const { container } = render(
      <PlannerFloorPlan
        room={room}
        document={documentWithCustomBlock()}
        arrangeOn={false}
        selectedId={null}
        warnings={[]}
        colliderManifest={SceneColliderManifestSchema.parse(doubleColliderJson)}
        hiddenGroups={new Set(['desk'])}
        onSelect={vi.fn()}
        dispatch={vi.fn()}
      />
    );

    expect(container.querySelector('[data-plan-id="desk_1"]')).toBeNull();
    const shelf = container.querySelector('[data-plan-id="bookshelf_1"] rect');
    expect(shelf).toHaveAttribute('width', '0.2');
    expect(shelf).toHaveAttribute('height', '0.612');
  });
});
