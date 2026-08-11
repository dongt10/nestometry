import type { RoomManifestItem, RoomObject } from '../data/assetManifest';
import { formatDimension, type Dimension, type FormattedDimension } from '../data/dimensions';

function DimCell({ formatted }: { formatted: FormattedDimension }) {
  return (
    <span className="dim-cell">
      <span className="dim-value">{formatted.text}</span>
      <span className={`dim-badge dim-badge--${formatted.badge}`}>{formatted.badge}</span>
    </span>
  );
}

function DimRow({
  label,
  count,
  x,
  y,
  z
}: {
  label: string;
  count?: number;
  x?: Dimension;
  y?: Dimension;
  z?: Dimension;
}) {
  return (
    <tr>
      <th scope="row">
        {label}
        {count && count > 1 ? <span className="dim-count"> ×{count}</span> : null}
      </th>
      <td>
        <DimCell formatted={formatDimension(x)} />
      </td>
      <td>
        <DimCell formatted={formatDimension(y)} />
      </td>
      <td>
        <DimCell formatted={formatDimension(z)} />
      </td>
    </tr>
  );
}

export function DimensionList({ room: item }: { room: RoomManifestItem }) {
  const { room } = item;
  return (
    <section className="dimension-panel">
      <h2>Dimensions</h2>
      <p className="dimension-disclaimer">
        Values are unverified unless labeled <strong>verified</strong>. Estimated and unknown values must not be
        treated as exact.
      </p>

      <h3>Room shell</h3>
      <table className="dim-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Width</th>
            <th scope="col">Depth</th>
            <th scope="col">Height</th>
          </tr>
        </thead>
        <tbody>
          <DimRow label="Room" x={room.room_shell.width} y={room.room_shell.depth} z={room.room_shell.height} />
        </tbody>
      </table>

      <h3>Objects</h3>
      <table className="dim-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">X</th>
            <th scope="col">Y</th>
            <th scope="col">Z</th>
          </tr>
        </thead>
        <tbody>
          {room.objects.map((obj: RoomObject) => (
            <DimRow
              key={obj.id}
              label={obj.label}
              count={obj.count}
              x={obj.dimensions_m?.x}
              y={obj.dimensions_m?.y}
              z={obj.dimensions_m?.z}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}
