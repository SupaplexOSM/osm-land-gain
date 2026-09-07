import { cellToBoundary, cellToLatLng, polygonToCells } from "h3-js";
import type { LngLatBounds, Map as MapLibreMap } from "maplibre-gl";
import type { TopUsers } from "./topusers";
import type { CellStats, CellView, FilterId, SnapshotCore, SnapshotMeta, UserStat } from "./types";
import { cellStatsFromTile } from "./types";

export const DAY_MS = 86400000;

/** Viewport label "Gegenwärtig aktiv": last touch before this many days of the snapshot. */
export const CURRENT_ACTIVITY_DAYS = 40;
/** Cell-panel age string: anything younger than this is just "vor kurzem". */
export const CELL_RECENT_DAYS = 120;

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
  if (days < CURRENT_ACTIVITY_DAYS) return 1;
  if (days < 180) return 2;
  if (days < 365) return 3;
  if (days < 365 * 3) return 4;
  return 5;
}

const winnerColorCache = new Map<FilterId, Map<number, number>>();

/** Drop filter-keyed caches after a snapshot switch so they are not reused stale. */
export function clearStatsCaches(): void {
  winnerColorCache.clear();
}

/** uid → palette index, unpacked from the flat pairs the pipeline precomputes. */
export function winnerColorByUid(core: SnapshotCore, filter: FilterId): Map<number, number> {
  const cached = winnerColorCache.get(filter);
  if (cached) return cached;
  const map = new Map<number, number>();
  const flat = core.colors?.[filter] ?? [];
  for (let i = 0; i + 1 < flat.length; i += 2) map.set(flat[i]!, flat[i + 1]!);
  winnerColorCache.set(filter, map);
  return map;
}

/** Hex fill layers, in the order they were added to the style. */
const H3_LAYERS = ["h3-fill", "h3-fill-sparse", "h3-fill-dim"];

function presentLayers(map: MapLibreMap): string[] {
  return H3_LAYERS.filter((id) => map.getLayer(id));
}

/**
 * Cells currently painted, decoded from their tile properties.
 * A hex clipped across tile borders shows up more than once, so dedupe by id.
 */
export function visibleCellStats(map: MapLibreMap, filter: FilterId): CellStats[] {
  const layers = presentLayers(map);
  if (!layers.length) return [];
  const seen = new Map<string, CellStats>();
  try {
    for (const feature of map.queryRenderedFeatures(undefined, { layers })) {
      const props = feature.properties as Record<string, unknown> | null;
      if (!props) continue;
      const stats = cellStatsFromTile(props, filter);
      if (stats && !seen.has(stats.h3)) seen.set(stats.h3, stats);
    }
  } catch {
    return [];
  }
  return [...seen.values()];
}

/** One cell's numbers from the loaded tiles, or null if it is not in them. */
export function cellStatsFor(map: MapLibreMap, h3: string, filter: FilterId): CellStats | null {
  if (!map.getSource("h3")) return null;
  try {
    const hits = map.querySourceFeatures("h3", {
      sourceLayer: "h3",
      filter: ["==", ["get", "h"], h3],
    });
    for (const hit of hits) {
      const stats = cellStatsFromTile((hit.properties ?? {}) as Record<string, unknown>, filter);
      if (stats) return stats;
    }
  } catch {
    return null;
  }
  return null;
}

export function cellView(
  stats: CellStats | null,
  filter: FilterId,
  topUsers: TopUsers | null,
): CellView | null {
  if (!stats) return null;
  return { ...stats, top: topUsers ? topUsers.rows(stats.h3, filter) : null };
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

export interface RankedUser {
  uid: number;
  name: string;
  score: number;
  lastTs: number;
  specialties: UserStat["specialties"];
  recency: RecencyTier;
  /** 1-based rank in the full viewport list. */
  rank: number;
  newcomer: boolean;
}

export const NEWCOMER_MIN_RECENT = 25;
export const NEWCOMER_SCORE_SHARE = 0.9;
/** Must have a last-editor touch in the visible cells within this many days. */
export const NEWCOMER_VIEWPORT_DAYS = 365;

export function isNewcomer(user: UserStat | undefined): boolean {
  if (!user) return false;
  const recent = user.edits_recent ?? 0;
  const scoreRecent = user.score_recent ?? 0;
  const total = user.scores?.all ?? 0;
  return recent >= NEWCOMER_MIN_RECENT && total > 0 && scoreRecent >= NEWCOMER_SCORE_SHARE * total;
}

function hadRecentViewportTouch(lastTs: number, now: number): boolean {
  if (!lastTs) return false;
  return (now - lastTs) / DAY_MS <= NEWCOMER_VIEWPORT_DAYS;
}

/** Users active in the given cells, best first. Null until cells.bin.gz arrived. */
export function viewportRanking(
  h3Ids: string[],
  users: Record<string, UserStat>,
  filter: FilterId,
  topUsers: TopUsers | null,
  now = Date.now(),
): RankedUser[] | null {
  if (!topUsers) return null;
  const ranked: RankedUser[] = [];
  for (const [uid, val] of topUsers.aggregate(h3Ids, filter)) {
    const u = users[String(uid)];
    if (!u) continue;
    ranked.push({
      uid,
      name: u.name,
      score: val.score,
      lastTs: val.lastTs,
      specialties: u.specialties,
      recency: recencyTier(val.lastTs, now),
      rank: 0,
      newcomer: isNewcomer(u) && hadRecentViewportTouch(val.lastTs, now),
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach((row, i) => {
    row.rank = i + 1;
  });
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

export function sparseThreshold(meta: SnapshotMeta, filter: FilterId): number {
  const sc = meta.sparse_count;
  const raw = typeof sc === "number" ? sc : (sc[filter] ?? sc.all ?? 20);
  return Math.max(1, raw);
}

/** Unsmoothed cell activity: mean object recency, scaled down when object count is below the sparse threshold. */
export function cellActivity(view: CellStats | null, threshold: number): number {
  if (!view || view.count <= 0) return 0;
  return view.currentness * Math.min(1, view.count / threshold);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface ViewportSummary {
  /** null until cells.bin.gz arrived; everything else comes from the tiles. */
  mappers: number | null;
  objects: number;
  currentness: number;
  level: ActivityLevel;
  /** Share of visible cells (incl. empty) with activityLevel 6 or 7. */
  highShare: number;
}

export function viewportSummary(
  cells: CellStats[],
  meta: SnapshotMeta,
  filter: FilterId,
  topUsers: TopUsers | null,
): ViewportSummary {
  const threshold = sparseThreshold(meta, filter);
  const values: number[] = [];
  let objects = 0;
  let high = 0;
  for (const cell of cells) {
    const value = cellActivity(cell, threshold);
    values.push(value);
    if (activityLevel(value) >= 6) high += 1;
    if (cell.count > 0) objects += cell.count;
  }
  const currentness = median(values);
  return {
    mappers: topUsers ? topUsers.mapperCount(cells.map((c) => c.h3), filter) : null,
    objects,
    currentness,
    level: viewportActivityLevel(currentness),
    highShare: cells.length ? high / cells.length : 0,
  };
}

/** Equal-width histogram of 0–1 values, for the legend density curve. */
export const LEGEND_DENSITY_BINS = 24;

export function densityBins(values: number[], binCount = LEGEND_DENSITY_BINS): number[] {
  const n = Math.max(1, binCount);
  const counts = new Array<number>(n).fill(0);
  for (const raw of values) {
    const t = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const i = t >= 1 ? n - 1 : Math.floor(t * n);
    counts[i]! += 1;
  }
  return counts;
}

const DENSITY_W = 100;
const DENSITY_H = 32;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function catmullRomPath(points: Array<[number, number]>, h: number): string {
  const fmt = (x: number, y: number) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  if (!points.length) return `M 0 ${h.toFixed(2)}`;
  if (points.length === 1) return `M ${fmt(points[0]![0], points[0]![1])}`;
  let d = `M ${fmt(points[0]![0], points[0]![1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6, 0, h);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6, 0, h);
    d += ` C ${fmt(c1x, c1y)}, ${fmt(c2x, c2y)}, ${fmt(p2[0], p2[1])}`;
  }
  return d;
}

/** Smoothed area + stroke paths for the legend density SVG (viewBox 0 0 100 32). */
export function densitySvgPaths(counts: number[]): { fill: string; line: string } {
  const w = DENSITY_W;
  const h = DENSITY_H;
  const n = counts.length;
  const max = n ? Math.max(...counts) : 0;
  if (!n || max <= 0) {
    const y = h.toFixed(2);
    const line = `M 0 ${y} L ${w} ${y}`;
    return { fill: `${line} L ${w} ${h} L 0 ${h} Z`, line };
  }
  const top = 1.25;
  const pts: Array<[number, number]> = counts.map((c, i) => {
    const x = n === 1 ? 0 : (i / (n - 1)) * w;
    const y = top + (1 - c / max) * (h - top);
    return [x, y];
  });
  const line = catmullRomPath(pts, h);
  return { fill: `${line} L ${w} ${h} L 0 ${h} Z`, line };
}

export function formatAge(lastTs: number, now = Date.now()): string {
  if (!lastTs) return "unbekannt";
  const days = Math.max(0, Math.floor((now - lastTs) / DAY_MS));
  if (days < 1) return "heute";
  if (days === 1) return "gestern";
  if (days < 30) return `vor ${days} Tagen`;
  const months = Math.floor(days / 30);
  // Bis 18 Monate in Monaten, damit nicht „vor 0 Jahren“ / „vor 1 Jahr“ für ~1–1,5 Jahre erscheint.
  if (months <= 18) return `vor ${months} Monat${months === 1 ? "" : "en"}`;
  const years = Math.max(2, Math.floor(days / 365));
  return `vor ${years} Jahren`;
}

/** Coarser age for the cell-panel list: anything under 120 days is just "vor kurzem". */
export function formatCellAge(lastTs: number, now = Date.now()): string {
  if (!lastTs) return "unbekannt";
  const days = Math.max(0, Math.floor((now - lastTs) / DAY_MS));
  if (days < CELL_RECENT_DAYS) return "vor kurzem";
  return formatAge(lastTs, now);
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

export function maxActivityScore(meta: SnapshotMeta, filter: FilterId): number {
  return Math.max(1, meta.max_score?.[filter] ?? 0);
}

export function maxFeatureCount(meta: SnapshotMeta, filter: FilterId): number {
  return Math.max(1, meta.max_count?.[filter] ?? 0);
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
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0]!, first[1]!]);
  return ring;
}

export type ActivityCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { lvl: number; t: number; ci: number; uid: number };
    geometry: { type: "Polygon"; coordinates: number[][][] };
  }>;
};

export const EMPTY_ACTIVITY: ActivityCollection = { type: "FeatureCollection", features: [] };

export function userActivityCollection(
  topUsers: TopUsers | null,
  meta: SnapshotMeta,
  filter: FilterId,
  uids: number[],
  colorByUid?: Map<number, number>,
): ActivityCollection {
  if (!topUsers || !uids.length) return EMPTY_ACTIVITY;
  const maxScore = maxActivityScore(meta, filter);
  const features: ActivityCollection["features"] = [];
  const ringCache = new Map<string, number[][]>();
  for (const uid of new Set(uids)) {
    for (const cell of topUsers.cellsForUid(filter, uid)) {
      const score = topUsers.scoreFor(cell, filter, uid);
      if (score <= 0) continue;
      let ring = ringCache.get(cell);
      if (!ring) {
        ring = hexRing(cell);
        ringCache.set(cell, ring);
      }
      if (ring.length < 4) continue;
      const t = activityStrength(score, maxScore);
      const lvl = Math.max(0, Math.min(ACTIVITY_DOT_LEVELS - 1, Math.round(t * (ACTIVITY_DOT_LEVELS - 1))));
      features.push({
        type: "Feature",
        properties: { lvl, t, ci: colorByUid?.get(uid) ?? 0, uid },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
  }
  features.sort((a, b) => a.properties.t - b.properties.t);
  return { type: "FeatureCollection", features };
}
