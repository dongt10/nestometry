import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  arrangementReducer,
  contactShadowKey,
  initialArrangementState,
  shouldShowDimensionBadges,
  type ArrangementFinishReason,
  type ArrangementState
} from './arrangementState';
import { collectArrangeInstances, groupForNodeName } from './furnitureGroups';

function reduce(
  state: ArrangementState,
  ...actions: Parameters<typeof arrangementReducer>[1][]
): ArrangementState {
  return actions.reduce(arrangementReducer, state);
}

describe('arrangement presentation state', () => {
  it('keeps wall bookshelves independent from movable dressers', () => {
    const root = new Object3D();
    const dresser = new Object3D();
    dresser.name = 'dresser_1_carcass';
    const bookshelf = new Object3D();
    bookshelf.name = 'bookshelf_1_board_1';
    root.add(dresser, bookshelf);

    expect(groupForNodeName(bookshelf.name)).toBe('bookshelf');
    expect(collectArrangeInstances(root).get('dresser_1')).toEqual([dresser]);
    expect([...collectArrangeInstances(root).keys()]).not.toContain('bookshelf_1');
  });

  it('does not dirty or revise a no-movement click', () => {
    const dragging = arrangementReducer(initialArrangementState, { type: 'drag-start' });
    expect(shouldShowDimensionBadges(true, '3d', dragging)).toBe(false);

    const released = arrangementReducer(dragging, {
      type: 'drag-end',
      moved: false,
      reason: 'pointer-up'
    });
    expect(released).toEqual(initialArrangementState);
    expect(shouldShowDimensionBadges(true, '3d', released)).toBe(true);
  });

  it('increments once for each completed moved drag and retains dirty state', () => {
    const first = reduce(
      initialArrangementState,
      { type: 'drag-start' },
      { type: 'drag-move' },
      { type: 'drag-move' },
      { type: 'drag-end', moved: true, reason: 'pointer-up' }
    );
    expect(first).toMatchObject({ isDragging: false, layoutDirty: true, arrangementRevision: 1 });

    const second = reduce(
      first,
      { type: 'drag-start' },
      { type: 'drag-move' },
      { type: 'drag-end', moved: true, reason: 'pointer-up' }
    );
    expect(second).toMatchObject({ isDragging: false, layoutDirty: true, arrangementRevision: 2 });
  });

  it.each<ArrangementFinishReason>(['pointer-cancel', 'cleanup'])(
    'commits a moved drag exactly once on %s',
    (reason) => {
      const finished = reduce(
        initialArrangementState,
        { type: 'drag-start' },
        { type: 'drag-move' },
        { type: 'drag-end', moved: true, reason }
      );
      expect(finished).toEqual({
        isDragging: false,
        layoutDirty: true,
        arrangementRevision: 1
      });
    }
  );

  it('reset clears dirty state and advances the presentation revision', () => {
    const dirty = {
      isDragging: false,
      layoutDirty: true,
      arrangementRevision: 2
    };
    expect(arrangementReducer(dirty, { type: 'reset' })).toEqual({
      isDragging: false,
      layoutDirty: false,
      arrangementRevision: 3
    });
  });

  it('room switching clears transient state and the room id rekeys shadows', () => {
    const oldRoom = {
      isDragging: true,
      layoutDirty: true,
      arrangementRevision: 2
    };
    const switched = arrangementReducer(oldRoom, { type: 'room-switch' });
    expect(switched).toEqual({
      isDragging: false,
      layoutDirty: false,
      arrangementRevision: 2
    });
    expect(contactShadowKey('double', ['desk', 'bed'], switched)).not.toBe(
      contactShadowKey('triple', ['desk', 'bed'], switched)
    );
  });

  it('finishes a mid-drag room switch without dirtying the next room', () => {
    const switching = reduce(
      initialArrangementState,
      { type: 'drag-start' },
      { type: 'drag-move' },
      { type: 'drag-end', moved: true, reason: 'cleanup' },
      { type: 'room-switch' }
    );
    expect(switching).toEqual({
      isDragging: false,
      layoutDirty: false,
      arrangementRevision: 1
    });
  });

  it('rekeys contact shadows on hidden groups and revisions', () => {
    const original = contactShadowKey('double', ['desk', 'bed'], initialArrangementState);
    const reordered = contactShadowKey('double', ['bed', 'desk'], initialArrangementState);
    const hidden = contactShadowKey('double', ['bed'], initialArrangementState);
    const revised = contactShadowKey('double', ['desk', 'bed'], {
      ...initialArrangementState,
      arrangementRevision: 1
    });

    expect(reordered).toBe(original);
    expect(hidden).not.toBe(original);
    expect(revised).not.toBe(original);
  });
});
