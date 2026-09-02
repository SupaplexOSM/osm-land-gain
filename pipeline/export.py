"""Write the snapshot payloads: core JSON, binaries and a PMTiles archive.

Per snapshot the web app fetches ``cells.json`` (metadata, activity centers and
precomputed lookups, a few hundred KB), the PMTiles for everything it draws, the
overlay/front sidecars, and — only once the map is already interactive —
``cells.bin.gz`` with the per-cell top-user lists.
"""

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

from .binpack import read_cell_records, write_cell_binaries
from .config import FILTER_PREFIX, FILTERS, Config
from .territories import FilterCell

EMPTY_ROW = {"w": 0, "s": 0, "c": 0, "n": 0, "f": 0, "k": 0, "sp": 1, "ci": 0, "u": []}
PACKED_KEYS = ("w", "s", "c", "n", "f", "k", "sp", "ci", "u")


def write_json_gz(path: Path, payload: object) -> None:
    """Write compact JSON pre-compressed, so no server has to gzip on the fly."""
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    path.write_bytes(gzip.compress(raw, 6))


def read_json_maybe_gz(path: Path) -> object | None:
    """Read ``x.json.gz`` if present, else ``x.json``; None when neither exists."""
    gz = path if path.suffix == ".gz" else path.with_suffix(path.suffix + ".gz")
    plain = Path(str(gz)[: -len(".gz")]) if gz != path else path
    if gz.exists():
        return json.loads(gzip.decompress(gz.read_bytes()).decode("utf-8"))
    if plain.exists():
        return json.loads(plain.read_text(encoding="utf-8"))
    return None


def cell_polygon(cell: str) -> list[list[float]]:
    boundary = h3.cell_to_boundary(cell)
    ring = [[lng, lat] for lat, lng in boundary]
    ring.append(ring[0])
    return ring


def cell_center(cell: str) -> tuple[float, float]:
    lat, lng = h3.cell_to_latlng(cell)
    return lng, lat


def filter_maxima(records: dict[str, FilterCell]) -> tuple[dict[str, float], dict[str, int]]:
    """Highest per-user score and object count per filter.

    The web app used to scan every cell for these on each filter switch.
    """
    max_score = {filt: 0.0 for filt in FILTERS}
    max_count = {filt: 0 for filt in FILTERS}
    for by_filter in records.values():
        for filt in FILTERS:
            row = by_filter.get(filt)
            if not row:
                continue
            count = int(row.get("n") or 0)
            if count > max_count[filt]:
                max_count[filt] = count
            for entry in row.get("u") or []:
                if entry and float(entry[1]) > max_score[filt]:
                    max_score[filt] = float(entry[1])
    return (
        {filt: round(value, 3) for filt, value in max_score.items()},
        max_count,
    )


def winner_colors(records: dict[str, FilterCell]) -> dict[str, list[int]]:
    """Flat [uid, colorIndex, …] pairs per filter for every territory winner."""
    out: dict[str, list[int]] = {}
    for filt in FILTERS:
        seen: dict[int, int] = {}
        for by_filter in records.values():
            row = by_filter.get(filt)
            if not row:
                continue
            uid = int(row.get("w") or 0)
            if not uid or int(row.get("sp") or 0) == 1 or uid in seen:
                continue
            seen[uid] = int(row.get("ci") or 0)
        flat: list[int] = []
        for uid, ci in seen.items():
            flat.append(uid)
            flat.append(ci)
        out[filt] = flat
    return out


def write_json_sidecars(
    out_dir: Path,
    records: dict[str, FilterCell],
    user_stats: dict[int, dict],
    cfg: Config,
    generated: date,
    centers: dict[str, list[dict]] | None = None,
    snapshot: dict | None = None,
) -> None:
    users_out = {str(uid): st for uid, st in user_stats.items()}
    max_score, max_count = filter_maxima(records)
    meta = {
        "generated": generated.isoformat(),
        "h3_res": cfg.h3_res,
        "filters": list(FILTERS),
        "sparse_count": dict(cfg.sparse_count),
        "active_days": 90,
        "bbox": list(cfg.bbox),
        "bboxes": [list(b) for b in cfg.bboxes],
        "max_score": max_score,
        "max_count": max_count,
    }
    if snapshot:
        meta.update(snapshot)
    (out_dir / "cells.json").write_text(
        json.dumps(
            {
                "meta": meta,
                "centers": centers or {f: [] for f in FILTERS},
                "colors": winner_colors(records),
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    write_json_gz(out_dir / "users.json.gz", users_out)
    (out_dir / "users.json").unlink(missing_ok=True)
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    write_cell_binaries(out_dir, records, user_stats)


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


def legacy_cells_json(snap_dir: Path) -> Path | None:
    """Path of a pre-binary cells.json (one that still carries a `cells` block)."""
    path = snap_dir / "cells.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return path if isinstance(payload, dict) and payload.get("cells") else None


def user_stats_from_snapshot(snap_dir: Path) -> dict | None:
    return read_json_maybe_gz(snap_dir / "users.json")  # type: ignore[return-value]


def records_from_snapshot(snap_dir: Path) -> dict[str, FilterCell] | None:
    """Full per-cell records from the binaries, falling back to a legacy cells.json."""
    records = read_cell_records(snap_dir)
    if records is not None:
        return records
    legacy = legacy_cells_json(snap_dir)
    return records_from_cells_json(legacy) if legacy else None


def migrate_legacy_snapshot(snap_dir: Path) -> bool:
    """Rewrite a pre-binary snapshot folder in place; False if nothing to do.

    Snapshots restored from the gh-pages archive still carry the old monolithic
    cells.json. Converting them here keeps older quarters usable without a PBF.
    """
    legacy = legacy_cells_json(snap_dir)
    if legacy is None:
        return False
    payload = json.loads(legacy.read_text(encoding="utf-8"))
    records = records_from_cells_json(legacy)
    user_stats = user_stats_from_snapshot(snap_dir)
    if not isinstance(user_stats, dict):
        return False

    meta = dict(payload.get("meta") or {})
    for stale in ("cell_keys", "cell_layout"):
        meta.pop(stale, None)
    max_score, max_count = filter_maxima(records)
    meta["max_score"] = max_score
    meta["max_count"] = max_count
    centers = payload.get("centers") or {f: [] for f in FILTERS}

    (snap_dir / "cells.json").write_text(
        json.dumps(
            {"meta": meta, "centers": centers, "colors": winner_colors(records)},
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    write_json_gz(snap_dir / "users.json.gz", user_stats)
    (snap_dir / "users.json").unlink(missing_ok=True)
    (snap_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    write_cell_binaries(snap_dir, records, {int(uid): st for uid, st in user_stats.items()})
    return True


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
