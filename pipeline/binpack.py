"""Binary snapshot payloads: per-cell top users (client) and scalars (pipeline).

Two gzipped files per snapshot:

- ``cells.bin.gz``   h3 key block, uid table and the per-cell top-user rows.
  The web app fetches this in a worker; nothing here is needed to draw the map.
- ``scalars.bin.gz`` the per-cell scalar columns. Only the pipeline reads it,
  to rebuild tiles or sidecars without going back to the PBF.

Both are struct-of-arrays so a decoder can wrap typed arrays around the buffer
instead of parsing. All integers are little-endian.
"""

from __future__ import annotations

import gzip
import struct
import sys
from array import array
from pathlib import Path

from .config import FILTERS
from .territories import FilterCell

# Typecodes are only portable if the width matches what the JS decoder expects.
_WIDTHS = {"B": 1, "H": 2, "I": 4, "f": 4}
for _code, _width in _WIDTHS.items():
    if array(_code).itemsize != _width:
        raise RuntimeError(f"array('{_code}') ist {array(_code).itemsize} Byte, erwartet {_width}")

CELLS_NAME = "cells.bin.gz"
SCALARS_NAME = "scalars.bin.gz"

CELLS_MAGIC = b"OLGT"
SCALARS_MAGIC = b"OLGS"
VERSION = 1
HEADER_SIZE = 32
DAY_SECONDS = 86400

EMPTY_ROW = {"w": 0, "s": 0, "c": 0, "n": 0, "f": 0, "k": 0, "sp": 1, "ci": 0, "u": []}


def _pad4(buf: bytearray) -> None:
    while len(buf) % 4:
        buf.append(0)


def _tofile(values: array) -> bytes:
    """Little-endian bytes of a typed array."""
    if sys.byteorder != "little":
        values = array(values.typecode, values)
        values.byteswap()
    return values.tobytes()


def _header(magic: bytes, *fields: int) -> bytes:
    padded = list(fields) + [0] * (7 - len(fields))
    return magic + struct.pack("<7I", *padded)


def _read_header(buf: bytes, magic: bytes) -> tuple[int, ...]:
    if len(buf) < HEADER_SIZE or buf[:4] != magic:
        raise ValueError(f"Unerwartete Signatur, erwartet {magic!r}")
    fields = struct.unpack_from("<7I", buf, 4)
    if fields[0] != VERSION:
        raise ValueError(f"Unbekannte Version {fields[0]}")
    return fields


def _view(buf: bytes, offset: int, typecode: str, count: int) -> tuple[array, int]:
    values = array(typecode)
    size = values.itemsize * count
    values.frombytes(buf[offset : offset + size])
    if sys.byteorder != "little":
        values.byteswap()
    return values, offset + size


def _align(offset: int) -> int:
    return offset + (-offset % 4)


def write_cell_binaries(
    out_dir: Path,
    records: dict[str, FilterCell],
    user_stats: dict[int, dict],
) -> None:
    """Write cells.bin.gz and scalars.bin.gz for one snapshot."""
    cells = sorted(records)
    uids = sorted(int(uid) for uid in user_stats)
    uid_index = {uid: i for i, uid in enumerate(uids)}
    n_filters = len(FILTERS)
    slots = len(cells) * n_filters

    row_start = array("I", [0]) * (slots + 1)
    user_idx = array("I")
    score = array("f")
    day = array("H")

    w_col = array("I", [0]) * slots
    s_col = array("f", [0.0]) * slots
    c_col = array("f", [0.0]) * slots
    n_col = array("I", [0]) * slots
    f_col = array("I", [0]) * slots
    sp_col = array("B", [1]) * slots
    ci_col = array("B", [0]) * slots

    written = 0
    for ci, cell in enumerate(cells):
        by_filter = records[cell]
        for fi, filt in enumerate(FILTERS):
            slot = ci * n_filters + fi
            row = by_filter.get(filt) or EMPTY_ROW
            w_col[slot] = int(row.get("w") or 0)
            s_col[slot] = float(row.get("s") or 0.0)
            c_col[slot] = float(row.get("c") or 0.0)
            n_col[slot] = int(row.get("n") or 0)
            f_col[slot] = int(row.get("f") or 0)
            sp_col[slot] = 1 if int(row.get("sp") or 0) else 0
            ci_col[slot] = int(row.get("ci") or 0) & 0xFF
            for entry in row.get("u") or []:
                if not entry:
                    continue
                uid = int(entry[0])
                idx = uid_index.get(uid)
                if idx is None:
                    continue
                user_idx.append(idx)
                score.append(float(entry[1]))
                day.append(min(0xFFFF, int(entry[2]) // DAY_SECONDS))
                written += 1
            row_start[slot + 1] = written

    keys = "\n".join(cells).encode("ascii")

    payload = bytearray()
    payload += _header(
        CELLS_MAGIC,
        VERSION,
        len(cells),
        n_filters,
        len(uids),
        written,
        len(keys),
    )
    payload += keys
    _pad4(payload)
    payload += _tofile(array("I", uids))
    payload += _tofile(row_start)
    payload += _tofile(user_idx)
    payload += _tofile(score)
    payload += _tofile(day)
    _pad4(payload)
    (out_dir / CELLS_NAME).write_bytes(gzip.compress(bytes(payload), 6))

    scalars = bytearray()
    scalars += _header(SCALARS_MAGIC, VERSION, len(cells), n_filters)
    scalars += _tofile(w_col)
    scalars += _tofile(s_col)
    scalars += _tofile(c_col)
    scalars += _tofile(n_col)
    scalars += _tofile(f_col)
    scalars += _tofile(sp_col)
    scalars += _tofile(ci_col)
    _pad4(scalars)
    (out_dir / SCALARS_NAME).write_bytes(gzip.compress(bytes(scalars), 6))


def read_cell_records(snap_dir: Path) -> dict[str, FilterCell] | None:
    """Rebuild full per-cell records from the two binaries, or None if absent."""
    cells_path = snap_dir / CELLS_NAME
    scalars_path = snap_dir / SCALARS_NAME
    if not cells_path.exists() or not scalars_path.exists():
        return None

    buf = gzip.decompress(cells_path.read_bytes())
    _, cell_count, n_filters, user_count, row_count, keys_len, _ = _read_header(buf, CELLS_MAGIC)
    offset = HEADER_SIZE
    keys = buf[offset : offset + keys_len].decode("ascii")
    cells = keys.split("\n") if keys else []
    offset = _align(offset + keys_len)
    uids, offset = _view(buf, offset, "I", user_count)
    row_start, offset = _view(buf, offset, "I", cell_count * n_filters + 1)
    user_idx, offset = _view(buf, offset, "I", row_count)
    score, offset = _view(buf, offset, "f", row_count)
    day, offset = _view(buf, offset, "H", row_count)

    sbuf = gzip.decompress(scalars_path.read_bytes())
    _, s_cells, s_filters, *_ = _read_header(sbuf, SCALARS_MAGIC)
    if s_cells != cell_count or s_filters != n_filters:
        raise ValueError("scalars.bin passt nicht zu cells.bin")
    slots = cell_count * n_filters
    soff = HEADER_SIZE
    w_col, soff = _view(sbuf, soff, "I", slots)
    s_col, soff = _view(sbuf, soff, "f", slots)
    c_col, soff = _view(sbuf, soff, "f", slots)
    n_col, soff = _view(sbuf, soff, "I", slots)
    f_col, soff = _view(sbuf, soff, "I", slots)
    sp_col, soff = _view(sbuf, soff, "B", slots)
    ci_col, soff = _view(sbuf, soff, "B", slots)

    records: dict[str, FilterCell] = {}
    for ci, cell in enumerate(cells):
        by_filter: FilterCell = {}
        for fi, filt in enumerate(FILTERS):
            slot = ci * n_filters + fi
            lo = row_start[slot]
            hi = row_start[slot + 1]
            top = [
                [int(uids[user_idx[i]]), round(float(score[i]), 3), int(day[i]) * DAY_SECONDS]
                for i in range(lo, hi)
            ]
            by_filter[filt] = {
                "w": int(w_col[slot]),
                "s": round(float(s_col[slot]), 3),
                "c": round(float(c_col[slot]), 4),
                "n": int(n_col[slot]),
                "f": int(f_col[slot]),
                "k": 0,
                "sp": int(sp_col[slot]),
                "ci": int(ci_col[slot]),
                "u": top,
            }
        records[cell] = by_filter
    return records
