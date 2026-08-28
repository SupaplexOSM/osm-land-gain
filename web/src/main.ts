import "maplibre-gl/dist/maplibre-gl.css";
import { CURRENTNESS_CSS, FEATURE_CSS } from "./colors";
import { createMap, type MapHandles } from "./map";
import { osmExtentUrl, renderCellPanel, renderHighlightChip, renderViewportPanel } from "./panel";
import {
  MAP_DEFAULT_CENTER,
  MAP_DEFAULT_ZOOM,
  parsePermalink,
  writePermalink,
} from "./permalink";
import {
  cellActivity,
  cellView,
  cellsInBounds,
  featureLegendMarks,
  featureStrength,
  maxFeatureCount,
  sparseThreshold,
  viewportRanking,
  viewportSummary,
  visibleCellIds,
  winnerColorByUid,
} from "./stats";
import type { CellsFile, FilterId, UserStat, ViewMode } from "./types";
import { FILTERS, FILTER_TIPS, normalizeCellsFile } from "./types";
import "./style.css";

type ByteSlot = { loaded: number; total: number };

async function fetchBuffer(url: string, onProgress: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(loaded, loaded);
  return out.buffer;
}

function parseJsonBuffer<T>(buf: ArrayBuffer): T {
  return JSON.parse(new TextDecoder().decode(buf)) as T;
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
  const highlightedUids = new Set<number>();
  let handles: MapHandles | undefined;
  let data: CellsFile;
  let users: Record<string, UserStat>;

  try {
    const slots: ByteSlot[] = [
      { loaded: 0, total: 0 },
      { loaded: 0, total: 0 },
    ];
    const tick = () => {
      const loaded = slots.reduce((sum, s) => sum + s.loaded, 0);
      const total = slots.reduce((sum, s) => sum + s.total, 0);
      const pct = total > 0 ? Math.min(99, (loaded / total) * 100) : 0;
      setProgress(pct);
    };
    const track = (i: number) => (loaded: number, total: number) => {
      slots[i] = { loaded, total: total || slots[i]!.total };
      tick();
    };
    const [cellsBuf, usersBuf] = await Promise.all([
      fetchBuffer("./data/cells.json", track(0)),
      fetchBuffer("./data/users.json", track(1)),
    ]);
    setProgress(100, "Daten werden gelesen…");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    data = normalizeCellsFile(parseJsonBuffer(cellsBuf));
    users = parseJsonBuffer<Record<string, UserStat>>(usersBuf);
  } catch (err) {
    loading.innerHTML = `<p>Daten fehlen. Pipeline zuerst ausführen:<br><code>python -m pipeline.run --download</code></p>`;
    throw err;
  }

  const uidByName = new Map<string, number>();
  for (const [id, u] of Object.entries(users)) {
    const uid = Number(id);
    if (!uid || !u.name || u.name.startsWith("#")) continue;
    uidByName.set(u.name, uid);
  }

  const applyLink = (link: ReturnType<typeof parsePermalink>) => {
    filter = link.filter ?? "all";
    mode = link.mode ?? "users";
    selected = link.cell && data.cells[link.cell] ? link.cell : null;
    highlightedUids.clear();
    for (const name of link.userNames ?? []) {
      const uid = uidByName.get(name);
      if (uid) highlightedUids.add(uid);
    }
  };
  const startLink = parsePermalink();
  applyLink(startLink);

  const generated = $("generated");
  generated.textContent = `Stand: ${new Date(`${data.meta.generated}T00:00:00`).toLocaleDateString("de-DE")}`;

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
      for (const [t, label] of featureLegendMarks(maxFeatureCount(data, filter))) {
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
  const placeTick = (el: HTMLElement, h3: string | null) => {
    const view = h3 && choropleth() ? cellView(data, h3, filter) : null;
    if (!view) {
      el.toggleAttribute("hidden", true);
      return;
    }
    const t =
      mode === "features"
        ? featureStrength(view.count, maxFeatureCount(data, filter))
        : cellActivity(view, sparseThreshold(data, filter));
    el.style.left = `${Math.round(Math.max(0, Math.min(1, t)) * 100)}%`;
    el.toggleAttribute("hidden", false);
  };
  const syncLegendTicks = () => {
    placeTick(hoverTick, hovered);
    placeTick(selTick, selected);
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
  const refreshPanels = (opts?: { fromCamera?: boolean }) => {
    if (!handles) return;
    const camKey = cameraKey();
    if (opts?.fromCamera && camKey === lastCamKey) return;
    lastCamKey = camKey;
    const threshold = sparseThreshold(data, filter);
    const view = selected ? cellView(data, selected, filter) : null;
    const colors = winnerColorByUid(data, filter);
    renderHighlightChip($("user-chip"), highlightedUids, users);
    renderCellPanel($("cell-panel"), view, users, filter, data.centers?.[filter] ?? [], mode, colors, highlightedUids, threshold);
    let ids = visibleCellIds(handles.map);
    if (!ids.length) ids = cellsInBounds(handles.map.getBounds(), data.meta.h3_res);
    const ranked = viewportRanking(ids, data, users, filter);
    const summary = viewportSummary(ids, data, filter);
    const osmUrl = osmExtentUrl(handles.map.getCenter(), handles.map.getZoom());
    renderViewportPanel($("viewport-panel"), ranked, summary, colors, highlightedUids, osmUrl);
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
    });
  };
  const onCameraMove = () => {
    window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => refreshPanels({ fromCamera: true }), 80);
  };

  setProgress(100, "Karte wird vorbereitet…");
  handles = await createMap(
    $("map"),
    data,
    users,
    (h3) => {
      selected = h3;
      refreshPanels();
    },
    onCameraMove,
    (h3) => {
      hovered = h3;
      syncLegendTicks();
    },
    {
      center: [startLink.lng ?? MAP_DEFAULT_CENTER[0], startLink.lat ?? MAP_DEFAULT_CENTER[1]],
      zoom: startLink.zoom ?? MAP_DEFAULT_ZOOM,
    },
  );
  handles.setFilter(filter);
  handles.setMode(mode);
  handles.setSelection(selected);
  handles.setHighlightUsers([...highlightedUids]);

  const userIndex = Object.entries(users)
    .map(([id, u]) => ({ uid: Number(id), name: u.name, scores: u.scores }))
    .filter((u) => u.uid && u.name && !u.name.startsWith("#"));
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
    if (el?.closest?.("button.cell-clear") || el?.closest?.("[data-clear-cell]")) {
      selected = null;
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
    modeUsers.title = "Gebiete der aktivsten OSM-User (gewichtet nach Aktualität der Edits und geglättet mit Nachbarwerten).";
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
    applyLink(link);
    if (!handles) return;
    handles.map.jumpTo({
      center: [link.lng ?? MAP_DEFAULT_CENTER[0], link.lat ?? MAP_DEFAULT_CENTER[1]],
      zoom: link.zoom ?? MAP_DEFAULT_ZOOM,
    });
    handles.setFilter(filter);
    handles.setMode(mode);
    handles.setSelection(selected);
    handles.setHighlightUsers([...highlightedUids]);
    $("filters").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-filter") === filter));
    $("modes").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-mode") === mode));
    syncLegend();
    refreshPanels();
  });

  handles.map.on("load", () => {
    loading.classList.add("hide");
    refreshPanels();
  });
  handles.map.on("error", (ev) => {
    console.error(ev);
    loading.innerHTML = `<p>Karte konnte nicht geladen werden. Details in der Browserkonsole.</p>`;
  });
}

void main();
