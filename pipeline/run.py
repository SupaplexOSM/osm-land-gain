"""CLI: Geofabrik-PBF → H3-Auswertung → PMTiles + JSON."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

from .config import Config
from .export import compact_cells_payload, records_from_cells_json, write_json_sidecars, write_pmtiles
from .extract import cells_for_bbox, extract_pbf
from .territories import assemble_cell_records, recolor_packed_cells

ROOT = Path(__file__).resolve().parent.parent


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


def download_pbf(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"PBF vorhanden: {dest}")
        return dest
    print(f"Lade {url} → {dest}")
    last = [-1]

    def _progress(block: int, block_size: int, total: int) -> None:
        if total <= 0:
            return
        done = min(100, int((block * block_size * 100) / total))
        if done >= last[0] + 10:
            last[0] = done
            print(f"  Download {done}%", flush=True)

    opener = urllib.request.build_opener()
    opener.addheaders = [("User-Agent", "osm-land-gain/1.0 (+https://github.com)")]
    urllib.request.install_opener(opener)
    urllib.request.urlretrieve(url, dest, reporthook=_progress)
    return dest


def run(pbf: Path, out_dir: Path, cfg: Config | None = None) -> None:
    cfg = cfg or Config()
    today = date.today()
    acc, users = extract_pbf(str(pbf), cfg, today)
    all_cells = cells_for_bbox(cfg.bbox, cfg.h3_res)
    all_cells.update(acc.keys())
    print(f"H3-Zellen (inkl. leerer Felder): {len(all_cells):,}")
    print("Glätte Nachbarn, bilde Usergebiete, setze Aktivitätszentren…")
    records, user_stats, centers = assemble_cell_records(acc, users, all_cells, cfg)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_json_sidecars(out_dir, records, user_stats, cfg, today, centers)
    write_pmtiles(out_dir / "berlin.pmtiles", records, cfg)
    print("Fertig.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OSM Land Gain Pipeline (Geofabrik-PBF, kein Overpass)")
    parser.add_argument("--pbf", type=Path, help="Lokaler berlin-latest.osm.pbf")
    parser.add_argument("--download", action="store_true", help="PBF von BBBike laden")
    parser.add_argument("--tiles-only", action="store_true", help="Nur PMTiles aus vorhandenem cells.json neu bauen")
    parser.add_argument(
        "--repack-cells",
        action="store_true",
        help="cells.json ins kompakte Filter-Array-Format umschreiben (ohne PBF)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "web" / "public" / "data",
        help="Ausgabeverzeichnis",
    )
    args = parser.parse_args(argv)
    cfg = Config()
    if args.repack_cells:
        cells_path = args.out / "cells.json"
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
        cells_path = args.out / "cells.json"
        if not cells_path.exists():
            print(f"cells.json nicht gefunden: {cells_path}", file=sys.stderr)
            return 1
        names = _user_names(args.out / "users.json")
        payload = json.loads(cells_path.read_text(encoding="utf-8"))
        recolor_packed_cells(payload["cells"], cfg.palette_size, names)
        cells_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        print("Userfarben aus Usernamen neu gesetzt.")
        records = records_from_cells_json(cells_path)
        write_pmtiles(args.out / "berlin.pmtiles", records, cfg)
        return 0
    cache = ROOT / "pipeline" / "_cache" / "berlin-latest.osm.pbf"
    pbf = args.pbf
    if args.download or pbf is None:
        pbf = download_pbf(cfg.pbf_url, pbf or cache)
    if not pbf.exists():
        print(f"PBF nicht gefunden: {pbf}", file=sys.stderr)
        return 1
    run(pbf, args.out, cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
