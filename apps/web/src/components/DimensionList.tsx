import type { RoomManifestItem, RoomObject } from '../data/assetManifest';
import {
  formatDimensionForUnit,
  type Dimension,
  type FormattedDimension,
  type UnitSystem
} from '../data/dimensions';
import { lowerText } from './presentation';

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
  z,
  units
}: {
  label: string;
  count?: number;
  x?: Dimension;
  y?: Dimension;
  z?: Dimension;
  units: UnitSystem;
}) {
  return (
    <tr>
      <th scope="row">
        {lowerText(label)}
        {count && count > 1 ? <span className="dim-count"> ×{count}</span> : null}
      </th>
      <td>
        <DimCell formatted={formatDimensionForUnit(x, units)} />
      </td>
      <td>
        <DimCell formatted={formatDimensionForUnit(y, units)} />
      </td>
      <td>
        <DimCell formatted={formatDimensionForUnit(z, units)} />
      </td>
    </tr>
  );
}

export function DimensionList({ room: item, units }: { room: RoomManifestItem; units: UnitSystem }) {
  const { room } = item;
  return (
    <section className="dimension-panel">
      <p className="dimension-disclaimer">
        official dimensions are unknown. model estimates are planning guidance, not exact measurements.
      </p>

      <h3>official room dimensions</h3>
      <table className="dim-table">
        <thead>
          <tr>
            <th scope="col">item</th>
            <th scope="col">width</th>
            <th scope="col">depth</th>
            <th scope="col">height</th>
          </tr>
        </thead>
        <tbody>
          <DimRow label="room" units={units} x={room.room_shell.width} y={room.room_shell.depth} z={room.room_shell.height} />
        </tbody>
      </table>

      <h3>visualization estimate</h3>
      <table className="dim-table">
        <thead>
          <tr>
            <th scope="col">item</th>
            <th scope="col">width</th>
            <th scope="col">depth</th>
            <th scope="col">height</th>
          </tr>
        </thead>
        <tbody>
          <DimRow
            label="model shell"
            units={units}
            x={room.visualization_shell.width}
            y={room.visualization_shell.depth}
            z={room.visualization_shell.height}
          />
        </tbody>
      </table>

      <h3>furniture</h3>
      <table className="dim-table">
        <thead>
          <tr>
            <th scope="col">item</th>
            <th scope="col">x</th>
            <th scope="col">y</th>
            <th scope="col">z</th>
          </tr>
        </thead>
        <tbody>
          {room.objects.map((obj: RoomObject) => (
            <DimRow
              key={obj.id}
              label={obj.label}
              count={obj.count}
              units={units}
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
