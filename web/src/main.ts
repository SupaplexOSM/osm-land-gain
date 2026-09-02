import "maplibre-gl/dist/maplibre-gl.css";
import { CURRENTNESS_CSS, FEATURE_CSS } from "./colors";
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
  featureLegendMarks,
  featureStrength,
  maxFeatureCount,
  sparseThreshold,
  viewportRanking,
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

function previousQuarterDate(iso: string): Date {
  const [yearRaw, monthRaw] = iso.split("-").map(Number);
  let month = (monthRaw || 1) - 3;
  let year = yearRaw || 1970;
  if (month <= 0) {
    month += 12;
    year -= 1;
  }
  return new Date(Date.UTC(year, month - 1, 21));
}

function formatPeriodDay(d: Date, withYear: boolean): string {
  const text = `${d.getUTCDate()}. ${MONTH_DE[d.getUTCMonth() + 1]}`;
  return withYear ? `${text} ${d.getUTCFullYear()}` : text;
}

function snapshotPeriodHint(s: Snapshot): string {
  const end = new Date(`${s.date}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return s.period ?? "";
  const start = previousQuarterDate(s.date);
  const startYear = start.getUTCFullYear() !== end.getUTCFullYear();
  return `OSM-Bearbeitungen im Zeitraum ${formatPeriodDay(start, startYear)} bis ${formatPeriodDay(end, true)}`;
}

function isSpringSnapshot(s: Snapshot): boolean {
  return s.season === "fruehling" || /^\d{4}-03-21$/.test(s.date);
}

function snapshotCountLabel(n: number): string {
  return n === 1 ? "1 Datenstand" : `${n} Datenstände`;
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

function neighbourSnapshotIds(snapshots: Snapshot[], id: string): string[] {
  const i = snapshots.findIndex((s) => s.id === id);
  if (i < 0) return [];
  return [snapshots[i + 1]?.id, snapshots[i - 1]?.id].filter((s): s is string => Boolean(s));
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
  let snapshotId = "";
  const snapshotCache = new Map<string, CachedSnapshot>();
  let packedOverlays: PackedOverlays | null = null;
  let packedFronts: PackedFronts | null = null;
  let topUsers: TopUsers | null = null;
  let topUsersJob: TopUsersHandle | null = null;

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
      for (const id of neighbourSnapshotIds(snapshots, snapshotId)) {
        if (snapshotCache.has(id)) continue;
        warmTiles(snapshotUrls(id).pmtiles);
        void fetchSnapshotCore(id).catch(() => {});
      }
    });
  };

  try {
    const manifest = await fetchJson<{ snapshots?: Snapshot[] }>("./data/snapshots.json");
    snapshots = (manifest.snapshots ?? []).filter((s) => s.id);
    if (!snapshots.length) throw new Error("snapshots.json ist leer");
    const bootLink = parsePermalink();
    const wanted = bootLink.date;
    const startSnap =
      (wanted && snapshots.find((s) => s.id === wanted || s.date === wanted)) || snapshots[snapshots.length - 1]!;
    snapshotId = startSnap.id;
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
  const snapshotCount = $("snapshot-count");
  const snapshotTicks = $("snapshot-ticks");
  const currentSnapshot = () => snapshots.find((s) => s.id === snapshotId) ?? snapshots[snapshots.length - 1]!;
  const syncSnapshotLabel = (id = snapshotId) => {
    const snap = snapshots.find((s) => s.id === id) ?? currentSnapshot();
    snapshotLabel.textContent = snap.label;
    snapshotLabel.title = snapshotPeriodHint(snap);
    const idx = Math.max(0, snapshots.findIndex((s) => s.id === snap.id));
    snapshotSlider.setAttribute("aria-valuetext", snap.label);
    snapshotSlider.setAttribute("aria-valuenow", String(idx));
    const many = snapshots.length > 1;
    generated.hidden = many;
    generated.textContent = many ? "" : snap.label;
    generated.title = many ? "" : snapshotPeriodHint(snap);
    snapshotTicks.querySelectorAll("[data-index]").forEach((el) => {
      const on = Number((el as HTMLElement).dataset.index) === idx;
      el.classList.toggle("on", on);
    });
  };
  const setupSlider = () => {
    const many = snapshots.length > 1;
    snapshotWrap.classList.toggle("hide", !many);
    snapshotWrap.toggleAttribute("hidden", !many);
    snapshotSlider.min = "0";
    snapshotSlider.max = String(Math.max(0, snapshots.length - 1));
    snapshotSlider.value = String(Math.max(0, snapshots.findIndex((s) => s.id === snapshotId)));
    snapshotCount.textContent = snapshotCountLabel(snapshots.length);
    snapshotTicks.replaceChildren();
    const n = snapshots.length;
    snapshots.forEach((s, i) => {
      const mark = document.createElement("span");
      mark.className = "snapshot-tick";
      mark.dataset.index = String(i);
      mark.style.left = `${n <= 1 ? 50 : (i / (n - 1)) * 100}%`;
      if (isSpringSnapshot(s)) {
        const yearBtn = document.createElement("button");
        yearBtn.type = "button";
        yearBtn.className = "snapshot-tick-year";
        yearBtn.textContent = s.date.slice(0, 4);
        yearBtn.title = s.label;
        yearBtn.dataset.index = String(i);
        yearBtn.tabIndex = -1;
        if (i === 0) yearBtn.classList.add("edge-start");
        if (i === n - 1) yearBtn.classList.add("edge-end");
        mark.append(yearBtn);
      }
      snapshotTicks.append(mark);
    });
    syncSnapshotLabel();
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
      legendBar.style.background = `linear-gradient(90deg, ${FEATURE_CSS})`;
      legendLabels.classList.add("legend-counts");
      legendLabels.classList.remove("legend-levels");
      legendLabels.replaceChildren();
      for (const [t, label] of featureLegendMarks(maxFeatureCount(core.meta, filter))) {
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
        ? featureStrength(view.count, maxFeatureCount(core.meta, filter))
        : cellActivity(view, sparseThreshold(core.meta, filter));
    el.style.left = `${Math.round(Math.max(0, Math.min(1, t)) * 100)}%`;
    el.toggleAttribute("hidden", false);
  };
  const syncLegendTicks = () => {
    placeTick(hoverTick, hovered, hoveredProps);
    placeTick(selTick, selected, selectedProps);
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
    if (!cells.length) {
      // Tiles are not in yet: fall back to the hexes covering the viewport.
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
    const summary = viewportSummary(cells, core.meta, filter, topUsers);
    const osmUrl = osmExtentUrl(handles.map.getCenter(), handles.map.getZoom());
    renderViewportPanel($("viewport-panel"), ranked, summary, colors, highlightedUids, osmUrl, asOf);
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
    },
  );
  handles.setFilter(filter);
  handles.setMode(mode);
  handles.setSelection(selected);
  handles.setHighlightUsers([...highlightedUids]);
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
  let snapGen = 0;
  let snapAbort: AbortController | null = null;
  const applyLoadedSnapshot = (nextId: string, cached: CachedSnapshot) => {
    core = cached.core;
    users = cached.users;
    packedOverlays = cached.overlays;
    packedFronts = cached.fronts;
    snapshotId = nextId;
    // The numbers behind the remembered hexes belong to the old snapshot.
    selectedProps = null;
    hoveredProps = null;
    rebuildUidIndex();
    rebuildUserIndex();
    const kept = [...highlightedUids].filter((uid) => users[String(uid)]);
    highlightedUids.clear();
    for (const uid of kept) highlightedUids.add(uid);
    handles?.setSnapshot(core, users, snapshotUrls(nextId).pmtiles, packedOverlays, packedFronts);
    handles?.setFilter(filter);
    handles?.setMode(mode);
    handles?.setHighlightUsers([...highlightedUids]);
    startTopUsers(nextId, cached);
    syncSnapshotLabel();
    syncLegend();
    refreshPanels();
    neighboursWarmed = false;
  };
  const applySnapshot = async (nextId: string) => {
    if (!nextId) return;
    syncSnapshotLabel(nextId);
    snapshotSlider.value = String(Math.max(0, snapshots.findIndex((s) => s.id === nextId)));
    if (nextId === snapshotId) return;
    const gen = ++snapGen;
    snapAbort?.abort();
    const ac = new AbortController();
    snapAbort = ac;
    try {
      warmTiles(snapshotUrls(nextId).pmtiles);
      const cached = await fetchSnapshotCore(nextId, ac.signal);
      if (gen !== snapGen) return;
      applyLoadedSnapshot(nextId, cached);
    } catch (err) {
      if (isAbortError(err) || gen !== snapGen) return;
      throw err;
    }
  };
  snapshotSlider.addEventListener("input", () => {
    const snap = snapshots[Number(snapshotSlider.value)];
    if (snap) void applySnapshot(snap.id);
  });
  snapshotTicks.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    if (!btn || !snapshotTicks.contains(btn)) return;
    const snap = snapshots[Number(btn.dataset.index)];
    if (!snap) return;
    snapshotSlider.value = String(btn.dataset.index);
    void applySnapshot(snap.id);
  });
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
    const btn = (ev.target as HTMLElement).closest("button[data-filter]");
    if (!btn) return;
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
  $("modes").querySelector(`[data-mode="${mode}"]`)?.classList.add("on");
  const modeUsers = $("modes").querySelector('[data-mode="users"]') as HTMLButtonElement | null;
  const modeCur = $("modes").querySelector('[data-mode="currentness"]') as HTMLButtonElement | null;
  const modeFeat = $("modes").querySelector('[data-mode="features"]') as HTMLButtonElement | null;
  if (modeUsers) {
    modeUsers.title = "Gebiete der aktivsten OSM-Mapper:innen (gewichtet nach Aktualität der Edits und geglättet mit Nachbarwerten).";
    modeUsers.classList.add("tip");
  }
  if (modeCur) {
    modeCur.title = "Färbung nach Mapping-Aktivitäten. Jüngere Edits zählen stärker.";
    modeCur.classList.add("tip");
  }
  if (modeFeat) {
    modeFeat.title = "Färbung nach Anzahl/Dichte der OSM-Features in einem Gebiet.";
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
