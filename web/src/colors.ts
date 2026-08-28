/** User-Farbpalette — Index muss zu pipeline palette_size (128) passen.
 *  Golden-Angle-Hue plus acht Sättigungs-/Helligkeitsbänder. */

const GOLDEN_ANGLE = 137.508;
const SAT = [0.95, 0.55, 0.84, 0.68, 0.9, 0.48, 0.76, 0.62];
const LIT = [0.36, 0.56, 0.28, 0.48, 0.42, 0.6, 0.32, 0.52];
export const PALETTE_SIZE = 128;

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export const MEEPLE: string[] = Array.from({ length: PALETTE_SIZE }, (_, i) =>
  hslToHex((i * GOLDEN_ANGLE) % 360, SAT[i % 4], LIT[i % 4]),
);

export const PARCHMENT = "#d9c7a6";
export const PARCHMENT_DARK = "#c4b08c";
export const INK = "#2c2118";

/** Stops 0–1: dunkle Töne bis in den mittleren Bereich, Orange ab mittelhoch */
export const CURRENTNESS_STOPS: Array<[number, string]> = [
  [0, "#08040f"],
  [0.1, "#1a0533"],
  [0.22, "#2e1065"],
  [0.34, "#5b21b6"],
  [0.45, "#c2410c"],
  [0.58, "#ea580c"],
  [0.7, "#f59e0b"],
  [0.84, "#facc15"],
  [0.94, "#fef9c3"],
  [1, "#fffef7"],
];

export const CURRENTNESS_CSS = CURRENTNESS_STOPS.map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(", ");

/** Stops 0–1: hell (wenig) → blau, dunkles Blau/Lila mäßig gedrängt, Rot ab 0,88 */
export const FEATURE_STOPS: Array<[number, string]> = [
  [0, "#f8fafc"],
  [0.12, "#e0f2fe"],
  [0.26, "#bae6fd"],
  [0.42, "#38bdf8"],
  [0.56, "#0ea5e9"],
  [0.68, "#0284c7"],
  [0.74, "#0369a1"],
  [0.8, "#1e40af"],
  [0.84, "#6b21a8"],
  [0.88, "#be185d"],
  [0.94, "#e11d48"],
  [1, "#fb923c"],
];

export const FEATURE_CSS = FEATURE_STOPS.map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(", ");

export function currentnessColor(value: number): string {
  const t = Math.max(0, Math.min(1, value));
  let i = 0;
  while (i < CURRENTNESS_STOPS.length - 1 && t > CURRENTNESS_STOPS[i + 1][0]) i++;
  const [t0, c0] = CURRENTNESS_STOPS[i];
  const [t1, c1] = CURRENTNESS_STOPS[Math.min(i + 1, CURRENTNESS_STOPS.length - 1)];
  const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const a = hexRgb(c0);
  const b = hexRgb(c1);
  return `rgb(${Math.round(a.r + (b.r - a.r) * u)},${Math.round(a.g + (b.g - a.g) * u)},${Math.round(a.b + (b.b - a.b) * u)})`;
}

function hexRgb(hex: string): { r: number; g: number; b: number } {
  const n = hex.replace("#", "");
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  };
}

export function userColor(index: number): string {
  return MEEPLE[index % MEEPLE.length];
}

/** FNV-1a, same as pipeline/weights.py */
export function colorIndexFromName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % MEEPLE.length;
}
