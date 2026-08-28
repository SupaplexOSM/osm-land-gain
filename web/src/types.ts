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

/** Packed cell row: w, s, c, n, f (mean age days), k, sp, ci, u */
export type PackedCell = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  Array<[number, number, number]>,
];

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

export const EMPTY_PACKED: PackedCell = Object.freeze([
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  0,
  Object.freeze([]) as unknown as Array<[number, number, number]>,
]) as PackedCell;

export interface CellsFile {
  meta: {
    generated: string;
    h3_res: number;
    filters: FilterId[];
    sparse_count: number | Record<string, number>;
    active_days: number;
    bbox: [number, number, number, number];
    cell_keys: string[];
    cell_layout?: "filter-array" | "filter-object";
  };
  cells: Record<string, Record<FilterId, PackedCell>>;
  centers?: Record<FilterId, ActivityCenter[]>;
}

export interface UserStat {
  name: string;
  scores: Record<FilterId, number>;
  last_ts: number;
  specialties: Record<Exclude<FilterId, "all">, number>;
}

export interface CellView {
  h3: string;
  winner: number;
  score: number;
  currentness: number;
  count: number;
  meanAgeDays: number;
  sparse: boolean;
  colorIndex: number;
  top: Array<{ uid: number; score: number; lastTs: number }>;
}

/** Expand compact filter-array JSON (null empty rows) into in-memory filter records. */
export function normalizeCellsFile(raw: unknown): CellsFile {
  const payload = raw as {
    meta: CellsFile["meta"];
    cells: Record<string, unknown>;
    centers?: CellsFile["centers"];
  };
  const filters = (payload.meta.filters?.length ? payload.meta.filters : FILTERS) as FilterId[];
  if (payload.meta.cell_layout !== "filter-array") return payload as CellsFile;
  const cells: CellsFile["cells"] = {};
  for (const [h3, rows] of Object.entries(payload.cells)) {
    const arr = rows as Array<PackedCell | null>;
    const rec = {} as Record<FilterId, PackedCell>;
    for (let i = 0; i < filters.length; i++) {
      rec[filters[i]!] = arr[i] ?? EMPTY_PACKED;
    }
    cells[h3] = rec;
  }
  return { meta: payload.meta, cells, centers: payload.centers };
}

export function unpack(h3: string, packed: PackedCell): CellView {
  return {
    h3,
    winner: packed[0],
    score: packed[1],
    currentness: packed[2],
    count: packed[3],
    meanAgeDays: packed[4],
    sparse: packed[6] === 1,
    colorIndex: packed[7],
    top: packed[8].map(([uid, score, lastTs]) => ({ uid, score, lastTs })),
  };
}
