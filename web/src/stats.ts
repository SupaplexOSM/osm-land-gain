import { cellToBoundary, cellToLatLng, polygonToCells } from "h3-js";
import type { LngLatBounds, Map as MapLibreMap } from "maplibre-gl";
import type { CellsFile, CellView, FilterId, UserStat } from "./types";
import { unpack } from "./types";

export const DAY_MS = 86400000;

export type RecencyTier = 1 | 2 | 3 | 4 | 5;

export const RECENCY_LABEL: Record<RecencyTier, string> = {
  1: "Gegenwärtig aktiv",
  2: "Vor kurzem aktiv",
  3: "Vor einiger Zeit aktiv",
  4: "Vor längerer Zeit aktiv",
  5: "Früher aktiv",
};

export function recencyTier(lastTs: number, now = Date.now()): RecencyTier {
  if (!lastTs) return 5;
  const days = Math.max(0, (now - lastTs) / DAY_MS);
  if (days < 90) return 1;
  if (days < 180) return 2;
  if (days < 365) return 3;
  if (days < 365 * 3) return 4;
  return 5;
}

const winnerColorCache = new Map<FilterId, Map<number, number>>();

export function winnerColorByUid(data: CellsFile, filter: FilterId): Map<number, number> {
  const cached = winnerColorCache.get(filter);
  if (cached) return cached;
  const map = new Map<number, number>();
  for (const packed of Object.values(data.cells)) {
    const row = packed[filter];
    if (!row || row[6] === 1 || !row[0] || map.has(row[0])) continue;
    map.set(row[0], row[7]);
  }
  winnerColorCache.set(filter, map);
  return map;
}

export function cellView(data: CellsFile, h3: string, filter: FilterId): CellView | null {
  const packed = data.cells[h3]?.[filter];
  if (!packed) return null;
  return unpack(h3, packed);
}

export function cellsInBounds(bounds: LngLatBounds, res: number): string[] {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const polygon = [
    [sw.lat, sw.lng],
    [sw.lat, ne.lng],
    [ne.lat, ne.lng],
    [ne.lat, sw.lng],
  ];
  try {
    return polygonToCells(polygon, res);
  } catch {
    return [];
  }
}

/** Unique H3 ids currently painted in `h3-fill`; empty if tiles are not ready yet. */
export function visibleCellIds(map: MapLibreMap): string[] {
  if (!map.getLayer("h3-fill")) return [];
  const ids = new Set<string>();
  try {
    for (const f of map.queryRenderedFeatures(undefined, { layers: ["h3-fill"] })) {
      const h = f.properties?.h;
      if (typeof h === "string" && h) ids.add(h);
    }
  } catch {
    return [];
  }
  return [...ids];
}

export interface RankedUser {
  uid: number;
  name: string;
  score: number;
  lastTs: number;
  specialties: UserStat["specialties"];
  recency: RecencyTier;
}

export function viewportRanking(
  h3Ids: string[],
  data: CellsFile,
  users: Record<string, UserStat>,
  filter: FilterId,
  now = Date.now(),
): RankedUser[] {
  const acc = new Map<number, { score: number; lastTs: number }>();
  for (const id of h3Ids) {
    const packed = data.cells[id]?.[filter];
    if (!packed) continue;
    for (const row of packed[8]) {
      const prev = acc.get(row[0]);
      if (!prev) {
        acc.set(row[0], { score: row[1], lastTs: row[2] * 1000 });
      } else {
        prev.score += row[1];
        if (row[2] * 1000 > prev.lastTs) prev.lastTs = row[2] * 1000;
      }
    }
  }
  const ranked: RankedUser[] = [];
  for (const [uid, val] of acc) {
    const u = users[String(uid)];
    if (!u) continue;
    ranked.push({
      uid,
      name: u.name,
      score: val.score,
      lastTs: val.lastTs,
      specialties: u.specialties,
      recency: recencyTier(val.lastTs, now),
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export type ActivityLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const ACTIVITY_LEVEL_LABEL: Record<ActivityLevel, string> = {
  0: "keine Aktivität",
  1: "sehr geringe Aktivität",
  2: "geringe Aktivität",
  3: "eher geringe Aktivität",
  4: "mittlere Aktivität",
  5: "eher hohe Aktivität",
  6: "hohe Aktivität",
  7: "sehr hohe Aktivität",
};

export const ACTIVITY_LEVEL_ORDER: ActivityLevel[] = [0, 1, 2, 3, 4, 5, 6, 7];

export function activityLevel(value: number): ActivityLevel {
  if (value <= 0) return 0;
  if (value >= 0.8) return 7;
  if (value >= 0.62) return 6;
  if (value >= 0.48) return 5;
  if (value >= 0.34) return 4;
  if (value >= 0.2) return 3;
  if (value >= 0.1) return 2;
  return 1;
}

/** Compressed scale for the viewport median so modest deviations from ~50% already read as high/low. */
export function viewportActivityLevel(value: number): ActivityLevel {
  if (value <= 0) return 0;
  if (value >= 0.7) return 7;
  if (value >= 0.62) return 6;
  if (value >= 0.54) return 5;
  if (value >= 0.46) return 4;
  if (value >= 0.4) return 3;
  if (value >= 0.32) return 2;
  return 1;
}

export function sparseThreshold(data: CellsFile, filter: FilterId): number {
  const sc = data.meta.sparse_count;
  const raw = typeof sc === "number" ? sc : (sc[filter] ?? sc.all ?? 20);
  return Math.max(1, raw);
}

/** Unsmoothed cell activity: mean object recency, scaled down when object count is below the sparse threshold. */
export function cellActivity(view: CellView | null, threshold: number): number {
  if (!view || view.count <= 0) return 0;
  return view.currentness * Math.min(1, view.count / threshold);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ViewportSummary {
  mappers: number;
  objects: number;
  currentness: number;
  level: ActivityLevel;
}

export function viewportSummary(h3Ids: string[], data: CellsFile, filter: FilterId): ViewportSummary {
  const threshold = sparseThreshold(data, filter);
  const values: number[] = [];
  let objects = 0;
  const mappers = new Set<number>();
  for (const id of h3Ids) {
    const packed = data.cells[id]?.[filter];
    if (!packed) continue;
    const count = packed[3];
    values.push(count <= 0 ? 0 : packed[2] * Math.min(1, count / threshold));
    if (count <= 0) continue;
    objects += count;
    for (const row of packed[8]) {
      if (row[1] > 0) mappers.add(row[0]);
    }
  }
  const currentness = median(values);
  return {
    mappers: mappers.size,
    objects,
    currentness,
    level: viewportActivityLevel(currentness),
  };
}

export function formatAge(lastTs: number, now = Date.now()): string {
  if (!lastTs) return "unbekannt";
  const days = Math.max(0, Math.floor((now - lastTs) / DAY_MS));
  if (days < 1) return "heute";
  if (days === 1) return "gestern";
  if (days < 30) return `vor ${days} Tagen`;
  const months = Math.floor(days / 30);
  if (months < 24) return `vor ${months} Monat${months === 1 ? "" : "en"}`;
  const years = Math.floor(days / 365);
  return `vor ${years} Jahr${years === 1 ? "" : "en"}`;
}

export function formatScore(score: number): string {
  if (score >= 100) return score.toFixed(0);
  if (score >= 10) return score.toFixed(1);
  return score.toFixed(2);
}

export function flagLngLat(h3: string): [number, number] {
  const [lat, lng] = cellToLatLng(h3);
  return [lng, lat];
}

const maxScoreCache = new Map<FilterId, number>();

export function maxActivityScore(data: CellsFile, filter: FilterId): number {
  const cached = maxScoreCache.get(filter);
  if (cached != null) return cached;
  let hi = 0;
  for (const rec of Object.values(data.cells)) {
    const packed = rec[filter];
    if (!packed) continue;
    for (const row of packed[8]) {
      if (row[1] > hi) hi = row[1];
    }
  }
  const max = hi > 0 ? hi : 1;
  maxScoreCache.set(filter, max);
  return max;
}

const maxCountCache = new Map<FilterId, number>();

export function maxFeatureCount(data: CellsFile, filter: FilterId): number {
  const cached = maxCountCache.get(filter);
  if (cached != null) return cached;
  let hi = 0;
  for (const rec of Object.values(data.cells)) {
    const packed = rec[filter];
    if (!packed) continue;
    if (packed[3] > hi) hi = packed[3];
  }
  const max = hi > 0 ? hi : 1;
  maxCountCache.set(filter, max);
  return max;
}

/** 0–1 log1p scale against the dataset max for this filter. */
export function featureStrength(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  const t = Math.log1p(count) / Math.log1p(maxCount);
  return Math.max(0, Math.min(1, t));
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

export function featureLegendMarks(maxCount: number): Array<[number, string]> {
  const max = Math.max(1, maxCount);
  const marks: Array<[number, string]> = [[0, "0"]];
  for (const n of [1, 10, 100, 1000, 10000, 100000]) {
    if (n < max * 0.72) marks.push([featureStrength(n, max), formatCount(n)]);
  }
  marks.push([1, formatCount(max)]);
  return marks;
}

/** 0–1 from a fixed log scale against the dataset max (not the viewport). */
export function activityStrength(score: number, maxScore: number): number {
  if (score <= 0 || maxScore <= 0) return 0;
  const lo = Math.max(0.05, maxScore * 0.002);
  const span = Math.log(maxScore) - Math.log(lo);
  if (span <= 0) return 1;
  const t = (Math.log(Math.max(score, lo)) - Math.log(lo)) / span;
  return Math.max(0, Math.min(1, t));
}

export const ACTIVITY_DOT_LEVELS = 6;

function hexRing(cell: string): number[][] {
  const ring = cellToBoundary(cell, true);
  if (!ring.length) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

const activityCellsByUid = new Map<FilterId, Map<number, string[]>>();

export function activityCellsForFilter(data: CellsFile, filter: FilterId): Map<number, string[]> {
  const cached = activityCellsByUid.get(filter);
  if (cached) return cached;
  const idx = new Map<number, string[]>();
  for (const [cell, rec] of Object.entries(data.cells)) {
    const packed = rec[filter];
    if (!packed) continue;
    for (const row of packed[8]) {
      if (row[1] <= 0) continue;
      const list = idx.get(row[0]);
      if (list) list.push(cell);
      else idx.set(row[0], [cell]);
    }
  }
  activityCellsByUid.set(filter, idx);
  return idx;
}

export function userActivityCollection(
  data: CellsFile,
  filter: FilterId,
  uids: number[],
  colorByUid?: Map<number, number>,
): {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { lvl: number; t: number; ci: number; uid: number };
    geometry: { type: "Polygon"; coordinates: number[][][] };
  }>;
} {
  const selected = new Set(uids);
  const maxScore = maxActivityScore(data, filter);
  const features: Array<{
    type: "Feature";
    properties: { lvl: number; t: number; ci: number; uid: number };
    geometry: { type: "Polygon"; coordinates: number[][][] };
  }> = [];
  if (!selected.size) return { type: "FeatureCollection", features };
  const index = activityCellsForFilter(data, filter);
  const ringCache = new Map<string, number[][]>();
  for (const uid of selected) {
    const cells = index.get(uid);
    if (!cells) continue;
    for (const cell of cells) {
      const packed = data.cells[cell]?.[filter];
      if (!packed) continue;
      let score = 0;
      for (const row of packed[8]) {
        if (row[0] === uid) {
          score = row[1];
          break;
        }
      }
      if (score <= 0) continue;
      let ring = ringCache.get(cell);
      if (!ring) {
        ring = hexRing(cell);
        ringCache.set(cell, ring);
      }
      if (ring.length < 4) continue;
      const t = activityStrength(score, maxScore);
      const lvl = Math.max(0, Math.min(ACTIVITY_DOT_LEVELS - 1, Math.round(t * (ACTIVITY_DOT_LEVELS - 1))));
      const ci = colorByUid?.get(uid) ?? 0;
      features.push({
        type: "Feature",
        properties: { lvl, t, ci, uid },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
  }
  features.sort((a, b) => a.properties.t - b.properties.t);
  return { type: "FeatureCollection", features };
}
