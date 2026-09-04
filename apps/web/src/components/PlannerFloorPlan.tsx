'use client';

import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import type { RoomManifestItem, RoomObject } from '../data/assetManifest';
import { formatDimensionForUnit } from '../data/dimensions';
import {
  snapMeters,
  type CustomBlock,
  type PlannerAction,
  type PlannerInstance,
  type SceneDocument
} from '../data/plannerDocument';
import {
  plannerInstanceFootprint,
  type PlannerFootprint,
  type SceneColliderManifest
} from '../data/plannerCollisions';
import { groupForNodeName, type FurnitureGroup } from '../data/furnitureGroups';
import { lowerText } from './presentation';

type PlanWarning = { object_id: string; kind: string; severity: 'error' | 'warning' };
type DraggablePlanObject =
  | { kind: 'instance'; id: string; position: PlannerInstance['pose']['position_m'] }
  | { kind: 'custom-block'; id: string; position: CustomBlock['pose']['position_m'] };

const DRAG_EPSILON_M = 0.000_001;
const EMPTY_HIDDEN_GROUPS = new Set<FurnitureGroup>();

function fallbackFootprint(
  room: RoomManifestItem,
  instance: PlannerInstance
): PlannerFootprint {
  const object = room.room.objects.find((candidate: RoomObject) => candidate.id === instance.object_id);
  return {
    center_m: {
      x: instance.pose.position_m.x,
      y: instance.pose.position_m.y
    },
    size_m: {
      width: object?.dimensions_m?.x.value_m ?? 0.5,
      depth: object?.dimensions_m?.y.value_m ?? 0.5
    },
    rotation_deg: instance.pose.rotation_deg.z
  };
}

function sectorPath(
  center: { x: number; y: number },
  radius: number,
  startAngle: number,
  endAngle: number
): string {
  const startRad = (startAngle * Math.PI) / 180;
  const endRad = (endAngle * Math.PI) / 180;
  const start = {
    x: center.x + Math.cos(startRad) * radius,
    y: center.y + Math.sin(startRad) * radius
  };
  const end = {
    x: center.x + Math.cos(endRad) * radius,
    y: center.y + Math.sin(endRad) * radius
  };
  const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  return `M ${center.x} ${center.y} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

export function PlannerFloorPlan({
  room,
  document,
  arrangeOn,
  selectedId,
  warnings,
  colliderManifest,
  hiddenGroups = EMPTY_HIDDEN_GROUPS,
  dimensionsVisible = true,
  onSelect,
  onPosePreview,
  onPosePreviewEnd,
  dispatch
}: {
  room: RoomManifestItem;
  document: SceneDocument;
  arrangeOn: boolean;
  selectedId: string | null;
  warnings: PlanWarning[];
  colliderManifest?: SceneColliderManifest | null;
  hiddenGroups?: ReadonlySet<FurnitureGroup>;
  dimensionsVisible?: boolean;
  onSelect: (id: string | null) => void;
  onPosePreview?: (
    kind: DraggablePlanObject['kind'],
    id: string,
    position: DraggablePlanObject['position']
  ) => void;
  onPosePreviewEnd?: () => void;
  dispatch: (action: PlannerAction) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    pointerId: number;
    object: DraggablePlanObject;
    startPoint: { x: number; y: number };
    startPosition: { x: number; y: number; z: number };
    currentPosition: { x: number; y: number; z: number };
    element: SVGGElement;
    captureTarget: SVGRectElement;
  } | null>(null);
  const previewFrame = useRef<number | null>(null);
  const latestPreview = useRef<{
    object: DraggablePlanObject;
    position: DraggablePlanObject['position'];
  } | null>(null);

  useEffect(() => () => {
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
  }, []);
  const shellWidth = room.room.visualization_shell.width.value_m;
  const shellDepth = room.room.visualization_shell.depth.value_m;
  const margin = 0.38;
  const baseView = useMemo(() => ({
    width: shellWidth + margin * 2,
    height: shellDepth + margin * 2
  }), [shellDepth, shellWidth]);
  const errorIds = useMemo(
    () => new Set(warnings.filter((warning) => warning.severity === 'error').map((warning) => warning.object_id)),
    [warnings]
  );
  const advisoryIds = useMemo(
    () => new Set(warnings.filter((warning) => warning.severity === 'warning').map((warning) => warning.object_id)),
    [warnings]
  );
  const removed = useMemo(
    () => new Set(document.layout.removed_instance_ids),
    [document.layout.removed_instance_ids]
  );
  const collidersByInstance = useMemo(
    () => new Map(
      colliderManifest?.instances.map((entry) => [entry.instance_id, entry.colliders] as const) ?? []
    ),
    [colliderManifest]
  );
  const architecturalOpenings = useMemo(() =>
    document.layout.instances.flatMap((instance) => {
      const object = room.room.objects.find((candidate: RoomObject) => candidate.id === instance.object_id);
      if (!object || (object.type !== 'door' && object.type !== 'window')) return [];
      return [{
        id: instance.id,
        type: object.type,
        x: instance.pose.position_m.x,
        y: instance.pose.position_m.y,
        width: object.dimensions_m?.x.value_m ?? 0.9
      }];
    }), [document.layout.instances, room.room.objects]);
  const horizontalWallSegments = (wallY: number) => {
    const openings = architecturalOpenings
      .filter((opening) => Math.abs(opening.y - wallY) < 0.12)
      .sort((left, right) => left.x - right.x);
    const segments: Array<{ start: number; end: number }> = [];
    let cursor = -shellWidth / 2;
    for (const opening of openings) {
      const start = Math.max(-shellWidth / 2, opening.x - opening.width / 2);
      const end = Math.min(shellWidth / 2, opening.x + opening.width / 2);
      if (start > cursor) segments.push({ start: cursor, end: start });
      cursor = Math.max(cursor, end);
    }
    if (cursor < shellWidth / 2) segments.push({ start: cursor, end: shellWidth / 2 });
    return segments;
  };
  const widthLabel = formatDimensionForUnit(
    room.room.visualization_shell.width,
    document.view.units
  );
  const depthLabel = formatDimensionForUnit(
    room.room.visualization_shell.depth,
    document.view.units
  );
  const canonicalPlanSize = room.room.visualization_scene.cameras.plan.orthographic_size_m;
  const planCamera = document.view.plan_camera;
  const planCameraRef = useRef(planCamera);
  const planViewBox = (camera: SceneDocument['view']['plan_camera']) => {
    const scale = camera.orthographic_size_m / canonicalPlanSize;
    const width = baseView.width * scale;
    const height = baseView.height * scale;
    return `${camera.position_m.x - width / 2} ${-camera.position_m.y - height / 2} ${width} ${height}`;
  };
  const gesture = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    startDistance: number;
    startMidpoint: { x: number; y: number };
    startCamera: SceneDocument['view']['plan_camera'];
    currentCamera: SceneDocument['view']['plan_camera'];
    active: boolean;
  }>({
    pointers: new Map(),
    startDistance: 0,
    startMidpoint: { x: 0, y: 0 },
    startCamera: structuredClone(planCamera),
    currentCamera: structuredClone(planCamera),
    active: false
  });

  useEffect(() => {
    if (gesture.current.active) return;
    planCameraRef.current = planCamera;
    gesture.current.startCamera = structuredClone(planCamera);
    gesture.current.currentCamera = structuredClone(planCamera);
  }, [planCamera]);

  const pointInRoom = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return null;
    if (typeof svg.getScreenCTM === 'function' && typeof svg.createSVGPoint === 'function') {
      const screenTransform = svg.getScreenCTM();
      if (screenTransform) {
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const local = point.matrixTransform(screenTransform.inverse());
        return { x: local.x, y: -local.y };
      }
    }
    // jsdom does not implement SVG coordinate transforms; this equivalent
    // fallback also keeps unit tests deterministic at the canonical view.
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const scale = planCameraRef.current.orthographic_size_m / canonicalPlanSize;
    const width = baseView.width * scale;
    const height = baseView.height * scale;
    const originX = planCameraRef.current.position_m.x - width / 2;
    const originY = -planCameraRef.current.position_m.y - height / 2;
    const localX = originX + ((event.clientX - rect.left) / rect.width) * width;
    const localY = originY + ((event.clientY - rect.top) / rect.height) * height;
    return { x: localX, y: -localY };
  };

  const beginDrag = (
    event: ReactPointerEvent<SVGRectElement>,
    object: DraggablePlanObject,
    movable: boolean
  ) => {
    event.stopPropagation();
    if (drag.current) return;
    onSelect(object.id);
    if (!arrangeOn || !movable) return;
    const point = pointInRoom(event as unknown as ReactPointerEvent<SVGSVGElement>);
    if (!point) return;
    drag.current = {
      pointerId: event.pointerId,
      object,
      startPoint: point,
      startPosition: { ...object.position },
      currentPosition: { ...object.position },
      element: event.currentTarget.parentElement as unknown as SVGGElement,
      captureTarget: event.currentTarget
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic touch input and some assistive/browser event sources can
      // report a pointer before the platform marks it as capturable.
    }
  };

  const selectWithKeyboard = (
    event: ReactKeyboardEvent<SVGGElement>,
    object: DraggablePlanObject,
    options: { movable: boolean; removable: boolean }
  ) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      onSelect(object.id);
      return;
    }
    if (!arrangeOn) return;
    if (event.key.toLocaleLowerCase('en-US') === 'r' && options.movable) {
      event.preventDefault();
      dispatch(object.kind === 'instance'
        ? { type: 'rotate-instance', instance_id: object.id }
        : { type: 'rotate-custom-block', block_id: object.id });
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && options.removable) {
      event.preventDefault();
      dispatch(object.kind === 'instance'
        ? { type: 'remove-instance', instance_id: object.id }
        : { type: 'remove-custom-block', block_id: object.id });
      onSelect(null);
      return;
    }
    const movement = event.shiftKey ? 0.25 : 0.05;
    const delta = {
      ArrowLeft: { x: -movement, y: 0 },
      ArrowRight: { x: movement, y: 0 },
      ArrowUp: { x: 0, y: movement },
      ArrowDown: { x: 0, y: -movement }
    }[event.key];
    if (!delta || !options.movable) return;
    event.preventDefault();
    onSelect(object.id);
    const position_m = {
      ...object.position,
      x: object.position.x + delta.x,
      y: object.position.y + delta.y
    };
    dispatch(object.kind === 'instance'
      ? { type: 'move-instance', instance_id: object.id, position_m }
      : { type: 'move-custom-block', block_id: object.id, position_m });
  };

  const startPlanGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
    onSelect(null);
    if (event.pointerType !== 'touch') return;
    const current = gesture.current;
    current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic touch input and some assistive/browser event sources can
      // report a pointer before the platform marks it as capturable.
    }
    if (current.pointers.size !== 2) return;
    const [first, second] = [...current.pointers.values()];
    current.startDistance = Math.hypot(second.x - first.x, second.y - first.y);
    current.startMidpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    current.startCamera = structuredClone(planCameraRef.current);
    current.currentCamera = structuredClone(planCameraRef.current);
    current.active = true;
  };

  const movePlanGesture = (event: ReactPointerEvent<SVGSVGElement>): boolean => {
    const current = gesture.current;
    if (!current.pointers.has(event.pointerId)) return false;
    current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!current.active || current.pointers.size < 2) return true;
    const svg = svgRef.current;
    if (!svg) return true;
    const [first, second] = [...current.pointers.values()];
    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const nextSize = Math.min(
      Math.max(current.startCamera.orthographic_size_m * (current.startDistance / distance), 2.5),
      9
    );
    const scale = current.startCamera.orthographic_size_m / canonicalPlanSize;
    const rect = svg.getBoundingClientRect();
    const metersPerPixelX = (baseView.width * scale) / Math.max(rect.width, 1);
    const metersPerPixelY = (baseView.height * scale) / Math.max(rect.height, 1);
    current.currentCamera = {
      ...current.startCamera,
      position_m: {
        ...current.startCamera.position_m,
        x: current.startCamera.position_m.x - (midpoint.x - current.startMidpoint.x) * metersPerPixelX,
        y: current.startCamera.position_m.y + (midpoint.y - current.startMidpoint.y) * metersPerPixelY
      },
      orthographic_size_m: nextSize
    };
    svg.setAttribute('viewBox', planViewBox(current.currentCamera));
    return true;
  };

  const endPlanGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = gesture.current;
    if (!current.pointers.has(event.pointerId)) return false;
    current.pointers.delete(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The pointer may already have been released by the browser.
    }
    if (current.active) {
      current.active = false;
      dispatch({ type: 'set-plan-camera', camera: current.currentCamera });
    }
    return true;
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (movePlanGesture(event)) return;
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = pointInRoom(event);
    if (!point) return;
    const dx = point.x - active.startPoint.x;
    const dy = point.y - active.startPoint.y;
    const rawX = active.startPosition.x + dx;
    const rawY = active.startPosition.y + dy;
    active.currentPosition = {
      x: document.view.snap_enabled ? snapMeters(rawX) : rawX,
      y: document.view.snap_enabled ? snapMeters(rawY) : rawY,
      z: active.startPosition.z
    };
    const previewDx = active.currentPosition.x - active.startPosition.x;
    const previewDy = active.currentPosition.y - active.startPosition.y;
    active.element.setAttribute('transform', `translate(${previewDx} ${-previewDy})`);
    latestPreview.current = { object: active.object, position: active.currentPosition };
    if (previewFrame.current === null) {
      previewFrame.current = requestAnimationFrame(() => {
        previewFrame.current = null;
        const preview = latestPreview.current;
        if (preview) onPosePreview?.(preview.object.kind, preview.object.id, preview.position);
      });
    }
  };

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>, cancelled = false) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.element.removeAttribute('transform');
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
    previewFrame.current = null;
    latestPreview.current = null;
    onPosePreviewEnd?.();
    try {
      if (active.captureTarget.hasPointerCapture?.(event.pointerId)) {
        active.captureTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may already be gone after cancellation or element teardown.
    }
    drag.current = null;
    const moved =
      Math.abs(active.currentPosition.x - active.startPosition.x) > DRAG_EPSILON_M ||
      Math.abs(active.currentPosition.y - active.startPosition.y) > DRAG_EPSILON_M;
    if (cancelled || !moved) return;
    if (active.object.kind === 'instance') {
      dispatch({
        type: 'move-instance',
        instance_id: active.object.id,
        position_m: active.currentPosition
      });
      return;
    }
    dispatch({
      type: 'move-custom-block',
      block_id: active.object.id,
      position_m: active.currentPosition
    });
  };

  return (
    <div className="floor-plan-stage">
      <div className="floor-plan-editor">
        <svg
          ref={svgRef}
          viewBox={planViewBox(planCamera)}
          role="application"
          aria-label={`editable floor plan for ${lowerText(room.displayName)}`}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => {
            if (!endPlanGesture(event)) endDrag(event);
          }}
          onPointerCancel={(event) => {
            if (!endPlanGesture(event)) endDrag(event, true);
          }}
          onPointerDown={startPlanGesture}
        >
          <rect
            className="plan-room"
            x={-shellWidth / 2}
            y={-shellDepth / 2}
            width={shellWidth}
            height={shellDepth}
          />

          {horizontalWallSegments(shellDepth / 2).map((segment, index) => (
            <line key={`window-wall-${index}`} className="plan-wall" x1={segment.start} y1={-shellDepth / 2} x2={segment.end} y2={-shellDepth / 2} />
          ))}
          {horizontalWallSegments(-shellDepth / 2).map((segment, index) => (
            <line key={`entry-wall-${index}`} className="plan-wall" x1={segment.start} y1={shellDepth / 2} x2={segment.end} y2={shellDepth / 2} />
          ))}
          <line className="plan-wall" x1={-shellWidth / 2} y1={-shellDepth / 2} x2={-shellWidth / 2} y2={shellDepth / 2} />
          <line className="plan-wall" x1={shellWidth / 2} y1={-shellDepth / 2} x2={shellWidth / 2} y2={shellDepth / 2} />
          {architecturalOpenings.filter((opening) => opening.type === 'window').map((opening) => (
            <line
              key={`opening-${opening.id}`}
              className="plan-opening"
              x1={opening.x - opening.width / 2}
              y1={-opening.y}
              x2={opening.x + opening.width / 2}
              y2={-opening.y}
            />
          ))}

          {room.room.visualization_scene.clearance_zones
            .filter((zone) => zone.type === 'door_swing' || arrangeOn)
            .map((zone) => {
                if (zone.geometry.shape === 'rectangle') {
                  return (
                    <rect
                      key={zone.id}
                      className="plan-clearance"
                      x={zone.geometry.center_m.x - zone.geometry.size_m.width / 2}
                      y={-zone.geometry.center_m.y - zone.geometry.size_m.depth / 2}
                      width={zone.geometry.size_m.width}
                      height={zone.geometry.size_m.depth}
                      transform={`rotate(${-zone.geometry.rotation_deg} ${zone.geometry.center_m.x} ${-zone.geometry.center_m.y})`}
                    />
                  );
                }
                return (
                  <path
                    key={zone.id}
                    className="plan-clearance plan-door-swing"
                    d={sectorPath(
                      { x: zone.geometry.center_m.x, y: -zone.geometry.center_m.y },
                      zone.geometry.radius_m,
                      -zone.geometry.end_angle_deg,
                      -zone.geometry.start_angle_deg
                    )}
                  />
                );
              })}

          {document.layout.instances.map((instance) => {
            if (removed.has(instance.id)) return null;
            if (architecturalOpenings.some((opening) => opening.id === instance.id)) return null;
            const group = groupForNodeName(instance.id);
            if (group && hiddenGroups.has(group)) return null;
            const footprint = plannerInstanceFootprint(
              instance,
              collidersByInstance.get(instance.id) ?? []
            ) ?? fallbackFootprint(room, instance);
            const x = footprint.center_m.x;
            const y = -footprint.center_m.y;
            const classes = [
              'plan-instance',
              instance.role !== 'movable' ? 'is-built-in' : '',
              selectedId === instance.id ? 'is-selected' : '',
              errorIds.has(instance.id) ? 'has-conflict' : '',
              advisoryIds.has(instance.id) ? 'has-warning' : ''
            ].filter(Boolean).join(' ');
            return (
              <g
                key={instance.id}
                data-plan-id={instance.id}
                role="button"
                tabIndex={0}
                aria-label={`select ${lowerText(instance.label)}`}
                aria-pressed={selectedId === instance.id}
                onKeyDown={(event) => selectWithKeyboard(
                  event,
                  { kind: 'instance', id: instance.id, position: instance.pose.position_m },
                  { movable: instance.role === 'movable', removable: instance.removable }
                )}
              >
                <rect
                  className={classes}
                  x={x - footprint.size_m.width / 2}
                  y={y - footprint.size_m.depth / 2}
                  width={footprint.size_m.width}
                  height={footprint.size_m.depth}
                  transform={`rotate(${-footprint.rotation_deg} ${x} ${y})`}
                  rx={0.025}
                  onPointerDown={(event) =>
                    beginDrag(
                      event,
                      { kind: 'instance', id: instance.id, position: instance.pose.position_m },
                      instance.role === 'movable'
                    )
                  }
                />
                {selectedId === instance.id ? (
                  <text className="plan-label" x={x} y={y}>{lowerText(instance.label)}</text>
                ) : null}
              </g>
            );
          })}

          {document.layout.custom_blocks.map((block) => {
            const rotated = Math.round(block.pose.rotation_deg.z / 90) % 2 !== 0;
            const width = rotated ? block.dimensions_m.depth : block.dimensions_m.width;
            const depth = rotated ? block.dimensions_m.width : block.dimensions_m.depth;
            const x = block.pose.position_m.x;
            const y = -block.pose.position_m.y;
            return (
              <g
                key={block.id}
                data-plan-id={block.id}
                role="button"
                tabIndex={0}
                aria-label={`select ${lowerText(block.label)}`}
                aria-pressed={selectedId === block.id}
                onKeyDown={(event) => selectWithKeyboard(
                  event,
                  { kind: 'custom-block', id: block.id, position: block.pose.position_m },
                  { movable: true, removable: true }
                )}
              >
                <rect
                  className={`plan-custom-block${selectedId === block.id ? ' is-selected' : ''}${errorIds.has(block.id) ? ' has-conflict' : ''}${advisoryIds.has(block.id) ? ' has-warning' : ''}`}
                  x={x - width / 2}
                  y={y - depth / 2}
                  width={width}
                  height={depth}
                  rx={0.025}
                  onPointerDown={(event) =>
                    beginDrag(
                      event,
                      { kind: 'custom-block', id: block.id, position: block.pose.position_m },
                      true
                    )
                  }
                />
                {selectedId === block.id ? <text className="plan-label" x={x} y={y}>{lowerText(block.label)}</text> : null}
              </g>
            );
          })}

          {dimensionsVisible ? (
            <>
              <text className="plan-dimension" x={0} y={-shellDepth / 2 - 0.16} textAnchor="middle">
                {widthLabel.text} · {widthLabel.badge}
              </text>
              <text className="plan-dimension" x={shellWidth / 2 + 0.16} y={0} textAnchor="middle" transform={`rotate(90 ${shellWidth / 2 + 0.16} 0)`}>
                {depthLabel.text} · {depthLabel.badge}
              </text>
            </>
          ) : null}
        </svg>
      </div>
    </div>
  );
}
