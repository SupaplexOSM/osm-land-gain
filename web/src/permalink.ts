import { FILTERS, type FilterId, type ViewMode } from "./types";

export const MAP_MIN_ZOOM = 10;
export const MAP_MAX_ZOOM = 16;
export const MAP_DEFAULT_CENTER: [number, number] = [13.405, 52.52];
export const MAP_DEFAULT_ZOOM = 11;

export interface PermalinkState {
  zoom: number;
  lat: number;
  lng: number;
  filter: FilterId;
  mode: ViewMode;
  cell: string | null;
  userNames: string[];
  date: string | null;
}

function isFilterId(value: string): value is FilterId {
  return (FILTERS as readonly string[]).includes(value);
}

function parseUserNames(search: string): string[] {
  const match = search.match(/(?:^|[?&])users=([^&]*)/);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function readNumber(q: URLSearchParams, key: string): number | undefined {
  const raw = q.get(key);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Round to `maxDecimals` and drop trailing zeros (`11.00` → `11`, `52.52000` → `52.52`). */
function compactNumber(n: number, maxDecimals: number): string {
  return String(Number(n.toFixed(maxDecimals)));
}

export function parsePermalink(search = typeof location === "undefined" ? "" : location.search): Partial<PermalinkState> {
  const q = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const out: Partial<PermalinkState> = {};
  const z = readNumber(q, "z");
  if (z != null) out.zoom = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, z));
  const lat = readNumber(q, "lat");
  const lng = readNumber(q, "lng");
  if (lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    out.lat = lat;
    out.lng = lng;
  }
  const filter = q.get("filter");
  if (filter && isFilterId(filter)) out.filter = filter;
  const mode = q.get("mode");
  if (mode === "users" || mode === "features") out.mode = mode;
  else if (mode === "activity" || mode === "currentness") out.mode = "currentness";
  const cell = q.get("cell");
  if (cell) out.cell = cell;
  const names = parseUserNames(search.startsWith("?") ? search : `?${search}`);
  if (names.length) out.userNames = names;
  const date = q.get("date");
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date;
  return out;
}

export function permalinkQuery(state: PermalinkState): string {
  const q = new URLSearchParams();
  q.set("z", compactNumber(state.zoom, 2));
  q.set("lat", compactNumber(state.lat, 5));
  q.set("lng", compactNumber(state.lng, 5));
  if (state.filter !== "all") q.set("filter", state.filter);
  if (state.mode === "features") q.set("mode", "features");
  else if (state.mode === "currentness") q.set("mode", "activity");
  if (state.cell) q.set("cell", state.cell);
  if (state.date) q.set("date", state.date);
  let query = q.toString();
  if (state.userNames.length) {
    const users = state.userNames.map((name) => encodeURIComponent(name)).join(",");
    query += `${query ? "&" : ""}users=${users}`;
  }
  return query;
}

export function writePermalink(state: PermalinkState): void {
  const query = permalinkQuery(state);
  const next = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
  const cur = `${location.pathname}${location.search}${location.hash}`;
  if (cur === next) return;
  history.replaceState(null, "", next);
}
