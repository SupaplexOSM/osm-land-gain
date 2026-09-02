import type { OverlayCollection } from "./territories";
import { FILTERS, type FilterId } from "./types";

type Ring = [number, number][];

type Feature = {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: { type: "Polygon"; coordinates: Ring[] };
};

/**
 * One stretch of a territory border. The pipeline only ships the two endpoints,
 * the owner and which side the teeth point to; tangent, length and the latitude
 * cosine are cheap to derive and would otherwise triple the payload.
 */
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

/** Wire format of one row in fronts.json.gz. */
type PackedSegment = [uid: number, depth: number, ax: number, ay: number, bx: number, by: number, sign: number];

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

function isPackedSegment(value: unknown): value is PackedSegment {
  if (!Array.isArray(value) || value.length !== 7) return false;
  for (const n of value) if (typeof n !== "number" || !Number.isFinite(n)) return false;
  const depth = value[1];
  return depth === 1 || depth === 2 || depth === 3;
}

/** Rebuild the drawing frame from the two endpoints and the outward sign. */
function unpackSegment(row: PackedSegment): FrontSegment | null {
  const [uid, depth, ax, ay, bx, by, sign] = row;
  const midLat = (ay + by) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180) || 1e-6;
  const ex = (bx - ax) * cos;
  const ey = by - ay;
  const edgeLen = Math.hypot(ex, ey);
  if (edgeLen < 1e-12) return null;
  const tx = ex / edgeLen;
  const ty = ey / edgeLen;
  const s = sign < 0 ? -1 : 1;
  return {
    uid,
    depth: depth as 1 | 2 | 3,
    a: [ax, ay],
    b: [bx, by],
    tx,
    ty,
    ox: -ty * s,
    oy: tx * s,
    edgeLen,
    cos,
  };
}

export type PackedFronts = Partial<Record<FilterId, FrontSegment[]>>;

export function parsePackedFronts(raw: unknown): PackedFronts | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: PackedFronts = {};
  for (const filt of FILTERS) {
    const rows = src[filt];
    if (!Array.isArray(rows)) continue;
    const segments: FrontSegment[] = [];
    for (const row of rows) {
      if (!isPackedSegment(row)) continue;
      const seg = unpackSegment(row);
      if (seg) segments.push(seg);
    }
    out[filt] = segments;
  }
  return Object.keys(out).length ? out : null;
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
