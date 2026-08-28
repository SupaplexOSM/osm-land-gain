"""Read a Geofabrik PBF snapshot and accumulate last-editor scores per H3 cell."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Iterable

import h3
import osmium

from .config import FILTERS, Config, filters_for_tags
from .weights import age_weight

# cell -> filter -> uid -> [count, weight, last_ts, age_days_sum]
CellAcc = dict[str, dict[str, dict[int, list[float]]]]


def feature_filters(tags: osmium.osm.TagList) -> list[str]:
    return filters_for_tags({t.k: t.v for t in tags})


def is_polygon_way(way: osmium.osm.Way) -> bool:
    if not way.is_closed() or len(way.nodes) < 4:
        return False
    area = way.tags.get("area")
    if area == "no":
        return False
    if area == "yes":
        return True
    polygon_hints = {
        "building",
        "landuse",
        "natural",
        "leisure",
        "amenity",
        "place",
        "water",
        "wetland",
        "man_made",
        "aeroway",
    }
    return any(k in way.tags for k in polygon_hints)


def is_wanted_area(area: osmium.osm.Area, extra_keys: tuple[str, ...]) -> bool:
    tags = area.tags
    if tags.get("boundary") or tags.get("type") == "boundary":
        return False
    if tags.get("type") == "restriction":
        return False
    if area.from_way():
        return True
    return any(k in tags for k in extra_keys)


def cells_for_line(coords: list[tuple[float, float]], res: int) -> set[str]:
    """coords are (lat, lon). Cover the linestring with H3 cells."""
    cells: set[str] = set()
    prev: str | None = None
    for lat, lon in coords:
        if lat < -90 or lat > 90:
            continue
        cell = h3.latlng_to_cell(lat, lon, res)
        cells.add(cell)
        if prev and prev != cell:
            try:
                cells.update(h3.grid_path_cells(prev, cell))
            except Exception:
                pass
        prev = cell
    return cells


def cells_for_polygon(rings: list[list[tuple[float, float]]], res: int) -> set[str]:
    """rings of (lat, lon); first ring outer, rest holes."""
    if not rings or len(rings[0]) < 3:
        return set()
    cells: set[str] = set()
    try:
        poly = h3.LatLngPoly(rings[0], *rings[1:])
        cells = set(h3.polygon_to_cells(poly, res))
    except Exception:
        cells = set()
    if not cells:
        for ring in rings:
            cells.update(cells_for_line(ring, res))
        outer = rings[0]
        lat = sum(p[0] for p in outer) / len(outer)
        lon = sum(p[1] for p in outer) / len(outer)
        try:
            cells.add(h3.latlng_to_cell(lat, lon, res))
        except Exception:
            pass
    return cells


def as_datetime(ts: object) -> datetime | None:
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return ts
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def cells_for_bbox(bbox: tuple[float, float, float, float], res: int) -> set[str]:
    west, south, east, north = bbox
    outer = [
        (south, west),
        (south, east),
        (north, east),
        (north, west),
        (south, west),
    ]
    try:
        return set(h3.polygon_to_cells(h3.LatLngPoly(outer), res))
    except Exception:
        return cells_for_line(outer, res)


def _latlon(node: object) -> tuple[float, float] | None:
    loc = getattr(node, "location", None)
    if loc is not None:
        try:
            if loc.valid():
                return float(loc.lat), float(loc.lon)
        except Exception:
            pass
    try:
        return float(node.lat), float(node.lon)  # type: ignore[attr-defined]
    except Exception:
        return None


class UserIndex:
    def __init__(self) -> None:
        self._ids: dict[str, int] = {}
        self.names: list[str] = [""]

    def uid(self, name: str) -> int:
        found = self._ids.get(name)
        if found is not None:
            return found
        uid = len(self.names)
        self._ids[name] = uid
        self.names.append(name)
        return uid


class ScoreHandler(osmium.SimpleHandler):
    def __init__(self, cfg: Config, today: date) -> None:
        super().__init__()
        self.cfg = cfg
        self.today = today
        self.users = UserIndex()
        self.cells: CellAcc = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])))
        self.wkbfab = osmium.geom.WKBFactory()
        self.seen = 0
        self.kept = 0
        self.filter_kept: dict[str, int] = {f: 0 for f in FILTERS}
        self.area_errors = 0

    def _credit(
        self,
        user: str,
        uid: int,
        timestamp: object,
        tags: osmium.osm.TagList,
        cells: Iterable[str],
    ) -> None:
        name = (user or "").strip()
        if not name and uid:
            name = f"user-{uid}"
        ts = as_datetime(timestamp)
        if not name or ts is None or not cells:
            return
        uid_key = self.users.uid(name)
        weight = age_weight(ts, self.today)
        unix = ts.timestamp()
        age_days = max(0.0, (self.today - ts.date()).days)
        filters = feature_filters(tags)
        self.kept += 1
        for filt in filters:
            self.filter_kept[filt] += 1
        if self.kept % 200_000 == 0:
            print(f"  gewertet: {self.kept:,}", flush=True)
        for cell in cells:
            bucket = self.cells[cell]
            for filt in filters:
                rec = bucket[filt][uid_key]
                rec[0] += 1
                rec[1] += weight
                if unix > rec[2]:
                    rec[2] = unix
                rec[3] += age_days

    def node(self, n: osmium.osm.Node) -> None:
        self.seen += 1
        if not n.tags or not n.location.valid():
            return
        cell = h3.latlng_to_cell(n.location.lat, n.location.lon, self.cfg.h3_res)
        self._credit(n.user, n.uid, n.timestamp, n.tags, (cell,))

    def way(self, w: osmium.osm.Way) -> None:
        self.seen += 1
        if is_polygon_way(w):
            return
        coords: list[tuple[float, float]] = []
        for node in w.nodes:
            if not node.location.valid():
                continue
            coords.append((node.location.lat, node.location.lon))
        if len(coords) < 2:
            return
        self._credit(w.user, w.uid, w.timestamp, w.tags, cells_for_line(coords, self.cfg.h3_res))

    def area(self, a: osmium.osm.Area) -> None:
        self.seen += 1
        if not is_wanted_area(a, self.cfg.extra_area_keys):
            return
        try:
            rings = list(a.outer_rings())
        except Exception:
            self.area_errors += 1
            return
        for outer_inner in rings:
            try:
                outer: list[tuple[float, float]] = []
                for node in outer_inner:
                    ll = _latlon(node)
                    if ll:
                        outer.append(ll)
                if len(outer) < 3:
                    continue
                holes: list[list[tuple[float, float]]] = []
                try:
                    inners = list(a.inner_rings(outer_inner))
                except Exception:
                    inners = []
                for inner in inners:
                    hole: list[tuple[float, float]] = []
                    for node in inner:
                        ll = _latlon(node)
                        if ll:
                            hole.append(ll)
                    if len(hole) >= 3:
                        holes.append(hole)
                cells = cells_for_polygon([outer, *holes], self.cfg.h3_res)
                self._credit(a.user, a.uid, a.timestamp, a.tags, cells)
            except Exception:
                self.area_errors += 1


def extract_pbf(pbf_path: str, cfg: Config, today: date | None = None) -> tuple[CellAcc, UserIndex]:
    handler = ScoreHandler(cfg, today or date.today())
    print("Lese PBF (Nodes, Ways, Flächen)…")
    handler.apply_file(pbf_path, locations=True, idx="flex_mem")
    print(f"OSM-Objekte gesehen: {handler.seen:,}, gewertet: {handler.kept:,}, User: {len(handler.users.names) - 1:,}, Zellen mit Daten: {len(handler.cells):,}")
    parts = ", ".join(f"{f}={handler.filter_kept[f]:,}" for f in FILTERS)
    print(f"  Objekte je Filter: {parts}", flush=True)
    if handler.area_errors:
        print(f"  Flächen-Fehler (übersprungen): {handler.area_errors:,}", flush=True)
    return handler.cells, handler.users
