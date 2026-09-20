import { FILTERS, type FilterId, type ViewMode } from "./types";

export const MAP_MIN_ZOOM = 10;
export const MAP_MAX_ZOOM = 16;
export const MAP_DEFAULT_CENTER: [number, number] = [13.395, 52.517];
export const MAP_DEFAULT_ZOOM = 11;
/** Leaflet/OSM.org zoom 0 is 256 CSS px; MapLibre zoom 0 is 512 CSS px. */
export const OSM_ZOOM_FROM_MAPLIBRE = 1;

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

function parseUserNames(raw: string): string[] {
  const match = raw.match(/(?:^|[?&#])users=([^&]*)/);
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

function clampMapLibreZoom(z: number): number {
  return Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, z));
}

export function osmZoomFromMapLibre(zoom: number): number {
  return zoom + OSM_ZOOM_FROM_MAPLIBRE;
}

export function mapLibreZoomFromOsm(zoom: number): number {
  return zoom - OSM_ZOOM_FROM_MAPLIBRE;
}

function paramsFrom(raw: string): URLSearchParams {
  const text = raw.startsWith("?") || raw.startsWith("#") ? raw.slice(1) : raw;
  return new URLSearchParams(text);
}

function parseMapValue(raw: string | null): { zoom: number; lat: number; lng: number } | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^([\d.+-]+)\/([-\d.]+)\/([-\d.]+)$/);
  if (!match) return undefined;
  const osmZ = Number(match[1]);
  const lat = Number(match[2]);
  const lng = Number(match[3]);
  if (!Number.isFinite(osmZ) || !Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { zoom: clampMapLibreZoom(mapLibreZoomFromOsm(osmZ)), lat, lng };
}

function applyQueryParams(out: Partial<PermalinkState>, q: URLSearchParams, raw: string): void {
  const filter = q.get("filter");
  if (filter && isFilterId(filter)) out.filter = filter;
  const mode = q.get("mode");
  if (mode === "users" || mode === "features") out.mode = mode;
  else if (mode === "activity" || mode === "currentness") out.mode = "currentness";
  const cell = q.get("cell");
  if (cell) out.cell = cell;
  const names = parseUserNames(raw);
  if (names.length) out.userNames = names;
  const date = q.get("date");
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date;
}

function applyLegacyCamera(out: Partial<PermalinkState>, q: URLSearchParams): void {
  const z = readNumber(q, "z");
  if (z != null) out.zoom = clampMapLibreZoom(z);
  const lat = readNumber(q, "lat");
  const lng = readNumber(q, "lng");
  if (lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    out.lat = lat;
    out.lng = lng;
  }
}

/** OSM.org-style `#map=z/lat/lng` plus optional `&filter=&mode=&date=…`. */
export function permalinkHash(state: PermalinkState): string {
  const z = compactNumber(osmZoomFromMapLibre(state.zoom), 2);
  const lat = compactNumber(state.lat, 5);
  const lng = compactNumber(state.lng, 5);
  const extras = permalinkQuery(state);
  return `#map=${z}/${lat}/${lng}${extras ? `&${extras}` : ""}`;
}

export function parsePermalink(
  search = typeof location === "undefined" ? "" : location.search,
  hash = typeof location === "undefined" ? "" : location.hash,
): Partial<PermalinkState> {
  const q = paramsFrom(search);
  const h = paramsFrom(hash);
  const out: Partial<PermalinkState> = {};
  applyLegacyCamera(out, q);
  applyQueryParams(out, q, search);
  const fromHash = parseMapValue(h.get("map"));
  if (fromHash) {
    out.zoom = fromHash.zoom;
    out.lat = fromHash.lat;
    out.lng = fromHash.lng;
  }
  applyQueryParams(out, h, hash);
  return out;
}

export function permalinkQuery(state: PermalinkState): string {
  const q = new URLSearchParams();
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
  const next = `${location.pathname}${permalinkHash(state)}`;
  const cur = `${location.pathname}${location.search}${location.hash}`;
  if (cur === next) return;
  history.replaceState(null, "", next);
}
