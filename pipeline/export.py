"""Write cells.json, users.json and a PMTiles archive of H3 polygons."""

from __future__ import annotations

import gzip
import json
import math
from collections.abc import Iterable
from datetime import date
from pathlib import Path

import h3
import mercantile
from mapbox_vector_tile import encode as mvt_encode
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

from .config import FILTER_PREFIX, FILTERS, Config
from .territories import FilterCell

EMPTY_ROW = {"w": 0, "s": 0, "c": 0, "n": 0, "f": 0, "k": 0, "sp": 1, "ci": 0, "u": []}
PACKED_KEYS = ("w", "s", "c", "n", "f", "k", "sp", "ci", "u")


def cell_polygon(cell: str) -> list[list[float]]:
    boundary = h3.cell_to_boundary(cell)
    ring = [[lng, lat] for lat, lng in boundary]
    ring.append(ring[0])
    return ring


def cell_center(cell: str) -> tuple[float, float]:
    lat, lng = h3.cell_to_latlng(cell)
    return lng, lat


def packed_row_from_record(rec: dict) -> list:
    return [
        rec["w"],
        rec["s"],
        rec["c"],
        rec["n"],
        rec["f"],
        rec["k"],
        rec["sp"],
        rec["ci"],
        rec["u"],
    ]


def is_empty_packed_row(row: list | None) -> bool:
    """True when n=0, no winner, and no per-user scores."""
    if row is None:
        return True
    return (not row[0]) and (not row[3]) and (not row[8])


def compact_filter_array(by_filter: dict) -> list:
    rows = []
    for filt in FILTERS:
        rec = by_filter[filt]
        packed = packed_row_from_record(rec) if isinstance(rec, dict) and "w" in rec else rec
        rows.append(None if is_empty_packed_row(packed) else packed)
    return rows


def compact_cells_payload(payload: dict) -> dict:
    """Rewrite `cells` as filter-order arrays with null empty rows (in place)."""
    meta = payload.setdefault("meta", {})
    filters = list(meta.get("filters") or FILTERS)
    new_cells = {}
    for cell, packed in payload["cells"].items():
        if isinstance(packed, list):
            new_cells[cell] = [None if is_empty_packed_row(row) else row for row in packed]
        else:
            rows = []
            for filt in filters:
                row = packed.get(filt) if isinstance(packed, dict) else None
                rows.append(None if is_empty_packed_row(row) else row)
            new_cells[cell] = rows
    payload["cells"] = new_cells
    meta["cell_layout"] = "filter-array"
    meta["filters"] = filters
    return payload


def write_json_sidecars(
    out_dir: Path,
    records: dict[str, FilterCell],
    user_stats: dict[int, dict],
    cfg: Config,
    generated: date,
    centers: dict[str, list[dict]] | None = None,
    snapshot: dict | None = None,
) -> None:
    cells_out = {cell: compact_filter_array(by_filter) for cell, by_filter in records.items()}

    users_out = {str(uid): st for uid, st in user_stats.items()}
    meta = {
        "generated": generated.isoformat(),
        "h3_res": cfg.h3_res,
        "filters": list(FILTERS),
        "sparse_count": dict(cfg.sparse_count),
        "active_days": 90,
        "bbox": list(cfg.bbox),
        "bboxes": [list(b) for b in cfg.bboxes],
        "cell_keys": ["w", "s", "c", "n", "f", "k", "sp", "ci", "u"],
        "cell_layout": "filter-array",
    }
    if snapshot:
        meta.update(snapshot)
    (out_dir / "cells.json").write_text(
        json.dumps(
            {
                "meta": meta,
                "cells": cells_out,
                "centers": centers or {f: [] for f in FILTERS},
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    (out_dir / "users.json").write_text(
        json.dumps(users_out, separators=(",", ":")),
        encoding="utf-8",
    )
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


MERCATOR_MAX = 20037508.342789244


def lonlat_to_merc(lon: float, lat: float) -> tuple[float, float]:
    lat = max(-85.05112878, min(85.05112878, lat))
    x = lon * MERCATOR_MAX / 180.0
    y = math.log(math.tan((90.0 + lat) * math.pi / 360.0)) * MERCATOR_MAX / math.pi
    return x, y


def _row_to_dict(row: list | None) -> dict:
    if row is None:
        return dict(EMPTY_ROW)
    return dict(zip(PACKED_KEYS, row, strict=True))


def records_from_cells_json(path: Path) -> dict[str, FilterCell]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    filters = list(payload.get("meta", {}).get("filters") or FILTERS)
    records: dict[str, FilterCell] = {}
    for cell, packed in payload["cells"].items():
        if isinstance(packed, list):
            rec = {
                filt: _row_to_dict(packed[i] if i < len(packed) else None)
                for i, filt in enumerate(filters)
            }
            for filt in FILTERS:
                rec.setdefault(filt, dict(EMPTY_ROW))
            records[cell] = rec
        else:
            records[cell] = {
                filt: dict(zip(PACKED_KEYS, packed[filt], strict=True)) for filt in FILTERS
            }
    return records


def _tile_props(rec: FilterCell) -> dict:
    props: dict = {}
    for filt in FILTERS:
        p = FILTER_PREFIX[filt]
        row = rec[filt]
        props[f"{p}_w"] = int(row["w"])
        props[f"{p}_s"] = int(round(row["s"] * 10))
        props[f"{p}_c"] = int(round(row["c"] * 100))
        props[f"{p}_n"] = int(row["n"])
        props[f"{p}_f"] = int(row["f"])
        props[f"{p}_k"] = int(row["k"])
        props[f"{p}_sp"] = int(row["sp"])
        props[f"{p}_ci"] = int(row["ci"])
    return props


def _merc_polygon(cell: str):
    from shapely.geometry import Polygon

    ring = [lonlat_to_merc(lng, lat) for lat, lng in h3.cell_to_boundary(cell)]
    ring.append(ring[0])
    return Polygon(ring)


def _geom_features(geom, props: dict) -> list[dict]:
    from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPolygon, Polygon, mapping

    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, GeometryCollection):
        out: list[dict] = []
        for part in geom.geoms:
            out.extend(_geom_features(part, props))
        return out
    if isinstance(geom, MultiPolygon):
        return [
            {"geometry": mapping(part), "properties": props}
            for part in geom.geoms
            if not part.is_empty
        ]
    if isinstance(geom, MultiLineString):
        return [
            {"geometry": mapping(part), "properties": props}
            for part in geom.geoms
            if not part.is_empty
        ]
    if isinstance(geom, (Polygon, LineString)):
        return [{"geometry": mapping(geom), "properties": props}]
    return []


def unique_hex_edges(cells: Iterable[str]) -> list[tuple[object, tuple[float, float, float, float]]]:
    """Undirected H3 edges as Mercator LineStrings plus lon/lat bbox (west, south, east, north)."""
    from shapely.geometry import LineString

    cell_set = set(cells)
    out: list[tuple[object, tuple[float, float, float, float]]] = []
    for cell in cell_set:
        for edge in h3.origin_to_directed_edges(cell):
            dest = h3.get_directed_edge_destination(edge)
            if dest in cell_set and dest < cell:
                continue
            boundary = h3.directed_edge_to_boundary(edge)
            merc = [lonlat_to_merc(lng, lat) for lat, lng in boundary]
            lats = [lat for lat, _lng in boundary]
            lngs = [lng for _lat, lng in boundary]
            out.append((LineString(merc), (min(lngs), min(lats), max(lngs), max(lats))))
    return out


def write_pmtiles(
    out_path: Path,
    records: dict[str, FilterCell],
    cfg: Config,
) -> None:
    from shapely.geometry import box

    print("Bereite Hexagon-Geometrien in Web-Mercator vor…")
    merc_polys = {cell: _merc_polygon(cell) for cell in records}
    print("Bereite eindeutige Gitterkanten vor…")
    edge_geoms = unique_hex_edges(records)
    tiles_needed: dict[tuple[int, int, int], list[str]] = {}
    tiles_edges: dict[tuple[int, int, int], list[int]] = {}
    west = south = 180.0
    east = north = -180.0
    zooms = range(cfg.min_zoom, cfg.max_zoom + 1)
    for cell in records:
        ring = cell_polygon(cell)
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        west, east = min(west, min(lons)), max(east, max(lons))
        south, north = min(south, min(lats)), max(north, max(lats))
        for z in zooms:
            for tile in mercantile.tiles(min(lons), min(lats), max(lons), max(lats), zooms=z):
                tiles_needed.setdefault((tile.z, tile.x, tile.y), []).append(cell)
    for i, (_geom, (ew, es, ee, en)) in enumerate(edge_geoms):
        for z in zooms:
            for tile in mercantile.tiles(ew, es, ee, en, zooms=z):
                tiles_edges.setdefault((tile.z, tile.x, tile.y), []).append(i)

    tile_ids = sorted(set(tiles_needed) | set(tiles_edges), key=lambda zxy: zxy_to_tileid(*zxy))
    print(f"Schreibe PMTiles ({len(tile_ids):,} Kacheln, {len(records):,} Hexagone, {len(edge_geoms):,} Kanten)…")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("wb") as f:
        writer = Writer(f)
        written = 0
        for z, x, y in tile_ids:
            cell_ids = tiles_needed.get((z, x, y), [])
            tb = mercantile.xy_bounds(x, y, z)
            pad_m = (tb.right - tb.left) * (16 / 4096)
            clip = box(tb.left - pad_m, tb.bottom - pad_m, tb.right + pad_m, tb.top + pad_m)
            features: list[dict] = []
            for cell in cell_ids:
                poly = merc_polys[cell]
                if not poly.intersects(clip):
                    continue
                try:
                    clipped = poly.intersection(clip)
                except Exception:
                    continue
                props = _tile_props(records[cell])
                props["h"] = cell
                features.extend(_geom_features(clipped, props))
            grid_features: list[dict] = []
            for i in tiles_edges.get((z, x, y), []):
                line = edge_geoms[i][0]
                if not line.intersects(clip):
                    continue
                try:
                    clipped_line = line.intersection(clip)
                except Exception:
                    continue
                grid_features.extend(_geom_features(clipped_line, {"e": 1}))
            if not features and not grid_features:
                continue
            layers = []
            if features:
                layers.append({"name": "h3", "features": features})
            if grid_features:
                layers.append({"name": "h3-grid", "features": grid_features})
            try:
                # y_coord_down=True would *suppress* the Y-flip. Mercator Y grows
                # north; MVT Y grows down. Keep the library default (False) so
                # each tile is not vertically mirrored (horizontal seams).
                mvt = mvt_encode(
                    layers,
                    default_options={
                        "quantize_bounds": (tb.left, tb.bottom, tb.right, tb.top),
                        "y_coord_down": False,
                    },
                )
            except Exception:
                continue
            writer.write_tile(zxy_to_tileid(z, x, y), gzip.compress(mvt))
            written += 1
        pad = 0.02
        west, south, east, north = west - pad, south - pad, east + pad, north + pad
        writer.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_zoom": cfg.min_zoom,
                "max_zoom": cfg.max_zoom,
                "min_lon_e7": int(west * 1e7),
                "min_lat_e7": int(south * 1e7),
                "max_lon_e7": int(east * 1e7),
                "max_lat_e7": int(north * 1e7),
                "center_zoom": 11,
                "center_lon_e7": int(((west + east) / 2) * 1e7),
                "center_lat_e7": int(((south + north) / 2) * 1e7),
            },
            {
                "name": "osm-land-gain",
                "description": "OSM Land Gain H3-9",
                "vector_layers": [
                    {
                        "id": "h3",
                        "minzoom": cfg.min_zoom,
                        "maxzoom": cfg.max_zoom,
                        "fields": {"h": "String"},
                    },
                    {
                        "id": "h3-grid",
                        "minzoom": cfg.min_zoom,
                        "maxzoom": cfg.max_zoom,
                        "fields": {},
                    },
                ],
                "tilestats": {
                    "layerCount": 2,
                    "layers": [
                        {"layer": "h3", "count": len(records)},
                        {"layer": "h3-grid", "count": len(edge_geoms)},
                    ],
                },
            },
        )
    print(f"PMTiles geschrieben: {out_path} ({written:,} Kacheln)")


def lonlat_valid(lon: float, lat: float) -> bool:
    return math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90
