"""Compact territory sidecars (H3 lists, no coordinates)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import h3

from .config import FILTERS
from .territories import FilterCell, connected_territories


def label_cell(comp: list[str]) -> str:
    """Cell furthest from the territory edge (discrete pole of inaccessibility)."""
    cell_set = set(comp)
    dist: dict[str, int] = {}
    queue: list[str] = []
    for cell in comp:
        border = False
        for n in h3.grid_disk(cell, 1):
            if n != cell and n not in cell_set:
                border = True
                break
        if border:
            dist[cell] = 0
            queue.append(cell)
    if not queue:
        return comp[0]
    i = 0
    while i < len(queue):
        cell = queue[i]
        i += 1
        d = dist[cell]
        for n in h3.grid_disk(cell, 1):
            if n not in cell_set or n in dist:
                continue
            dist[n] = d + 1
            queue.append(n)
    clat = 0.0
    clng = 0.0
    for cell in comp:
        lat, lng = h3.cell_to_latlng(cell)
        clat += lat
        clng += lng
    clat /= len(comp)
    clng /= len(comp)
    best = comp[0]
    best_d = -1
    best_dist2 = float("inf")
    for cell in comp:
        d = dist.get(cell, 0)
        lat, lng = h3.cell_to_latlng(cell)
        dist2 = (lat - clat) ** 2 + (lng - clng) ** 2
        if d > best_d or (d == best_d and dist2 < best_dist2):
            best = cell
            best_d = d
            best_dist2 = dist2
    return best


def _component_score(records: dict[str, FilterCell], filt: str, uid: int, comp: list[str]) -> float:
    score = 0.0
    for cell in comp:
        row = records.get(cell, {}).get(filt) or {}
        found = False
        for urow in row.get("u") or []:
            if urow and urow[0] == uid:
                score += float(urow[1])
                found = True
                break
        if not found and row.get("w") == uid:
            score += float(row.get("s") or 0)
    return round(score, 4)


def pack_overlays(records: dict[str, FilterCell]) -> dict[str, list[dict[str, Any]]]:
    """Per-filter connected components as H3 lists plus label cell and score."""
    out: dict[str, list[dict[str, Any]]] = {}
    for filt in FILTERS:
        winners: dict[str, int] = {}
        for cell, rec in records.items():
            row = rec.get(filt) or {}
            uid = int(row.get("w") or 0)
            if not uid or int(row.get("sp") or 0) == 1:
                continue
            winners[cell] = uid
        items: list[dict[str, Any]] = []
        for comp in connected_territories(winners):
            uid = winners[comp[0]]
            items.append(
                {
                    "uid": uid,
                    "cells": comp,
                    "label": label_cell(comp),
                    "score": _component_score(records, filt, uid, comp),
                }
            )
        out[filt] = items
    return out


def write_sidecars(
    out_dir: Path,
    records: dict[str, FilterCell],
    user_stats: dict,
    prev_records: dict[str, FilterCell] | None,
    prev_users: dict | None,
    prev_id: str | None,
) -> None:
    """Precompute territories and front segments so the client never has to.

    Without these the web app would need the previous snapshot's full cell data
    just to draw the shark teeth.
    """
    from .export import write_json_gz
    from .fronts import pack_fronts

    write_json_gz(out_dir / "overlays.json.gz", pack_overlays(records))
    (out_dir / "overlays.json").unlink(missing_ok=True)
    if prev_records is None or prev_users is None:
        return
    fronts = pack_fronts(records, user_stats, prev_records, prev_users)
    write_json_gz(out_dir / "fronts.json.gz", {"prev": prev_id, **fronts})
    (out_dir / "fronts.json").unlink(missing_ok=True)
