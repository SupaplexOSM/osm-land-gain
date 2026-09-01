"""CLI: Geofabrik-Internal-PBF → H3-Auswertung → PMTiles + JSON."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from .config import PROFILES, Config, config_for_profile
from .export import compact_cells_payload, records_from_cells_json, write_json_sidecars, write_pmtiles
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
from .snapshots import (
    last_quarter_dates,
    parse_dates,
    snapshot_date_for_run,
    snapshot_entry,
    write_snapshots_manifest,
)
from .territories import assemble_cell_records, recolor_packed_cells

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "web" / "public" / "data"


def _user_names(path: Path) -> list[str] | None:
    if not path.exists():
        return None
    users = json.loads(path.read_text(encoding="utf-8"))
    if not users:
        return None
    max_uid = max(int(k) for k in users)
    names = [""] * (max_uid + 1)
    for uid, rec in users.items():
        names[int(uid)] = rec.get("name", "")
    return names


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
    print(f"Fertig: {snap_dir}")


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _snapshot_current(snap_dir: Path, cfg: Config) -> bool:
    meta_path = snap_dir / "meta.json"
    if not (snap_dir / "cells.json").exists() or not (snap_dir / "cells.pmtiles").exists() or not meta_path.exists():
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
    parser.add_argument("--tiles-only", action="store_true", help="Nur PMTiles aus vorhandenem cells.json neu bauen")
    parser.add_argument(
        "--repack-cells",
        action="store_true",
        help="cells.json ins kompakte Filter-Array-Format umschreiben (ohne PBF)",
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

    if args.repack_cells:
        cells_path = _snapshot_dir(args.out, args) / "cells.json"
        if not cells_path.exists():
            print(f"cells.json nicht gefunden: {cells_path}", file=sys.stderr)
            return 1
        print(f"Packe {cells_path} um…")
        payload = json.loads(cells_path.read_text(encoding="utf-8"))
        compact_cells_payload(payload)
        cells_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        print("cells.json umgepackt (filter-array).")
        return 0
    if args.tiles_only:
        snap_dir = _snapshot_dir(args.out, args)
        cells_path = snap_dir / "cells.json"
        if not cells_path.exists():
            print(f"cells.json nicht gefunden: {cells_path}", file=sys.stderr)
            return 1
        names = _user_names(snap_dir / "users.json")
        payload = json.loads(cells_path.read_text(encoding="utf-8"))
        recolor_packed_cells(payload["cells"], cfg.palette_size, names)
        cells_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        print("Userfarben aus Usernamen neu gesetzt.")
        records = records_from_cells_json(cells_path)
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

    write_snapshots_manifest(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
