'use client';

import type { ViewMode } from './RoomViewer3D';

export type ActiveSheet = 'rooms' | 'details' | 'layers' | 'share' | 'inventory' | 'more' | null;

export function AppHeader({
  roomName,
  compactRoomName,
  mode,
  dimsOn,
  arrangeOn,
  walkSupported,
  onOpenSheet,
  onModeChange,
  onToggleDimensions,
  onToggleArrange,
  onTopCamera,
  onResetCamera,
  onFullscreen
}: {
  roomName: string;
  compactRoomName: string;
  mode: ViewMode;
  dimsOn: boolean;
  arrangeOn: boolean;
  walkSupported: boolean;
  onOpenSheet: (sheet: Exclude<ActiveSheet, null>) => void;
  onModeChange: (mode: ViewMode) => void;
  onToggleDimensions: () => void;
  onToggleArrange: () => void;
  onTopCamera: () => void;
  onResetCamera: () => void;
  onFullscreen: () => void;
}) {
  return (
    <header className="app-header">
      <button type="button" className="wordmark" aria-label="reset camera" title="reset camera" onClick={onResetCamera}>nestometry</button>
      <button type="button" className="room-trigger" onClick={() => onOpenSheet('rooms')}>
        <span className="room-name-full">{roomName}</span>
        <span className="room-name-compact">{compactRoomName}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      <a
        className="project-status-link"
        href="https://github.com/dongt10/nestometry/blob/main/CONTRIBUTING.md"
        target="_blank"
        rel="noreferrer"
      >
        incomplete catalog · contribute ↗
      </a>
      <nav className="desktop-actions" aria-label="planner controls">
        <div className="view-switcher" role="group" aria-label="view">
          <button type="button" className={mode === '3d' ? 'is-active' : ''} aria-pressed={mode === '3d'} onClick={() => onModeChange('3d')}>3d</button>
          <button type="button" className={mode === '2d' ? 'is-active' : ''} aria-pressed={mode === '2d'} onClick={() => onModeChange('2d')}>2d</button>
          {walkSupported ? <button type="button" className={mode === 'walk' ? 'is-active' : ''} aria-pressed={mode === 'walk'} onClick={() => onModeChange(mode === 'walk' ? '3d' : 'walk')}>walk</button> : null}
        </div>
        <button type="button" className={arrangeOn ? 'quiet-action is-active' : 'quiet-action'} aria-pressed={arrangeOn} onClick={onToggleArrange}>arrange</button>
        <button type="button" className={dimsOn ? 'quiet-action is-active' : 'quiet-action'} aria-pressed={dimsOn} onClick={onToggleDimensions}>dimensions</button>
        <button type="button" className="quiet-action" onClick={() => onOpenSheet('layers')}>layers</button>
        <button type="button" className="quiet-action" onClick={() => onOpenSheet('details')}>details</button>
        <button type="button" className="quiet-action" onClick={() => onOpenSheet('share')}>share</button>
        <button type="button" className="icon-button" aria-label="top view" title="top view" onClick={onTopCamera}>⌃</button>
        <button type="button" className="icon-button" aria-label="reset camera" title="reset camera" onClick={onResetCamera}>⌂</button>
        <button type="button" className="icon-button" aria-label="toggle fullscreen" title="toggle fullscreen" onClick={onFullscreen}>⛶</button>
      </nav>
    </header>
  );
}

export function MobileDock({
  mode,
  arrangeOn,
  onOpenSheet,
  onModeChange,
  onToggleArrange
}: {
  mode: ViewMode;
  arrangeOn: boolean;
  onOpenSheet: (sheet: Exclude<ActiveSheet, null>) => void;
  onModeChange: (mode: ViewMode) => void;
  onToggleArrange: () => void;
}) {
  return (
    <nav className="mobile-dock" aria-label="planner controls">
      <button type="button" onClick={() => onOpenSheet('rooms')}><span aria-hidden="true">⌕</span>rooms</button>
      <button type="button" onClick={() => onModeChange(mode === '2d' ? '3d' : '2d')}><span aria-hidden="true">◇</span>{mode === '2d' ? '3d' : '2d'}</button>
      <button type="button" className={arrangeOn ? 'is-active' : ''} aria-pressed={arrangeOn} onClick={onToggleArrange}><span aria-hidden="true">↔</span>arrange</button>
      <button type="button" onClick={() => onOpenSheet('details')}><span aria-hidden="true">i</span>details</button>
      <button type="button" onClick={() => onOpenSheet('more')}><span aria-hidden="true">•••</span>more</button>
    </nav>
  );
}

export function ArrangeToolbar({
  canUndo,
  canRedo,
  snapOn,
  canRotate,
  canAddItem,
  warningCount,
  onUndo,
  onRedo,
  onRotate,
  onToggleSnap,
  onAddItem,
  onOpenInventory,
  onReset
}: {
  canUndo: boolean;
  canRedo: boolean;
  snapOn: boolean;
  canRotate: boolean;
  canAddItem: boolean;
  warningCount: number;
  onUndo: () => void;
  onRedo: () => void;
  onRotate: () => void;
  onToggleSnap: () => void;
  onAddItem: () => void;
  onOpenInventory: () => void;
  onReset: () => void;
}) {
  return (
    <div className="arrange-toolbar" role="toolbar" aria-label="arrange tools">
      <button type="button" disabled={!canUndo} onClick={onUndo}>undo</button>
      <button type="button" disabled={!canRedo} onClick={onRedo}>redo</button>
      <span className="toolbar-divider" aria-hidden="true" />
      <button type="button" disabled={!canRotate} onClick={onRotate}>rotate 90°</button>
      <button type="button" className={snapOn ? 'is-active' : ''} aria-pressed={snapOn} onClick={onToggleSnap}>5 cm snap</button>
      <button type="button" disabled={!canAddItem} onClick={onAddItem}>add item</button>
      <button type="button" onClick={onOpenInventory}>inventory</button>
      <button type="button" onClick={onReset}>reset</button>
      {warningCount > 0 ? <span className="warning-count" role="status">{warningCount} {warningCount === 1 ? 'warning' : 'warnings'}</span> : null}
    </div>
  );
}

export function SelectionBar({
  name,
  dimensions,
  confidence,
  warning,
  canRotate,
  canRemove,
  onRotate,
  onRemove,
  onClose
}: {
  name: string;
  dimensions: string;
  confidence: string;
  warning?: string;
  canRotate: boolean;
  canRemove: boolean;
  onRotate: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <div className="selection-bar">
      <div>
        <strong>{name}</strong>
        <small>{dimensions}</small>
        <small><span className={`confidence-dot confidence-dot--${confidence}`} />{confidence} confidence{warning ? ` · ${warning}` : ''}</small>
      </div>
      <button type="button" disabled={!canRotate} onClick={onRotate}>rotate 90°</button>
      {canRemove ? <button type="button" onClick={onRemove}>remove from plan</button> : null}
      <button type="button" className="icon-button" aria-label="clear selection" onClick={onClose}>×</button>
    </div>
  );
}
