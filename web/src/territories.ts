import { cellToLatLng, cellsToMultiPolygon, gridDisk } from "h3-js";
import type { CellsFile, FilterId, UserStat } from "./types";

type Feature = {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: { type: string; coordinates: unknown };
};

export type OverlayCollection = { type: "FeatureCollection"; features: Feature[] };

/** Cell furthest from the territory edge (discrete pole of inaccessibility). */
function labelCell(comp: string[]): string {
  const set = new Set(comp);
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const cell of comp) {
    let border = false;
    for (const n of gridDisk(cell, 1)) {
      if (n !== cell && !set.has(n)) {
        border = true;
        break;
      }
    }
    if (border) {
      dist.set(cell, 0);
      queue.push(cell);
    }
  }
  if (!queue.length) return comp[0]!;
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i]!;
    const d = dist.get(cell)!;
    for (const n of gridDisk(cell, 1)) {
      if (!set.has(n) || dist.has(n)) continue;
      dist.set(n, d + 1);
      queue.push(n);
    }
  }
  let clat = 0;
  let clng = 0;
  for (const cell of comp) {
    const [la, lo] = cellToLatLng(cell);
    clat += la;
    clng += lo;
  }
  clat /= comp.length;
  clng /= comp.length;
  let best = comp[0]!;
  let bestD = -1;
  let bestDist2 = Infinity;
  for (const cell of comp) {
    const d = dist.get(cell) ?? 0;
    const [la, lo] = cellToLatLng(cell);
    const dist2 = (la - clat) ** 2 + (lo - clng) ** 2;
    if (d > bestD || (d === bestD && dist2 < bestDist2)) {
      best = cell;
      bestD = d;
      bestDist2 = dist2;
    }
  }
  return best;
}

function connectedComponents(cells: string[]): string[][] {
  const set = new Set(cells);
  const visited = new Set<string>();
  const comps: string[][] = [];
  for (const start of cells) {
    if (visited.has(start)) continue;
    const stack = [start];
    const comp: string[] = [];
    while (stack.length) {
      const cell = stack.pop()!;
      if (visited.has(cell)) continue;
      visited.add(cell);
      comp.push(cell);
      for (const n of gridDisk(cell, 1)) {
        if (set.has(n) && !visited.has(n)) stack.push(n);
      }
    }
    if (comp.length) comps.push(comp);
  }
  return comps;
}

export function buildTerritoryOverlays(
  data: CellsFile,
  filter: FilterId,
  users: Record<string, UserStat>,
): { outlines: OverlayCollection; labels: OverlayCollection; territoryUids: Set<number> } {
  const byUid = new Map<number, string[]>();
  for (const [h3, rec] of Object.entries(data.cells)) {
    const packed = rec[filter];
    if (!packed) continue;
    const winner = packed[0];
    const sparse = packed[6] === 1;
    if (!winner || sparse) continue;
    const list = byUid.get(winner);
    if (list) list.push(h3);
    else byUid.set(winner, [h3]);
  }

  const outlines: Feature[] = [];
  const labels: Feature[] = [];
  for (const [uid, cells] of byUid) {
    const name = users[String(uid)]?.name ?? `#${uid}`;
    for (const comp of connectedComponents(cells)) {
      let polys;
      try {
        polys = cellsToMultiPolygon(comp, true);
      } catch {
        continue;
      }
      outlines.push({
        type: "Feature",
        properties: { uid, n: comp.length },
        geometry: { type: "MultiPolygon", coordinates: polys },
      });
      let score = 0;
      for (const cell of comp) {
        const packed = data.cells[cell]?.[filter];
        if (!packed) continue;
        const top = packed[8];
        let found = false;
        if (Array.isArray(top)) {
          for (const row of top) {
            if (row[0] === uid) {
              score += row[1];
              found = true;
              break;
            }
          }
        }
        if (!found && packed[0] === uid) score += packed[1];
      }
      const [lat, lng] = cellToLatLng(labelCell(comp));
      labels.push({
        type: "Feature",
        properties: { name, n: comp.length, uid, score },
        geometry: { type: "Point", coordinates: [lng, lat] },
      });
    }
  }

  labels.sort((a, b) => Number(b.properties.score) - Number(a.properties.score));
  return {
    outlines: { type: "FeatureCollection", features: outlines },
    labels: { type: "FeatureCollection", features: labels },
    territoryUids: new Set(byUid.keys()),
  };
}
