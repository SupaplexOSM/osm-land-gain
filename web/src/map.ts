import maplibregl from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import { colorIndexFromName, CURRENTNESS_STOPS, FEATURE_STOPS, MEEPLE, PARCHMENT } from "./colors";
import {
  ACTIVITY_DOT_LEVELS,
  EMPTY_ACTIVITY,
  clearStatsCaches,
  flagLngLat,
  maxFeatureCount,
  sparseThreshold,
  userActivityCollection,
  winnerColorByUid,
} from "./stats";
import {
  EMPTY_FRONTS,
  FRONT_REF_ZOOM,
  frontTeethGeoJSON,
  type FrontSegment,
  type PackedFronts,
} from "./fronts";
import { overlaysFromPacked, type OverlayBuild, type PackedOverlays } from "./territories";
import type { TopUsers } from "./topusers";
import { FILTER_PREFIX, type FilterId, type SnapshotCore, type TileProps, type UserStat, type ViewMode } from "./types";
import { MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, MAP_MAX_ZOOM, MAP_MIN_ZOOM } from "./permalink";
import { type BBox4, unionBboxes } from "./regions";

export interface MapHandles {
  map: maplibregl.Map;
  setFilter: (filter: FilterId) => void;
  setMode: (mode: ViewMode) => void;
  setHighlightUsers: (uids: number[]) => void;
  setSelection: (h3: string | null) => void;
  refreshMarkers: () => void;
  setOverlayOpacity: (t: number) => void;
  /** Hand over the per-cell top users once cells.bin.gz finished loading. */
  setTopUsers: (next: TopUsers | null) => void;
  setSnapshot: (
    next: SnapshotCore,
    nextUsers: Record<string, UserStat>,
    pmtilesUrl: string,
    packedOverlays?: PackedOverlays | null,
    packedFronts?: PackedFronts | null,
  ) => void;
}

const LABEL_FONT = ["Noto Sans Regular"];
const LABEL_FONT_BOLD = ["Noto Sans Bold"];

function hatchImage(): { width: number; height: number; data: Uint8Array } {
  const s = 16;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, s, s);
  ctx.strokeStyle = "rgba(62, 46, 28, 0.13)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (let i = -s; i < s * 2; i += 6) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + s, s);
  }
  ctx.stroke();
  const img = ctx.getImageData(0, 0, s, s);
  return { width: s, height: s, data: new Uint8Array(img.data) };
}

function drawPennant(color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 48;
  c.height = 60;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.strokeStyle = "#2a1c12";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(10, 4);
  ctx.lineTo(42, 16);
  ctx.lineTo(10, 28);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "#2a1c12";
  ctx.lineWidth = 3;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(10, 2);
  ctx.lineTo(10, 60);
  ctx.stroke();
  return c;
}

function canvasToImage(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
}

/** Matches the old 64px capital icon: outer 22, stroke 7, inner dot 8. */
function capitalPx(shapePx: number): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    9,
    ["*", ["get", "sz"], 0.19 * shapePx],
    14,
    ["*", ["get", "sz"], 0.36 * shapePx],
  ];
}

function inUidList(prop: string, uids: number[]): maplibregl.ExpressionSpecification {
  return ["in", ["to-number", ["get", prop]], ["literal", uids]] as maplibregl.ExpressionSpecification;
}

const meepleExprByProp = new Map<string, maplibregl.ExpressionSpecification>();

function matchMeeple(prop: string): maplibregl.ExpressionSpecification {
  const cached = meepleExprByProp.get(prop);
  if (cached) return cached;
  const expr: unknown[] = ["match", ["to-number", ["get", prop]]];
  MEEPLE.forEach((color, i) => {
    expr.push(i, color);
  });
  expr.push(PARCHMENT);
  const out = expr as maplibregl.ExpressionSpecification;
  meepleExprByProp.set(prop, out);
  return out;
}

const DIM_GRAY = "#d1d5db";
const NO_FADE = { duration: 0 } as const;
const H3_PAINT_LAYERS = ["h3-fill", "h3-fill-sparse", "h3-fill-dim"] as const;
/** Matches nothing. Expression form, since ["==", 0, 1] reads as a legacy filter. */
const HIDDEN_FILTER: maplibregl.FilterSpecification = ["boolean", false];

function interpolateStops(valueExpr: unknown, stops: Array<[number, string]>): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ["interpolate", ["linear"], valueExpr];
  for (const [t, color] of stops) {
    expr.push(t, color);
  }
  return expr as maplibregl.ExpressionSpecification;
}

function interpolateActivity(cProp: string, nProp: string, threshold: number): maplibregl.ExpressionSpecification {
  const t: unknown = [
    "*",
    ["/", ["to-number", ["get", cProp]], 100],
    ["min", 1, ["/", ["to-number", ["get", nProp]], threshold]],
  ];
  return interpolateStops(t, CURRENTNESS_STOPS);
}

function interpolateCount(nProp: string, maxCount: number): maplibregl.ExpressionSpecification {
  const hi = Math.max(1, maxCount);
  const t: unknown = [
    "/",
    ["ln", ["+", 1, ["max", 0, ["to-number", ["get", nProp]]]]],
    Math.log1p(hi),
  ];
  return interpolateStops(t, FEATURE_STOPS);
}

function pref(filter: FilterId, key: string): string {
  return `${FILTER_PREFIX[filter]}_${key}`;
}

function logSize(value: number, values: number[], minSz: number, maxSz: number): number {
  if (!values.length) return (minSz + maxSz) / 2;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.log(Math.max(hi, 1e-6)) - Math.log(Math.max(lo, 1e-6)) || 1;
  const t = (Math.log(Math.max(value, 1e-6)) - Math.log(Math.max(lo, 1e-6))) / span;
  return minSz + (maxSz - minSz) * Math.max(0, Math.min(1, t));
}

const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

/**
 * Fetch a PMTiles header and root directory ahead of time.
 *
 * MapLibre can only add our vector source once the remote basemap style is up,
 * and the archive then needs two round trips before the first tile byte moves.
 * Warming the same protocol cache while the snapshot core is downloading takes
 * both off the critical path.
 */
export function warmTiles(url: string): void {
  const archive = new PMTiles(url);
  protocol.add(archive);
  void archive.getHeader().catch(() => {});
}

/** Camera limits. PMTiles maxzoom (config max_zoom) is 14; MapLibre overzooms beyond that. */

/** Zoom at which the 8-column lattice looks right. Spacing follows mercator (×2 per zoom). */
const ACTIVITY_DOT_REF_ZOOM = 15;
const ACTIVITY_DOT_REF_COLS = 8;
const ACTIVITY_DOT_CANVAS = 128;

function activityDotCols(zoom: number): number {
  const colsExact = ACTIVITY_DOT_REF_COLS * 2 ** (ACTIVITY_DOT_REF_ZOOM - zoom);
  return Math.max(4, Math.min(24, Math.round(colsExact)));
}

/**
 * Shared lattice for all activity levels. Fill-patterns live in screen pixels, so
 * without compensation they get denser when zooming in. We retile the 128px image
 * with 2^(z − 15) so geographic spacing stays near the z=15 look.
 */
function drawActivityDots(level: number, zoom: number): HTMLCanvasElement {
  const s = ACTIVITY_DOT_CANVAS;
  const cols = activityDotCols(zoom);
  const rows = Math.max(4, (Math.round((cols * 2) / Math.sqrt(3)) & ~1));
  const spacing = s / cols;
  const rowH = s / rows;
  const t = ACTIVITY_DOT_LEVELS <= 1 ? 1 : level / (ACTIVITY_DOT_LEVELS - 1);
  const skip = t < 0.4 ? 2 : 1;
  const radius = spacing * (0.2 + t * 0.16) * 1.14;
  const alpha = 0.5 + t * 0.42;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = `rgba(17, 24, 39, ${alpha})`;
  const stamp = (x: number, y: number) => {
    for (const dx of [-s, 0, s]) {
      for (const dy of [-s, 0, s]) {
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  for (let row = 0; row < rows; row++) {
    const y = rowH * (row + 0.5);
    const xOff = row % 2 === 0 ? 0 : spacing * 0.5;
    for (let col = 0; col < cols; col++) {
      if (skip > 1 && (row + col) % skip !== 0) continue;
      stamp(spacing * (col + 0.5) + xOff, y);
    }
  }
  return c;
}

function activityPatternExpr(): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ["match", ["to-number", ["get", "lvl"]]];
  for (let i = 0; i < ACTIVITY_DOT_LEVELS; i++) {
    expr.push(i, `user-dot-${i}`);
  }
  expr.push("user-dot-0");
  return expr as maplibregl.ExpressionSpecification;
}

const ACTIVITY_FILL_OP: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["to-number", ["get", "t"]],
  0,
  0.12,
  1,
  0.38,
];
const ACTIVITY_PATTERN_OP: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["to-number", ["get", "t"]],
  0,
  0.4,
  1,
  1,
];

function scaleOpacity(
  value: number | maplibregl.ExpressionSpecification,
  t: number,
): number | maplibregl.ExpressionSpecification {
  const a = Math.round(Math.max(0, Math.min(1, t)) * 100) / 100;
  if (a === 1) return value;
  return scaleOpacityNode(value, a) as number | maplibregl.ExpressionSpecification;
}

/** Multiply numeric outputs in opacity expressions. Avoid `["*", expr, t]`, which MapLibre can reject. */
function scaleOpacityNode(value: unknown, a: number): unknown {
  if (typeof value === "number") return value * a;
  if (!Array.isArray(value) || typeof value[0] !== "string") return value;
  const op = value[0];
  if (op === "case") {
    const out: unknown[] = ["case"];
    for (let i = 1; i < value.length; i++) {
      const output = i === value.length - 1 || i % 2 === 0;
      out.push(output ? scaleOpacityNode(value[i], a) : value[i]);
    }
    return out;
  }
  if (op === "interpolate" || op === "interpolate-hcl" || op === "interpolate-lab") {
    const out: unknown[] = value.slice(0, 3);
    for (let i = 3; i < value.length; i += 2) {
      out.push(value[i]);
      if (i + 1 < value.length) out.push(scaleOpacityNode(value[i + 1], a));
    }
    return out;
  }
  if (op === "step") {
    const out: unknown[] = ["step", value[1]];
    for (let i = 2; i < value.length; i++) {
      out.push(i % 2 === 0 ? scaleOpacityNode(value[i], a) : value[i]);
    }
    return out;
  }
  if (op === "match") {
    const out: unknown[] = ["match", value[1]];
    for (let i = 2; i < value.length; i++) {
      const label = i !== value.length - 1 && (i - 2) % 2 === 0;
      out.push(label ? value[i] : scaleOpacityNode(value[i], a));
    }
    return out;
  }
  return value;
}

function softenBasemap(map: maplibregl.Map): void {
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    const id = layer.id.toLowerCase();
    const water = /water|river|lake|ocean/.test(id);
    const green = /park|wood|forest|grass|landcover|landuse|pitch/.test(id);
    const road = /road|street|highway|path|rail|bridge|tunnel|transport/.test(id);
    try {
      if (layer.type === "background") {
        map.setPaintProperty(layer.id, "background-color", "#eceff2");
      }
      if (layer.type === "fill" && water) {
        map.setPaintProperty(layer.id, "fill-opacity", 0.9);
      } else if (layer.type === "fill" && green) {
        map.setPaintProperty(layer.id, "fill-opacity", 0.75);
      } else if (layer.type === "fill") {
        map.setPaintProperty(layer.id, "fill-opacity", 0.28);
      }
      if (layer.type === "line" && (road || water)) {
        map.setPaintProperty(layer.id, "line-opacity", 0.62);
      } else if (layer.type === "line") {
        map.setPaintProperty(layer.id, "line-opacity", 0.3);
      }
      if (layer.type === "symbol") {
        map.setPaintProperty(layer.id, "text-opacity", 0.72);
        map.setPaintProperty(layer.id, "icon-opacity", 0.55);
      }
    } catch {
      /* layer has no such paint property */
    }
  }
}

export async function createMap(
  container: HTMLElement,
  initialCore: SnapshotCore,
  initialUsers: Record<string, UserStat>,
  /** Second argument are the raw tile properties, so callers avoid re-querying. */
  onCell: (h3: string | null, props: TileProps | null) => void,
  onMove: () => void,
  onHover: (h3: string | null, props: TileProps | null) => void = () => {},
  camera?: {
    center: [number, number];
    zoom: number;
    pmtilesUrl?: string;
    fitBboxes?: [number, number, number, number][];
    packedOverlays?: PackedOverlays | null;
    packedFronts?: PackedFronts | null;
  },
): Promise<MapHandles> {
  let core = initialCore;
  let users = initialUsers;
  let topUsers: TopUsers | null = null;
  let packedOverlays: PackedOverlays | null = camera?.packedOverlays ?? null;
  let packedFronts: PackedFronts | null = camera?.packedFronts ?? null;
  let pmtilesUrl = camera?.pmtilesUrl ?? new URL("./data/berlin.pmtiles", document.baseURI).href;

  const map = new maplibregl.Map({
    container,
    style: BASEMAP,
    center: camera?.center ?? MAP_DEFAULT_CENTER,
    zoom: camera?.zoom ?? MAP_DEFAULT_ZOOM,
    minZoom: MAP_MIN_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    maxPitch: 0,
    attributionControl: false,
  });
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://openfreemap.org">OpenFreeMap</a>',
    }),
    "bottom-right",
  );
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

  let filter: FilterId = "all";
  let mode: ViewMode = "users";
  let highlightUids: number[] = [];
  let overlayAlpha = 1;
  let paintStyleKey = "";
  let opacityLogged = 0;
  let opacityRaf = 0;
  type OpacityPack = {
    fill: number;
    sparseFill: number;
    dimFill: number;
    hatch: number;
    overlayOp: number | maplibregl.ExpressionSpecification;
    shadowOp: number | maplibregl.ExpressionSpecification;
    markOp: number | maplibregl.ExpressionSpecification;
  };
  let opacityPack: OpacityPack | null = null;

  const paintKey = () => `${filter}|${mode}|${highlightUids.join(",")}`;

  const rebuildPaintStyle = () => {
    const key = paintKey();
    if (key === paintStyleKey && opacityPack) return;
    paintStyleKey = key;
    const sp = pref(filter, "sp");
    const ci = pref(filter, "ci");
    const cu = pref(filter, "c");
    const n = pref(filter, "n");
    const w = pref(filter, "w");
    const activityFill = interpolateActivity(cu, n, sparseThreshold(core.meta, filter));
    const countFill = interpolateCount(n, maxFeatureCount(core.meta, filter));
    const scaleFill = mode === "features" ? countFill : activityFill;
    const choropleth = mode === "currentness" || mode === "features";
    const occupied = [">", ["to-number", ["get", n]], 0] as maplibregl.ExpressionSpecification;
    const sparse = ["==", ["get", sp], 1] as maplibregl.ExpressionSpecification;
    const notSparse = ["!=", ["get", sp], 1] as maplibregl.ExpressionSpecification;
    const highlighted = highlightUids.length > 0;
    const hit = highlighted ? inUidList(w, highlightUids) : (["boolean", true] as maplibregl.ExpressionSpecification);
    const missed = ["!", hit] as maplibregl.ExpressionSpecification;
    let fillColor: maplibregl.ExpressionSpecification | string = matchMeeple(ci);
    let fillFilter: maplibregl.FilterSpecification = ["all", occupied, notSparse];
    let sparseColor: maplibregl.ExpressionSpecification | string = PARCHMENT;
    let sparseFilter: maplibregl.FilterSpecification = ["all", occupied, sparse];
    let dimColor: maplibregl.ExpressionSpecification | string = DIM_GRAY;
    let dimFilter: maplibregl.FilterSpecification = HIDDEN_FILTER;
    let fillOpacity = 0.72;
    let sparseFill = 0.14;
    let dimFill = 0;
    if (!highlighted) {
      if (mode === "users") {
        fillColor = matchMeeple(ci);
        fillFilter = ["all", occupied, notSparse];
        fillOpacity = 0.72;
        sparseColor = PARCHMENT;
        sparseFilter = ["all", occupied, sparse];
        sparseFill = 0.14;
      } else {
        fillColor = scaleFill;
        fillFilter = occupied;
        fillOpacity = 0.84;
        sparseFilter = HIDDEN_FILTER;
        sparseFill = 0;
      }
    } else if (mode === "users") {
      fillColor = ["case", sparse, PARCHMENT, matchMeeple(ci)] as maplibregl.ExpressionSpecification;
      fillFilter = ["all", occupied, hit];
      fillOpacity = 0.84;
      sparseColor = PARCHMENT;
      sparseFilter = ["all", occupied, sparse, missed];
      sparseFill = 0.05;
      dimColor = DIM_GRAY;
      dimFilter = ["all", occupied, notSparse, missed];
      dimFill = 0.08;
    } else {
      fillColor = scaleFill;
      fillFilter = ["all", occupied, hit];
      fillOpacity = 0.9;
      sparseColor = DIM_GRAY;
      sparseFilter = ["all", occupied, sparse, missed];
      sparseFill = 0.05;
      dimColor = DIM_GRAY;
      dimFilter = ["all", occupied, notSparse, missed];
      dimFill = 0.08;
    }
    const styleFill = (
      id: string,
      nextFilter: maplibregl.FilterSpecification,
      color: maplibregl.ExpressionSpecification | string,
    ) => {
      if (!map.getLayer(id)) return;
      map.setFilter(id, nextFilter);
      map.setPaintProperty(id, "fill-color", color);
    };
    styleFill("h3-fill", fillFilter, fillColor);
    styleFill("h3-fill-sparse", sparseFilter, sparseColor);
    styleFill("h3-fill-dim", dimFilter, dimColor);
    if (map.getLayer("h3-hatch")) {
      map.setFilter("h3-hatch", ["all", sparse, occupied]);
    }
    opacityPack = {
      fill: fillOpacity,
      sparseFill,
      dimFill,
      hatch: choropleth || highlighted ? 0 : 0.35,
      overlayOp: !highlighted
        ? 0.62
        : (["case", inUidList("uid", highlightUids), 0.92, 0.06] as maplibregl.ExpressionSpecification),
      shadowOp: !highlighted
        ? 0.14
        : (["case", inUidList("uid", highlightUids), 0.2, 0.02] as maplibregl.ExpressionSpecification),
      markOp: !highlighted
        ? 1
        : (["case", inUidList("uid", highlightUids), 1, 0.12] as maplibregl.ExpressionSpecification),
    };
  };

  const applyOpacity = () => {
    if (!opacityPack) rebuildPaintStyle();
    const pack = opacityPack;
    if (!pack) return;
    const t = overlayAlpha;
    if (map.getLayer("h3-fill")) {
      map.setPaintProperty("h3-fill", "fill-opacity", pack.fill * t);
    }
    if (map.getLayer("h3-fill-sparse")) {
      map.setPaintProperty("h3-fill-sparse", "fill-opacity", pack.sparseFill * t);
    }
    if (map.getLayer("h3-fill-dim")) {
      map.setPaintProperty("h3-fill-dim", "fill-opacity", pack.dimFill * t);
    }
    if (map.getLayer("h3-hatch")) {
      map.setPaintProperty("h3-hatch", "fill-opacity", scaleOpacity(pack.hatch, t));
    }
    if (map.getLayer("h3-grid")) {
      map.setPaintProperty("h3-grid", "line-opacity", scaleOpacity(0.1, t));
    }
    if (map.getLayer("user-activity-fill")) {
      map.setPaintProperty("user-activity-fill", "fill-opacity", scaleOpacity(ACTIVITY_FILL_OP, t));
    }
    if (map.getLayer("user-activity")) {
      map.setPaintProperty("user-activity", "fill-opacity", scaleOpacity(ACTIVITY_PATTERN_OP, t));
    }
    if (map.getLayer("h3-line-sel")) {
      map.setPaintProperty("h3-line-sel", "line-opacity", scaleOpacity(0.95, t));
    }
    if (map.getLayer("h3-line-sel-halo")) {
      map.setPaintProperty("h3-line-sel-halo", "line-opacity", scaleOpacity(1, t));
    }
    if (map.getLayer("territories")) map.setPaintProperty("territories", "line-opacity", scaleOpacity(pack.overlayOp, t));
    if (map.getLayer("fronts")) map.setPaintProperty("fronts", "fill-opacity", scaleOpacity(pack.overlayOp, t));
    if (map.getLayer("territories-shadow")) {
      map.setPaintProperty("territories-shadow", "line-opacity", scaleOpacity(pack.shadowOp, t));
    }
    if (map.getLayer("capitals-dot")) map.setPaintProperty("capitals-dot", "circle-opacity", scaleOpacity(pack.markOp, t));
    if (map.getLayer("capitals-ring")) {
      map.setPaintProperty("capitals-ring", "circle-stroke-opacity", scaleOpacity(pack.markOp, t));
    }
    if (map.getLayer("flags")) map.setPaintProperty("flags", "icon-opacity", scaleOpacity(pack.markOp, t));
    if (map.getLayer("center-labels")) map.setPaintProperty("center-labels", "text-opacity", scaleOpacity(pack.markOp, t));
    if (map.getLayer("territory-labels")) {
      map.setPaintProperty("territory-labels", "text-opacity", scaleOpacity(pack.markOp, t));
    }
  };

  const applyPaint = () => {
    rebuildPaintStyle();
    applyOpacity();
  };

  const resetPaintStyle = () => {
    paintStyleKey = "";
    opacityPack = null;
  };

  const markerCollection = () => {
    const centers = core.centers?.[filter] ?? [];
    const capitalTotals = centers.filter((c) => c.own === 1).map((c) => c.total);
    const flagTotals = centers.filter((c) => c.own !== 1).map((c) => c.total);
    const colors = winnerColorByUid(core, filter);
    const features = centers.map((c) => {
      const name = users[String(c.uid)]?.name ?? `#${c.uid}`;
      const isCapital = c.own === 1;
      const ci = colors.get(c.uid) ?? colorIndexFromName(name);
      const [lng, lat] = flagLngLat(c.h3);
      return {
        type: "Feature" as const,
        properties: {
          kind: isCapital ? 1 : 0,
          uid: c.uid,
          icon: isCapital ? "olg-capital" : `olg-flag-${ci}`,
          sz: isCapital
            ? logSize(c.total, capitalTotals, 0.42, 1.12)
            : logSize(c.total, flagTotals, 0.42, 1.0),
          name,
          score: c.total,
        },
        geometry: { type: "Point" as const, coordinates: [lng, lat] as [number, number] },
      };
    });
    features.sort((a, b) => b.properties.score - a.properties.score);
    return { type: "FeatureCollection" as const, features };
  };

  const EMPTY_OVERLAYS: OverlayBuild = {
    outlines: { type: "FeatureCollection", features: [] },
    labels: { type: "FeatureCollection", features: [] },
    territoryUids: new Set(),
  };

  const overlayCache = new Map<FilterId, OverlayBuild>();
  const overlayData = (): OverlayBuild => {
    let hit = overlayCache.get(filter);
    if (!hit) {
      const packed = packedOverlays?.[filter];
      if (!packed?.length) return EMPTY_OVERLAYS;
      hit = overlaysFromPacked(packed, users);
      overlayCache.set(filter, hit);
    }
    return hit;
  };

  const frontSegments = (): FrontSegment[] => packedFronts?.[filter] ?? [];

  const hasFronts = () => packedFronts != null && Object.keys(packedFronts).length > 0;

  let frontsBakedZoom = Number.NaN;
  const FRONT_ZOOM_EPS = 0.03;
  const frontDataAt = (z: number) => {
    frontsBakedZoom = z;
    const segs = frontSegments();
    if (!segs.length) return EMPTY_FRONTS;
    return frontTeethGeoJSON(segs, z);
  };


  const refreshFronts = () => {
    const src = map.getSource("fronts") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const z = map.isStyleLoaded() ? map.getZoom() : FRONT_REF_ZOOM;
    src.setData(frontDataAt(z));
  };

  /** Size teeth for the current camera zoom before this frame paints. */
  const syncFrontsToCamera = () => {
    if (!hasFronts() || !map.isStyleLoaded() || !map.getSource("fronts")) return;
    const z = map.getZoom();
    if (Number.isFinite(frontsBakedZoom) && Math.abs(z - frontsBakedZoom) < FRONT_ZOOM_EPS) return;
    refreshFronts();
  };

  const refreshOverlays = () => {
    frontsBakedZoom = Number.NaN;
    const { outlines, labels } = overlayData();
    (map.getSource("territories") as maplibregl.GeoJSONSource | undefined)?.setData(outlines);
    refreshFronts();
    (map.getSource("territory-labels") as maplibregl.GeoJSONSource | undefined)?.setData(labels);
    (map.getSource("markers") as maplibregl.GeoJSONSource | undefined)?.setData(markerCollection());
  };

  const refreshActivity = () => {
    const src = map.getSource("user-activity") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!highlightUids.length || !topUsers) {
      src.setData(EMPTY_ACTIVITY);
      return;
    }
    const colors = winnerColorByUid(core, filter);
    for (const uid of highlightUids) {
      if (colors.has(uid)) continue;
      const name = users[String(uid)]?.name;
      if (name) colors.set(uid, colorIndexFromName(name));
    }
    src.setData(userActivityCollection(topUsers, core.meta, filter, highlightUids, colors));
  };

  let lastDotCols = -1;
  const syncDotPatterns = () => {
    if (!map.isStyleLoaded()) return;
    const z = map.getZoom();
    const cols = activityDotCols(z);
    if (cols === lastDotCols && map.hasImage("user-dot-0")) return;
    lastDotCols = cols;
    for (let i = 0; i < ACTIVITY_DOT_LEVELS; i++) {
      const id = `user-dot-${i}`;
      const img = canvasToImage(drawActivityDots(i, z));
      if (map.hasImage(id)) map.updateImage(id, img);
      else map.addImage(id, img, { pixelRatio: 2 });
    }
  };

  let patternRaf = 0;
  const onPatternZoom = () => {
    if (!highlightUids.length) return;
    if (patternRaf) return;
    patternRaf = requestAnimationFrame(() => {
      patternRaf = 0;
      syncDotPatterns();
    });
  };

  let frontRaf = 0;
  const onFrontZoom = () => {
    if (!hasFronts()) return;
    if (frontRaf) return;
    frontRaf = requestAnimationFrame(() => {
      frontRaf = 0;
      syncFrontsToCamera();
    });
  };

  const h3FillPaint = (
    color: string | maplibregl.ExpressionSpecification,
    opacity: number,
  ): maplibregl.FillLayerSpecification["paint"] => ({
    "fill-color": color,
    "fill-opacity": opacity,
    "fill-antialias": true,
    "fill-outline-color": "rgba(0,0,0,0)",
    "fill-color-transition": NO_FADE,
    "fill-opacity-transition": NO_FADE,
  });
  const addH3FillLayers = (before?: string) => {
    map.addLayer(
      {
        id: "h3-fill",
        type: "fill",
        source: "h3",
        "source-layer": "h3",
        filter: ["!=", ["get", "a_sp"], 1],
        paint: h3FillPaint(matchMeeple("a_ci"), 0.72),
      },
      before,
    );
    map.addLayer(
      {
        id: "h3-fill-sparse",
        type: "fill",
        source: "h3",
        "source-layer": "h3",
        filter: ["==", ["get", "a_sp"], 1],
        paint: h3FillPaint(PARCHMENT, 0.14),
      },
      before,
    );
    map.addLayer(
      {
        id: "h3-fill-dim",
        type: "fill",
        source: "h3",
        "source-layer": "h3",
        filter: HIDDEN_FILTER,
        paint: h3FillPaint(DIM_GRAY, 0),
      },
      before,
    );
  };

  map.on("load", () => {
    softenBasemap(map);
    map.addImage("hatch", hatchImage());
    syncDotPatterns();
    MEEPLE.forEach((color, i) => {
      map.addImage(`olg-flag-${i}`, canvasToImage(drawPennant(color)));
    });

    map.addSource("h3", {
      type: "vector",
      url: "pmtiles://" + pmtilesUrl,
      minzoom: MAP_MIN_ZOOM,
      maxzoom: 14,
      promoteId: "h",
    });
    addH3FillLayers();
    map.addLayer({
      id: "h3-hatch",
      type: "fill",
      source: "h3",
      "source-layer": "h3",
      filter: ["==", ["get", "a_sp"], 1],
      paint: { "fill-pattern": "hatch", "fill-opacity": 0.35, "fill-opacity-transition": NO_FADE },
    });
    map.addLayer({
      id: "h3-grid",
      type: "line",
      source: "h3",
      "source-layer": "h3-grid",
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#1f2937",
        "line-width": 1.1,
        "line-opacity": 0.1,
        "line-opacity-transition": NO_FADE,
      },
    });
    map.addSource("user-activity", { type: "geojson", data: EMPTY_ACTIVITY });
    map.addLayer({
      id: "user-activity-fill",
      type: "fill",
      source: "user-activity",
      paint: {
        "fill-color": matchMeeple("ci"),
        "fill-opacity": ACTIVITY_FILL_OP,
        "fill-opacity-transition": NO_FADE,
      },
    });
    map.addLayer({
      id: "user-activity",
      type: "fill",
      source: "user-activity",
      paint: {
        "fill-pattern": activityPatternExpr(),
        "fill-opacity": ACTIVITY_PATTERN_OP,
        "fill-opacity-transition": NO_FADE,
      },
    });
    const overlays = overlayData();
    map.addSource("territories", { type: "geojson", data: overlays.outlines });
    map.addSource("fronts", { type: "geojson", data: EMPTY_FRONTS });
    map.addLayer({
      id: "territories-shadow",
      type: "line",
      source: "territories",
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": "#1a1208",
        "line-width": 4.2,
        "line-opacity": 0.14,
        "line-blur": 2.6,
        "line-opacity-transition": NO_FADE,
      },
    });
    map.addLayer({
      id: "fronts",
      type: "fill",
      source: "fronts",
      paint: {
        "fill-color": "#2a1c12",
        "fill-opacity": 0.62,
        "fill-antialias": true,
        "fill-opacity-transition": NO_FADE,
      },
    });
    map.addLayer({
      id: "territories",
      type: "line",
      source: "territories",
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": "#2a1c12",
        "line-width": 1.35,
        "line-opacity": 0.62,
        "line-opacity-transition": NO_FADE,
      },
    });
    map.addLayer({
      id: "h3-line-sel-halo",
      type: "line",
      source: "h3",
      "source-layer": "h3",
      filter: ["==", ["get", "h"], ""],
      paint: { "line-color": "#2563eb", "line-width": 4.2, "line-opacity": 0.95, "line-opacity-transition": NO_FADE },
    });
    map.addLayer({
      id: "h3-line-sel",
      type: "line",
      source: "h3",
      "source-layer": "h3",
      filter: ["==", ["get", "h"], ""],
      paint: { "line-color": "#ffffff", "line-width": 1.8, "line-opacity": 1, "line-opacity-transition": NO_FADE },
    });
    map.addSource("territory-labels", { type: "geojson", data: overlays.labels });
    map.addSource("markers", { type: "geojson", data: markerCollection() });
    map.addLayer({
      id: "capitals-ring",
      type: "circle",
      source: "markers",
      filter: ["==", ["get", "kind"], 1],
      paint: {
        "circle-radius": capitalPx(15),
        "circle-color": "#111111",
        "circle-opacity": 0,
        "circle-stroke-width": capitalPx(7),
        "circle-stroke-color": "#111111",
        "circle-stroke-opacity": 1,
        "circle-pitch-alignment": "viewport",
        "circle-stroke-opacity-transition": NO_FADE,
      },
    });
    map.addLayer({
      id: "capitals-dot",
      type: "circle",
      source: "markers",
      filter: ["==", ["get", "kind"], 1],
      paint: {
        "circle-radius": capitalPx(8),
        "circle-color": "#111111",
        "circle-opacity": 1,
        "circle-pitch-alignment": "viewport",
        "circle-opacity-transition": NO_FADE,
      },
    });
    map.addLayer({
      id: "flags",
      type: "symbol",
      source: "markers",
      filter: ["==", ["get", "kind"], 0],
      layout: {
        "icon-image": ["get", "icon"],
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          MAP_MIN_ZOOM,
          ["*", ["get", "sz"], 0.32],
          14,
          ["*", ["get", "sz"], 0.78],
          MAP_MAX_ZOOM,
          ["*", ["get", "sz"], 0.95],
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-overlap": "always",
        "icon-anchor": "bottom",
        "icon-pitch-alignment": "viewport",
        "icon-rotation-alignment": "viewport",
        "symbol-sort-key": ["get", "score"],
        "symbol-z-order": "auto",
      },
      paint: {
        "icon-opacity": 1,
        "icon-opacity-transition": NO_FADE,
      },
    });
    map.addLayer({
      id: "center-labels",
      type: "symbol",
      source: "markers",
      filter: ["==", ["get", "kind"], 0],
      layout: {
        "text-field": ["get", "name"],
        "text-font": LABEL_FONT,
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, -0.05],
        "text-optional": true,
        "text-allow-overlap": false,
        "text-padding": 2,
        "symbol-sort-key": ["-", 0, ["to-number", ["get", "score"]]],
        "symbol-z-order": "auto",
      },
      paint: {
        "text-color": "#2a1c12",
        "text-halo-color": "#f4ead8",
        "text-halo-width": 1.4,
        "text-opacity-transition": NO_FADE,
      },
    });
    map.addLayer({
      id: "territory-labels",
      type: "symbol",
      source: "territory-labels",
      layout: {
        "text-field": ["get", "name"],
        "text-font": LABEL_FONT_BOLD,
        "text-size": [
          "interpolate",
          ["linear"],
          ["get", "n"],
          1,
          10,
          4,
          12,
          20,
          15,
          80,
          18,
        ],
        "text-optional": true,
        "text-allow-overlap": false,
        "text-padding": 4,
        "text-anchor": "center",
        "text-offset": [0, 0],
        "text-max-width": 8,
        "symbol-sort-key": ["-", 0, ["to-number", ["get", "score"]]],
        "symbol-z-order": "auto",
      },
      paint: {
        "text-color": "#2a1c12",
        "text-halo-color": "#f4ead8",
        "text-halo-width": 1.6,
        "text-halo-blur": 0.4,
        "text-opacity-transition": NO_FADE,
      },
    });
    applyPaint();
    map.once("idle", () => applyPaint());
    const boxes = (camera?.fitBboxes?.filter((b) => b.length === 4) ?? []) as BBox4[];
    if (boxes.length) {
      map.fitBounds(unionBboxes(boxes as [number, number, number, number][]), {
        padding: 56,
        maxZoom: 13,
        duration: 0,
      });
    }
    refreshFronts();
  });

  let selectedId: string | null = null;
  const applySelection = (id: string | null) => {
    selectedId = id;
    const match: maplibregl.FilterSpecification = ["==", ["get", "h"], id ?? ""];
    if (map.getLayer("h3-line-sel")) map.setFilter("h3-line-sel", match);
    if (map.getLayer("h3-line-sel-halo")) map.setFilter("h3-line-sel-halo", match);
  };

  const pickH3 = (point?: maplibregl.PointLike): { h3: string; props: TileProps } | null => {
    const layers = H3_PAINT_LAYERS.filter((id) => map.getLayer(id));
    if (!layers.length) return null;
    try {
      const props = map.queryRenderedFeatures(point, { layers: [...layers] })[0]?.properties;
      const id = props?.h;
      return typeof id === "string" && id ? { h3: id, props: props as TileProps } : null;
    } catch {
      return null;
    }
  };

  map.on("click", (e) => {
    const hit = pickH3(e.point);
    if (!hit || hit.h3 === selectedId) {
      applySelection(null);
      onCell(null, null);
      return;
    }
    applySelection(hit.h3);
    onCell(hit.h3, hit.props);
  });
  let hoverId: string | null = null;
  map.on("mousemove", (e) => {
    const hit = pickH3(e.point);
    map.getCanvas().style.cursor = hit ? "pointer" : "";
    if ((hit?.h3 ?? null) === hoverId) return;
    hoverId = hit?.h3 ?? null;
    onHover(hoverId, hit?.props ?? null);
  });
  map.on("mouseleave", () => {
    map.getCanvas().style.cursor = "";
    if (hoverId == null) return;
    hoverId = null;
    onHover(null, null);
  });
  map.on("moveend", onMove);
  map.on("zoom", () => {
    onPatternZoom();
    onFrontZoom();
  });
  map.on("zoomend", () => {
    if (highlightUids.length) syncDotPatterns();
    syncFrontsToCamera();
  });

  const replaceH3Source = (url: string) => {
    const selLayers = ["h3-line-sel", "h3-line-sel-halo"];
    const baseLayers = ["h3-grid", "h3-hatch", "h3-fill-dim", "h3-fill-sparse", "h3-fill"];
    for (const id of [...selLayers, ...baseLayers]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource("h3")) map.removeSource("h3");
    map.addSource("h3", {
      type: "vector",
      url: "pmtiles://" + url,
      minzoom: MAP_MIN_ZOOM,
      maxzoom: 14,
      promoteId: "h",
    });
    const beforeActivity = map.getLayer("user-activity-fill") ? "user-activity-fill" : undefined;
    addH3FillLayers(beforeActivity);
    map.addLayer(
      {
        id: "h3-hatch",
        type: "fill",
        source: "h3",
        "source-layer": "h3",
        filter: ["==", ["get", "a_sp"], 1],
        paint: { "fill-pattern": "hatch", "fill-opacity": 0.35, "fill-opacity-transition": NO_FADE },
      },
      beforeActivity,
    );
    map.addLayer(
      {
        id: "h3-grid",
        type: "line",
        source: "h3",
        "source-layer": "h3-grid",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#1f2937", "line-width": 1.1, "line-opacity": 0.1, "line-opacity-transition": NO_FADE },
      },
      beforeActivity,
    );
    const beforeSel = map.getLayer("capitals-ring") ? "capitals-ring" : undefined;
    map.addLayer(
      {
        id: "h3-line-sel-halo",
        type: "line",
        source: "h3",
        "source-layer": "h3",
        filter: ["==", ["get", "h"], ""],
        paint: { "line-color": "#2563eb", "line-width": 4.2, "line-opacity": 0.95, "line-opacity-transition": NO_FADE },
      },
      beforeSel,
    );
    map.addLayer(
      {
        id: "h3-line-sel",
        type: "line",
        source: "h3",
        "source-layer": "h3",
        filter: ["==", ["get", "h"], ""],
        paint: { "line-color": "#ffffff", "line-width": 1.8, "line-opacity": 1, "line-opacity-transition": NO_FADE },
      },
      beforeSel,
    );
    applySelection(selectedId);
    resetPaintStyle();
    applyPaint();
    map.once("idle", () => applyPaint());
  };

  return {
    map,
    setFilter: (next) => {
      filter = next;
      applyPaint();
      refreshOverlays();
      refreshActivity();
    },
    setMode: (next) => {
      mode = next;
      applyPaint();
    },
    setHighlightUsers: (uids) => {
      highlightUids = uids;
      applyPaint();
      if (uids.length) syncDotPatterns();
      refreshActivity();
    },
    setSelection: (id) => {
      applySelection(id);
    },
    refreshMarkers: refreshOverlays,
    setOverlayOpacity: (t) => {
      overlayAlpha = Math.round(Math.max(0, Math.min(1, t)) * 100) / 100;
      if (opacityRaf) return;
      opacityRaf = requestAnimationFrame(() => {
        opacityRaf = 0;
        const t0 = performance.now();
        applyOpacity();
        if (opacityLogged < 3) {
          console.debug(`[olg] opacity ${opacityLogged}: ${(performance.now() - t0).toFixed(1)}ms`);
          opacityLogged += 1;
        }
      });
    },
    setTopUsers: (next) => {
      topUsers = next;
      if (map.isStyleLoaded()) refreshActivity();
    },
    setSnapshot: (next, nextUsers, url, nextOverlays, nextFronts) => {
      core = next;
      users = nextUsers;
      pmtilesUrl = url;
      topUsers = null;
      packedOverlays = nextOverlays ?? null;
      packedFronts = nextFronts ?? null;
      overlayCache.clear();
      resetPaintStyle();
      clearStatsCaches();
      if (map.getSource("h3")) replaceH3Source(url);
      if (map.isStyleLoaded()) {
        refreshOverlays();
        refreshActivity();
        applyPaint();
      }
    },
  };
}
