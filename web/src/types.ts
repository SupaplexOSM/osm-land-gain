export const FILTERS = ["all", "highway", "building", "landuse", "place", "furniture"] as const;
export type FilterId = (typeof FILTERS)[number];
export type ViewMode = "users" | "currentness" | "features";

export const FILTER_PREFIX: Record<FilterId, string> = {
  all: "a",
  highway: "h",
  building: "b",
  landuse: "l",
  place: "p",
  furniture: "f",
};

export const FILTER_LABELS: Record<FilterId, string> = {
  all: "Alle OSM-Objekte",
  highway: "Straßen",
  building: "Gebäude",
  landuse: "Landschaft",
  place: "Einrichtungen",
  furniture: "Stadtmöbel",
};

export const SPECIALTY_LABELS: Record<Exclude<FilterId, "all">, string> = {
  highway: "Straßen",
  building: "Gebäude",
  landuse: "Landschaft",
  place: "Einrichtungen",
  furniture: "Stadtmöbel",
};

export const SPECIALTY_COLORS: Record<Exclude<FilterId, "all">, string> = {
  highway: "#2563eb",
  building: "#c2410c",
  landuse: "#16a34a",
  place: "#7c3aed",
  furniture: "#64748b",
};

export const FILTER_TIPS: Record<FilterId, string> = {
  all: "Alle OSM-Objekte mit letztem Bearbeiter, unabhängig vom Tag.",
  highway: "Linien mit highway=* (Straßen, Wege, Pfade).",
  building: "Gebäudeflächen mit building=*.",
  landuse:
    "Landschaft: landuse, natural (auch Bäume), landcover, water, waterway sowie Parks und ähnliche Grünflächen (leisure=park/garden/nature_reserve …).",
  place:
    "Betretbare Einrichtungen: Läden, Gastronomie, Büros, Gesundheit, Bildung, Hotels, Museen, Sportstätten, Toiletten. Ohne Bänke, Mülleimer und Parkplätze.",
  furniture:
    "Öffentliche Ausstattung im Freien: Bänke, Mülleimer, Laternen, Hydranten, Infotafeln, Denkmäler, Parkplätze, Haltestellen, Automaten.",
};

export interface ActivityCenter {
  uid: number;
  h3: string;
  peak: number;
  total: number;
  rank: number;
  /** 2 = ornate crown, 1 = plain crown, 0 = flag (pipeline rank tiers) */
  tier: number;
  /** 1 if the peak cell's winner is this user */
  own: number;
}

export interface SnapshotMeta {
  generated: string;
  h3_res: number;
  filters: FilterId[];
  sparse_count: number | Record<string, number>;
  active_days: number;
  bbox: [number, number, number, number];
  bboxes?: [number, number, number, number][];
  /** Highest per-user score in any cell, per filter (precomputed by the pipeline). */
  max_score: Partial<Record<FilterId, number>>;
  /** Highest object count in any cell, per filter. */
  max_count: Partial<Record<FilterId, number>>;
  label?: string;
  season?: string;
  id?: string;
}

/**
 * Everything the map needs up front. A few hundred KB: the per-cell numbers all
 * live in the vector tiles, the per-cell top-user lists in cells.bin.gz.
 */
export interface SnapshotCore {
  meta: SnapshotMeta;
  centers: Partial<Record<FilterId, ActivityCenter[]>>;
  /** Flat [uid, colorIndex, …] pairs per filter for every territory winner. */
  colors: Partial<Record<FilterId, number[]>>;
}

export interface UserStat {
  name: string;
  scores: Record<FilterId, number>;
  last_ts: number;
  specialties: Record<Exclude<FilterId, "all">, number>;
}

/** Per-cell numbers, read straight from the vector tile feature. */
export interface CellStats {
  h3: string;
  winner: number;
  score: number;
  currentness: number;
  count: number;
  meanAgeDays: number;
  sparse: boolean;
  colorIndex: number;
}

export interface CellView extends CellStats {
  /** null while cells.bin.gz is still loading. */
  top: Array<{ uid: number; score: number; lastTs: number }> | null;
}

/** Raw feature properties of one hex, as encoded into the vector tiles. */
export type TileProps = Record<string, unknown>;

function num(props: Record<string, unknown>, key: string): number {
  const value = props[key];
  return typeof value === "number" ? value : Number(value) || 0;
}

/**
 * Decode one hex from its tile properties. The pipeline stores the score times
 * ten and the currentness times a hundred to keep the tiles integer-only.
 */
export function cellStatsFromTile(props: Record<string, unknown>, filter: FilterId): CellStats | null {
  const h3 = props.h;
  if (typeof h3 !== "string" || !h3) return null;
  const p = FILTER_PREFIX[filter];
  return {
    h3,
    winner: num(props, `${p}_w`),
    score: num(props, `${p}_s`) / 10,
    currentness: num(props, `${p}_c`) / 100,
    count: num(props, `${p}_n`),
    meanAgeDays: num(props, `${p}_f`),
    sparse: num(props, `${p}_sp`) === 1,
    colorIndex: num(props, `${p}_ci`),
  };
}
