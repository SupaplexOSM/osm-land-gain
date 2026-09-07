"""StreetComplete changeset IDs from the weekly planet dump (streamed, not stored)."""

from __future__ import annotations

import gzip
import xml.etree.ElementTree as ET
from array import array
from collections.abc import Iterable
from pathlib import Path
from typing import BinaryIO, Callable

import requests

from .config import PLANET_CHANGESETS_URL
from .planet import CONNECT_TIMEOUT, HEADERS, HttpBz2Reader, READ_TIMEOUT, drain_root, xml_local

PROGRESS_EVERY = 500_000


def is_streetcomplete_created_by(value: str) -> bool:
    return value.strip().startswith("StreetComplete")


def _changeset_is_streetcomplete(elem: ET.Element) -> bool:
    for child in elem:
        if xml_local(child.tag) != "tag":
            continue
        if child.get("k") == "created_by" and is_streetcomplete_created_by(child.get("v") or ""):
            return True
    return False


def parse_streetcomplete_changesets(
    source: BinaryIO | str,
    *,
    progress: Callable[[], int] | None = None,
) -> set[int]:
    """Read OSM changeset XML; keep IDs whose created_by starts with StreetComplete."""
    ids: set[int] = set()
    seen = 0
    context = ET.iterparse(source, events=("start", "end"))
    root = None
    for event, elem in context:
        if event == "start":
            if root is None:
                root = elem
            continue
        if xml_local(elem.tag) != "changeset":
            continue
        seen += 1
        raw_id = elem.get("id")
        if raw_id and _changeset_is_streetcomplete(elem):
            ids.add(int(raw_id))
        elem.clear()
        drain_root(root)
        if seen % PROGRESS_EVERY == 0:
            extra = ""
            if progress is not None:
                extra = f", {progress() / 1e9:.2f} GB komprimiert"
            print(f"  Changesets gelesen: {seen:,} (StreetComplete: {len(ids):,}{extra})", flush=True)
    print(f"  Changesets insgesamt: {seen:,}, StreetComplete: {len(ids):,}", flush=True)
    return ids


def stream_streetcomplete_ids(url: str = PLANET_CHANGESETS_URL) -> set[int]:
    print(f"Streame Changeset-Dump (ohne Speichern): {url}", flush=True)
    with requests.get(url, stream=True, headers=HEADERS, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT)) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length") or 0)
        if total:
            print(f"  {resp.url} ({total / 1e9:.2f} GB)", flush=True)
        else:
            print(f"  {resp.url}", flush=True)
        reader = HttpBz2Reader(resp)
        return parse_streetcomplete_changesets(reader, progress=lambda: reader.bytes_in)


def save_changeset_ids(path: Path, ids: Iterable[int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    values = array("I", sorted({i for i in ids if 0 <= i <= 0xFFFFFFFF}))
    path.write_bytes(gzip.compress(values.tobytes(), 6))


def load_changeset_ids(path: Path) -> set[int]:
    raw = gzip.decompress(path.read_bytes())
    if len(raw) % 4:
        raise ValueError(f"Ungültige Changeset-ID-Datei: {path}")
    values = array("I")
    values.frombytes(raw)
    return set(values)


def ensure_streetcomplete_ids(
    cache_path: Path,
    meta_path: Path | None = None,
    *,
    refresh: bool = False,
) -> set[int]:
    if not refresh and cache_path.exists() and cache_path.stat().st_size > 16:
        ids = load_changeset_ids(cache_path)
        print(f"StreetComplete-Changesets aus Cache: {len(ids):,} ({cache_path})", flush=True)
        if meta_path is not None:
            save_changeset_ids(meta_path, ids)
        return ids
    ids = stream_streetcomplete_ids()
    save_changeset_ids(cache_path, ids)
    if meta_path is not None:
        save_changeset_ids(meta_path, ids)
        print(f"StreetComplete-IDs geschrieben: {meta_path}", flush=True)
    return ids
