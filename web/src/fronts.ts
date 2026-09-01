import {
  cellToLatLng,
  cellToLocalIj,
  directedEdgeToBoundary,
  getDirectedEdgeDestination,
  gridDisk,
  originToDirectedEdges,
} from "h3-js";
import type { OverlayCollection } from "./territories";
import { FILTERS, type CellsFile, type FilterId, type UserStat } from "./types";

type Ring = [number, number][];

type Feature = {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: { type: "Polygon"; coordinates: Ring[] };
};

/** Compact occupancy: h3 → username per filter. Missing filter = neutral. */
export type SnapshotOwners = Map<string, Partial<Record<FilterId, string>>>;

export type FrontSegment = {
  uid: number;
  depth: 1 | 2 | 3;
  a: [number, number];
  b: [number, number];
  tx: number;
  ty: number;
  ox: number;
  oy: number;
  edgeLen: number;
  cos: number;
};

export const EMPTY_FRONTS: OverlayCollection = { type: "FeatureCollection", features: [] };

/** Below this zoom teeth scale with the map; above, they grow slower than geographic. */
export const FRONT_REF_ZOOM = 12;
/** Pixel growth exponent past ref zoom: 1 = with the map, 0 = frozen. */
const TOOTH_ZOOM_GROWTH = 0.4;
const TOOTH_COUNT_CAP = 48;

/** Size 2/3 match the former 1/2 visuals, then shortened; size 1 is the small step.
 *  Height steps ~0.14 / 0.23 / 0.32. Pointy bases (height/base ≈ 1.65).
 *  Tooth count 5 / 4 / 3 so larger teeth sit in fewer, still tight slots. */
const TOOTH_HEIGHT = [0, 0.14, 0.23, 0.32] as const;
const TOOTH_BASE = [0, 0.085, 0.14, 0.195] as const;
const TOOTH_COUNT = [0, 5, 4, 3] as const;

function cellOwner(
  packed: CellsFile["cells"][string][FilterId] | undefined,
  users: Record<string, UserStat>,
): { name: string; uid: number } | null {
  if (!packed) return null;
  const uid = packed[0];
  if (!uid || packed[6] === 1) return null;
  const name = users[String(uid)]?.name;
  if (!name) return null;
  return { name, uid };
}

function neighborsOf(cell: string): string[] {
  try {
    return gridDisk(cell, 1);
  } catch {
    return [];
  }
}

/** Keep username occupancy for every filter so snapshot switches stay cheap. */
export function extractSnapshotOwners(
  data: CellsFile,
  users: Record<string, UserStat>,
): SnapshotOwners {
  const filters = (data.meta.filters?.length ? data.meta.filters : FILTERS) as FilterId[];
  const out: SnapshotOwners = new Map();
  for (const [h3, rec] of Object.entries(data.cells)) {
    const row: Partial<Record<FilterId, string>> = {};
    let any = false;
    for (const filter of filters) {
      const hit = cellOwner(rec[filter], users);
      if (!hit) continue;
      row[filter] = hit.name;
      any = true;
    }
    if (any) out.set(h3, row);
  }
  return out;
}

function prevOwner(previous: SnapshotOwners, cell: string, filter: FilterId): string | null {
  return previous.get(cell)?.[filter] ?? null;
}

function clampDepth(n: number): 1 | 2 | 3 {
  if (n <= 1) return 1;
  if (n === 2) return 2;
  return 3;
}

export function toothZoomScale(zoom: number): number {
  const dz = Math.max(0, zoom - FRONT_REF_ZOOM);
  return 2 ** ((TOOTH_ZOOM_GROWTH - 1) * dz);
}

function toothCountForZoom(depth: 1 | 2 | 3, zoom: number): number {
  const base = TOOTH_COUNT[depth];
  const dz = Math.max(0, zoom - FRONT_REF_ZOOM);
  const n = base * 2 ** ((1 - TOOTH_ZOOM_GROWTH) * dz);
  return Math.max(base, Math.min(TOOTH_COUNT_CAP, Math.round(n)));
}

/** Connected newly owned cells around start (stops at land the user already had). */
function newLandComponent(
  start: string,
  user: string,
  curOwner: Map<string, string>,
  previous: SnapshotOwners,
  filter: FilterId,
): string[] {
  const cells: string[] = [];
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cell = stack.pop()!;
    cells.push(cell);
    for (const n of neighborsOf(cell)) {
      if (seen.has(n) || n === cell) continue;
      if (curOwner.get(n) !== user) continue;
      if (prevOwner(previous, n, filter) === user) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return cells;
}

/** Narrower bounding-box side of an island, in hex cells. */
function islandExtent(cells: string[]): 1 | 2 | 3 {
  if (cells.length <= 2) return 1;
  const origin = cells[0]!;
  let minI = Infinity;
  let maxI = -Infinity;
  let minJ = Infinity;
  let maxJ = -Infinity;
  let ok = 0;
  for (const cell of cells) {
    try {
      const { i, j } = cellToLocalIj(origin, cell);
      minI = Math.min(minI, i);
      maxI = Math.max(maxI, i);
      minJ = Math.min(minJ, j);
      maxJ = Math.max(maxJ, j);
      ok += 1;
    } catch {
      /* some H3 pairs have no local IJ */
    }
  }
  if (ok < 2) return cells.length <= 6 ? 2 : 3;
  return clampDepth(Math.min(maxI - minI + 1, maxJ - minJ + 1));
}

/** Distance from a newly owned border cell to the user's previous territory. */
function advanceDepth(
  start: string,
  user: string,
  curOwner: Map<string, string>,
  previous: SnapshotOwners,
  filter: FilterId,
  cache: Map<string, 1 | 2 | 3>,
): 1 | 2 | 3 {
  const hit = cache.get(start);
  if (hit) return hit;
  const dist = new Map<string, number>([[start, 1]]);
  const queue = [start];
  let found = 0;
  for (let i = 0; i < queue.length && !found; i++) {
    const cell = queue[i]!;
    const d = dist.get(cell)!;
    for (const n of neighborsOf(cell)) {
      if (n === cell) continue;
      if (prevOwner(previous, n, filter) === user) {
        found = d;
        break;
      }
      if (curOwner.get(n) === user && prevOwner(previous, n, filter) !== user && !dist.has(n) && d < 3) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  if (found) {
    const depth = clampDepth(found);
    cache.set(start, depth);
    return depth;
  }
  const island = newLandComponent(start, user, curOwner, previous, filter);
  const depth = islandExtent(island);
  for (const cell of island) cache.set(cell, depth);
  return depth;
}

/**
 * Thickness of land this user lost, from the current outline outward.
 * A long 1-hex strip stays 1; a 2-hex bite reaches 2.
 */
function lostOutwardDepth(
  curOwner: Map<string, string>,
  previous: SnapshotOwners,
  filter: FilterId,
): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const [cell, user] of curOwner) {
    for (const n of neighborsOf(cell)) {
      if (n === cell || dist.has(n)) continue;
      if (curOwner.get(n) === user) continue;
      if (prevOwner(previous, n, filter) !== user) continue;
      dist.set(n, 1);
      queue.push(n);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i]!;
    const d = dist.get(cell)!;
    if (d >= 3) continue;
    const user = prevOwner(previous, cell, filter);
    if (!user) continue;
    for (const n of neighborsOf(cell)) {
      if (n === cell || dist.has(n)) continue;
      if (prevOwner(previous, n, filter) !== user) continue;
      if (curOwner.get(n) === user) continue;
      dist.set(n, d + 1);
      queue.push(n);
    }
  }
  const outward = new Map<string, number>();
  const byDist: string[][] = [[], [], [], []];
  for (const [cell, d] of dist) {
    const cap = Math.min(3, d);
    byDist[cap]!.push(cell);
    outward.set(cell, cap);
  }
  for (let d = 3; d >= 1; d--) {
    for (const cell of byDist[d]!) {
      let best = outward.get(cell) ?? d;
      for (const n of neighborsOf(cell)) {
        const nd = dist.get(n);
        if (nd == null || nd <= d) continue;
        best = Math.max(best, outward.get(n) ?? nd);
      }
      outward.set(cell, Math.min(3, best));
    }
  }
  return outward;
}

function edgeFrame(
  edge: string,
  origin: string,
  dest: string,
): Omit<FrontSegment, "uid" | "depth"> | null {
  let boundary: [number, number][];
  try {
    boundary = directedEdgeToBoundary(edge, true) as [number, number][];
  } catch {
    return null;
  }
  if (!boundary || boundary.length < 2) return null;
  const a = boundary[0]!;
  const b = boundary[1]!;
  let oLat: number;
  let oLng: number;
  let dLat: number;
  let dLng: number;
  try {
    [oLat, oLng] = cellToLatLng(origin);
    [dLat, dLng] = cellToLatLng(dest);
  } catch {
    return null;
  }
  const midLat = (a[1] + b[1]) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180) || 1e-6;
  const ex = (b[0] - a[0]) * cos;
  const ey = b[1] - a[1];
  const edgeLen = Math.hypot(ex, ey);
  if (edgeLen < 1e-12) return null;
  const tx = ex / edgeLen;
  const ty = ey / edgeLen;
  let ox = -ty;
  let oy = tx;
  const vx = (dLng - oLng) * cos;
  const vy = dLat - oLat;
  if (ox * vx + oy * vy < 0) {
    ox = -ox;
    oy = -oy;
  }
  return { a, b, tx, ty, ox, oy, edgeLen, cos };
}

function toothRingAt(
  lng: number,
  lat: number,
  seg: FrontSegment,
  half: number,
  height: number,
): Ring {
  const invCos = 1 / seg.cos;
  const baseL: [number, number] = [lng - seg.tx * half * invCos, lat - seg.ty * half];
  const baseR: [number, number] = [lng + seg.tx * half * invCos, lat + seg.ty * half];
  const apex: [number, number] = [lng + seg.ox * height * invCos, lat + seg.oy * height];
  return [baseL, apex, baseR, baseL];
}

export function frontTeethGeoJSON(segments: FrontSegment[], zoom: number): OverlayCollection {
  if (!segments.length) return EMPTY_FRONTS;
  const scale = toothZoomScale(zoom);
  const features: Feature[] = [];
  for (const seg of segments) {
    const n = toothCountForZoom(seg.depth, zoom);
    const height = seg.edgeLen * TOOTH_HEIGHT[seg.depth] * scale;
    const half = (seg.edgeLen * TOOTH_BASE[seg.depth] * scale) / 2;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const lng = seg.a[0] + (seg.b[0] - seg.a[0]) * t;
      const lat = seg.a[1] + (seg.b[1] - seg.a[1]) * t;
      features.push({
        type: "Feature",
        properties: { uid: seg.uid, depth: seg.depth },
        geometry: { type: "Polygon", coordinates: [toothRingAt(lng, lat, seg, half, height)] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

export function buildFrontSegments(
  data: CellsFile,
  users: Record<string, UserStat>,
  previous: SnapshotOwners | null,
  filter: FilterId,
): FrontSegment[] {
  if (!previous) return [];

  const curOwner = new Map<string, string>();
  const curUid = new Map<string, number>();
  for (const [h3, rec] of Object.entries(data.cells)) {
    const hit = cellOwner(rec[filter], users);
    if (!hit) continue;
    curOwner.set(h3, hit.name);
    curUid.set(h3, hit.uid);
  }

  const lostDepth = lostOutwardDepth(curOwner, previous, filter);
  const advanceCache = new Map<string, 1 | 2 | 3>();
  const segments: FrontSegment[] = [];

  for (const [cell, user] of curOwner) {
    const uid = curUid.get(cell);
    if (!uid) continue;
    let edges: string[];
    try {
      edges = originToDirectedEdges(cell);
    } catch {
      continue;
    }
    const prevCell = prevOwner(previous, cell, filter);
    for (const edge of edges) {
      let dest: string;
      try {
        dest = getDirectedEdgeDestination(edge);
      } catch {
        continue;
      }
      if (curOwner.get(dest) === user) continue;
      const prevDest = prevOwner(previous, dest, filter);
      if (prevCell === user && prevDest !== user) continue;

      let depth: 1 | 2 | 3;
      if (prevCell !== user) {
        depth = advanceDepth(cell, user, curOwner, previous, filter, advanceCache);
      } else {
        if (curOwner.has(dest)) continue;
        depth = clampDepth(lostDepth.get(dest) ?? 1);
      }
      const frame = edgeFrame(edge, cell, dest);
      if (!frame) continue;
      segments.push({ uid, depth, ...frame });
    }
  }

  return segments;
}
