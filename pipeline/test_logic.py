"""Unit tests for age weights and stable user colors (no PBF required)."""

from datetime import datetime
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.config import Config, SPARSE_COUNT, filters_for_tags
from pipeline.export import unique_hex_edges
from pipeline.territories import sparse_threshold
from pipeline.weights import age_weight, user_color_index


def test_age_weight() -> None:
    today = datetime(2026, 8, 26).date()
    assert age_weight(datetime(2026, 3, 1), today) == 1.0
    assert age_weight(datetime(2024, 10, 1), today) == 0.8
    assert age_weight(datetime(2018, 1, 1), today) == 0.05


def test_color_stable() -> None:
    assert user_color_index("alice") == user_color_index("alice")
    assert user_color_index("alice") != user_color_index("bob")


def test_color_independent_of_filter() -> None:
    a = user_color_index("mapper")
    b = user_color_index("mapper")
    assert a == b
    cfg = Config()
    assert sparse_threshold(cfg, "all") == SPARSE_COUNT["all"]
    assert sparse_threshold(cfg, "landuse") == SPARSE_COUNT["landuse"]
    assert sparse_threshold(cfg, "place") == 3
    assert sparse_threshold(cfg, "furniture") == 4
    assert cfg.palette_size == 128
    assert user_color_index("alice", 128) < 128


def test_landscape_and_poi_filters() -> None:
    assert "landuse" in filters_for_tags({"natural": "tree"})
    assert "landuse" in filters_for_tags({"landuse": "forest"})
    assert "landuse" in filters_for_tags({"leisure": "park"})
    assert "landuse" in filters_for_tags({"waterway": "stream"})
    assert "landuse" not in filters_for_tags({"leisure": "pitch"})
    assert "place" in filters_for_tags({"shop": "bakery"})
    assert "place" in filters_for_tags({"amenity": "cafe"})
    assert "place" in filters_for_tags({"amenity": "toilets"})
    assert "place" not in filters_for_tags({"amenity": "parking"})
    assert "place" not in filters_for_tags({"amenity": "bench"})
    assert "place" not in filters_for_tags({"natural": "tree"})
    assert "place" in filters_for_tags({"tourism": "museum"})
    assert "place" not in filters_for_tags({"tourism": "viewpoint"})
    assert "furniture" in filters_for_tags({"amenity": "bench"})
    assert "furniture" in filters_for_tags({"amenity": "waste_basket"})
    assert "furniture" in filters_for_tags({"highway": "street_lamp"})
    assert "furniture" in filters_for_tags({"amenity": "parking"})
    assert "furniture" in filters_for_tags({"tourism": "information"})
    assert "furniture" not in filters_for_tags({"shop": "bakery"})
    assert "furniture" not in filters_for_tags({"amenity": "cafe"})


def viewport_activity_level(value: float) -> int:
    """Keep in sync with web/src/stats.ts viewportActivityLevel."""
    if value <= 0:
        return 0
    if value >= 0.70:
        return 7
    if value >= 0.62:
        return 6
    if value >= 0.54:
        return 5
    if value >= 0.46:
        return 4
    if value >= 0.40:
        return 3
    if value >= 0.32:
        return 2
    return 1


def test_viewport_activity_level() -> None:
    assert viewport_activity_level(0) == 0
    assert viewport_activity_level(0.25) == 1
    assert viewport_activity_level(0.50) == 4
    assert viewport_activity_level(0.75) == 7
    assert viewport_activity_level(0.32) == 2
    assert viewport_activity_level(0.70) == 7


def test_unique_hex_edges() -> None:
    import h3

    cell = "891f1d48d27ffff"
    neighbor = next(n for n in h3.grid_disk(cell, 1) if n != cell)
    assert len(unique_hex_edges([cell])) == 6
    assert len(unique_hex_edges([cell, neighbor])) == 11


def _sample_old_cells_payload() -> dict:
    from pipeline.config import FILTERS

    empty = [0, 0, 0, 0, 0, 0, 1, 0, []]
    filled = [42, 1.5, 0.8, 12, 30, 0, 0, 7, [[42, 1.5, 1700000000]]]
    packed = {filt: list(empty) for filt in FILTERS}
    packed["all"] = filled
    packed["highway"] = list(empty)
    return {
        "meta": {"filters": list(FILTERS)},
        "cells": {"891f1d48d27ffff": packed},
    }


def test_migrate_legacy_snapshot() -> None:
    """A gh-pages snapshot in the old one-big-cells.json layout converts in place."""
    import gzip
    import json
    import tempfile

    from pipeline.config import FILTERS
    from pipeline.export import migrate_legacy_snapshot, records_from_snapshot

    cell = "891f1d48d27ffff"
    with tempfile.TemporaryDirectory() as raw:
        snap = Path(raw)
        payload = _sample_old_cells_payload()
        payload["centers"] = {f: [] for f in FILTERS}
        payload["meta"].update({"h3_res": 9, "cell_layout": "by-filter"})
        (snap / "cells.json").write_text(json.dumps(payload), encoding="utf-8")
        (snap / "users.json").write_text(
            json.dumps({"42": {"name": "alice", "scores": {}, "last_ts": 0, "specialties": {}}}),
            encoding="utf-8",
        )

        assert migrate_legacy_snapshot(snap)
        names = {p.name for p in snap.iterdir()}
        assert {"cells.json", "cells.bin.gz", "scalars.bin.gz", "users.json.gz", "meta.json"} <= names
        assert "users.json" not in names

        core = json.loads((snap / "cells.json").read_text(encoding="utf-8"))
        assert "cells" not in core
        assert core["meta"]["max_count"]["all"] == 12
        assert core["colors"]["all"] == [42, 7]
        assert json.loads(gzip.decompress((snap / "users.json.gz").read_bytes()))["42"]["name"] == "alice"

        back = records_from_snapshot(snap)
        assert back[cell]["all"]["w"] == 42
        assert back[cell]["all"]["u"][0][0] == 42
        assert back[cell]["highway"]["sp"] == 1
        assert set(back[cell]) == set(FILTERS)
        # Running it again is a no-op: there is no legacy file left to convert.
        assert not migrate_legacy_snapshot(snap)


def test_cells_for_bboxes_union() -> None:
    from pipeline.extract import cells_for_bbox, cells_for_bboxes

    a = (13.39, 52.45, 13.48, 52.50)
    b = (13.31, 52.52, 13.33, 52.53)
    cells_a = cells_for_bbox(a, 9)
    cells_b = cells_for_bbox(b, 9)
    both = cells_for_bboxes((a, b), 9)
    assert cells_a <= both
    assert cells_b <= both
    assert both == cells_a | cells_b
    assert len(both) == len(cells_a) + len(cells_b)


def test_season_labels() -> None:
    from datetime import date

    from pipeline.snapshots import is_quarter_date, snapshot_entry

    spring = snapshot_entry(date(2026, 3, 21))
    assert spring["season"] == "fruehling"
    assert spring["short"] == "Frühling 2026"
    assert spring["label"] == "Datenstand: Frühling 2026"
    assert snapshot_entry(date(2026, 6, 21))["label"] == "Datenstand: Sommer 2026"
    assert snapshot_entry(date(2026, 6, 21))["period"] == (
        "OSM-Bearbeitungen im Zeitraum 21. März bis 21. Juni 2026"
    )
    assert snapshot_entry(date(2026, 3, 21))["period"] == (
        "OSM-Bearbeitungen im Zeitraum 21. Dezember 2025 bis 21. März 2026"
    )
    assert snapshot_entry(date(2026, 9, 21))["label"] == "Datenstand: Herbst 2026"
    assert snapshot_entry(date(2026, 12, 21))["label"] == "Datenstand: Winter 2026"
    assert snapshot_entry(date(2025, 12, 21))["short"] == "Winter 2025"
    assert is_quarter_date(date(2026, 3, 21))
    assert not is_quarter_date(date(2026, 3, 1))
    odd = snapshot_entry(date(2026, 8, 31))
    assert odd["season"] == ""
    assert "31.08.2026" in odd["label"]


def test_snapshot_date_for_run() -> None:
    from datetime import date

    from pipeline.snapshots import most_recent_quarter, snapshot_date_for_run

    assert snapshot_date_for_run(date(2026, 9, 21)) == date(2026, 9, 21)
    assert snapshot_date_for_run(date(2026, 8, 31)) == date(2026, 6, 21)
    assert most_recent_quarter(date(2026, 1, 10)) == date(2025, 12, 21)


def test_last_quarter_dates() -> None:
    from datetime import date

    from pipeline.snapshots import last_quarter_dates

    dates = last_quarter_dates(12, today=date(2026, 8, 31))
    assert dates[0] == date(2023, 9, 21)
    assert dates[-1] == date(2026, 6, 21)
    assert len(dates) == 12
    assert dates == sorted(dates)


def test_cell_binaries_roundtrip() -> None:
    import tempfile

    import h3

    from pipeline.binpack import read_cell_records, write_cell_binaries
    from pipeline.config import FILTERS

    cell = h3.latlng_to_cell(52.52, 13.4, 9)
    other = next(c for c in h3.grid_disk(cell, 1) if c != cell)
    empty = {"w": 0, "s": 0, "c": 0, "n": 0, "f": 0, "k": 0, "sp": 1, "ci": 0, "u": []}
    filled = {
        "w": 42,
        "s": 1.5,
        "c": 0.8,
        "n": 12,
        "f": 30,
        "k": 0,
        "sp": 0,
        "ci": 7,
        "u": [[42, 1.5, 1700006400], [7, 0.25, 1600041600]],
    }
    records = {
        cell: {filt: dict(filled) if filt == "all" else dict(empty) for filt in FILTERS},
        other: {filt: dict(empty) for filt in FILTERS},
    }
    user_stats = {42: {"name": "alice"}, 7: {"name": "bob"}}

    with tempfile.TemporaryDirectory() as raw:
        out = Path(raw)
        write_cell_binaries(out, records, user_stats)
        back = read_cell_records(out)

    assert back is not None
    assert set(back) == {cell, other}
    row = back[cell]["all"]
    assert row["w"] == 42
    assert row["s"] == 1.5
    assert row["c"] == 0.8
    assert row["n"] == 12
    assert row["ci"] == 7
    assert row["sp"] == 0
    assert [entry[0] for entry in row["u"]] == [42, 7]
    assert [entry[1] for entry in row["u"]] == [1.5, 0.25]
    # Timestamps are stored as whole days, so they land on midnight UTC.
    assert [entry[2] for entry in row["u"]] == [1700006400 // 86400 * 86400, 1600041600 // 86400 * 86400]
    assert back[cell]["highway"]["sp"] == 1
    assert back[other]["all"]["u"] == []


def test_filter_maxima_and_colors() -> None:
    from pipeline.config import FILTERS
    from pipeline.export import filter_maxima, winner_colors

    empty = {"w": 0, "s": 0, "c": 0, "n": 0, "f": 0, "k": 0, "sp": 1, "ci": 0, "u": []}
    records = {
        "a": {filt: dict(empty) for filt in FILTERS},
        "b": {filt: dict(empty) for filt in FILTERS},
    }
    records["a"]["all"] = {**empty, "w": 5, "sp": 0, "ci": 3, "n": 40, "u": [[5, 9.5, 0], [6, 2.0, 0]]}
    records["b"]["all"] = {**empty, "w": 6, "sp": 0, "ci": 4, "n": 12, "u": [[6, 4.0, 0]]}
    # Sparse cells have no territory, so their winner must not enter the color table.
    records["b"]["highway"] = {**empty, "w": 9, "sp": 1, "ci": 8, "n": 3, "u": [[9, 1.0, 0]]}

    max_score, max_count = filter_maxima(records)
    assert max_score["all"] == 9.5
    assert max_count["all"] == 40
    assert max_score["highway"] == 1.0
    assert max_count["highway"] == 3

    colors = winner_colors(records)
    assert dict(zip(colors["all"][::2], colors["all"][1::2])) == {5: 3, 6: 4}
    assert colors["highway"] == []


def test_pack_overlays_connected() -> None:
    import h3

    from pipeline.config import FILTERS
    from pipeline.overlays import pack_overlays

    cell = h3.latlng_to_cell(52.52, 13.4, 9)
    neighbor = next(c for c in h3.grid_disk(cell, 1) if c != cell)
    empty = {"w": 0, "s": 0, "c": 0, "n": 0, "f": 0, "k": 0, "sp": 1, "ci": 0, "u": []}

    def occupied(uid: int, score: float) -> dict:
        return {"w": uid, "s": score, "c": 1, "n": 5, "f": 0, "k": 0, "sp": 0, "ci": 1, "u": [[uid, score, 0]]}

    records = {
        cell: {filt: occupied(1, 2.0) if filt == "all" else dict(empty) for filt in FILTERS},
        neighbor: {filt: occupied(1, 3.0) if filt == "all" else dict(empty) for filt in FILTERS},
    }
    packed = pack_overlays(records)
    assert len(packed["all"]) == 1
    item = packed["all"][0]
    assert item["uid"] == 1
    assert set(item["cells"]) == {cell, neighbor}
    assert item["label"] in item["cells"]
    assert item["score"] == 5.0
    assert packed["highway"] == []


def test_pack_fronts_new_land() -> None:
    import h3

    from pipeline.config import FILTERS
    from pipeline.fronts import pack_fronts

    cell = h3.latlng_to_cell(52.52, 13.4, 9)
    neighbor = next(c for c in h3.grid_disk(cell, 1) if c != cell)
    empty = {"w": 0, "s": 0, "c": 0, "n": 0, "f": 0, "k": 0, "sp": 1, "ci": 0, "u": []}

    def occupied(uid: int) -> dict:
        return {"w": uid, "s": 1.0, "c": 1, "n": 5, "f": 0, "k": 0, "sp": 0, "ci": 1, "u": [[uid, 1.0, 0]]}

    prev = {
        cell: {filt: occupied(1) if filt == "all" else dict(empty) for filt in FILTERS},
    }
    cur = {
        cell: {filt: occupied(1) if filt == "all" else dict(empty) for filt in FILTERS},
        neighbor: {filt: occupied(1) if filt == "all" else dict(empty) for filt in FILTERS},
    }
    users = {1: {"name": "alice"}}
    fronts = pack_fronts(cur, users, prev, users)
    assert fronts["all"]
    # Rows are [uid, depth, ax, ay, bx, by, sign]; the rest is derived client-side.
    assert all(len(seg) == 7 for seg in fronts["all"])
    assert all(seg[0] == 1 for seg in fronts["all"])
    assert all(seg[1] in (1, 2, 3) for seg in fronts["all"])
    assert all(seg[6] in (1, -1) for seg in fronts["all"])


def test_prune_and_manifest() -> None:
    import json
    import tempfile
    from datetime import date

    from pipeline.config import MAX_SNAPSHOTS
    from pipeline.snapshots import prune_snapshots, write_snapshots_manifest

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        for i in range(14):
            month = (i % 12) + 1
            year = 2024 + i // 12
            day = date(year, month, 21) if month in (3, 6, 9, 12) else date(year, month, 1)
            folder = root / day.isoformat()
            folder.mkdir()
            (folder / "cells.json").write_text("{}", encoding="utf-8")
        kept = prune_snapshots(root, keep=MAX_SNAPSHOTS)
        assert len(kept) == MAX_SNAPSHOTS
        manifest = write_snapshots_manifest(root)
        assert len(manifest["snapshots"]) == MAX_SNAPSHOTS
        ids = [s["id"] for s in manifest["snapshots"]]
        assert ids == sorted(ids)
        payload = json.loads((root / "snapshots.json").read_text(encoding="utf-8"))
        assert payload["snapshots"][-1]["id"] == ids[-1]


def test_parse_dates() -> None:
    from datetime import date

    from pipeline.snapshots import parse_dates

    assert parse_dates("2025-12-21,2026-03-21,2026-06-21") == [
        date(2025, 12, 21),
        date(2026, 3, 21),
        date(2026, 6, 21),
    ]


def test_profile_bboxes() -> None:
    from pipeline.config import BBBIKE_BERLIN_BBOX, BERLIN_BBOX, DEV_TEST_BBOXES, LOERRACH_BBOX, config_for_profile

    dev, cfg = config_for_profile("dev")
    assert cfg.bboxes == DEV_TEST_BBOXES
    assert cfg.bboxes == ((13.2753, 52.4382, 13.5005, 52.5519),)
    assert len(dev.sources) == 1
    prod, pcfg = config_for_profile("prod")
    assert BERLIN_BBOX in pcfg.bboxes
    assert BBBIKE_BERLIN_BBOX in pcfg.bboxes
    assert LOERRACH_BBOX in pcfg.bboxes
    assert [src.id for src in prod.sources] == ["berlin", "brandenburg", "freiburg-regbez"]


def test_apply_cookie_parses_http_format() -> None:
    import requests

    from pipeline.geofabrik import COOKIE_DOMAIN, apply_cookie

    session = requests.Session()
    apply_cookie(session, 'gf_download_oauth="login|2018-04-12|token"')
    assert session.cookies.get("gf_download_oauth", domain=COOKIE_DOMAIN) == "login|2018-04-12|token"
    apply_cookie(session, "gf_download_oauth=login|2018-04-12|plain")
    assert session.cookies.get("gf_download_oauth", domain=COOKIE_DOMAIN) == "login|2018-04-12|plain"


if __name__ == "__main__":
    test_age_weight()
    test_color_stable()
    test_color_independent_of_filter()
    test_landscape_and_poi_filters()
    test_viewport_activity_level()
    test_unique_hex_edges()
    test_migrate_legacy_snapshot()
    test_cells_for_bboxes_union()
    test_season_labels()
    test_snapshot_date_for_run()
    test_last_quarter_dates()
    test_cell_binaries_roundtrip()
    test_filter_maxima_and_colors()
    test_pack_overlays_connected()
    test_pack_fronts_new_land()
    test_prune_and_manifest()
    test_parse_dates()
    test_profile_bboxes()
    test_apply_cookie_parses_http_format()
    print("weights ok")
