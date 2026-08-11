import type { RoomManifestItem, Source } from '../data/assetManifest';

export function AccuracyPanel({ room: item }: { room: RoomManifestItem }) {
  const { room } = item;
  return (
    <aside className="accuracy-panel">
      <h2>Accuracy &amp; sources</h2>
      <div className="badge">{room.accuracy_tier.replaceAll('_', ' ')}</div>
      {room.variation_warning ? <p className="warning">{room.variation_warning}</p> : null}

      <h3>Sources</h3>
      <ul className="source-list">
        {room.sources.map((source: Source) => (
          <li key={source.id}>
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>
            ) : (
              source.title
            )}
            <span className="source-meta">
              {source.source_type.replaceAll('_', ' ')} · {source.confidence} confidence
            </span>
          </li>
        ))}
      </ul>

      <h3>Notes</h3>
      <ul className="notes-list">
        {room.public_notes.map((note: string, index: number) => (
          <li key={index}>{note}</li>
        ))}
        <li>
          Decorative items (bedding, rug, desk items, curtains) are illustrative only
          and not included with the room.
        </li>
      </ul>
    </aside>
  );
}
