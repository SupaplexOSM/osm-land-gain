import { colorIndexFromName, userColor } from "./colors";
import {
  ACTIVITY_LEVEL_LABEL,
  activityLevel,
  cellActivity,
  formatAge,
  formatScore,
  RECENCY_LABEL,
  type RankedUser,
  type ViewportSummary,
} from "./stats";
import type { ActivityCenter, CellView, FilterId, UserStat, ViewMode } from "./types";
import { FILTER_LABELS, SPECIALTY_COLORS, SPECIALTY_LABELS } from "./types";

const TIP = {
  objects: "Anzahl der OSM-Features in diesem Gitterfeld für den gewählten Filter.",
  activity:
    "Aktivität der User in diesem Gitterfeld: jüngere Bearbeitungen zählen stärker, schwach kartierte Felder werden heruntergewichtet.",
  scoreSmooth:
    "Geglätteter Aktivitätswert dieses Users: zählt seine Edits in diesem Gitterfeld und den Nachbarfeldern. Neuere Bearbeitungen zählen stärker. Dieser Wert bestimmt, wer Gebietsleader ist.",
  scoreCell:
    "Tatsächlicher Aktivitätswert dieses Users nur in diesem Gitterfeld, ohne die Nachbarn. Neuere Bearbeitungen zählen stärker.",
  scoreView:
    "Summe der tatsächlichen Aktivitätswerte dieses Users in den sichtbaren Gitterfeldern, ohne Glättung mit Nachbarn. Neuere Bearbeitungen zählen stärker.",
  center: "Zelle mit dem höchsten geglätteten Punktwert dieses Users.",
  fieldList: "User mit dem höchsten Aktivitäts-Score in diesem Gitterfeld, basierend darauf, wer ein OSM-Objekt zuletzt bearbeitet hat.",
  leader: "User mit dem höchsten geglätteten Aktivitäts-Score in diesem Gitterfeld und der Umgebung (aktivster User in der Gegend).",
  flags:
    "Diese User haben in diesem Gitterfeld ein Aktivitätszentrum (Fähnchen auf der Karte), sind aber nicht die aktivsten User im Umkreis.",
  viewList: "User mit dem höchsten Aktivitäts-Score im sichtbaren Kartenausschnitt, basierend darauf, wer ein OSM-Objekt zuletzt bearbeitet hat.",
  summary:
    "Median der tatsächlichen User-Aktivität aller sichtbaren Gitterfelder (nicht geglättet). Schwach kartierte und leere Felder zählen mit — fehlende Features gelten als keine Aktivität, weil dort kartiert werden könnte. Die Stufen sind gegenüber dem einzelnen Gitterfeld gestaucht, damit Abweichungen vom Mittelfeld früher sichtbar werden.",
  osmExtent: "Denselben Kartenausschnitt auf openstreetmap.org öffnen.",
};

function tip(label: string, text: string): string {
  return `<span class="tip" title="${escapeHtml(text)}">${label}</span>`;
}

function capitalSvg(): string {
  return `<svg class="capital" viewBox="0 0 64 64" width="14" height="14" aria-hidden="true">
    <circle cx="32" cy="32" r="10" fill="#111111"/>
    <circle cx="32" cy="32" r="18.5" fill="none" stroke="#111111" stroke-width="7"/>
  </svg>`;
}

function osmUserUrl(name: string): string {
  return `https://www.openstreetmap.org/user/${encodeURIComponent(name)}`;
}

function osmExtIcon(): string {
  return `<svg class="osm-ext-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path fill="currentColor" d="M6.5 3h-3A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-3h-1.25v3a.25.25 0 0 1-.25.25h-8a.25.25 0 0 1-.25-.25v-8a.25.25 0 0 1 .25-.25h3V3Zm4.25 0H14v3.25h-1.25V5.13L8.06 9.81l-.87-.87 4.69-4.69H10.75V3Z"/>
  </svg>`;
}

function osmProfileLink(name: string): string {
  if (!name || name.startsWith("#")) return "";
  return `<a class="osm-ext" href="${osmUserUrl(name)}" target="_blank" rel="noopener noreferrer" title="OSM-Profil von ${escapeHtml(name)}" aria-label="OSM-Profil von ${escapeHtml(name)} öffnen">${osmExtIcon()}</a>`;
}

function specialtyIcon(key: keyof typeof SPECIALTY_LABELS): string {
  if (key === "highway") {
    return `<svg class="stack-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M3.4 14.6 6.4 1.6h3.2l3 13H3.4zm4.35-11.5-.4 11.5h1.3l.4-11.5z"/></svg>`;
  }
  if (key === "building") {
    return `<svg class="stack-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M8 1.4 14.5 7.35V14.6H1.5V7.35L8 1.4zM6.45 10.2h3.1V14.6h-3.1z"/></svg>`;
  }
  if (key === "landuse") {
    return `<svg class="stack-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="5.15" r="3.55" fill="#fff"/><circle cx="5.15" cy="7.35" r="3.05" fill="#fff"/><circle cx="10.85" cy="7.35" r="3.05" fill="#fff"/><rect x="6.95" y="10" width="2.1" height="4.7" rx="0.4" fill="#fff"/></svg>`;
  }
  if (key === "furniture") {
    return `<svg class="stack-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="#fff" d="M2 7.4h12v1.7H2z"/><rect x="3.4" y="9.1" width="1.6" height="4.2" rx="0.3" fill="#fff"/><rect x="11" y="9.1" width="1.6" height="4.2" rx="0.3" fill="#fff"/></svg>`;
  }
  return `<svg class="stack-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M8 1.15a5.15 5.15 0 0 0-5.15 5.15c0 3.55 5.15 8.55 5.15 8.55s5.15-5 5.15-8.55A5.15 5.15 0 0 0 8 1.15zM8 4.05a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z"/></svg>`;
}

function specialtyStack(spec: UserStat["specialties"]): string {
  const keys = Object.keys(SPECIALTY_LABELS) as Array<keyof typeof SPECIALTY_LABELS>;
  const segs = keys
    .map((key) => ({ key, pct: Math.round((spec[key] ?? 0) * 100) }))
    .filter((s) => s.pct > 0);
  if (!segs.length) return "";
  const parts = segs
    .map((s) => {
      const label = SPECIALTY_LABELS[s.key];
      const color = SPECIALTY_COLORS[s.key];
      return `<span class="stack-seg" style="width:${s.pct}%;background:${color}" title="${escapeHtml(label)}">${specialtyIcon(s.key)}</span>`;
    })
    .join("");
  return `<div class="stack" role="img" aria-label="Themenanteile">${parts}</div>`;
}

function userLink(uid: number, name: string, selectedUids: Set<number>): string {
  const on = selectedUids.has(uid);
  return `<span class="user-name">${osmProfileLink(name)}<button type="button" class="user-link${on ? " on" : ""}" data-uid="${uid}" aria-pressed="${on ? "true" : "false"}">${escapeHtml(name)}</button></span>`;
}

function userRow(
  entry: { uid?: number; name: string; score: number; lastTs?: number; colorIndex?: number },
  rank: number,
  selectedUids: Set<number>,
  scoreTip = TIP.scoreCell,
): string {
  const swatch = userColor(entry.colorIndex ?? colorIndexFromName(entry.name));
  const age = entry.lastTs ? `<small>${formatAge(entry.lastTs)}</small>` : "";
  const name = entry.uid != null ? userLink(entry.uid, entry.name, selectedUids) : escapeHtml(entry.name);
  return `<li><b>${rank}.</b> <i style="background:${swatch}"></i> <span>${name}</span> <em class="tip" title="${escapeHtml(scoreTip)}">${formatScore(entry.score)}</em> ${age}</li>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function pennantSvg(color: string): string {
  return `<svg class="pennant" viewBox="0 0 48 60" width="14" height="17" aria-hidden="true">
    <path d="M10 4 L42 16 L10 28 Z" fill="${color}" stroke="#2a1c12" stroke-width="1.5" stroke-linejoin="round" />
    <line x1="10" y1="2" x2="10" y2="58" stroke="#2a1c12" stroke-width="3" />
  </svg>`;
}

function activityPhrase(value: number): string {
  return ACTIVITY_LEVEL_LABEL[activityLevel(value)];
}

/**
 * MapLibre-Zoom nach OSM.org (Leaflet) umrechnen.
 *
 * Leaflet/OSM.org: Zoom 0 = die Welt ist 256 CSS-Pixel breit (Rasterkacheln).
 * MapLibre:        Zoom 0 = die Welt ist 512 CSS-Pixel breit (Vektorkacheln).
 * Derselbe z-Wert ist in MapLibre daher eine Zoomstufe näher; +1 gleicht das aus.
 */
const OSM_ZOOM_FROM_MAPLIBRE = 1;

export function osmExtentUrl(center: { lng: number; lat: number }, zoom: number): string {
  const z = Math.max(0, Math.min(19, Math.round(zoom + OSM_ZOOM_FROM_MAPLIBRE)));
  return `https://www.openstreetmap.org/#map=${z}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`;
}

export function renderCellPanel(
  el: HTMLElement,
  view: CellView | null,
  users: Record<string, UserStat>,
  filter: FilterId,
  centers: ActivityCenter[] = [],
  _mode: ViewMode = "users",
  colorByUid?: Map<number, number>,
  selectedUids: Set<number> = new Set(),
  threshold = 20,
): void {
  if (!view) {
    el.innerHTML = `<p class="hint">Klicke ein Gitterfeld, um dort aktive User zu sehen.</p>`;
    return;
  }
  const winner = view.winner ? users[String(view.winner)] : null;
  const title = view.sparse
    ? "Geringe Aktivität"
    : winner
      ? userLink(view.winner, winner.name, selectedUids)
      : "Ohne Gewinner";
  const here = centers.filter((c) => c.h3 === view.h3);
  const isActivityCenter = here.some((c) => c.own === 1);
  const flagRows = here
    .filter((c) => c.own !== 1)
    .map((c) => {
      const name = users[String(c.uid)]?.name ?? `#${c.uid}`;
      const color = userColor(colorByUid?.get(c.uid) ?? colorIndexFromName(name));
      const on = selectedUids.has(c.uid);
      const flagTip = `Auch ${name} ist hier aktiv und hat hier ein Aktivitätszentrum.`;
      return `<p class="flag-user" title="${escapeHtml(flagTip)}"><span class="user-name">${osmProfileLink(name)}<button type="button" class="user-link${on ? " on" : ""}" data-uid="${c.uid}" aria-pressed="${on ? "true" : "false"}" title="${escapeHtml(flagTip)}">${pennantSvg(color)}<span>${escapeHtml(name)}</span></button></span></p>`;
    })
    .join("");
  const flagBlock = flagRows
    ? `<h3 class="quiet-head">${tip("Weitere Aktivitätszentren", TIP.flags)}</h3>${flagRows}`
    : "";
  const top5 = view.top.slice(0, 5).map((row, i) => {
    const u = users[String(row.uid)];
    return userRow(
      {
        uid: row.uid,
        name: u?.name ?? `#${row.uid}`,
        score: row.score,
        lastTs: row.lastTs * 1000,
        colorIndex: colorByUid?.get(row.uid) ?? (u ? colorIndexFromName(u.name) : view.colorIndex),
      },
      i + 1,
      selectedUids,
    );
  });
  const activity = activityPhrase(cellActivity(view, threshold));
  const centerMark = isActivityCenter
    ? `<p class="center-mark">${capitalSvg()}${tip("Aktivitätszentrum", TIP.center)}</p>`
    : "";
  const leaderScore = view.sparse
    ? ""
    : `<em class="tip" title="${escapeHtml(TIP.scoreSmooth)}">${formatScore(view.score)}</em>`;
  const sparseNote = view.sparse
    ? `<p class="score">Gitterfeld mit gegenwärtig sehr geringer Mappingaktivität</p>`
    : "";
  const kicker = `<p class="kicker">${FILTER_LABELS[filter]} · <span class="tip" title="${escapeHtml(TIP.objects)}">${view.count.toLocaleString("de-DE")} Features</span> · <span class="tip" title="${escapeHtml(TIP.activity)}">${activity}</span></p>`;
  el.innerHTML = `
    <h3 class="cell-list-head quiet-head">${tip("Aktivster User in der Gegend", TIP.leader)}<button type="button" class="cell-clear" data-clear-cell="1" aria-label="Gitterfeld abwählen" title="Gitterfeld abwählen">×</button></h3>
    <div class="leader">
      <h2>${title}</h2>
      ${leaderScore}
    </div>
    ${centerMark}
    ${sparseNote}
    ${flagBlock}
    <h3>${tip("Aktivste User im Gitterfeld", TIP.fieldList)}</h3>
    ${kicker}
    <ol class="rank">${top5.join("") || "<li>Keine Edits</li>"}</ol>
  `;
}

export function renderHighlightChip(
  el: HTMLElement,
  uids: Set<number>,
  users: Record<string, UserStat>,
): void {
  if (!uids.size) {
    el.innerHTML = "";
    el.classList.add("hide");
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.classList.remove("hide");
  const chips = [...uids]
    .map((uid) => {
      const name = users[String(uid)]?.name ?? `#${uid}`;
      return `<span class="chip-user"><strong>${escapeHtml(name)}</strong><button type="button" class="user-clear" data-uid="${uid}" aria-label="${escapeHtml(name)} abwählen" title="Abwählen">×</button></span>`;
    })
    .join("");
  const clearAll =
    uids.size > 1
      ? `<button type="button" class="user-clear-all" data-clear-all="1" aria-label="Auswahl aufheben" title="Alle abwählen">alle aufheben</button>`
      : "";
  el.innerHTML = `
    <div class="user-chip-head">
      <p>Userauswahl</p>
      ${clearAll}
    </div>
    <div class="user-chip-list">${chips}</div>
  `;
}

export function renderViewportPanel(
  el: HTMLElement,
  ranked: RankedUser[],
  summary: ViewportSummary,
  colorByUid?: Map<number, number>,
  selectedUids: Set<number> = new Set(),
  osmUrl = "https://www.openstreetmap.org/",
): void {
  const top = ranked.slice(0, 10);
  const recentYear = ranked.filter((u) => u.recency <= 3).slice(0, 10);
  const past = ranked.filter((u) => u.recency >= 4).slice(0, 10);
  const list = (rows: RankedUser[]) =>
    rows
      .map((u, i) => {
        const age = formatAge(u.lastTs);
        return `<li>
          <header><b>${i + 1}.</b> <span>${userLink(u.uid, u.name, selectedUids)}</span> <em class="tip" title="${escapeHtml(TIP.scoreView)}">${formatScore(u.score)}</em></header>
          <p class="muted">${RECENCY_LABEL[u.recency]} (${age})</p>
          ${specialtyStack(u.specialties)}
        </li>`;
      })
      .join("") || "<li class='empty'>Keine User im Ausschnitt</li>";

  const activity = ACTIVITY_LEVEL_LABEL[summary.level];
  el.innerHTML = `
    <p class="summary" title="${escapeHtml(TIP.summary)}">${summary.mappers} User · ${summary.objects.toLocaleString("de-DE")} Features · <span class="tip" title="${escapeHtml(TIP.activity)}">${activity}</span></p>
    <h3 class="viewport-list-head">${tip("Aktivste User im Kartenausschnitt", TIP.viewList)}<a class="osm-ext osm-extent" href="${escapeHtml(osmUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(TIP.osmExtent)}" aria-label="${escapeHtml(TIP.osmExtent)}"><img class="osm-logo" src="./osm-logo.svg" width="22" height="22" alt=""></a></h3>
    <ol class="rank fat">${list(top)}</ol>
    <h3>Im letzten Jahr aktiv</h3>
    <ol class="rank">${recentYear.map((u, i) => userRow({ uid: u.uid, name: u.name, score: u.score, lastTs: u.lastTs, colorIndex: colorByUid?.get(u.uid) }, i + 1, selectedUids, TIP.scoreView)).join("") || "<li>Niemand im letzten Jahr</li>"}</ol>
    <h3>In der Vergangenheit aktiv</h3>
    <ol class="rank">${past.map((u, i) => userRow({ uid: u.uid, name: u.name, score: u.score, lastTs: u.lastTs, colorIndex: colorByUid?.get(u.uid) }, i + 1, selectedUids, TIP.scoreView)).join("") || "<li>Keine älteren Schwerpunkte</li>"}</ol>
  `;
}
