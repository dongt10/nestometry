export type ArrangementFinishReason =
  | 'pointer-up'
  | 'pointer-cancel'
  | 'cleanup';

export type ArrangementState = {
  isDragging: boolean;
  layoutDirty: boolean;
  arrangementRevision: number;
};

export type ArrangementAction =
  | { type: 'drag-start' }
  | { type: 'drag-move' }
  | { type: 'drag-end'; moved: boolean; reason: ArrangementFinishReason }
  | { type: 'reset' }
  | { type: 'room-switch' };

export const initialArrangementState: ArrangementState = {
  isDragging: false,
  layoutDirty: false,
  arrangementRevision: 0
};

/**
 * Small state machine for the declarative side of imperative Three.js drags.
 * Pointer moves do not advance the revision; one drag-end action does so once.
 */
export function arrangementReducer(
  state: ArrangementState,
  action: ArrangementAction
): ArrangementState {
  switch (action.type) {
    case 'drag-start':
      return state.isDragging ? state : { ...state, isDragging: true };
    case 'drag-move':
      return state.layoutDirty ? state : { ...state, layoutDirty: true };
    case 'drag-end':
      return {
        isDragging: false,
        layoutDirty: state.layoutDirty || action.moved,
        arrangementRevision: state.arrangementRevision + (action.moved ? 1 : 0)
      };
    case 'reset':
      return {
        isDragging: false,
        layoutDirty: false,
        arrangementRevision: state.arrangementRevision + 1
      };
    case 'room-switch':
      // The room id is part of every presentation key, so switching rooms
      // clears transient state without inventing an extra arrangement commit.
      return {
        ...state,
        isDragging: false,
        layoutDirty: false
      };
  }
}

export function shouldShowDimensionBadges(
  dimsOn: boolean,
  mode: '3d' | '2d' | 'walk',
  state: ArrangementState
): boolean {
  return dimsOn && mode !== 'walk' && !state.isDragging;
}

export function contactShadowKey(
  roomId: string,
  hiddenGroups: Iterable<string>,
  state: ArrangementState
): string {
  return `cs-${roomId}-${[...hiddenGroups].sort().join('.')}-${state.arrangementRevision}`;
}
