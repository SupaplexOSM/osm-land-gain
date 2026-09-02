import { cellToLatLng, cellsToMultiPolygon } from "h3-js";
import { FILTERS, type FilterId, type UserStat } from "./types";

type Feature = {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: { type: string; coordinates: unknown };
};

export type OverlayCollection = { type: "FeatureCollection"; features: Feature[] };

/** One connected territory as shipped in overlays.json.gz. */
export type PackedTerritory = {
  uid: number;
  cells: string[];
  label: string;
  score: number;
};

export type OverlayBuild = {
  outlines: OverlayCollection;
  labels: OverlayCollection;
  territoryUids: Set<number>;
};

export type PackedOverlays = Partial<Record<FilterId, PackedTerritory[]>>;

function isPackedTerritory(value: unknown): value is PackedTerritory {
  if (!value || typeof value !== "object") return false;
  const item = value as PackedTerritory;
  return typeof item.uid === "number" && Array.isArray(item.cells) && typeof item.score === "number";
}

export function parsePackedOverlays(raw: unknown): PackedOverlays | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: PackedOverlays = {};
  for (const filt of FILTERS) {
    const arr = src[filt];
    if (!Array.isArray(arr)) continue;
    out[filt] = arr.filter(isPackedTerritory);
  }
  return Object.keys(out).length ? out : null;
}

export function overlaysFromPacked(
  packed: PackedTerritory[],
  users: Record<string, UserStat>,
): OverlayBuild {
  const outlines: Feature[] = [];
  const labels: Feature[] = [];
  const territoryUids = new Set<number>();
  for (const item of packed) {
    if (!item?.cells?.length) continue;
    territoryUids.add(item.uid);
    const name = users[String(item.uid)]?.name ?? `#${item.uid}`;
    let polys;
    try {
      polys = cellsToMultiPolygon(item.cells, true);
    } catch {
      continue;
    }
    outlines.push({
      type: "Feature",
      properties: { uid: item.uid, n: item.cells.length },
      geometry: { type: "MultiPolygon", coordinates: polys },
    });
    const labelCellId = item.label && item.cells.includes(item.label) ? item.label : item.cells[0]!;
    const [lat, lng] = cellToLatLng(labelCellId);
    labels.push({
      type: "Feature",
      properties: { name, n: item.cells.length, uid: item.uid, score: item.score },
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
  }
  labels.sort((a, b) => Number(b.properties.score) - Number(a.properties.score));
  return {
    outlines: { type: "FeatureCollection", features: outlines },
    labels: { type: "FeatureCollection", features: labels },
    territoryUids,
  };
}
