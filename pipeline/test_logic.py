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


def test_compact_cells_payload_nulls_empty_rows() -> None:
    from pipeline.config import FILTERS
    from pipeline.export import compact_cells_payload, is_empty_packed_row

    payload = _sample_old_cells_payload()
    compact_cells_payload(payload)
    assert payload["meta"]["cell_layout"] == "filter-array"
    rows = payload["cells"]["891f1d48d27ffff"]
    assert isinstance(rows, list)
    assert len(rows) == len(FILTERS)
    assert rows[0][0] == 42
    assert rows[FILTERS.index("highway")] is None
    assert is_empty_packed_row(None)
    compact_cells_payload(payload)
    assert payload["cells"]["891f1d48d27ffff"][0][0] == 42


def test_records_from_cells_json_both_layouts() -> None:
    import json
    import tempfile

    from pipeline.config import FILTERS
    from pipeline.export import compact_cells_payload, records_from_cells_json
    from pipeline.territories import recolor_packed_cells
    from pipeline.weights import user_color_index

    with tempfile.TemporaryDirectory() as raw:
        tmp_path = Path(raw)
        old_path = tmp_path / "old.json"
        old_path.write_text(json.dumps(_sample_old_cells_payload()), encoding="utf-8")
        old_rec = records_from_cells_json(old_path)
        assert old_rec["891f1d48d27ffff"]["all"]["w"] == 42
        assert old_rec["891f1d48d27ffff"]["highway"]["n"] == 0

        compact = compact_cells_payload(_sample_old_cells_payload())
        names = [""] * 43
        names[42] = "alice"
        recolor_packed_cells(compact["cells"], 48, names)
        new_path = tmp_path / "new.json"
        new_path.write_text(json.dumps(compact), encoding="utf-8")
        new_rec = records_from_cells_json(new_path)
        assert new_rec["891f1d48d27ffff"]["all"]["w"] == 42
        assert new_rec["891f1d48d27ffff"]["all"]["ci"] == user_color_index("alice", 48)
        assert new_rec["891f1d48d27ffff"]["highway"]["sp"] == 1
        assert set(new_rec["891f1d48d27ffff"]) == set(FILTERS)


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


if __name__ == "__main__":
    test_age_weight()
    test_color_stable()
    test_color_independent_of_filter()
    test_landscape_and_poi_filters()
    test_viewport_activity_level()
    test_unique_hex_edges()
    test_compact_cells_payload_nulls_empty_rows()
    test_records_from_cells_json_both_layouts()
    test_cells_for_bboxes_union()
    test_season_labels()
    test_snapshot_date_for_run()
    test_last_quarter_dates()
    test_prune_and_manifest()
    test_parse_dates()
    test_profile_bboxes()
    print("weights ok")
