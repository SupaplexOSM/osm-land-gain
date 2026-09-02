"""CLI: Geofabrik-Internal-PBF → H3-Auswertung → PMTiles + JSON."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from .binpack import CELLS_NAME
from .config import PROFILES, Config, config_for_profile
from .export import (
    migrate_legacy_snapshot,
    records_from_snapshot,
    user_stats_from_snapshot,
    write_json_sidecars,
    write_pmtiles,
)
from .extract import cells_for_bboxes, extract_pbf
from .geofabrik import GeofabrikAuthError, CACHE as PBF_CACHE, geofabrik_cookie
from .osm_prep import (
    OsmiumError,
    TMP,
    clip_history_sources,
    die_osmium,
    prepare_latest_pbf,
    snapshot_pbf_from_clips,
)
from .overlays import write_sidecars
from .snapshots import (
    last_quarter_dates,
    list_snapshot_dirs,
    parse_dates,
    previous_quarter_date,
    snapshot_date_for_run,
    snapshot_entry,
    write_snapshots_manifest,
)
from .territories import assemble_cell_records

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "web" / "public" / "data"


def _write_sidecars(
    snap_dir: Path,
    snapshot: date,
    records: dict | None = None,
    user_stats: dict | None = None,
) -> None:
    """Territory and front sidecars for one snapshot; needs the previous quarter."""
    if records is None:
        records = records_from_snapshot(snap_dir)
        if records is None:
            return
    if user_stats is None:
        user_stats = user_stats_from_snapshot(snap_dir)
        if not isinstance(user_stats, dict):
            return
    prev = previous_quarter_date(snapshot)
    prev_dir = snap_dir.parent / prev.isoformat()
    prev_records = records_from_snapshot(prev_dir) if prev_dir.is_dir() else None
    prev_users = user_stats_from_snapshot(prev_dir) if prev_records is not None else None
    if not isinstance(prev_users, dict):
        prev_records = None
        prev_users = None
    write_sidecars(
        snap_dir,
        records,
        user_stats,
        prev_records,
        prev_users,
        prev.isoformat() if prev_records is not None else None,
    )
    print(f"Sidecars: {snap_dir / 'overlays.json.gz'}")


def _upgrade_snapshots(out_dir: Path) -> None:
    """Bring archived snapshot folders to the current file layout."""
    for snap_dir in list_snapshot_dirs(out_dir):
        if migrate_legacy_snapshot(snap_dir):
            print(f"Snapshot umgestellt: {snap_dir.name}")
    for snap_dir in list_snapshot_dirs(out_dir):
        if (snap_dir / "overlays.json.gz").exists():
            continue
        _write_sidecars(snap_dir, date.fromisoformat(snap_dir.name))


def run_snapshot(pbf: Path, snap_dir: Path, cfg: Config, snapshot: date) -> None:
    entry = snapshot_entry(snapshot)
    print(f"Auswertung {entry['label']} ({pbf})…")
    acc, users = extract_pbf(str(pbf), cfg, snapshot)
    all_cells = cells_for_bboxes(cfg.bboxes, cfg.h3_res)
    all_cells.update(acc.keys())
    print(f"H3-Zellen (inkl. leerer Felder): {len(all_cells):,}")
    print("Glätte Nachbarn, bilde Usergebiete, setze Aktivitätszentren…")
    records, user_stats, centers = assemble_cell_records(acc, users, all_cells, cfg)
    snap_dir.mkdir(parents=True, exist_ok=True)
    write_json_sidecars(snap_dir, records, user_stats, cfg, snapshot, centers, snapshot=entry)
    write_pmtiles(snap_dir / "cells.pmtiles", records, cfg)
    _write_sidecars(snap_dir, snapshot, records, {str(uid): st for uid, st in user_stats.items()})
    print(f"Fertig: {snap_dir}")


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _snapshot_current(snap_dir: Path, cfg: Config) -> bool:
    meta_path = snap_dir / "meta.json"
    needed = (snap_dir / "cells.json", snap_dir / CELLS_NAME, snap_dir / "cells.pmtiles", meta_path)
    if not all(path.exists() for path in needed):
        return False
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    want = [list(b) for b in cfg.bboxes]
    return meta.get("bboxes") == want


def _snapshot_dir(out_dir: Path, args: argparse.Namespace) -> Path:
    if args.snapshot:
        return out_dir / date.fromisoformat(args.snapshot).isoformat()
    if out_dir.joinpath("cells.json").exists():
        return out_dir
    snaps = sorted(
        path for path in out_dir.glob("*/cells.json")
    )
    if snaps:
        return snaps[-1].parent
    return out_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OSM Land Gain Pipeline (Geofabrik Internal, kein Overpass)")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="dev", help="dev = Berlin-Test-BBOX, prod = Berlin+Umland+Lörrach")
    parser.add_argument("--pbf", type=Path, help="Lokales PBF (überspringt Download und Zuschnitt)")
    parser.add_argument("--download", action="store_true", help="Internal-PBF von Geofabrik laden")
    parser.add_argument("--history", action="store_true", help="Stände aus History-OSH erzeugen")
    parser.add_argument("--dates", help="Kommagetrennte Stichtage YYYY-MM-DD (mit --history; Standard: letzte 12 Quartale)")
    parser.add_argument("--snapshot", help="Stichtag YYYY-MM-DD für den aktuellen Latest-Extract")
    parser.add_argument("--force", action="store_true", help="Vorhandene Snapshots neu berechnen")
    parser.add_argument("--tiles-only", action="store_true", help="Nur PMTiles aus den Snapshot-Binärdateien neu bauen")
    parser.add_argument(
        "--upgrade",
        action="store_true",
        help="Vorhandene Snapshot-Ordner auf das aktuelle Dateiformat bringen (ohne PBF)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Ausgabeverzeichnis (enthält YYYY-MM-DD-Unterordner)",
    )
    args = parser.parse_args(argv)
    try:
        profile, cfg = config_for_profile(args.profile)
    except ValueError as err:
        print(err, file=sys.stderr)
        return 1

    if args.upgrade:
        _upgrade_snapshots(args.out)
        write_snapshots_manifest(args.out)
        return 0
    if args.tiles_only:
        snap_dir = _snapshot_dir(args.out, args)
        records = records_from_snapshot(snap_dir)
        if records is None:
            print(f"Keine Zelldaten in {snap_dir}", file=sys.stderr)
            return 1
        write_pmtiles(snap_dir / "cells.pmtiles", records, cfg)
        return 0

    snapshot_dates: list[date] = []
    latest_date: date | None = None
    if args.snapshot:
        latest_date = date.fromisoformat(args.snapshot)
    if args.dates:
        try:
            snapshot_dates = parse_dates(args.dates)
        except ValueError as err:
            print(err, file=sys.stderr)
            return 1
    elif args.history:
        snapshot_dates = last_quarter_dates()
        print(
            "Kein --dates, nutze die letzten "
            f"{len(snapshot_dates)} Quartale: {','.join(d.isoformat() for d in snapshot_dates)}."
        )
    if not args.history and latest_date is None and args.pbf is None and not args.download:
        parser.print_help()
        return 1
    if not args.history and latest_date is None:
        latest_date = snapshot_date_for_run()
        print(f"Kein --snapshot, nutze Stichtag {latest_date.isoformat()}.")

    PBF_CACHE.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)

    try:
        if args.pbf:
            if not args.pbf.exists():
                print(f"PBF nicht gefunden: {args.pbf}", file=sys.stderr)
                return 1
            when = latest_date or snapshot_date_for_run()
            run_snapshot(args.pbf, args.out / when.isoformat(), cfg, when)
        else:
            if args.download or latest_date is not None or args.history:
                cookie = geofabrik_cookie()
            else:
                cookie = ""
            if latest_date is not None:
                pbf = prepare_latest_pbf(profile.sources, PBF_CACHE, TMP, cookie)
                run_snapshot(pbf, args.out / latest_date.isoformat(), cfg, latest_date)
            if args.history:
                clips = clip_history_sources(profile.sources, PBF_CACHE, TMP, cookie)
                for when in snapshot_dates:
                    snap_dir = args.out / when.isoformat()
                    if not args.force and _snapshot_current(snap_dir, cfg):
                        print(f"Überspringe {when.isoformat()} (bereits vorhanden).")
                        continue
                    pbf, parts = snapshot_pbf_from_clips(clips, TMP, when)
                    run_snapshot(pbf, snap_dir, cfg, when)
                    _unlink_quiet(pbf)
                    for part in parts:
                        _unlink_quiet(part)
                    write_snapshots_manifest(args.out)
    except GeofabrikAuthError as err:
        print(str(err), file=sys.stderr)
        return 1
    except OsmiumError as err:
        return die_osmium(err)

    _upgrade_snapshots(args.out)
    write_snapshots_manifest(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
