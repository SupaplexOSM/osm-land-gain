"""Quarterly snapshot ids, labels, prune and manifest."""

from __future__ import annotations

import json
import re
import shutil
from datetime import date
from pathlib import Path

from .config import FILTERS, MAX_SNAPSHOTS, SNAPSHOT_DAY, SNAPSHOT_MONTHS, SNAPSHOT_PIPELINE_DAY

SNAPSHOT_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SEASON_BY_MONTH = {
    3: "fruehling",
    6: "sommer",
    9: "herbst",
    12: "winter",
}
SEASON_LABEL_DE = {
    "fruehling": "Frühling",
    "sommer": "Sommer",
    "herbst": "Herbst",
    "winter": "Winter",
}
MONTH_LABEL_DE = (
    "",
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
)


def parse_dates(raw: str) -> list[date]:
    out: list[date] = []
    for part in raw.split(","):
        text = part.strip()
        if not text:
            continue
        out.append(date.fromisoformat(text))
    if not out:
        raise ValueError("Keine Daten in --dates")
    return out


def is_quarter_date(day: date) -> bool:
    return day.month in SNAPSHOT_MONTHS and day.day == SNAPSHOT_DAY


def is_quarter_pipeline_day(day: date) -> bool:
    """GitHub Action day: 22 Mar/Jun/Sep/Dec, after the 21st extract is on Geofabrik."""
    return day.month in SNAPSHOT_MONTHS and day.day == SNAPSHOT_PIPELINE_DAY


def is_winter_date(day: date) -> bool:
    return day.month == 12 and day.day == SNAPSHOT_DAY


def most_recent_quarter(today: date | None = None) -> date:
    today = today or date.today()
    found: list[date] = []
    for year in (today.year - 1, today.year):
        for month in SNAPSHOT_MONTHS:
            candidate = date(year, month, SNAPSHOT_DAY)
            if candidate <= today:
                found.append(candidate)
    if not found:
        return date(today.year, 3, SNAPSHOT_DAY)
    return max(found)


def snapshot_date_for_run(today: date | None = None) -> date:
    """Stichtag für CI: heute falls Quartalstag, sonst das letzte Quartal."""
    today = today or date.today()
    if is_quarter_date(today):
        return today
    return most_recent_quarter(today)


def last_quarter_dates(n: int = MAX_SNAPSHOTS, today: date | None = None) -> list[date]:
    """Die n jüngsten Quartalsstichtage, chronologisch (ältester zuerst)."""
    end = snapshot_date_for_run(today)
    year, month = end.year, end.month
    out: list[date] = []
    for _ in range(n):
        out.append(date(year, month, SNAPSHOT_DAY))
        month -= 3
        if month <= 0:
            month += 12
            year -= 1
    return list(reversed(out))


def previous_quarter_date(day: date) -> date:
    """Stichtag des vorherigen Quartals (21. des Monats, drei Monate früher)."""
    month = day.month - 3
    year = day.year
    if month <= 0:
        month += 12
        year -= 1
    return date(year, month, SNAPSHOT_DAY)


def _format_period_day(day: date, with_year: bool) -> str:
    text = f"{day.day}. {MONTH_LABEL_DE[day.month]}"
    return f"{text} {day.year}" if with_year else text


def snapshot_period_hint(day: date) -> str:
    """Tooltip: OSM-Edits vom vorherigen Quartalsstichtag bis zu diesem Datenstand."""
    start = previous_quarter_date(day)
    years_differ = start.year != day.year
    return (
        "OSM-Bearbeitungen im Zeitraum "
        f"{_format_period_day(start, years_differ)} bis {_format_period_day(day, True)}"
    )


def snapshot_entry(day: date) -> dict:
    season = SEASON_BY_MONTH.get(day.month, "") if day.day == SNAPSHOT_DAY else ""
    if season:
        short = f"{SEASON_LABEL_DE[season]} {day.year}"
        label = f"Datenstand: {short}"
    else:
        short = day.strftime("%d.%m.%Y")
        label = f"Datenstand: {short}"
    return {
        "id": day.isoformat(),
        "date": day.isoformat(),
        "season": season,
        "short": short,
        "label": label,
        "period": snapshot_period_hint(day),
        "year": day.year,
    }


def list_snapshot_dirs(data_dir: Path) -> list[Path]:
    if not data_dir.exists():
        return []
    dirs = [
        path
        for path in data_dir.iterdir()
        if path.is_dir()
        and SNAPSHOT_DIR_RE.match(path.name)
        and (path / "cells.json").exists()
    ]
    return sorted(dirs, key=lambda path: path.name)


def split_snapshot_dirs(
    dirs: list[Path],
    keep: int = MAX_SNAPSHOTS,
    today: date | None = None,
) -> tuple[list[Path], list[Path]]:
    """Quarter folders among the last `keep` calendar quarters vs older 21-Dec history."""
    recent = {day.isoformat() for day in last_quarter_dates(n=keep, today=today)}
    kept_quarters = [path for path in dirs if path.name in recent]
    history = [
        path
        for path in dirs
        if is_winter_date(date.fromisoformat(path.name)) and path.name not in recent
    ]
    return kept_quarters, history


def is_yearly_history(day: date, today: date | None = None) -> bool:
    """21 Dec that is not among the current 12 quarterly slider dates."""
    return is_winter_date(day) and day not in last_quarter_dates(today=today)


def history_tile_zoom(day: date, today: date | None = None) -> int | None:
    """Always None: every snapshot uses Config.max_zoom (HISTORY_MAX_ZOOM)."""
    return None


def prune_snapshots(data_dir: Path, keep: int = MAX_SNAPSHOTS) -> list[Path]:
    dirs = list_snapshot_dirs(data_dir)
    kept_quarters, history = split_snapshot_dirs(dirs, keep)
    keep_names = {path.name for path in kept_quarters} | {path.name for path in history}
    for path in dirs:
        if path.name in keep_names:
            continue
        print(f"Snapshot entfernt (Limit {keep} Quartale): {path.name}")
        shutil.rmtree(path)
    return list_snapshot_dirs(data_dir)


def _max_count_from_snapshot(path: Path) -> dict:
    meta_file = path / "meta.json"
    if meta_file.exists():
        try:
            payload = json.loads(meta_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            payload = {}
        counts = payload.get("max_count") if isinstance(payload, dict) else None
        if isinstance(counts, dict):
            return counts
    cells_file = path / "cells.json"
    if cells_file.exists():
        try:
            payload = json.loads(cells_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            payload = {}
        meta = payload.get("meta") if isinstance(payload, dict) else None
        counts = meta.get("max_count") if isinstance(meta, dict) else None
        if isinstance(counts, dict):
            return counts
    return {}


def snapshot_max_counts(dirs: list[Path]) -> dict[str, int]:
    out = {filt: 0 for filt in FILTERS}
    for path in dirs:
        counts = _max_count_from_snapshot(path)
        for filt in FILTERS:
            raw = counts.get(filt)
            if isinstance(raw, (int, float)) and raw > out[filt]:
                out[filt] = int(raw)
    return out


def write_snapshots_manifest(data_dir: Path, keep: int = MAX_SNAPSHOTS) -> dict:
    dirs = prune_snapshots(data_dir, keep)
    quarters, history_dirs = split_snapshot_dirs(dirs, keep)
    payload = {
        "snapshots": [snapshot_entry(date.fromisoformat(path.name)) for path in quarters],
        "history": [snapshot_entry(date.fromisoformat(path.name)) for path in history_dirs],
        "max_count": snapshot_max_counts(dirs),
    }
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "snapshots.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return payload
