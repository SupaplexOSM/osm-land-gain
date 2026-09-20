import "maplibre-gl/dist/maplibre-gl.css";
import { CURRENTNESS_CSS } from "./colors";
import { parsePackedFronts, type PackedFronts } from "./fronts";
import { fetchJson, fetchJsonOptional, isAbortError } from "./gz";
import { createMap, warmTiles, type MapHandles } from "./map";
import { osmExtentUrl, renderCellPanel, renderHighlightChip, renderViewportPanel } from "./panel";
import {
  MAP_DEFAULT_CENTER,
  MAP_DEFAULT_ZOOM,
  parsePermalink,
  writePermalink,
} from "./permalink";
import {
  cellActivity,
  cellStatsFor,
  cellView,
  cellsInBounds,
  densityBins,
  densitySvgPaths,
  featureLegendMarks,
  featureStrength,
  maxFeatureCount,
  mergeMaxCount,
  sparseThreshold,
  viewportRanking,
  pendingViewportSummary,
  viewportSummary,
  visibleCellStats,
  winnerColorByUid,
} from "./stats";
import { parsePackedOverlays, type PackedOverlays } from "./territories";
import type { TopUsers } from "./topusers";
import { loadTopUsers, type TopUsersHandle } from "./topusersclient";
import type { CellStats, FilterId, SnapshotCore, TileProps, UserStat, ViewMode } from "./types";
import { cellStatsFromTile, FILTERS, FILTER_TIPS } from "./types";
import "./style.css";

interface Snapshot {
  id: string;
  date: string;
  season: string;
  label: string;
  short?: string;
  period?: string;
  year?: number;
}

/**
 * Everything needed before the map can be shown. The per-cell top-user lists are
 * deliberately not in here; they stream in afterwards and only fill the panels.
 */
type CachedSnapshot = {
  core: SnapshotCore;
  users: Record<string, UserStat>;
  overlays: PackedOverlays | null;
  fronts: PackedFronts | null;
  topUsers: TopUsers | null;
};

const SNAPSHOT_CACHE_MAX = 4;

const MONTH_DE = [
  "",
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

function formatPeriodDay(d: Date, withYear: boolean): string {
  const text = `${d.getUTCDate()}. ${MONTH_DE[d.getUTCMonth() + 1]}`;
  return withYear ? `${text} ${d.getUTCFullYear()}` : text;
}

function snapshotPeriodHint(s: Snapshot): string {
  const end = new Date(`${s.date}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return s.period ?? "";
  return `OSM-Bearbeitungen bis ${formatPeriodDay(end, true)}`;
}

function isSpringSnapshot(s: Snapshot): boolean {
  return s.season === "fruehling" || /^\d{4}-03-21$/.test(s.date);
}

function isWinterSnapshot(s: Snapshot): boolean {
  return s.season === "winter" || /^\d{4}-12-21$/.test(s.date || s.id);
}

/** Evenly spaced tick indices; always includes the first (and last when n > 1). At most `maxLabels`. */
function yearLabelIndices(n: number, maxLabels = 7): number[] {
  if (n <= 0) return [];
  const count = Math.min(n, maxLabels);
  if (count === 1) return [0];
  const out = new Set<number>();
  for (let k = 0; k < count; k++) {
    out.add(Math.round((k / (count - 1)) * (n - 1)));
  }
  return [...out].sort((a, b) => a - b);
}

function snapshotYear(s: Snapshot): number {
  return s.year ?? Number((s.date || s.id).slice(0, 4));
}

function snapshotDisplayLabel(s: Snapshot, yearMode: boolean): string {
  if (yearMode) return `Datenstand: ${snapshotYear(s)}`;
  return s.label;
}

function snapshotMillis(id: string): number {
  const t = Date.parse(`${id}T23:59:59Z`);
  return Number.isFinite(t) ? t : Date.now();
}

function snapshotUrls(id: string): {
  core: string;
  users: string;
  pmtiles: string;
  overlays: string;
  fronts: string;
  topUsers: string;
} {
  const base = `./data/${id}`;
  const abs = (name: string) => new URL(`${base}/${name}`, document.baseURI).href;
  return {
    core: `${base}/cells.json`,
    users: `${base}/users.json.gz`,
    // The worker and the PMTiles protocol resolve relative paths against their
    // own script, so hand them absolute URLs.
    pmtiles: abs("cells.pmtiles"),
    overlays: `${base}/overlays.json.gz`,
    fronts: `${base}/fronts.json.gz`,
    topUsers: abs("cells.bin.gz"),
  };
}

function neighbourSnapshotIds(track: Snapshot[], id: string): string[] {
  const i = track.findIndex((s) => s.id === id);
  if (i < 0) return [];
  return [track[i + 1]?.id, track[i - 1]?.id].filter((s): s is string => Boolean(s));
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} fehlt`);
  return el;
}

async function main(): Promise<void> {
  const loading = $("loading");
  const loadingStatus = $("loading-status");
  const loadingFill = $("loading-fill");
  const loadingBar = $("loading-bar");
  let statusText = "Daten werden geladen…";
  const setProgress = (pct: number, label?: string) => {
    const n = Math.max(0, Math.min(100, Math.round(pct)));
    loadingFill.style.width = `${n}%`;
    loadingBar.setAttribute("aria-valuenow", String(n));
    if (label) statusText = label;
    loadingStatus.textContent = `${statusText}  ${n} %`;
  };
  let filter: FilterId = "all";
  let mode: ViewMode = "users";
  let selected: string | null = null;
  let hovered: string | null = null;
  // Tile properties of the clicked and hovered hex, kept so switching filters or
  // panning does not have to search the loaded tiles again.
  let selectedProps: TileProps | null = null;
  let hoveredProps: TileProps | null = null;
  const highlightedUids = new Set<number>();
  let handles: MapHandles | undefined;
  let core: SnapshotCore;
  let users: Record<string, UserStat>;
  let snapshots: Snapshot[] = [];
  let history: Snapshot[] = [];
  /** All available 21 Dec stands, oldest → newest (history + winter quarters). */
  let yearTrack: Snapshot[] = [];
  let timelineMode: "quarters" | "years" = "quarters";
  let snapshotId = "";
  /** Slider/label target; may lead `snapshotId` while the map payload is still loading. */
  let uiSnapshotId = "";
  const snapshotCache = new Map<string, CachedSnapshot>();
  let packedOverlays: PackedOverlays | null = null;
  let packedFronts: PackedFronts | null = null;
  let topUsers: TopUsers | null = null;
  let topUsersJob: TopUsersHandle | null = null;
  let scaleMaxCount: Partial<Record<FilterId, number>> = {};
  const featureMax = (nextFilter = filter) => maxFeatureCount(core.meta, nextFilter, scaleMaxCount);
  const activeTrack = () => (timelineMode === "years" ? yearTrack : snapshots);

  const takeCachedSnapshot = (id: string): CachedSnapshot | undefined => {
    const hit = snapshotCache.get(id);
    if (!hit) return undefined;
    snapshotCache.delete(id);
    snapshotCache.set(id, hit);
    return hit;
  };

  const rememberSnapshot = (id: string, cached: CachedSnapshot) => {
    snapshotCache.delete(id);
    snapshotCache.set(id, cached);
    while (snapshotCache.size > SNAPSHOT_CACHE_MAX) {
      const oldest = snapshotCache.keys().next().value as string | undefined;
      if (!oldest || oldest === id) break;
      snapshotCache.delete(oldest);
    }
  };

  /** Core payload only — a few hundred KB, enough to put the map on screen. */
  const fetchSnapshotCore = async (id: string, signal?: AbortSignal): Promise<CachedSnapshot> => {
    const hit = takeCachedSnapshot(id);
    if (hit) return hit;
    const urls = snapshotUrls(id);
    const t0 = performance.now();
    const [nextCore, nextUsers, overlayRaw, frontRaw] = await Promise.all([
      fetchJson<SnapshotCore>(urls.core, signal),
      fetchJson<Record<string, UserStat>>(urls.users, signal),
      fetchJsonOptional(urls.overlays, signal),
      fetchJsonOptional(urls.fronts, signal),
    ]);
    console.debug(`[olg] snapshot ${id}: core ${(performance.now() - t0).toFixed(0)}ms`);
    const cached: CachedSnapshot = {
      core: nextCore,
      users: nextUsers,
      overlays: parsePackedOverlays(overlayRaw),
      fronts: parsePackedFronts(frontRaw),
      topUsers: null,
    };
    rememberSnapshot(id, cached);
    return cached;
  };

  /**
   * Pull the top-user lists in a worker and refresh the panels once they land.
   * Everything already on screen keeps working while this runs.
   */
  const startTopUsers = (id: string, cached: CachedSnapshot) => {
    topUsersJob?.cancel();
    topUsersJob = null;
    topUsers = cached.topUsers;
    handles?.setTopUsers(topUsers);
    if (topUsers) return;
    const t0 = performance.now();
    const job = loadTopUsers(snapshotUrls(id).topUsers);
    topUsersJob = job;
    job.ready.then(
      (loaded) => {
        cached.topUsers = loaded;
        if (topUsersJob !== job) return;
        topUsersJob = null;
        topUsers = loaded;
        console.debug(`[olg] snapshot ${id}: top users ${(performance.now() - t0).toFixed(0)}ms`);
        handles?.setTopUsers(loaded);
        refreshPanels();
      },
      (err) => {
        if (topUsersJob === job) topUsersJob = null;
        if (isAbortError(err)) return;
        console.error("[olg] cells.bin.gz", err);
      },
    );
  };

  /** Warm the neighbouring snapshots while the browser is idle. */
  const prefetchNeighbours = () => {
    const idle =
      window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    idle(() => {
      for (const id of neighbourSnapshotIds(activeTrack(), snapshotId)) {
        if (snapshotCache.has(id)) continue;
        warmTiles(snapshotUrls(id).pmtiles);
        void fetchSnapshotCore(id).catch(() => {});
      }
    });
  };

  try {
    const manifest = await fetchJson<{
      snapshots?: Snapshot[];
      history?: Snapshot[];
      max_count?: Partial<Record<FilterId, number>>;
    }>("./data/snapshots.json");
    snapshots = (manifest.snapshots ?? []).filter((s) => s.id);
    history = (manifest.history ?? []).filter((s) => s.id);
    if (!snapshots.length) throw new Error("snapshots.json ist leer");
    const byId = new Map<string, Snapshot>();
    for (const s of [...history, ...snapshots]) {
      if (isWinterSnapshot(s)) byId.set(s.id, s);
    }
    yearTrack = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
    scaleMaxCount = mergeMaxCount(manifest.max_count);
    if (!Object.values(scaleMaxCount).some((n) => (n ?? 0) > 0)) {
      const metas = await Promise.all(
        [...snapshots, ...history].map((s) =>
          fetchJsonOptional<{ max_count?: Partial<Record<FilterId, number>> }>(`./data/${s.id}/meta.json`),
        ),
      );
      scaleMaxCount = mergeMaxCount(...metas.map((m) => m?.max_count));
    }
    const bootLink = parsePermalink();
    const wanted = bootLink.date;
    const listed = [...history, ...snapshots];
    const startSnap =
      (wanted && listed.find((s) => s.id === wanted || s.date === wanted)) || snapshots[snapshots.length - 1]!;
    snapshotId = startSnap.id;
    uiSnapshotId = startSnap.id;
    // Permalink to a stand that is not among the 12 quarters → open in year mode.
    timelineMode =
      snapshots.some((s) => s.id === snapshotId) || !yearTrack.some((s) => s.id === snapshotId)
        ? "quarters"
        : "years";
    setProgress(40);
    warmTiles(snapshotUrls(snapshotId).pmtiles);
    const cached = await fetchSnapshotCore(snapshotId);
    core = cached.core;
    users = cached.users;
    packedOverlays = cached.overlays;
    packedFronts = cached.fronts;
    setProgress(100, "Karte wird vorbereitet…");
  } catch (err) {
    loading.innerHTML = `<p>Daten fehlen. Pipeline zuerst ausführen:<br><code>python -m pipeline.run --profile dev --download --history --dates 2025-12-21,2026-03-21,2026-06-21</code></p>`;
    throw err;
  }

  const uidByName = new Map<string, number>();
  const rebuildUidIndex = () => {
    uidByName.clear();
    for (const [id, u] of Object.entries(users)) {
      const uid = Number(id);
      if (!uid || !u.name || u.name.startsWith("#")) continue;
      uidByName.set(u.name, uid);
    }
  };
  rebuildUidIndex();

  const applyLink = (link: ReturnType<typeof parsePermalink>) => {
    filter = link.filter ?? "all";
    mode = link.mode ?? "users";
    selected = link.cell || null;
    selectedProps = null;
    highlightedUids.clear();
    for (const name of link.userNames ?? []) {
      const uid = uidByName.get(name);
      if (uid) highlightedUids.add(uid);
    }
  };
  const startLink = parsePermalink();
  applyLink(startLink);

  const generated = $("generated");
  const snapshotWrap = $("snapshot-slider-wrap");
  const snapshotSlider = $("snapshot-slider") as HTMLInputElement;
  const snapshotLabel = $("snapshot-label");
  const snapshotTicks = $("snapshot-ticks");
  const navPast = $("snapshot-nav-past") as HTMLButtonElement;
  const navPresent = $("snapshot-nav-present") as HTMLButtonElement;
  const frontsLegend = $("lede-legend-fronts");
  const findSnapshot = (id: string) =>
    snapshots.find((s) => s.id === id || s.date === id) ??
    history.find((s) => s.id === id || s.date === id) ??
    yearTrack.find((s) => s.id === id || s.date === id);
  const currentSnapshot = () => findSnapshot(snapshotId) ?? snapshots[snapshots.length - 1]!;
  const syncFrontsLegend = () => {
    const mute = packedFronts == null;
    frontsLegend.classList.toggle("off", mute);
    frontsLegend.toggleAttribute("aria-disabled", mute);
  };
  /** Shark teeth follow the loaded snapshot in both quarter and year mode. */
  const syncMapFronts = () => {
    handles?.setPackedFronts(packedFronts);
    syncFrontsLegend();
  };
  const syncFilterAvailability = () => {
    const counts = core.meta.max_count ?? {};
    let fallback = false;
    FILTERS.forEach((id) => {
      const b = $("filters").querySelector(`[data-filter="${id}"]`) as HTMLButtonElement | null;
      if (!b) return;
      const empty = id !== "all" && (counts[id] ?? 0) <= 0;
      b.disabled = empty;
      if (empty) {
        b.title = `${FILTER_TIPS[id]} (in diesem Datenstand keine Daten)`;
        if (filter === id) fallback = true;
      } else {
        b.title = FILTER_TIPS[id];
      }
    });
    if (fallback) {
      filter = "all";
      $("filters").querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", b.getAttribute("data-filter") === "all");
      });
      handles?.setFilter(filter);
    }
  };
  const syncNavButtons = () => {
    const canYears = yearTrack.length > 0 && history.length > 0;
    const inYears = timelineMode === "years";
    navPast.disabled = !canYears || inYears;
    navPresent.disabled = !inYears;
    snapshotWrap.classList.toggle("years", inYears);
  };
  const syncSnapshotLabel = (id = snapshotId) => {
    const snap = findSnapshot(id) ?? currentSnapshot();
    const track = activeTrack();
    const idx = track.findIndex((s) => s.id === snap.id);
    const yearMode = timelineMode === "years";
    const text = snapshotDisplayLabel(snap, yearMode);
    snapshotLabel.textContent = text;
    snapshotLabel.title = snapshotPeriodHint(snap);
    snapshotSlider.setAttribute("aria-valuetext", text);
    if (idx >= 0) snapshotSlider.setAttribute("aria-valuenow", String(idx));
    const many = snapshots.length > 1 || yearTrack.length > 1;
    generated.hidden = many;
    generated.textContent = many ? "" : text;
    generated.title = many ? "" : snapshotPeriodHint(snap);
    snapshotTicks.querySelectorAll("[data-index]").forEach((el) => {
      const on = idx >= 0 && Number((el as HTMLElement).dataset.index) === idx;
      el.classList.toggle("on", on);
      el.querySelector(".snapshot-tick-year")?.classList.toggle("on", on);
    });
    syncFrontsLegend();
    syncNavButtons();
  };
  const setupSlider = (focusId = uiSnapshotId) => {
    const track = activeTrack();
    const many = snapshots.length > 1 || yearTrack.length > 1;
    snapshotWrap.classList.toggle("hide", !many);
    snapshotWrap.toggleAttribute("hidden", !many);
    snapshotSlider.min = "0";
    snapshotSlider.max = String(Math.max(0, track.length - 1));
    const idx = track.findIndex((s) => s.id === focusId);
    snapshotSlider.value = String(Math.max(0, idx));
    snapshotTicks.replaceChildren();
    const n = track.length;
    const yearMode = timelineMode === "years";
    const labelAt = yearMode ? new Set(yearLabelIndices(n, 7)) : null;
    track.forEach((s, i) => {
      const mark = document.createElement("span");
      mark.className = "snapshot-tick";
      mark.dataset.index = String(i);
      // Same geometry as the range thumb center: half-thumb + t * (width - thumb).
      const t = n <= 1 ? 0.5 : i / (n - 1);
      mark.style.left = `calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${t})`;
      const showYear = yearMode ? labelAt!.has(i) : isSpringSnapshot(s);
      if (showYear) {
        const yearBtn = document.createElement("button");
        yearBtn.type = "button";
        yearBtn.className = "snapshot-tick-year";
        yearBtn.textContent = String(snapshotYear(s));
        yearBtn.title = snapshotDisplayLabel(s, yearMode);
        yearBtn.dataset.index = String(i);
        yearBtn.tabIndex = -1;
        mark.append(yearBtn);
      }
      snapshotTicks.append(mark);
    });
    syncSnapshotLabel(focusId);
  };
  const pickYearNear = (from: Snapshot): Snapshot => {
    const t = Date.parse(from.date);
    const exact = yearTrack.find((s) => s.id === from.id);
    if (exact) return exact;
    const earlier = [...yearTrack].reverse().find((s) => Date.parse(s.date) <= t);
    return earlier ?? yearTrack[yearTrack.length - 1]!;
  };
  const enterYearMode = () => {
    if (timelineMode === "years" || !yearTrack.length || !history.length) return;
    const next = pickYearNear(currentSnapshot());
    timelineMode = "years";
    uiSnapshotId = next.id;
    setupSlider(next.id);
    syncMapFronts();
    void applySnapshot(next.id);
  };
  const enterQuarterMode = () => {
    if (timelineMode === "quarters") return;
    const cur = currentSnapshot();
    const next =
      snapshots.find((s) => s.id === cur.id) ??
      snapshots.find((s) => s.date === cur.date) ??
      snapshots[snapshots.length - 1]!;
    timelineMode = "quarters";
    uiSnapshotId = next.id;
    setupSlider(next.id);
    syncMapFronts();
    void applySnapshot(next.id);
  };
  setupSlider();

  const legend = $("currentness-legend");
  const legendTitle = $("legend-title");
  const legendBar = $("legend-bar");
  const legendLabels = $("legend-labels");
  const hoverTick = $("legend-tick-hover");
  const selTick = $("legend-tick-sel");
  const choropleth = () => mode === "currentness" || mode === "features";
  const syncLegend = () => {
    const on = choropleth();
    legend.classList.toggle("hide", !on);
    legend.toggleAttribute("hidden", !on);
    if (mode === "features") {
      legendTitle.textContent = "Features";
      legendBar.style.background = `linear-gradient(90deg, ${CURRENTNESS_CSS})`;
      legendLabels.classList.add("legend-counts");
      legendLabels.classList.remove("legend-levels");
      legendLabels.replaceChildren();
      for (const [t, label] of featureLegendMarks(featureMax())) {
        const span = document.createElement("span");
        span.textContent = label;
        span.style.left = `${Math.round(t * 100)}%`;
        legendLabels.append(span);
      }
    } else {
      legendTitle.textContent = "Aktivität";
      legendBar.style.background = `linear-gradient(90deg, ${CURRENTNESS_CSS})`;
      legendLabels.classList.add("legend-levels");
      legendLabels.classList.remove("legend-counts");
      legendLabels.style.removeProperty("left");
      legendLabels.innerHTML = "<span>keine / sehr gering</span><span>mittelhoch</span><span>sehr hoch</span>";
    }
  };
  /** Cell numbers for the current filter, from remembered tile props if we have them. */
  const statsFor = (h3: string | null, props: TileProps | null): CellStats | null => {
    if (!h3) return null;
    if (props) return cellStatsFromTile(props, filter);
    return handles ? cellStatsFor(handles.map, h3, filter) : null;
  };

  const placeTick = (el: HTMLElement, h3: string | null, props: TileProps | null) => {
    const view = choropleth() ? statsFor(h3, props) : null;
    if (!view) {
      el.toggleAttribute("hidden", true);
      return;
    }
    const t =
      mode === "features"
        ? featureStrength(view.count, featureMax())
        : cellActivity(view, sparseThreshold(core.meta, filter));
    el.style.left = `${Math.round(Math.max(0, Math.min(1, t)) * 100)}%`;
    el.toggleAttribute("hidden", false);
  };
  const syncLegendTicks = () => {
    placeTick(hoverTick, hovered, hoveredProps);
    placeTick(selTick, selected, selectedProps);
  };

  const legendHistoFill = document.querySelector("#legend-histo .legend-histo-fill");
  const legendHistoLine = document.querySelector("#legend-histo .legend-histo-line");
  const drawLegendDensity = (cells: CellStats[]) => {
    if (!legendHistoFill || !legendHistoLine) return;
    const values =
      mode === "features"
        ? cells.map((c) => featureStrength(c.count, featureMax()))
        : cells.map((c) => cellActivity(c, sparseThreshold(core.meta, filter)));
    const { fill, line } = densitySvgPaths(densityBins(values));
    legendHistoFill.setAttribute("d", fill);
    legendHistoLine.setAttribute("d", line);
  };

  const syncHighlight = () => {
    handles?.setHighlightUsers([...highlightedUids]);
  };

  const cameraKey = () => {
    const z = handles!.map.getZoom();
    const b = handles!.map.getBounds();
    return `${z.toFixed(3)}:${b.getWest().toFixed(5)}:${b.getSouth().toFixed(5)}:${b.getEast().toFixed(5)}:${b.getNorth().toFixed(5)}`;
  };
  let lastCamKey = "";
  let moveTimer = 0;
  let tileTimer = 0;
  let neighboursWarmed = false;
  const refreshPanels = (opts?: { fromCamera?: boolean }) => {
    if (!handles) return;
    const camKey = cameraKey();
    if (opts?.fromCamera && camKey === lastCamKey) return;
    lastCamKey = camKey;
    const threshold = sparseThreshold(core.meta, filter);
    const view = cellView(statsFor(selected, selectedProps), filter, topUsers);
    const colors = winnerColorByUid(core, filter);
    renderHighlightChip($("user-chip"), highlightedUids, users);
    const asOf =
      snapshotId && snapshotId === snapshots[snapshots.length - 1]?.id
        ? snapshotMillis(snapshotId)
        : null;
    renderCellPanel($("cell-panel"), view, users, filter, core.centers?.[filter] ?? [], mode, colors, highlightedUids, threshold, asOf);
    let cells: CellStats[] = visibleCellStats(handles.map, filter);
    const tilesReady = cells.length > 0;
    if (!tilesReady) {
      // Tiles are not in yet: use covering hexes for ranking/mapper count only.
      // Do not invent zero object/activity stats — that flashed "0 Features" / "0 %".
      cells = cellsInBounds(handles.map.getBounds(), core.meta.h3_res).map((h3) => ({
        h3,
        winner: 0,
        score: 0,
        currentness: 0,
        count: 0,
        meanAgeDays: 0,
        sparse: true,
        colorIndex: 0,
      }));
    }
    const ranked = viewportRanking(cells.map((c) => c.h3), users, filter, topUsers, snapshotMillis(snapshotId));
    const summary = tilesReady
      ? viewportSummary(cells, core.meta, filter, topUsers)
      : pendingViewportSummary();
    const osmUrl = osmExtentUrl(handles.map.getCenter(), handles.map.getZoom());
    renderViewportPanel($("viewport-panel"), ranked, summary, colors, highlightedUids, osmUrl, asOf, filter);
    if (tilesReady) drawLegendDensity(cells);
    syncLegendTicks();
    const center = handles.map.getCenter();
    writePermalink({
      zoom: handles.map.getZoom(),
      lat: center.lat,
      lng: center.lng,
      filter,
      mode,
      cell: selected,
      userNames: [...highlightedUids]
        .map((uid) => users[String(uid)]?.name)
        .filter((name): name is string => Boolean(name)),
      date: snapshotId && snapshotId !== snapshots[snapshots.length - 1]?.id ? snapshotId : null,
    });
  };
  const onCameraMove = () => {
    window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => refreshPanels({ fromCamera: true }), 80);
  };

  handles = await createMap(
    $("map"),
    core,
    users,
    (h3, props) => {
      selected = h3;
      selectedProps = props;
      refreshPanels();
    },
    onCameraMove,
    (h3, props) => {
      hovered = h3;
      hoveredProps = props;
      syncLegendTicks();
    },
    {
      center: [startLink.lng ?? MAP_DEFAULT_CENTER[0], startLink.lat ?? MAP_DEFAULT_CENTER[1]],
      zoom: startLink.zoom ?? MAP_DEFAULT_ZOOM,
      pmtilesUrl: snapshotUrls(snapshotId).pmtiles,
      packedOverlays,
      packedFronts,
      featureMax: scaleMaxCount,
    },
  );
  handles.setFilter(filter);
  handles.setMode(mode);
  handles.setSelection(selected);
  handles.setHighlightUsers([...highlightedUids]);
  syncFrontsLegend();

  let snapGen = 0;
  let snapAbort: AbortController | null = null;
  /** Non-null while we wait for h3 viewport tiles after a snapshot switch. */
  let tilesWaitGen: number | null = null;
  let tilesWaitTimer = 0;
  const mapLoading = $("map-loading");
  const setMapLoading = (on: boolean) => {
    mapLoading.hidden = !on;
  };
  const clearTilesWait = () => {
    tilesWaitGen = null;
    window.clearTimeout(tilesWaitTimer);
  };
  const finishTilesWait = (gen: number) => {
    if (tilesWaitGen !== gen) return;
    clearTilesWait();
    setMapLoading(false);
  };
  const armTilesWait = (gen: number) => {
    tilesWaitGen = gen;
    window.clearTimeout(tilesWaitTimer);
    // Safety net if sourcedata never reports loaded (e.g. empty viewport).
    tilesWaitTimer = window.setTimeout(() => finishTilesWait(gen), 12_000);
  };

  // The viewport numbers are read off the rendered hexes, so every arriving tile
  // can change them. Refreshing per tile (coalesced) rather than once on "idle"
  // fills the panels as early as possible and keeps them right when a snapshot
  // switch replaces the tiles under them; "idle" would additionally wait for the
  // basemap, which the numbers do not depend on.
  handles.map.on("sourcedata", (e) => {
    if (e.sourceId !== "h3") return;
    if (e.tile) {
      window.clearTimeout(tileTimer);
      tileTimer = window.setTimeout(() => refreshPanels(), 60);
    }
    // Warming the neighbours earlier would make their downloads compete with
    // the hexes of the snapshot actually on screen.
    if (e.isSourceLoaded && !neighboursWarmed) {
      neighboursWarmed = true;
      prefetchNeighbours();
    }
    // Spinner stays until the hex fills for the current viewport are in.
    if (tilesWaitGen != null && e.isSourceLoaded) {
      const gen = tilesWaitGen;
      requestAnimationFrame(() => finishTilesWait(gen));
    }
  });
  const overlaySlider = $("overlay-opacity") as HTMLInputElement;
  overlaySlider.addEventListener("input", () => {
    handles?.setOverlayOpacity(Number(overlaySlider.value) / 100);
  });

  let userIndex = Object.entries(users)
    .map(([id, u]) => ({ uid: Number(id), name: u.name, scores: u.scores }))
    .filter((u) => u.uid && u.name && !u.name.startsWith("#"));
  const rebuildUserIndex = () => {
    userIndex = Object.entries(users)
      .map(([id, u]) => ({ uid: Number(id), name: u.name, scores: u.scores }))
      .filter((u) => u.uid && u.name && !u.name.startsWith("#"));
  };
  const afterNextPaint = (): Promise<void> =>
    new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  const applyLoadedSnapshot = (nextId: string, cached: CachedSnapshot) => {
    const keptNames = [...highlightedUids]
      .map((uid) => users[String(uid)]?.name)
      .filter((name): name is string => Boolean(name) && !name.startsWith("#"));
    core = cached.core;
    users = cached.users;
    packedOverlays = cached.overlays;
    packedFronts = cached.fronts;
    snapshotId = nextId;
    // uiSnapshotId may already point at a newer slider target; leave it alone.
    // The numbers behind the remembered hexes belong to the old snapshot.
    selectedProps = null;
    hoveredProps = null;
    rebuildUidIndex();
    rebuildUserIndex();
    highlightedUids.clear();
    for (const name of keptNames) {
      const uid = uidByName.get(name);
      if (uid) highlightedUids.add(uid);
    }
    const fronts = packedFronts;
    handles?.setSnapshot(core, users, snapshotUrls(nextId).pmtiles, packedOverlays, fronts);
    handles?.setFilter(filter);
    handles?.setMode(mode);
    handles?.setHighlightUsers([...highlightedUids]);
    startTopUsers(nextId, cached);
    syncFilterAvailability();
    syncSnapshotLabel(uiSnapshotId);
    syncFrontsLegend();
    syncLegend();
    refreshPanels();
    neighboursWarmed = false;
    armTilesWait(snapGen);
  };
  /**
   * @param moveSlider When false (native range `input`), the thumb already sits on
   *   the new index — rewriting `.value` in the same turn can fight the drag and
   *   delay paint until the snapshot payload is applied.
   */
  const applySnapshot = async (nextId: string, moveSlider = true) => {
    if (!nextId) return;
    // Permalink / deep link to a year stand while still in quarter mode.
    if (timelineMode === "quarters" && !snapshots.some((s) => s.id === nextId) && yearTrack.some((s) => s.id === nextId)) {
      timelineMode = "years";
      uiSnapshotId = nextId;
      setupSlider(nextId);
      syncMapFronts();
    } else if (timelineMode === "years" && !yearTrack.some((s) => s.id === nextId) && snapshots.some((s) => s.id === nextId)) {
      timelineMode = "quarters";
      uiSnapshotId = nextId;
      setupSlider(nextId);
      syncMapFronts();
    }
    uiSnapshotId = nextId;
    if (moveSlider) {
      const idx = activeTrack().findIndex((s) => s.id === nextId);
      if (idx >= 0) snapshotSlider.value = String(idx);
    }
    syncSnapshotLabel(nextId);
    if (nextId === snapshotId) {
      clearTilesWait();
      setMapLoading(false);
      return;
    }
    const gen = ++snapGen;
    snapAbort?.abort();
    const ac = new AbortController();
    snapAbort = ac;
    clearTilesWait();
    setMapLoading(true);
    // Yield so the thumb + label paint before cache hits / PMTiles work block the main thread.
    await afterNextPaint();
    if (gen !== snapGen) return;
    try {
      warmTiles(snapshotUrls(nextId).pmtiles);
      const cached = await fetchSnapshotCore(nextId, ac.signal);
      if (gen !== snapGen) return;
      applyLoadedSnapshot(nextId, cached);
    } catch (err) {
      if (isAbortError(err) || gen !== snapGen) return;
      clearTilesWait();
      setMapLoading(false);
      throw err;
    }
  };
  snapshotSlider.addEventListener("input", () => {
    const snap = activeTrack()[Number(snapshotSlider.value)];
    if (snap) void applySnapshot(snap.id, false);
  });
  snapshotWrap.addEventListener(
    "wheel",
    (ev) => {
      const dy = ev.deltaY;
      const dx = ev.deltaX;
      // Prefer vertical; fall back to horizontal trackpad swipes.
      const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      if (!delta) return;
      const track = activeTrack();
      if (track.length < 2) return;
      ev.preventDefault();
      const cur = Math.max(
        0,
        track.findIndex((s) => s.id === uiSnapshotId),
      );
      // Scroll down / right → later stand; up / left → earlier.
      const next = Math.max(0, Math.min(track.length - 1, cur + (delta > 0 ? 1 : -1)));
      const snap = track[next];
      if (snap && snap.id !== uiSnapshotId) void applySnapshot(snap.id, true);
    },
    { passive: false },
  );
  snapshotTicks.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    if (!btn || !snapshotTicks.contains(btn)) return;
    const snap = activeTrack()[Number(btn.dataset.index)];
    if (!snap) return;
    void applySnapshot(snap.id, true);
  });
  navPast.addEventListener("click", () => enterYearMode());
  navPresent.addEventListener("click", () => enterQuarterMode());
  const searchInput = $("user-search") as HTMLInputElement;
  const searchResults = $("user-search-results");

  const closeSearch = () => {
    searchResults.hidden = true;
    searchResults.replaceChildren();
  };

  const renderSearchHits = (q: string) => {
    const needle = q.trim().toLowerCase();
    searchResults.replaceChildren();
    if (needle.length < 1) {
      searchResults.hidden = true;
      return;
    }
    const hits = userIndex
      .filter((u) => u.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        const sa = a.scores[filter] ?? a.scores.all ?? 0;
        const sb = b.scores[filter] ?? b.scores.all ?? 0;
        return sb - sa || a.name.localeCompare(b.name, "de");
      })
      .slice(0, 12);
    if (!hits.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Kein Treffer";
      searchResults.append(li);
      searchResults.hidden = false;
      return;
    }
    for (const u of hits) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "user-search-hit" + (highlightedUids.has(u.uid) ? " on" : "");
      btn.dataset.uid = String(u.uid);
      btn.textContent = u.name;
      li.append(btn);
      searchResults.append(li);
    }
    searchResults.hidden = false;
  };

  const pickSearchedUser = (uid: number) => {
    if (!uid) return;
    highlightedUids.add(uid);
    searchInput.value = "";
    closeSearch();
    syncHighlight();
    refreshPanels();
  };

  searchInput.addEventListener("input", () => renderSearchHits(searchInput.value));
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeSearch();
      searchInput.blur();
      return;
    }
    if (ev.key !== "Enter") return;
    const first = searchResults.querySelector("button.user-search-hit") as HTMLElement | null;
    if (!first) return;
    ev.preventDefault();
    pickSearchedUser(Number(first.dataset.uid));
  });
  searchResults.addEventListener("mousedown", (ev) => ev.preventDefault());
  searchResults.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button.user-search-hit") as HTMLElement | null;
    if (!btn) return;
    pickSearchedUser(Number(btn.dataset.uid));
  });
  document.addEventListener("click", (ev) => {
    const wrap = $("user-search-wrap");
    if (!wrap.contains(ev.target as Node)) closeSearch();
  });

  $("board").addEventListener("click", (ev) => {
    const el = ev.target as Element | null;
    if (el?.closest?.("a.osm-ext")) return;
    const methodBtn = el?.closest?.("button.lede-method-toggle") as HTMLButtonElement | null;
    if (methodBtn) {
      const open = methodBtn.getAttribute("aria-expanded") === "true";
      methodBtn.setAttribute("aria-expanded", open ? "false" : "true");
      const body = document.getElementById("lede-method-text");
      if (body) body.hidden = open;
      return;
    }
    if (el?.closest?.("button.cell-clear") || el?.closest?.("[data-clear-cell]")) {
      selected = null;
      selectedProps = null;
      handles?.setSelection(null);
      refreshPanels();
      return;
    }
    if (el?.closest?.("button.user-clear-all") || el?.closest?.("[data-clear-all]")) {
      highlightedUids.clear();
      syncHighlight();
      refreshPanels();
      return;
    }
    const oneClear = el?.closest?.("button.user-clear") as HTMLElement | null;
    if (oneClear) {
      const uid = Number(oneClear.getAttribute("data-uid"));
      if (uid) highlightedUids.delete(uid);
      else highlightedUids.clear();
      syncHighlight();
      refreshPanels();
      return;
    }
    const btn = el?.closest?.("button.user-link");
    if (!btn) return;
    const uid = Number(btn.getAttribute("data-uid"));
    if (!uid) return;
    if (highlightedUids.has(uid)) highlightedUids.delete(uid);
    else highlightedUids.add(uid);
    syncHighlight();
    refreshPanels();
  });

  $("filters").addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button[data-filter]") as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    filter = btn.getAttribute("data-filter") as FilterId;
    $("filters").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    handles?.setFilter(filter);
    syncLegend();
    refreshPanels();
  });
  $("modes").addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button[data-mode]");
    if (!btn) return;
    mode = btn.getAttribute("data-mode") as ViewMode;
    $("modes").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    handles?.setMode(mode);
    syncLegend();
    refreshPanels();
  });

  FILTERS.forEach((id) => {
    const b = $("filters").querySelector(`[data-filter="${id}"]`) as HTMLButtonElement | null;
    if (!b) return;
    b.title = FILTER_TIPS[id];
    b.classList.add("tip");
    if (id === filter) b.classList.add("on");
  });
  syncFilterAvailability();
  $("modes").querySelector(`[data-mode="${mode}"]`)?.classList.add("on");
  const modeUsers = $("modes").querySelector('[data-mode="users"]') as HTMLButtonElement | null;
  const modeCur = $("modes").querySelector('[data-mode="currentness"]') as HTMLButtonElement | null;
  const modeFeat = $("modes").querySelector('[data-mode="features"]') as HTMLButtonElement | null;
  if (modeUsers) {
    modeUsers.title = "Gebiete der aktivsten Mapper:innen (gewichtet nach Aktualität der Edits und geglättet mit Nachbarwerten).";
    modeUsers.classList.add("tip");
  }
  if (modeCur) {
    modeCur.title = "Färbung nach Mapping-Aktivität: Wo fanden die meisten Edits statt?";
    modeCur.classList.add("tip");
  }
  if (modeFeat) {
    modeFeat.title = "Färbung nach Anzahl der Objekte im gewählten Filter: Wie viele Features dieser Art gibt es im jeweiligen Gitterfeld?";
    modeFeat.classList.add("tip");
  }
  syncLegend();

  window.addEventListener("popstate", () => {
    const link = parsePermalink();
    if (!handles) return;
    handles.map.jumpTo({
      center: [link.lng ?? MAP_DEFAULT_CENTER[0], link.lat ?? MAP_DEFAULT_CENTER[1]],
      zoom: link.zoom ?? MAP_DEFAULT_ZOOM,
    });
    const nextDate = link.date ?? snapshots[snapshots.length - 1]?.id;
    const go = async () => {
      if (nextDate && nextDate !== snapshotId) await applySnapshot(nextDate);
      applyLink(link);
      syncFilterAvailability();
      handles?.setFilter(filter);
      handles?.setMode(mode);
      handles?.setSelection(selected);
      handles?.setHighlightUsers([...highlightedUids]);
      $("filters").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-filter") === filter));
      $("modes").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-mode") === mode));
      syncLegend();
      refreshPanels();
    };
    void go();
  });

  handles.map.on("load", () => {
    loading.classList.add("hide");
    refreshPanels();
    // Only now, with the map on screen, pull the per-cell top-user lists.
    const cached = snapshotCache.get(snapshotId);
    if (cached) startTopUsers(snapshotId, cached);
  });
  handles.map.on("error", (ev) => {
    console.error("[olg] map", ev.error?.message ?? ev);
    if (!loading.classList.contains("hide")) {
      loading.innerHTML = `<p>Karte konnte nicht geladen werden. Details in der Browserkonsole.</p>`;
    }
  });
}

void main();
