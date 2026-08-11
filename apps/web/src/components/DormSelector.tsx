'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RoomViewer3D, FurnitureToggles, type ViewMode, type ZoomFn } from './RoomViewer3D';
import { AccuracyPanel } from './AccuracyPanel';
import { DimensionList } from './DimensionList';
import { FloorPlan2D } from './FloorPlan2D';
import {
  roomManifest,
  roomSummary,
  uniqueHalls,
  type RoomManifestItem
} from '../data/assetManifest';
import {
  DECOR_GROUP,
  FURNITURE_GROUP_PREFIXES,
  type FurnitureGroup
} from '../data/furnitureGroups';
import {
  arrangementReducer,
  initialArrangementState
} from '../data/arrangementState';

function firstRoomForHall(hall: string): RoomManifestItem {
  return roomManifest.find((item) => item.hall === hall) ?? roomManifest[0];
}

export function DormSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const halls = useMemo(() => uniqueHalls(), []);

  // --- Initialize state from the URL on mount ---
  const initialRoom = useMemo(() => {
    const roomId = searchParams.get('room');
    return roomManifest.find((item) => item.id === roomId) ?? roomManifest[0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [hall, setHall] = useState<string>(() => {
    const fromUrl = searchParams.get('hall');
    if (fromUrl && halls.includes(fromUrl)) return fromUrl;
    return initialRoom.hall;
  });
  const [roomId, setRoomId] = useState<string>(initialRoom.id);
  // Walk is never restored from the URL: pointer lock needs a fresh user
  // gesture, so deep links only ever open in 3d or 2d.
  const [mode, setMode] = useState<ViewMode>(() => (searchParams.get('mode') === '2d' ? '2d' : '3d'));
  const [dimsOn, setDimsOn] = useState<boolean>(() => searchParams.get('dims') === '1');

  // First-person walk needs pointer lock and a real mouse, so the Walk toggle
  // only appears on fine-pointer devices. Detected in an effect so the server
  // and first client render agree (no button) and hydration stays clean.
  // Arrange shares the fine-pointer gate: hover cues plus press-drag would
  // fight one-finger orbiting on touch screens.
  const [walkSupported, setWalkSupported] = useState(false);
  const [arrangeSupported, setArrangeSupported] = useState(false);
  useEffect(() => {
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    setWalkSupported('requestPointerLock' in document.documentElement && finePointer);
    setArrangeSupported(finePointer);
  }, []);

  // Arrange (move-furniture) mode. Session-only by design: nothing here is
  // written to the URL — a custom layout is a transient what-if, and switching
  // rooms restores the official layout. layoutDirty mirrors "any furniture is
  // displaced" (reported by the viewer) and drives the Reset pill + note.
  const [arrangeOn, setArrangeOn] = useState(false);
  const [arrangementState, dispatchArrangement] = useReducer(
    arrangementReducer,
    initialArrangementState
  );
  const { layoutDirty } = arrangementState;
  // Bridge from the Reset-layout pill to the in-Canvas restore action.
  const resetLayoutRef = useRef<(() => void) | null>(null);

  // Groups present in the loaded GLB (discovered after load).
  const [availableGroups, setAvailableGroups] = useState<FurnitureGroup[]>([]);
  // Groups the user has hidden. Initialized from ?show= (which lists VISIBLE
  // FURNITURE groups). The Decor master is tracked separately via ?decor=0 so it
  // stays visible for legacy URLs written before decor existed: a `show` list
  // that predates decor never names it, and deriving hidden from `show` would
  // wrongly hide it. `decor` is therefore excluded from the show-derived set and
  // is hidden only when an explicit `?decor=0` token is present.
  const [hiddenGroups, setHiddenGroups] = useState<Set<FurnitureGroup>>(() => {
    const show = searchParams.get('show');
    const hidden = new Set<FurnitureGroup>();
    if (show !== null) {
      const visible = new Set(show.split(',').filter(Boolean));
      for (const g of FURNITURE_GROUP_PREFIXES) {
        if (g === DECOR_GROUP) continue; // decor is governed by ?decor=, not ?show=
        if (!visible.has(g)) hidden.add(g);
      }
    }
    // Decor defaults on; only an explicit ?decor=0 hides it.
    if (searchParams.get('decor') === '0') hidden.add(DECOR_GROUP);
    return hidden;
  });

  // Local UI state (not persisted to URL): furniture popover + collapsible
  // right panel on small screens.
  const [furnitureOpen, setFurnitureOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);
  // Bridge from the DOM zoom buttons to the active R3F camera.
  const zoomRef = useRef<ZoomFn | null>(null);

  const roomsForHall = useMemo(
    () => roomManifest.filter((item) => item.hall === hall),
    [hall]
  );

  const item = useMemo(
    () => roomManifest.find((entry) => entry.id === roomId) ?? roomsForHall[0] ?? roomManifest[0],
    [roomId, roomsForHall]
  );

  const summary = useMemo(() => roomSummary(item.room), [item.room]);

  // --- URL sync: reflect current state into ?hall=&room=&mode=&show=&dims= ---
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('hall', hall);
    params.set('room', roomId);
    // Walk is a transient pose (see the mode initializer): reloading a
    // mode=walk URL couldn't re-lock the pointer, so it round-trips as 3d.
    params.set('mode', mode === 'walk' ? '3d' : mode);

    // show = comma-separated VISIBLE FURNITURE groups; omit entirely when every
    // furniture group is visible. Decor is excluded here (see below) so it never
    // pollutes the legacy `show` contract.
    const furniturePrefixes = FURNITURE_GROUP_PREFIXES.filter((g) => g !== DECOR_GROUP);
    const visibleGroups = furniturePrefixes.filter((g) => !hiddenGroups.has(g));
    const allFurnitureVisible = visibleGroups.length === furniturePrefixes.length;
    if (!allFurnitureVisible) {
      params.set('show', visibleGroups.join(','));
    }
    // decor=0 only when the Decor master is off; omit when on (the default).
    if (hiddenGroups.has(DECOR_GROUP)) {
      params.set('decor', '0');
    }
    // dims=1 only when the overlay is on; omit when off.
    if (dimsOn) {
      params.set('dims', '1');
    }

    router.replace(`?${params.toString()}`, { scroll: false });
  }, [hall, roomId, mode, hiddenGroups, dimsOn, router]);

  const handleHallChange = (nextHall: string) => {
    setHall(nextHall);
    // Keep current room if it still belongs to the hall; else pick the first.
    const stillValid = roomManifest.some((r) => r.hall === nextHall && r.id === roomId);
    if (!stillValid) {
      dispatchArrangement({ type: 'room-switch' });
      setRoomId(firstRoomForHall(nextHall).id);
    }
  };

  const handleRoomChange = (nextRoomId: string) => {
    if (nextRoomId === roomId) return;
    dispatchArrangement({ type: 'room-switch' });
    setRoomId(nextRoomId);
  };

  const handleGroupsDiscovered = useCallback((groups: FurnitureGroup[]) => {
    // Preserve the schema prefix order for stable checkbox ordering.
    const ordered = FURNITURE_GROUP_PREFIXES.filter((g) => groups.includes(g));
    setAvailableGroups((prev) => {
      if (prev.length === ordered.length && prev.every((g, i) => g === ordered[i])) {
        return prev; // avoid needless re-render loops
      }
      return ordered;
    });
  }, []);

  const handleToggle = (group: FurnitureGroup, visible: boolean) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (visible) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const handleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen?.();
    }
  }, []);

  const handleZoom = useCallback((direction: 1 | -1) => {
    zoomRef.current?.(direction);
  }, []);

  // Leaving walk mode (ESC / lost pointer lock) always lands back on the orbit.
  const handleWalkExit = useCallback(() => setMode('3d'), []);

  // Close the furniture popover and switch Arrange off when leaving 3D: 2D has
  // no furniture UI, walk locks the pointer, and Arrange is orbit-only. Any
  // displaced layout (and its honesty note) persists until reset/room switch.
  useEffect(() => {
    if (mode !== '3d') {
      setFurnitureOpen(false);
      setArrangeOn(false);
    }
  }, [mode]);

  const handleResetLayout = useCallback(() => {
    resetLayoutRef.current?.();
  }, []);

  return (
    <main className="app-stage">
      {/* Full-bleed stage: the SAME R3F canvas, perspective (3D) or top-down
          orthographic (2D). Floating UI sits over it. */}
      <div className="stage" ref={stageRef}>
        <RoomViewer3D
          room={item}
          mode={mode}
          dimsOn={dimsOn}
          arrangeOn={arrangeOn}
          arrangementState={arrangementState}
          hiddenGroups={hiddenGroups}
          onGroupsDiscovered={handleGroupsDiscovered}
          onWalkExit={handleWalkExit}
          onArrangementAction={dispatchArrangement}
          resetLayoutRef={resetLayoutRef}
          zoomRef={zoomRef}
        />

        {/* Round zoom +/- buttons floating on the stage's right edge. Hidden
            while walking: the pointer is locked and WASD replaces zooming. */}
        {mode !== 'walk' ? (
          <div className="zoom-controls">
            <button type="button" className="zoom-btn" onClick={() => handleZoom(1)} aria-label="Zoom in">
              +
            </button>
            <button type="button" className="zoom-btn" onClick={() => handleZoom(-1)} aria-label="Zoom out">
              −
            </button>
          </div>
        ) : null}
      </div>

      {/* White full-width top bar over the stage. */}
      <div className="topbar">
        <div className="topbar-title">{item.displayName}</div>
        <div className="topbar-actions">
          <button
            type="button"
            className={`topbar-pill${dimsOn ? ' active' : ''}`}
            aria-pressed={dimsOn}
            onClick={() => setDimsOn((on) => !on)}
          >
            Dimensions
          </button>

          <div className="topbar-furniture">
            <button
              type="button"
              className={`topbar-pill${furnitureOpen ? ' active' : ''}`}
              aria-expanded={furnitureOpen}
              onClick={() => setFurnitureOpen((open) => !open)}
            >
              Furniture
            </button>
            {furnitureOpen ? (
              <div className="furniture-popover" role="dialog" aria-label="Furniture visibility">
                <FurnitureToggles
                  availableGroups={availableGroups}
                  hiddenGroups={hiddenGroups}
                  onToggle={handleToggle}
                />
              </div>
            ) : null}
          </div>

          {/* Arrange is 3D-orbit-only (hidden in 2D/walk) and fine-pointer-only,
              like Walk. The Reset pill appears once something actually moved. */}
          {arrangeSupported && mode === '3d' ? (
            <button
              type="button"
              className={`topbar-pill${arrangeOn ? ' active' : ''}`}
              aria-pressed={arrangeOn}
              onClick={() => setArrangeOn((on) => !on)}
            >
              Arrange
            </button>
          ) : null}
          {arrangeSupported && mode === '3d' && arrangeOn && layoutDirty ? (
            <button type="button" className="topbar-pill" onClick={handleResetLayout}>
              Reset layout
            </button>
          ) : null}

          <button
            type="button"
            className="topbar-pill topbar-icon"
            onClick={handleFullscreen}
            aria-label="Toggle fullscreen"
            title="Toggle fullscreen"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Stacked 3D / 2D segmented toggle at the far corner. When Walk is
              available (fine-pointer devices) the group gains a third segment
              and lays out as a row so it still fits the bar; touch devices keep
              the original stacked pair untouched. */}
          <div className={`topbar-segmented${walkSupported ? ' has-walk' : ''}`}>
            <button
              type="button"
              className={mode === '3d' ? 'active' : ''}
              aria-pressed={mode === '3d'}
              onClick={() => setMode('3d')}
            >
              3D
            </button>
            <button
              type="button"
              className={mode === '2d' ? 'active' : ''}
              aria-pressed={mode === '2d'}
              onClick={() => setMode('2d')}
            >
              2D
            </button>
            {walkSupported ? (
              <button
                type="button"
                className={mode === 'walk' ? 'active' : ''}
                aria-pressed={mode === 'walk'}
                onClick={() => setMode((current) => (current === 'walk' ? '3d' : 'walk'))}
              >
                Walk
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Floating top-left: project eyebrow + compact selectors + room info chip.
          Sits below the top bar (see .selector-card top offset). */}
      <div className="float-card selector-card">
        <p className="eyebrow">Nestometry · Source-backed dorm rooms in 2D and 3D</p>

        <label className="field-label" htmlFor="hall-select">
          Hall
        </label>
        <select
          id="hall-select"
          value={hall}
          onChange={(event) => handleHallChange(event.target.value)}
        >
          {halls.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>

        <label className="field-label" htmlFor="room-select">
          Room
        </label>
        <select
          id="room-select"
          value={item.id}
          onChange={(event) => handleRoomChange(event.target.value)}
        >
          {roomsForHall.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName}
            </option>
          ))}
        </select>

        <div className="room-info-chip" title="Honest occupancy summary">
          {summary}
        </div>
        <p className="independence-note">
          Independent student project; not affiliated with or endorsed by UC Berkeley or
          the Regents of the University of California.
        </p>
      </div>

      {/* Floating right: accuracy + dimensions + schematic. Collapsible on mobile. */}
      <aside className={`float-card info-panel${panelOpen ? '' : ' is-collapsed'}`}>
        <button
          type="button"
          className="info-panel-header"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        >
          <span>Accuracy &amp; details</span>
          <span className="info-panel-caret" aria-hidden="true">
            {panelOpen ? '▾' : '▸'}
          </span>
        </button>
        {panelOpen ? (
          <div className="info-panel-body">
            <AccuracyPanel room={item} />
            <DimensionList room={item} />
            <FloorPlan2D room={item} />
          </div>
        ) : null}
      </aside>
    </main>
  );
}
