"""Closed OSM notes at a snapshot date, credited to the last closer."""

from __future__ import annotations

import bz2
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import BinaryIO, Sequence

import h3

from .config import PLANET_NOTES_URL, Config, in_bboxes
from .extract import CellAcc, UserIndex, credit_cells
from .planet import download_file, drain_root, xml_local

PROGRESS_EVERY = 100_000
MIN_DUMP_BYTES = 10_000_000


@dataclass(frozen=True)
class NoteComment:
    ts: datetime
    action: str
    user: str
    uid: str


def parse_osm_timestamp(value: str) -> datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        ts = datetime.fromisoformat(text)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def _actor_name(user: str, uid: str) -> str:
    return user.strip() or (f"user-{uid.strip()}" if uid.strip() else "")


def _same_mapper(opener_user: str, opener_uid: str, closer_user: str, closer_uid: str) -> bool:
    """True if opener and closer are the same identified mapper (not anonymous)."""
    if opener_uid and closer_uid:
        return opener_uid == closer_uid
    if opener_user and closer_user:
        return opener_user == closer_user
    return False


def closer_at_snapshot(comments: Sequence[NoteComment], snapshot: date) -> tuple[str, datetime] | None:
    """Last closer on or before the snapshot; None if the note is not closed then.

    A self-close (same mapper opened and closed) does not count. Anonymous
    openers do count: someone else resolved a note without an OSM account.
    """
    state = "open"
    closer = ""
    closer_uid = ""
    closer_ts: datetime | None = None
    opener_seen = False
    opener_user = ""
    opener_uid = ""
    seen = False
    for comment in comments:
        if comment.ts.tzinfo is None:
            day = comment.ts.date()
        else:
            day = comment.ts.astimezone(timezone.utc).date()
        if day > snapshot:
            continue
        seen = True
        action = comment.action.lower()
        if action == "hidden":
            return None
        if action == "opened" and not opener_seen:
            opener_seen = True
            opener_user = comment.user.strip()
            opener_uid = comment.uid.strip()
        if action in ("opened", "reopened"):
            state = "open"
        elif action == "closed":
            state = "closed"
            closer = _actor_name(comment.user, comment.uid)
            closer_user = comment.user.strip()
            closer_uid = comment.uid.strip()
            closer_ts = comment.ts
    if not seen or state != "closed" or not closer or closer_ts is None:
        return None
    if _same_mapper(opener_user, opener_uid, closer_user, closer_uid):
        return None
    return closer, closer_ts


def _note_comments(elem: ET.Element) -> list[NoteComment]:
    out: list[NoteComment] = []
    for child in elem:
        if xml_local(child.tag) != "comment":
            continue
        ts = parse_osm_timestamp(child.get("timestamp") or "")
        if ts is None:
            continue
        out.append(
            NoteComment(
                ts=ts,
                action=(child.get("action") or "").strip(),
                user=(child.get("user") or "").strip(),
                uid=(child.get("uid") or "").strip(),
            )
        )
    return out


def credit_closed_notes(
    source: BinaryIO | Path,
    snapshot: date,
    cfg: Config,
    acc: CellAcc,
    users: UserIndex,
) -> int:
    """Replay note history; credit closers of notes that are closed at the snapshot."""
    close_count = 0
    seen = 0
    kept = 0
    path: Path | None = source if isinstance(source, Path) else None
    opener = None
    fp: BinaryIO
    if path is not None:
        opener = bz2.open(path, "rb") if path.suffix == ".bz2" or path.name.endswith(".osn.bz2") else path.open("rb")
        fp = opener
    else:
        fp = source
    try:
        context = ET.iterparse(fp, events=("start", "end"))
        root = None
        for event, elem in context:
            if event == "start":
                if root is None:
                    root = elem
                continue
            if xml_local(elem.tag) != "note":
                continue
            seen += 1
            try:
                lat = float(elem.get("lat") or "")
                lon = float(elem.get("lon") or "")
            except ValueError:
                lat = lon = None  # type: ignore[assignment]
            comments = _note_comments(elem)
            elem.clear()
            drain_root(root)
            if seen % PROGRESS_EVERY == 0:
                print(f"  Notes gelesen: {seen:,} (geschlossen im Gebiet: {kept:,})", flush=True)
            if lat is None or lon is None or not in_bboxes(lon, lat, cfg.bboxes):
                continue
            hit = closer_at_snapshot(comments, snapshot)
            if hit is None:
                continue
            name, ts = hit
            cell = h3.latlng_to_cell(lat, lon, cfg.h3_res)
            credit_cells(acc, users, (cell,), ("notes",), name, ts, snapshot)
            kept += 1
            close_count += 1
    finally:
        if opener is not None:
            opener.close()
    print(f"  Notes insgesamt: {seen:,}, geschlossen im Gebiet am Stichtag: {close_count:,}", flush=True)
    return close_count


def ensure_notes_dump(cache_dir: Path, *, refresh: bool = False) -> Path:
    dest = cache_dir / "planet-notes-latest.osn.bz2"
    if not refresh and dest.exists() and dest.stat().st_size >= MIN_DUMP_BYTES:
        print(f"Notes-Dump aus Cache: {dest}", flush=True)
        return dest
    if refresh and dest.exists():
        dest.unlink()
    return download_file(PLANET_NOTES_URL, dest)
