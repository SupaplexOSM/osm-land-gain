import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { colorIndexFromName, CURRENTNESS_STOPS, FEATURE_STOPS, MEEPLE, PARCHMENT } from "./colors";
import { flagLngLat, maxFeatureCount, sparseThreshold, userActivityCollection, ACTIVITY_DOT_LEVELS, winnerColorByUid } from "./stats";
import { buildTerritoryOverlays } from "./territories";
import { FILTER_PREFIX, type CellsFile, type FilterId, type UserStat, type ViewMode } from "./types";
import { MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, MAP_MAX_ZOOM, MAP_MIN_ZOOM } from "./permalink";

export interface MapHandles {
  map: maplibregl.Map;
  setFilter: (filter: FilterId) => void;
  setMode: (mode: ViewMode) => void;
  setHighlightUsers: (uids: number[]) => void;
  setSelection: (h3: string | null) => void;
  refreshMarkers: () => void;
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

function matchMeeple(prop: string): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ["match", ["to-number", ["get", prop]]];
  MEEPLE.forEach((color, i) => {
    expr.push(i, color);
  });
  expr.push(PARCHMENT);
  return expr as maplibregl.ExpressionSpecification;
}

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
  data: CellsFile,
  users: Record<string, UserStat>,
  onCell: (h3: string | null) => void,
  onMove: () => void,
  onHover: (h3: string | null) => void = () => {},
  camera?: { center: [number, number]; zoom: number },
): Promise<MapHandles> {
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  const archiveUrl = new URL("./data/berlin.pmtiles", document.baseURI).href;

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

  const applyPaint = () => {
    const sp = pref(filter, "sp");
    const ci = pref(filter, "ci");
    const cu = pref(filter, "c");
    const n = pref(filter, "n");
    const w = pref(filter, "w");
    const activityFill = interpolateActivity(cu, n, sparseThreshold(data, filter));
    const countFill = interpolateCount(n, maxFeatureCount(data, filter));
    const scaleFill = mode === "features" ? countFill : activityFill;
    const choropleth = mode === "currentness" || mode === "features";
    const empty = ["<=", ["to-number", ["get", n]], 0] as maplibregl.ExpressionSpecification;
    const fillNormal: maplibregl.ExpressionSpecification =
      mode === "users"
        ? ([
            "case",
            empty,
            "rgba(0,0,0,0)",
            ["==", ["get", sp], 1],
            PARCHMENT,
            matchMeeple(ci),
          ] as maplibregl.ExpressionSpecification)
        : scaleFill;
    const highlighted = highlightUids.length > 0;
    const hit = highlighted ? inUidList(w, highlightUids) : (["boolean", true] as maplibregl.ExpressionSpecification);
    const fill: maplibregl.ExpressionSpecification = !highlighted
      ? fillNormal
      : mode === "users"
        ? ([
            "case",
            empty,
            "rgba(0,0,0,0)",
            ["==", ["get", sp], 1],
            PARCHMENT,
            hit,
            matchMeeple(ci),
            "#d1d5db",
          ] as maplibregl.ExpressionSpecification)
        : (["case", hit, scaleFill, "#d1d5db"] as maplibregl.ExpressionSpecification);
    const opacity: number | maplibregl.ExpressionSpecification = !highlighted
      ? (choropleth
          ? 0.84
          : (["case", empty, 0, ["==", ["get", sp], 1], 0.14, 0.72] as maplibregl.ExpressionSpecification))
      : ([
          "case",
          empty,
          0,
          hit,
          choropleth ? 0.9 : 0.84,
          ["==", ["get", sp], 1],
          0.05,
          0.08,
        ] as maplibregl.ExpressionSpecification);
    if (map.getLayer("h3-fill")) {
      map.setPaintProperty("h3-fill", "fill-color", fill);
      map.setPaintProperty("h3-fill", "fill-opacity", opacity);
    }
    if (map.getLayer("h3-hatch")) {
      map.setFilter("h3-hatch", ["all", ["==", ["get", sp], 1], [">", ["to-number", ["get", n]], 0]]);
      map.setPaintProperty("h3-hatch", "fill-opacity", choropleth || highlighted ? 0 : 0.35);
    }
    const overlayOp: maplibregl.ExpressionSpecification | number = !highlighted
      ? 0.62
      : (["case", inUidList("uid", highlightUids), 0.92, 0.06] as maplibregl.ExpressionSpecification);
    if (map.getLayer("territories")) map.setPaintProperty("territories", "line-opacity", overlayOp);
    const shadowOp: maplibregl.ExpressionSpecification | number = !highlighted
      ? 0.14
      : (["case", inUidList("uid", highlightUids), 0.2, 0.02] as maplibregl.ExpressionSpecification);
    if (map.getLayer("territories-shadow")) map.setPaintProperty("territories-shadow", "line-opacity", shadowOp);
    const markOp: maplibregl.ExpressionSpecification | number = !highlighted
      ? 1
      : (["case", inUidList("uid", highlightUids), 1, 0.12] as maplibregl.ExpressionSpecification);
    if (map.getLayer("capitals-dot")) map.setPaintProperty("capitals-dot", "circle-opacity", markOp);
    if (map.getLayer("capitals-ring")) map.setPaintProperty("capitals-ring", "circle-stroke-opacity", markOp);
    if (map.getLayer("flags")) map.setPaintProperty("flags", "icon-opacity", markOp);
    if (map.getLayer("center-labels")) map.setPaintProperty("center-labels", "text-opacity", markOp);
    if (map.getLayer("territory-labels")) map.setPaintProperty("territory-labels", "text-opacity", markOp);
  };

  const markerCollection = () => {
    const centers = data.centers?.[filter] ?? [];
    const capitalTotals = centers.filter((c) => c.own === 1).map((c) => c.total);
    const flagTotals = centers.filter((c) => c.own !== 1).map((c) => c.total);
    const colors = winnerColorByUid(data, filter);
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

  const overlayCache = new Map<FilterId, ReturnType<typeof buildTerritoryOverlays>>();
  const overlayData = () => {
    let hit = overlayCache.get(filter);
    if (!hit) {
      hit = buildTerritoryOverlays(data, filter, users);
      overlayCache.set(filter, hit);
    }
    return hit;
  };

  const emptyActivity = { type: "FeatureCollection" as const, features: [] as never[] };

  const refreshOverlays = () => {
    const { outlines, labels } = overlayData();
    (map.getSource("territories") as maplibregl.GeoJSONSource | undefined)?.setData(outlines);
    (map.getSource("territory-labels") as maplibregl.GeoJSONSource | undefined)?.setData(labels);
    (map.getSource("markers") as maplibregl.GeoJSONSource | undefined)?.setData(markerCollection());
  };

  const refreshActivity = () => {
    const src = map.getSource("user-activity") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!highlightUids.length) {
      src.setData(emptyActivity);
      return;
    }
    const colors = winnerColorByUid(data, filter);
    for (const uid of highlightUids) {
      if (colors.has(uid)) continue;
      const name = users[String(uid)]?.name;
      if (name) colors.set(uid, colorIndexFromName(name));
    }
    src.setData(userActivityCollection(data, filter, highlightUids, colors));
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

  map.on("load", () => {
    softenBasemap(map);
    map.addImage("hatch", hatchImage());
    syncDotPatterns();
    MEEPLE.forEach((color, i) => {
      map.addImage(`olg-flag-${i}`, canvasToImage(drawPennant(color)));
    });

    map.addSource("h3", {
      type: "vector",
      url: "pmtiles://" + archiveUrl,
      minzoom: MAP_MIN_ZOOM,
      maxzoom: 14,
      promoteId: "h",
    });
    map.addLayer({
      id: "h3-fill",
      type: "fill",
      source: "h3",
      "source-layer": "h3",
      paint: {
        "fill-color": PARCHMENT,
        "fill-opacity": 0.72,
        "fill-antialias": true,
        "fill-outline-color": "rgba(0,0,0,0)",
      },
    });
    map.addLayer({
      id: "h3-hatch",
      type: "fill",
      source: "h3",
      "source-layer": "h3",
      filter: ["==", ["get", "a_sp"], 1],
      paint: { "fill-pattern": "hatch", "fill-opacity": 0.35 },
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
      },
    });
    map.addSource("user-activity", { type: "geojson", data: emptyActivity });
    map.addLayer({
      id: "user-activity-fill",
      type: "fill",
      source: "user-activity",
      paint: {
        "fill-color": matchMeeple("ci"),
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["to-number", ["get", "t"]],
          0,
          0.12,
          1,
          0.38,
        ],
      },
    });
    map.addLayer({
      id: "user-activity",
      type: "fill",
      source: "user-activity",
      paint: {
        "fill-pattern": activityPatternExpr(),
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["to-number", ["get", "t"]],
          0,
          0.4,
          1,
          1,
        ],
      },
    });
    const overlays = overlayData();
    map.addSource("territories", { type: "geojson", data: overlays.outlines });
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
      },
    });
    map.addLayer({
      id: "h3-line-sel-halo",
      type: "line",
      source: "h3",
      "source-layer": "h3",
      filter: ["==", ["get", "h"], ""],
      paint: { "line-color": "#2563eb", "line-width": 4.2, "line-opacity": 0.95 },
    });
    map.addLayer({
      id: "h3-line-sel",
      type: "line",
      source: "h3",
      "source-layer": "h3",
      filter: ["==", ["get", "h"], ""],
      paint: { "line-color": "#ffffff", "line-width": 1.8, "line-opacity": 1 },
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
      },
    });
    applyPaint();
  });

  let selectedId: string | null = null;
  const applySelection = (id: string | null) => {
    selectedId = id;
    const match: maplibregl.FilterSpecification = ["==", ["get", "h"], id ?? ""];
    if (map.getLayer("h3-line-sel")) map.setFilter("h3-line-sel", match);
    if (map.getLayer("h3-line-sel-halo")) map.setFilter("h3-line-sel-halo", match);
  };

  map.on("click", "h3-fill", (e) => {
    const id = e.features?.[0]?.properties?.h as string | undefined;
    if (!id) return;
    if (id === selectedId) {
      applySelection(null);
      onCell(null);
    } else {
      applySelection(id);
      onCell(id);
    }
  });
  map.on("click", (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ["h3-fill"] });
    if (!hits.length) {
      applySelection(null);
      onCell(null);
    }
  });
  map.on("mouseenter", "h3-fill", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  let hoverId: string | null = null;
  map.on("mousemove", "h3-fill", (e) => {
    const id = (e.features?.[0]?.properties?.h as string | undefined) ?? null;
    if (id === hoverId) return;
    hoverId = id;
    onHover(id);
  });
  map.on("mouseleave", "h3-fill", () => {
    map.getCanvas().style.cursor = "";
    if (hoverId == null) return;
    hoverId = null;
    onHover(null);
  });
  map.on("moveend", onMove);
  map.on("zoom", onPatternZoom);
  map.on("zoomend", () => {
    if (highlightUids.length) syncDotPatterns();
  });

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
  };
}
