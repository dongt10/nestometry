'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react';
import { useSearchParams } from 'next/navigation';
import { RoomViewer3D, type ViewMode, type ZoomFn } from './RoomViewer3D';
import { AppHeader, ArrangeToolbar, MobileDock, SelectionBar, type ActiveSheet } from './PlannerChrome';
import { DetailsPanel, LayersPanel, RoomBrowser } from './PlannerSheets';
import { AddItemDialog, SharePanel } from './PlannerDialogs';
import { PlannerFloorPlan } from './PlannerFloorPlan';
import { ResponsiveSheet } from './ResponsiveSheet';
import { humanizePlannerMessage, lowerText } from './presentation';
import { roomManifest, type RoomManifestItem } from '../data/assetManifest';
import {
  CUSTOM_BLOCK_LIMIT,
  createPlannerState,
  createSceneDocumentFromRoom,
  isLayoutAction,
  isPlannerLayoutDirty,
  nextCustomBlockId,
  plannerReducer,
  type CanonicalPlannerRoom,
  type CustomBlock,
  type PlannerAction,
  type PlannerPose,
  type PlannerState,
  type SceneDocument
} from '../data/plannerDocument';
import { savePlannerDocument } from '../data/plannerPersistence';
import {
  decodePlannerShareFragment,
  encodePlannerShareFragment,
  resolveInitialPlannerDocument,
  withoutPlannerShareFragment
} from '../data/plannerShare';
import {
  evaluatePlannerConflicts,
  loadSceneColliderManifest,
  plannerClearanceZonesFromRoom,
  plannerShellFromRoom,
  type SceneColliderManifest
} from '../data/plannerCollisions';
import { formatDimensionForUnit, type Dimension } from '../data/dimensions';
import {
  arrangementReducer,
  initialArrangementState
} from '../data/arrangementState';
import {
  DECOR_GROUP,
  FURNITURE_GROUP_PREFIXES,
  groupForNodeName,
  type FurnitureGroup
} from '../data/furnitureGroups';

const TIP_KEY_PREFIX = 'nestometry:tip:v1:';

function manifestRoom(roomId: string | null): RoomManifestItem {
  return roomManifest.find((room) => room.id === roomId) ?? roomManifest[0];
}

function canonicalState(room: RoomManifestItem): PlannerState {
  return createPlannerState(
    createSceneDocumentFromRoom(room.room as CanonicalPlannerRoom)
  );
}

function useFinePointerSupport() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
        'requestPointerLock' in document.documentElement
    );
  }, []);
  return supported;
}

export function DormSelector() {
  const searchParams = useSearchParams();
  const initialRoom = useMemo(() => manifestRoom(searchParams.get('room')), [searchParams]);
  const [roomId, setRoomId] = useState(initialRoom.id);
  const room = useMemo(() => manifestRoom(roomId), [roomId]);
  const [planner, dispatchPlanner] = useReducer(plannerReducer, room, canonicalState);
  const [arrangement, dispatchArrangement] = useReducer(arrangementReducer, initialArrangementState);
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);
  const expectedGroups = useMemo(() => {
    const groups = new Set<FurnitureGroup>([DECOR_GROUP]);
    for (const instance of room.room.visualization_scene.instances) {
      const group = groupForNodeName(instance.id);
      if (group) groups.add(group);
    }
    return FURNITURE_GROUP_PREFIXES.filter((group) => groups.has(group));
  }, [room]);
  const [discoveredGroups, setDiscoveredGroups] = useState<{
    roomId: string;
    groups: FurnitureGroup[];
  } | null>(null);
  const availableGroups = discoveredGroups?.roomId === room.id
    ? discoveredGroups.groups
    : expectedGroups;
  const [arrangeOn, setArrangeOn] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [sharedSource, setSharedSource] = useState(false);
  const sharedSourceRef = useRef(false);
  const [readyRoomId, setReadyRoomId] = useState<string | null>(null);
  const [cameraResetRevision, setCameraResetRevision] = useState(0);
  const [posePreview, setPosePreview] = useState<{
    kind: 'instance' | 'custom-block';
    id: string;
    pose: PlannerPose;
  } | null>(null);
  const [colliderManifest, setColliderManifest] = useState<SceneColliderManifest | null>(null);
  const [colliderMessage, setColliderMessage] = useState<string | null>(null);
  const [tip, setTip] = useState<'rooms' | 'arrange' | 'share' | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomFn | null>(null);
  const resetLayoutRef = useRef<(() => void) | null>(null);
  const walkSupported = useFinePointerSupport();

  const document = planner.document;
  const documentLayoutDirty = useMemo(
    () => isPlannerLayoutDirty(document),
    [document]
  );
  const mode = document.view.mode as ViewMode;
  const hiddenGroups = useMemo(() => {
    const hidden = new Set(document.view.hidden_group_ids as FurnitureGroup[]);
    if (!document.view.staging_visible) hidden.add(DECOR_GROUP);
    return hidden;
  }, [document.view.hidden_group_ids, document.view.staging_visible]);
  const removedInstanceIds = useMemo(
    () => new Set(document.layout.removed_instance_ids),
    [document.layout.removed_instance_ids]
  );

  const closeSheet = useCallback(() => setActiveSheet(null), []);

  const dismissTip = useCallback((name: 'rooms' | 'arrange' | 'share') => {
    try {
      localStorage.setItem(`${TIP_KEY_PREFIX}${name}`, '1');
    } catch {
      // The hints remain dismissible for this render when storage is blocked.
    }
    setTip((current) => (current === name ? null : current));
  }, []);

  const maybeShowTip = useCallback((name: 'rooms' | 'arrange' | 'share') => {
    try {
      if (localStorage.getItem(`${TIP_KEY_PREFIX}${name}`) !== '1') setTip(name);
    } catch {
      setTip(name);
    }
  }, []);

  useEffect(() => {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      // A strict browser privacy mode may deny access to the storage object.
    }
    if (!searchParams.has('room') && !window.location.hash) {
      let lastRoom: string | null = null;
      try {
        lastRoom = storage?.getItem('nestometry:last-room') ?? null;
      } catch {
        // Continue with the URL/default room when reads are blocked.
      }
      if (lastRoom && lastRoom !== room.id && roomManifest.some((candidate) => candidate.id === lastRoom)) {
        setRoomId(lastRoom);
        return;
      }
    }
    const shared = decodePlannerShareFragment(window.location.hash);
    if (shared.status === 'ok' && shared.document.room_id !== room.id) {
      const sharedRoom = roomManifest.find((candidate) => candidate.id === shared.document.room_id);
      if (sharedRoom) {
        setRoomId(sharedRoom.id);
        return;
      }
    }
    const canonical = createSceneDocumentFromRoom(room.room as CanonicalPlannerRoom);
    const resolved = resolveInitialPlannerDocument({
      canonical,
      fragment: window.location.hash,
      search: window.location.search,
      storage
    });
    dispatchPlanner({ type: 'load-document', document: resolved.document });
    sharedSourceRef.current = resolved.source === 'shared';
    setSharedSource(sharedSourceRef.current);
    setReadyRoomId(room.id);
    setShareMessage(
      resolved.share_status
        ? 'the shared plan was invalid or incompatible, so a saved or representative plan was opened.'
        : null
    );
    setSelectedId(null);
    setPosePreview(null);
    setArrangeOn(false);
    dispatchArrangement({ type: 'room-switch' });
    maybeShowTip('rooms');
  }, [room, maybeShowTip, searchParams]);

  useEffect(() => {
    let active = true;
    setColliderManifest(null);
    setColliderMessage(null);
    void loadSceneColliderManifest(room.colliderPath)
      .then((manifest) => {
        if (!active) return;
        if (manifest.room_id !== room.id || manifest.scene_revision !== room.room.visualization_scene.revision) {
          throw new Error('collision data does not match this room revision');
        }
        setColliderManifest(manifest);
      })
      .catch(() => {
        if (!active) return;
        setColliderMessage('collision guidance is unavailable for this room.');
      });
    return () => {
      active = false;
    };
  }, [room]);

  useEffect(() => {
    if (readyRoomId !== document.room_id || sharedSourceRef.current) return;
    try {
      savePlannerDocument(window.localStorage, document);
    } catch {
      // Editing remains usable when the browser blocks persistent storage.
    }
  }, [document, readyRoomId]);

  useEffect(() => {
    if (
      !arrangement.isDragging &&
      arrangement.layoutDirty !== documentLayoutDirty
    ) {
      dispatchArrangement({ type: 'sync-layout', dirty: documentLayoutDirty });
    }
  }, [arrangement.isDragging, arrangement.layoutDirty, documentLayoutDirty]);

  const forkSharedPlan = useCallback(() => {
    if (!sharedSource) return;
    window.history.replaceState(null, '', withoutPlannerShareFragment(window.location.href));
    sharedSourceRef.current = false;
    setSharedSource(false);
    setShareMessage('shared plan copied to this device for editing.');
  }, [sharedSource]);

  const send = useCallback((action: PlannerAction, presentation = true) => {
    if (action.type !== 'load-document') forkSharedPlan();
    const nextPlanner =
      presentation && isLayoutAction(action)
        ? plannerReducer(planner, action)
        : null;
    dispatchPlanner(action);
    if (nextPlanner && nextPlanner.document.layout !== planner.document.layout) {
      dispatchArrangement(
        action.type === 'reset-layout'
          ? { type: 'reset' }
          : {
              type: 'layout-command',
              dirty: isPlannerLayoutDirty(nextPlanner.document)
            }
      );
    }
  }, [forkSharedPlan, planner]);

  const handleRoomChange = useCallback((nextRoomId: string) => {
    if (nextRoomId === roomId) {
      closeSheet();
      return;
    }
    forkSharedPlan();
    const url = new URL(window.location.href);
    url.searchParams.set('room', nextRoomId);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    setRoomId(nextRoomId);
    try {
      localStorage.setItem('nestometry:last-room', nextRoomId);
    } catch {
      // Room selection still works when browser storage is unavailable.
    }
    closeSheet();
  }, [closeSheet, forkSharedPlan, roomId]);

  const handleModeChange = useCallback((nextMode: ViewMode) => {
    send({ type: 'set-mode', mode: nextMode }, false);
    if (nextMode === 'walk') setArrangeOn(false);
  }, [send]);

  const handleGroupsDiscovered = useCallback((groups: FurnitureGroup[]) => {
    const ordered = FURNITURE_GROUP_PREFIXES.filter(
      (group) => expectedGroups.includes(group) || groups.includes(group)
    );
    setDiscoveredGroups({ roomId: room.id, groups: ordered });
  }, [expectedGroups, room.id]);

  const handleGroupToggle = useCallback((group: FurnitureGroup, visible: boolean) => {
    if (group === DECOR_GROUP) {
      send({ type: 'set-staging-visible', visible }, false);
      return;
    }
    const next = new Set(document.view.hidden_group_ids);
    if (visible) next.delete(group);
    else next.add(group);
    send({ type: 'set-hidden-groups', group_ids: [...next] }, false);
  }, [document.view.hidden_group_ids, send]);

  const handleToggleArrange = useCallback(() => {
    if (mode === 'walk') handleModeChange('3d');
    setArrangeOn((current) => {
      const next = !current;
      if (next) maybeShowTip('arrange');
      return next;
    });
  }, [handleModeChange, maybeShowTip, mode]);

  const handleResetLayout = useCallback(() => {
    resetLayoutRef.current?.();
    send({ type: 'reset-layout' }, false);
    dispatchArrangement({ type: 'reset' });
    setSelectedId(null);
  }, [send]);

  const handlePoseCommit = useCallback((instanceId: string, pose: PlannerPose) => {
    send({ type: 'set-instance-pose', instance_id: instanceId, pose }, false);
  }, [send]);

  const handleCustomBlockPoseCommit = useCallback((blockId: string, pose: PlannerPose) => {
    const block = document.layout.custom_blocks.find((candidate) => candidate.id === blockId);
    if (block) send({ type: 'update-custom-block', block_id: blockId, block: { ...block, pose } }, false);
  }, [document.layout.custom_blocks, send]);

  const handlePosePreview = useCallback((
    kind: 'instance' | 'custom-block',
    id: string,
    pose: PlannerPose
  ) => {
    setPosePreview({ kind, id, pose });
  }, []);

  const clearPosePreview = useCallback(() => setPosePreview(null), []);

  const handlePlanPosePreview = useCallback((
    kind: 'instance' | 'custom-block',
    id: string,
    position: PlannerPose['position_m']
  ) => {
    const pose = kind === 'instance'
      ? document.layout.instances.find((instance) => instance.id === id)?.pose
      : document.layout.custom_blocks.find((block) => block.id === id)?.pose;
    if (pose) setPosePreview({ kind, id, pose: { ...pose, position_m: position } });
  }, [document.layout.custom_blocks, document.layout.instances]);

  const selectedInstance = document.layout.instances.find((instance) => instance.id === selectedId);
  const selectedBlock = document.layout.custom_blocks.find((block) => block.id === selectedId);
  const previewDocument = useMemo(() => {
    if (!posePreview) return document;
    if (posePreview.kind === 'instance') {
      return {
        ...document,
        layout: {
          ...document.layout,
          instances: document.layout.instances.map((instance) =>
            instance.id === posePreview.id ? { ...instance, pose: posePreview.pose } : instance
          )
        }
      };
    }
    return {
      ...document,
      layout: {
        ...document.layout,
        custom_blocks: document.layout.custom_blocks.map((block) =>
          block.id === posePreview.id ? { ...block, pose: posePreview.pose } : block
        )
      }
    };
  }, [document, posePreview]);
  const conflicts = useMemo(
    () => colliderManifest &&
      colliderManifest.room_id === previewDocument.room_id &&
      colliderManifest.scene_revision === previewDocument.scene_revision
      ? evaluatePlannerConflicts({
          document: previewDocument,
          shell: plannerShellFromRoom(room.room),
          collider_manifest: colliderManifest,
          clearance_zones: plannerClearanceZonesFromRoom(room.room)
        })
      : [],
    [colliderManifest, previewDocument, room.room]
  );
  const changedIds = useMemo(() => {
    const ids = new Set(document.layout.custom_blocks.map((block) => block.id));
    for (const instance of document.layout.instances) {
      const pose = instance.pose;
      const original = instance.original_pose;
      if (
        pose.position_m.x !== original.position_m.x ||
        pose.position_m.y !== original.position_m.y ||
        pose.position_m.z !== original.position_m.z ||
        pose.rotation_deg.z !== original.rotation_deg.z
      ) {
        ids.add(instance.id);
      }
    }
    if (posePreview) ids.add(posePreview.id);
    return ids;
  }, [document.layout.custom_blocks, document.layout.instances, posePreview]);
  const actionableConflicts = useMemo(
    () => conflicts.filter((conflict) => conflict.instance_ids.some((id) => changedIds.has(id))),
    [changedIds, conflicts]
  );
  const warnings = useMemo(
    () => actionableConflicts.flatMap((conflict) =>
      conflict.instance_ids.map((object_id) => ({
        object_id,
        kind: conflict.kind,
        severity: conflict.severity
      }))
    ),
    [actionableConflicts]
  );
  const conflictInstanceIds = useMemo(
    () => new Set(
      warnings
        .filter((warning) => warning.severity === 'error')
        .map((warning) => warning.object_id)
    ),
    [warnings]
  );
  const selectedWarnings = useMemo(
    () => actionableConflicts
      .filter((conflict) => selectedId && conflict.instance_ids.includes(selectedId))
      .map((conflict) => humanizePlannerMessage(conflict.message)),
    [actionableConflicts, selectedId]
  );

  const rotateSelected = useCallback(() => {
    if (selectedInstance) {
      send({ type: 'rotate-instance', instance_id: selectedInstance.id });
    } else if (selectedBlock) {
      send({
        type: 'update-custom-block',
        block_id: selectedBlock.id,
        block: {
          ...selectedBlock,
          pose: {
            ...selectedBlock.pose,
            rotation_deg: {
              ...selectedBlock.pose.rotation_deg,
              z: (selectedBlock.pose.rotation_deg.z + 90) % 360
            }
          }
        }
      });
    }
  }, [selectedBlock, selectedInstance, send]);

  const removeSelected = useCallback(() => {
    if (selectedInstance?.removable) {
      send({ type: 'remove-instance', instance_id: selectedInstance.id });
      setSelectedId(null);
    } else if (selectedBlock) {
      send({ type: 'remove-custom-block', block_id: selectedBlock.id });
      setSelectedId(null);
    }
  }, [selectedBlock, selectedInstance, send]);

  const createShare = useCallback(async () => {
    try {
      const shareDocument = document.view.mode === 'walk'
        ? { ...document, view: { ...document.view, mode: '3d' as const } }
        : document;
      const fragment = encodePlannerShareFragment(shareDocument);
      const url = `${window.location.origin}${window.location.pathname}${fragment}`;
      setShareUrl(url);
      await navigator.clipboard.writeText(url);
      setShareMessage('share link copied.');
    } catch (error) {
      setShareMessage(error instanceof Error ? lowerText(error.message) : 'the share link could not be created.');
    }
  }, [document]);

  const openSheet = useCallback((sheet: Exclude<ActiveSheet, null>) => {
    setActiveSheet(sheet);
    if (sheet === 'share') maybeShowTip('share');
  }, [maybeShowTip]);

  const handleFullscreen = useCallback(() => {
    if (window.document.fullscreenElement) void window.document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.();
  }, []);

  const handleResetCamera = useCallback(() => {
    const canonical = room.room.visualization_scene.cameras.orbit;
    send({
      type: 'set-orbit-camera',
      camera: {
        position_m: { ...canonical.position_m },
        target_m: { ...canonical.target_m },
        fov_deg: canonical.fov_deg
      }
    }, false);
    setCameraResetRevision((revision) => revision + 1);
  }, [room.room.visualization_scene.cameras.orbit, send]);

  const handleTopCamera = useCallback(() => {
    if (mode !== '3d') handleModeChange('3d');
    const cameras = room.room.visualization_scene.cameras;
    send({
      type: 'set-orbit-camera',
      camera: {
        position_m: { ...cameras.plan.position_m },
        target_m: { ...cameras.plan.target_m },
        fov_deg: cameras.orbit.fov_deg
      }
    }, false);
    setCameraResetRevision((revision) => revision + 1);
  }, [handleModeChange, mode, room.room.visualization_scene.cameras, send]);

  const handleCameraCommit = useCallback((camera: SceneDocument['view']['orbit_camera']) => {
    send({ type: 'set-orbit-camera', camera }, false);
  }, [send]);

  const roomName = lowerText(room.displayName.replace(/\s+—\s+Representative$/i, ''));
  const compactRoomName = lowerText(
    `${room.hall} ${room.roomType.replace(/^standard_/u, '').replaceAll('_', ' ')}`
  );
  const canRotateSelection = Boolean(
    selectedBlock || selectedInstance?.role === 'movable'
  );
  const selectedDimensions = useMemo(() => {
    if (selectedBlock) {
      const dimensions = selectedBlock.dimensions_m;
      const asDimension = (value_m: number): Dimension => ({
        value_m,
        status: 'verified',
        estimated: false,
        source_id: null,
        confidence: 'high'
      });
      return [dimensions.width, dimensions.depth, dimensions.height]
        .map((value) => formatDimensionForUnit(asDimension(value), document.view.units).text)
        .join(' × ');
    }
    if (!selectedInstance) return null;
    const object = room.room.objects.find((candidate) => candidate.id === selectedInstance.object_id);
    if (!object?.dimensions_m) return 'dimensions unknown';
    return [object.dimensions_m.x, object.dimensions_m.y, object.dimensions_m.z]
      .map((dimension) => formatDimensionForUnit(dimension, document.view.units).text)
      .join(' × ');
  }, [document.view.units, room.room.objects, selectedBlock, selectedInstance]);

  return (
    <main className="app-stage" ref={stageRef}>
      <div className="stage" id="main-stage">
        {mode === '2d' ? (
          <PlannerFloorPlan
            room={room}
            document={document}
            arrangeOn={arrangeOn}
            selectedId={selectedId}
            warnings={arrangeOn ? warnings : []}
            colliderManifest={colliderManifest}
            hiddenGroups={hiddenGroups}
            dimensionsVisible={document.view.dimensions_visible}
            onSelect={setSelectedId}
            onPosePreview={handlePlanPosePreview}
            onPosePreviewEnd={clearPosePreview}
            dispatch={send}
          />
        ) : (
          <RoomViewer3D
            key={room.id}
            room={room}
            mode={mode}
            dimsOn={document.view.dimensions_visible}
            arrangeOn={arrangeOn}
            arrangementState={arrangement}
            hiddenGroups={hiddenGroups}
            onGroupsDiscovered={handleGroupsDiscovered}
            onWalkExit={() => handleModeChange('3d')}
            onArrangementAction={dispatchArrangement}
            resetLayoutRef={resetLayoutRef}
            zoomRef={zoomRef}
            removedInstanceIds={removedInstanceIds}
            cameraResetRevision={cameraResetRevision}
            renderProfile={document.view.render_profile}
            plannerDocument={document}
            selectedInstanceId={selectedId}
            snapEnabled={document.view.snap_enabled}
            onInstanceSelected={setSelectedId}
            onInstancePoseCommit={handlePoseCommit}
            onCustomBlockPoseCommit={handleCustomBlockPoseCommit}
            onPosePreview={handlePosePreview}
            onPosePreviewEnd={clearPosePreview}
            showConfidence={document.view.confidence_visible}
            conflictInstanceIds={conflictInstanceIds}
            onCameraCommit={handleCameraCommit}
          />
        )}
        {mode !== 'walk' && mode !== '2d' ? (
          <div className="zoom-controls">
            <button type="button" className="zoom-btn" aria-label="zoom in" onClick={() => zoomRef.current?.(1)}>+</button>
            <button type="button" className="zoom-btn" aria-label="zoom out" onClick={() => zoomRef.current?.(-1)}>−</button>
          </div>
        ) : null}
      </div>

      <AppHeader
        roomName={roomName}
        compactRoomName={compactRoomName}
        mode={mode}
        dimsOn={document.view.dimensions_visible}
        arrangeOn={arrangeOn}
        walkSupported={walkSupported}
        onOpenSheet={openSheet}
        onModeChange={handleModeChange}
        onToggleDimensions={() => send({ type: 'set-dimensions-visible', visible: !document.view.dimensions_visible }, false)}
        onToggleArrange={handleToggleArrange}
        onTopCamera={handleTopCamera}
        onResetCamera={handleResetCamera}
        onFullscreen={handleFullscreen}
      />
      <MobileDock mode={mode} arrangeOn={arrangeOn} onOpenSheet={openSheet} onModeChange={handleModeChange} onToggleArrange={handleToggleArrange} />

      {mode === '2d' ? (
        <div className="stage-status-stack">
          {arrangement.layoutDirty ? (
            <div className="stage-arrange-note" role="status">
              custom arrangement · not the representative layout
            </div>
          ) : null}
          <div className="stage-accuracy-chip">
            representative plan · dimensions estimated · actual rooms vary
          </div>
        </div>
      ) : null}

      {arrangeOn ? (
        <ArrangeToolbar
          canUndo={planner.past.length > 0}
          canRedo={planner.future.length > 0}
          snapOn={document.view.snap_enabled}
          canRotate={canRotateSelection}
          canAddItem={document.layout.custom_blocks.length < CUSTOM_BLOCK_LIMIT}
          warningCount={actionableConflicts.length}
          onUndo={() => send({ type: 'undo' })}
          onRedo={() => send({ type: 'redo' })}
          onRotate={rotateSelected}
          onToggleSnap={() => send({ type: 'set-snap-enabled', enabled: !document.view.snap_enabled }, false)}
          onAddItem={() => setAddItemOpen(true)}
          onOpenInventory={() => openSheet('inventory')}
          onReset={handleResetLayout}
        />
      ) : null}

      {arrangeOn && (selectedInstance || selectedBlock) ? (
        <SelectionBar
          name={lowerText(selectedInstance?.label ?? selectedBlock?.label ?? '')}
          dimensions={selectedDimensions ?? 'dimensions unknown'}
          confidence={selectedInstance?.confidence ?? 'low'}
          warning={selectedWarnings[0]}
          canRotate={canRotateSelection}
          canRemove={Boolean(selectedInstance?.removable || selectedBlock)}
          onRotate={rotateSelected}
          onRemove={removeSelected}
          onClose={() => setSelectedId(null)}
        />
      ) : null}

      <ResponsiveSheet open={activeSheet === 'rooms'} title="rooms" side="left" onClose={closeSheet}>
        <RoomBrowser selected={room} onSelect={handleRoomChange} />
      </ResponsiveSheet>
      <ResponsiveSheet open={activeSheet === 'details'} title="details" side="right" onClose={closeSheet}>
        <DetailsPanel room={room} units={document.view.units} onUnitsChange={(units) => send({ type: 'set-units', units }, false)} />
      </ResponsiveSheet>
      <ResponsiveSheet open={activeSheet === 'layers'} title="layers" side="right" onClose={closeSheet}>
        <LayersPanel
          availableGroups={availableGroups}
          hiddenGroups={hiddenGroups}
          onToggle={handleGroupToggle}
          quality={document.view.render_profile}
          onQualityChange={(profile) => send({ type: 'set-render-profile', profile }, false)}
          wallFadeOn={document.view.wall_fade_enabled}
          onWallFadeChange={(enabled) => send({ type: 'set-wall-fade-enabled', enabled }, false)}
          confidenceOn={document.view.confidence_visible}
          onConfidenceChange={(visible) => send({ type: 'set-confidence-visible', visible }, false)}
        />
      </ResponsiveSheet>
      <ResponsiveSheet open={activeSheet === 'share'} title="share this plan" side="right" onClose={closeSheet}>
        <SharePanel shareUrl={shareUrl} message={shareMessage} onCopy={createShare} />
      </ResponsiveSheet>
      <ResponsiveSheet open={activeSheet === 'inventory'} title="removed from plan" side="right" onClose={closeSheet}>
        <div className="inventory-list">
          {document.layout.removed_instance_ids.length === 0 ? <p className="empty-state">no supplied furniture has been removed.</p> : null}
          {document.layout.removed_instance_ids.map((id) => {
            const instance = document.layout.instances.find((candidate) => candidate.id === id);
            return instance ? (
              <div className="inventory-item" key={id}>
                <span>{lowerText(instance.label)}</span>
                <button type="button" className="secondary-button" onClick={() => send({ type: 'restore-instance', instance_id: id })}>restore</button>
              </div>
            ) : null;
          })}
        </div>
      </ResponsiveSheet>
      <ResponsiveSheet open={activeSheet === 'more'} title="more planner tools" side="right" onClose={closeSheet}>
        <div className="more-tools" role="group" aria-label="more planner tools">
          <button type="button" className="secondary-button" onClick={() => openSheet('layers')}>layers and quality</button>
          <button type="button" className="secondary-button" onClick={() => openSheet('share')}>share this plan</button>
          <button type="button" className="secondary-button" aria-pressed={document.view.dimensions_visible} onClick={() => send({ type: 'set-dimensions-visible', visible: !document.view.dimensions_visible }, false)}>dimensions</button>
          <button type="button" className="secondary-button" onClick={() => { handleTopCamera(); closeSheet(); }}>top view</button>
          <button type="button" className="secondary-button" onClick={() => { handleResetCamera(); closeSheet(); }}>reset camera</button>
          <button type="button" className="secondary-button" onClick={() => { handleFullscreen(); closeSheet(); }}>toggle fullscreen</button>
        </div>
      </ResponsiveSheet>

      {addItemOpen && document.layout.custom_blocks.length < CUSTOM_BLOCK_LIMIT ? (
        <AddItemDialog
          document={document}
          nextId={nextCustomBlockId(document)}
          onAdd={(block: CustomBlock) => {
            send({ type: 'add-custom-block', block });
            setSelectedId(block.id);
            setAddItemOpen(false);
          }}
          onClose={() => setAddItemOpen(false)}
        />
      ) : null}

      {tip ? (
        <div className="onboarding-tip" style={tip === 'rooms' ? { top: 64, left: 88 } : tip === 'arrange' ? { bottom: 76, left: '50%', transform: 'translateX(-50%)' } : { top: 64, right: 14 }}>
          {tip === 'rooms' ? 'open rooms to search the growing catalog.' : tip === 'arrange' ? 'select furniture, then move it in 2d or 3d. warnings are guidance, not blockers.' : 'share creates an editable copy without uploading your plan.'}
          <button type="button" className="icon-button" aria-label={`dismiss ${tip} tip`} onClick={() => dismissTip(tip)}>×</button>
        </div>
      ) : null}
      {arrangeOn && actionableConflicts.length > 0 ? (
        <div className="planner-warning-summary" role="status">
          <strong>{actionableConflicts.length} {actionableConflicts.length === 1 ? 'warning' : 'warnings'}</strong>
          <span>{selectedWarnings[0] ?? humanizePlannerMessage(actionableConflicts[0].message)} · movement is still allowed</span>
        </div>
      ) : null}
      {colliderMessage ? <div className="planner-notice" role="status">{colliderMessage}</div> : null}
    </main>
  );
}
