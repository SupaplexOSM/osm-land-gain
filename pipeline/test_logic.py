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


if __name__ == "__main__":
    test_age_weight()
    test_color_stable()
    test_color_independent_of_filter()
    test_landscape_and_poi_filters()
    test_viewport_activity_level()
    test_unique_hex_edges()
    test_compact_cells_payload_nulls_empty_rows()
    test_records_from_cells_json_both_layouts()
    print("weights ok")
