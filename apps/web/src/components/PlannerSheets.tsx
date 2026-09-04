'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import {
  roomManifest,
  roomSummary,
  type RoomManifestItem
} from '../data/assetManifest';
import type { UnitSystem } from '../data/dimensions';
import type { FurnitureGroup } from '../data/furnitureGroups';
import { AccuracyPanel } from './AccuracyPanel';
import { DimensionList } from './DimensionList';
import { FurnitureToggles } from './RoomViewer3D';
import { lowerText, roomChoiceName } from './presentation';

const CONTRIBUTING_URL = 'https://github.com/dongt10/nestometry/blob/main/CONTRIBUTING.md';

export function RoomBrowser({
  selected,
  onSelect
}: {
  selected: RoomManifestItem;
  onSelect: (roomId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase('en-US'));
  const groups = useMemo(() => {
    const byHall = new Map<string, RoomManifestItem[]>();
    for (const room of roomManifest) {
      const haystack = `${room.displayName} ${room.hall} ${room.roomType}`.toLocaleLowerCase('en-US');
      if (deferredQuery && !haystack.includes(deferredQuery)) continue;
      const rooms = byHall.get(room.hall);
      if (rooms) rooms.push(room);
      else byHall.set(room.hall, [room]);
    }
    return [...byHall.entries()];
  }, [deferredQuery]);

  return (
    <div className="room-browser">
      <label className="search-field">
        <span className="visually-hidden">search halls, rooms, or types</span>
        <input
          type="search"
          value={query}
          placeholder="search halls, rooms, or types"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p className="catalog-count">{roomManifest.length} representative room examples</p>
      <div className="room-results" aria-live="polite">
        {groups.length === 0 ? <p className="empty-state">no rooms match that search.</p> : null}
        {groups.map(([hall, rooms]) => {
          const headingId = `hall-${encodeURIComponent(hall)}`;
          return (
          <section key={hall} className="room-group" aria-labelledby={headingId}>
            <h3 id={headingId}>{lowerText(hall)}</h3>
            <div className="room-result-list">
              {rooms.map((room) => {
                const active = room.id === selected.id;
                return (
                  <button
                    key={room.id}
                    type="button"
                    className={`room-result${active ? ' is-current' : ''}`}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(room.id)}
                  >
                    <span>
                      <strong>{roomChoiceName(room.displayName, room.hall)}</strong>
                      <small>{lowerText(roomSummary(room.room))}</small>
                    </span>
                    <span className="room-result-check" aria-hidden="true">{active ? '✓' : '›'}</span>
                  </button>
                );
              })}
            </div>
          </section>
          );
        })}
      </div>
      <div className="project-callout project-callout--sheet">
        <strong>this catalog is incomplete.</strong>
        <p>help map every uc berkeley dorm and apartment so students can plan before move-in.</p>
        <a href={CONTRIBUTING_URL} target="_blank" rel="noreferrer">
          contribution guide <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>
  );
}

export function DetailsPanel({
  room,
  units,
  onUnitsChange
}: {
  room: RoomManifestItem;
  units: UnitSystem;
  onUnitsChange: (units: UnitSystem) => void;
}) {
  return (
    <div className="details-panel">
      <div className="unit-toggle" role="group" aria-label="display units">
        <button
          type="button"
          className={units === 'imperial' ? 'is-active' : ''}
          aria-pressed={units === 'imperial'}
          onClick={() => onUnitsChange('imperial')}
        >
          imperial
        </button>
        <button
          type="button"
          className={units === 'metric' ? 'is-active' : ''}
          aria-pressed={units === 'metric'}
          onClick={() => onUnitsChange('metric')}
        >
          metric
        </button>
      </div>
      <details open>
        <summary>room summary</summary>
        <div className="detail-section">
          <p className="room-summary-copy">{lowerText(roomSummary(room.room))}</p>
          <p>{lowerText(room.room.variation_warning ?? 'representative room; actual rooms vary.')}</p>
        </div>
      </details>
      <details>
        <summary>dimensions and confidence</summary>
        <DimensionList room={room} units={units} />
      </details>
      <details>
        <summary>sources and accuracy</summary>
        <div className="detail-section"><AccuracyPanel room={room} /></div>
      </details>
      <details>
        <summary>about this project</summary>
        <div className="detail-section">
          <p>
            nestometry is an incomplete, community-built catalog for planning what fits in uc berkeley housing.
          </p>
          <p>
            independent student project; not affiliated with or endorsed by uc berkeley, the regents, or the university of california.
          </p>
          <a href={CONTRIBUTING_URL} target="_blank" rel="noreferrer">
            contribute a room or correction <span aria-hidden="true">↗</span>
          </a>
        </div>
      </details>
    </div>
  );
}

export function LayersPanel({
  availableGroups,
  hiddenGroups,
  onToggle,
  quality,
  onQualityChange,
  wallFadeOn,
  onWallFadeChange,
  confidenceOn,
  onConfidenceChange
}: {
  availableGroups: FurnitureGroup[];
  hiddenGroups: Set<FurnitureGroup>;
  onToggle: (group: FurnitureGroup, visible: boolean) => void;
  quality: 'auto' | 'low' | 'balanced' | 'high';
  onQualityChange: (quality: 'auto' | 'low' | 'balanced' | 'high') => void;
  wallFadeOn: boolean;
  onWallFadeChange: (enabled: boolean) => void;
  confidenceOn: boolean;
  onConfidenceChange: (enabled: boolean) => void;
}) {
  return (
    <div className="layers-panel">
      <h3>room layers</h3>
      <label className="layer-option">
        <input type="checkbox" checked={wallFadeOn} onChange={(event) => onWallFadeChange(event.target.checked)} />
        <span>smart wall fade</span>
      </label>
      <label className="layer-option">
        <input type="checkbox" checked={confidenceOn} onChange={(event) => onConfidenceChange(event.target.checked)} />
        <span>confidence markers</span>
      </label>
      <FurnitureToggles
        availableGroups={availableGroups}
        hiddenGroups={hiddenGroups}
        onToggle={onToggle}
      />
      <h3>render quality</h3>
      <label className="select-field">
        <span className="visually-hidden">render quality</span>
        <select value={quality} onChange={(event) => onQualityChange(event.target.value as typeof quality)}>
          <option value="auto">automatic</option>
          <option value="low">low</option>
          <option value="balanced">balanced</option>
          <option value="high">high</option>
        </select>
      </label>
      <p className="field-help">automatic quality may step down when the room cannot maintain a smooth frame rate.</p>
    </div>
  );
}
