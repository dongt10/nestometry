import type { RoomManifestItem, Source } from '../data/assetManifest';
import { lowerText } from './presentation';

export function AccuracyPanel({ room: item }: { room: RoomManifestItem }) {
  const { room } = item;
  return (
    <div className="accuracy-panel">
      <div className="badge">{lowerText(room.accuracy_tier.replaceAll('_', ' '))}</div>
      {room.variation_warning ? <p className="warning">{lowerText(room.variation_warning)}</p> : null}

      <h3>sources</h3>
      <ul className="source-list">
        {room.sources.map((source: Source) => (
          <li key={source.id}>
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer">
                {lowerText(source.title)} <span aria-hidden="true">↗</span>
              </a>
            ) : (
              lowerText(source.title)
            )}
            <span className="source-meta">
              {lowerText(source.source_type.replaceAll('_', ' '))} · {source.confidence} confidence
            </span>
          </li>
        ))}
      </ul>

      <h3>notes</h3>
      <ul className="notes-list">
        {room.public_notes.map((note: string, index: number) => (
          <li key={index}>{lowerText(note)}</li>
        ))}
        <li>
          decorative items are illustrative and are not included with the room.
        </li>
      </ul>
    </div>
  );
}
