"""Clip, time-filter and merge OSM files with osmium-tool."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

from .config import BBox, Source

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / "pipeline" / "_tmp"


class OsmiumError(RuntimeError):
    pass


def require_osmium() -> str:
    path = shutil.which("osmium")
    if not path:
        raise OsmiumError(
            "osmium-tool fehlt. Installieren z. B. mit: sudo apt-get install osmium-tool"
        )
    return path


def _run(cmd: list[str]) -> None:
    print(" ", " ".join(cmd), flush=True)
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as err:
        raise OsmiumError(f"osmium fehlgeschlagen ({err.returncode}): {' '.join(cmd)}") from err


def bboxes_geojson(bboxes: tuple[BBox, ...] | list[BBox]) -> dict:
    features = []
    for west, south, east, north in bboxes:
        ring = [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
        ]
        features.append(
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def osmium_extract(
    src: Path,
    dest: Path,
    bboxes: tuple[BBox, ...] | list[BBox],
    *,
    with_history: bool = False,
) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if len(bboxes) > 1:
        parts = [
            osmium_extract(
                src,
                dest.with_name(f"part{i}-{dest.name}"),
                (bbox,),
                with_history=with_history,
            )
            for i, bbox in enumerate(bboxes)
        ]
        return osmium_merge(parts, dest, with_history=with_history)
    west, south, east, north = bboxes[0]
    cmd = [
        require_osmium(),
        "extract",
        "-o",
        str(dest),
        "--overwrite",
        "--strategy",
        "complete_ways",
        "-b",
        f"{west},{south},{east},{north}",
    ]
    if with_history:
        cmd.append("--with-history")
    cmd.append(str(src))
    _run(cmd)
    return dest


def osmium_time_filter(src: Path, dest: Path, when: date) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    stamp = f"{when.isoformat()}T00:00:00Z"
    _run(
        [
            require_osmium(),
            "time-filter",
            "-o",
            str(dest),
            "--overwrite",
            str(src),
            stamp,
        ]
    )
    return dest


def osmium_merge(inputs: list[Path], dest: Path, *, with_history: bool = False) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if len(inputs) == 1:
        shutil.copy2(inputs[0], dest)
        return dest
    cmd = [require_osmium(), "merge", "-o", str(dest), "--overwrite"]
    if with_history:
        cmd.append("--with-history")
    cmd.extend(str(path) for path in inputs)
    _run(cmd)
    return dest


def prepare_latest_pbf(sources: tuple[Source, ...], cache: Path, tmp: Path, cookie: str) -> Path:
    from .geofabrik import cache_name_for_url, download_internal

    clipped: list[Path] = []
    for src in sources:
        raw = download_internal(src.latest_url, cache / cache_name_for_url(src.latest_url), cookie=cookie)
        out = tmp / f"{src.id}.clip.osm.pbf"
        print(f"Schneide {src.id} (latest)…")
        osmium_extract(raw, out, src.bboxes, with_history=False)
        clipped.append(out)
    merged = tmp / "latest.merged.osm.pbf"
    print("Führe Latest-Ausschnitte zusammen…" if len(clipped) > 1 else "Latest-Ausschnitt fertig.")
    return osmium_merge(clipped, merged)


def clip_history_sources(
    sources: tuple[Source, ...],
    cache: Path,
    tmp: Path,
    cookie: str,
) -> list[tuple[Source, Path]]:
    """Download and bbox-clip each history OSH once (reuse across --dates)."""
    from .geofabrik import cache_name_for_url, download_internal

    clips: list[tuple[Source, Path]] = []
    for src in sources:
        raw = download_internal(src.history_url, cache / cache_name_for_url(src.history_url), cookie=cookie)
        hist = tmp / f"{src.id}.clip.osh.pbf"
        print(f"Schneide {src.id} (history)…")
        osmium_extract(raw, hist, src.bboxes, with_history=True)
        clips.append((src, hist))
    return clips


def snapshot_pbf_from_clips(
    clips: list[tuple[Source, Path]],
    tmp: Path,
    when: date,
) -> tuple[Path, list[Path]]:
    """Time-filter clipped history files and merge into one snapshot PBF."""
    snaps: list[Path] = []
    for src, hist in clips:
        snap = tmp / f"{src.id}.{when.isoformat()}.osm.pbf"
        print(f"Stichtag {when.isoformat()} für {src.id}…")
        osmium_time_filter(hist, snap, when)
        snaps.append(snap)
    merged = tmp / f"history.{when.isoformat()}.merged.osm.pbf"
    return osmium_merge(snaps, merged), snaps


def prepare_history_pbf(
    sources: tuple[Source, ...],
    cache: Path,
    tmp: Path,
    cookie: str,
    when: date,
) -> Path:
    clips = clip_history_sources(sources, cache, tmp, cookie)
    merged, _snaps = snapshot_pbf_from_clips(clips, tmp, when)
    return merged


def die_osmium(err: OsmiumError) -> int:
    print(str(err), file=sys.stderr)
    return 1
