"""Compact front-segment sidecars matching web/src/fronts.ts."""

from __future__ import annotations

import math
from collections import defaultdict

import h3

from .config import FILTERS
from .territories import FilterCell


def _user_name(users: dict, uid: int) -> str | None:
    rec = users.get(uid)
    if rec is None:
        rec = users.get(str(uid))
    if not rec:
        return None
    name = rec.get("name")
    if not name or str(name).startswith("#"):
        return None
    return str(name)


def _cell_owner(row: dict | None, users: dict) -> tuple[str, int] | None:
    if not row:
        return None
    uid = int(row.get("w") or 0)
    if not uid or int(row.get("sp") or 0) == 1:
        return None
    name = _user_name(users, uid)
    if not name:
        return None
    return name, uid


def _neighbors(cell: str) -> list[str]:
    try:
        return list(h3.grid_disk(cell, 1))
    except Exception:
        return []


def _owners_for_filter(
    records: dict[str, FilterCell],
    users: dict,
    filt: str,
) -> dict[str, str]:
    out: dict[str, str] = {}
    for cell, rec in records.items():
        hit = _cell_owner(rec.get(filt), users)
        if hit:
            out[cell] = hit[0]
    return out


def _clamp_depth(n: int) -> int:
    if n <= 1:
        return 1
    if n == 2:
        return 2
    return 3


def _new_land_component(
    start: str,
    user: str,
    cur_owner: dict[str, str],
    previous: dict[str, str],
) -> list[str]:
    cells: list[str] = []
    seen = {start}
    stack = [start]
    while stack:
        cell = stack.pop()
        cells.append(cell)
        for n in _neighbors(cell):
            if n in seen or n == cell:
                continue
            if cur_owner.get(n) != user:
                continue
            if previous.get(n) == user:
                continue
            seen.add(n)
            stack.append(n)
    return cells


def _island_extent(cells: list[str]) -> int:
    if len(cells) <= 2:
        return 1
    origin = cells[0]
    min_i = min_j = math.inf
    max_i = max_j = -math.inf
    ok = 0
    for cell in cells:
        try:
            i, j = h3.cell_to_local_ij(origin, cell)
        except Exception:
            continue
        min_i = min(min_i, i)
        max_i = max(max_i, i)
        min_j = min(min_j, j)
        max_j = max(max_j, j)
        ok += 1
    if ok < 2:
        return 2 if len(cells) <= 6 else 3
    return _clamp_depth(int(min(max_i - min_i + 1, max_j - min_j + 1)))


def _advance_depth(
    start: str,
    user: str,
    cur_owner: dict[str, str],
    previous: dict[str, str],
    cache: dict[str, int],
) -> int:
    hit = cache.get(start)
    if hit:
        return hit
    dist = {start: 1}
    queue = [start]
    found = 0
    i = 0
    while i < len(queue) and not found:
        cell = queue[i]
        i += 1
        d = dist[cell]
        for n in _neighbors(cell):
            if n == cell:
                continue
            if previous.get(n) == user:
                found = d
                break
            if cur_owner.get(n) == user and previous.get(n) != user and n not in dist and d < 3:
                dist[n] = d + 1
                queue.append(n)
    if found:
        depth = _clamp_depth(found)
        cache[start] = depth
        return depth
    island = _new_land_component(start, user, cur_owner, previous)
    depth = _island_extent(island)
    for cell in island:
        cache[cell] = depth
    return depth


def _lost_outward_depth(cur_owner: dict[str, str], previous: dict[str, str]) -> dict[str, int]:
    dist: dict[str, int] = {}
    queue: list[str] = []
    for cell, user in cur_owner.items():
        for n in _neighbors(cell):
            if n == cell or n in dist:
                continue
            if cur_owner.get(n) == user:
                continue
            if previous.get(n) != user:
                continue
            dist[n] = 1
            queue.append(n)
    i = 0
    while i < len(queue):
        cell = queue[i]
        i += 1
        d = dist[cell]
        if d >= 3:
            continue
        user = previous.get(cell)
        if not user:
            continue
        for n in _neighbors(cell):
            if n == cell or n in dist:
                continue
            if previous.get(n) != user:
                continue
            if cur_owner.get(n) == user:
                continue
            dist[n] = d + 1
            queue.append(n)
    outward: dict[str, int] = {}
    by_dist: list[list[str]] = [[], [], [], []]
    for cell, d in dist.items():
        cap = min(3, d)
        by_dist[cap].append(cell)
        outward[cell] = cap
    for d in (3, 2, 1):
        for cell in by_dist[d]:
            best = outward.get(cell, d)
            for n in _neighbors(cell):
                nd = dist.get(n)
                if nd is None or nd <= d:
                    continue
                best = max(best, outward.get(n, nd))
            outward[cell] = min(3, best)
    return outward


def _edge_frame(edge: str, origin: str, dest: str) -> list[float] | None:
    """Edge endpoints plus the outward sign: [ax, ay, bx, by, s].

    Tangent, length and the latitude cosine all follow from the endpoints, so
    only the side the teeth point to has to be stored. web/src/fronts.ts
    rebuilds the full frame from these five numbers.
    """
    try:
        boundary = h3.directed_edge_to_boundary(edge)
    except Exception:
        return None
    if not boundary or len(boundary) < 2:
        return None
    a = [float(boundary[0][1]), float(boundary[0][0])]
    b = [float(boundary[1][1]), float(boundary[1][0])]
    try:
        o_lat, o_lng = h3.cell_to_latlng(origin)
        d_lat, d_lng = h3.cell_to_latlng(dest)
    except Exception:
        return None
    mid_lat = (a[1] + b[1]) / 2
    cos = math.cos((mid_lat * math.pi) / 180) or 1e-6
    ex = (b[0] - a[0]) * cos
    ey = b[1] - a[1]
    edge_len = math.hypot(ex, ey)
    if edge_len < 1e-12:
        return None
    tx = ex / edge_len
    ty = ey / edge_len
    vx = (d_lng - o_lng) * cos
    vy = d_lat - o_lat
    sign = 1 if (-ty) * vx + tx * vy >= 0 else -1
    return [
        round(a[0], 7),
        round(a[1], 7),
        round(b[0], 7),
        round(b[1], 7),
        sign,
    ]


def pack_fronts(
    records: dict[str, FilterCell],
    users: dict,
    prev_records: dict[str, FilterCell],
    prev_users: dict,
) -> dict[str, list[list[float]]]:
    """Per filter a list of [uid, depth, ax, ay, bx, by, sign] rows."""
    out: dict[str, list[list[float]]] = defaultdict(list)
    for filt in FILTERS:
        cur_owner: dict[str, str] = {}
        cur_uid: dict[str, int] = {}
        for cell, rec in records.items():
            hit = _cell_owner(rec.get(filt), users)
            if not hit:
                continue
            name, uid = hit
            cur_owner[cell] = name
            cur_uid[cell] = uid
        previous = _owners_for_filter(prev_records, prev_users, filt)
        lost_depth = _lost_outward_depth(cur_owner, previous)
        advance_cache: dict[str, int] = {}
        segments: list[list[float]] = []
        for cell, user in cur_owner.items():
            uid = cur_uid.get(cell)
            if not uid:
                continue
            try:
                edges = h3.origin_to_directed_edges(cell)
            except Exception:
                continue
            prev_cell = previous.get(cell)
            for edge in edges:
                try:
                    dest = h3.get_directed_edge_destination(edge)
                except Exception:
                    continue
                if cur_owner.get(dest) == user:
                    continue
                prev_dest = previous.get(dest)
                if prev_cell == user and prev_dest != user:
                    continue
                if prev_cell != user:
                    depth = _advance_depth(cell, user, cur_owner, previous, advance_cache)
                else:
                    if dest in cur_owner:
                        continue
                    depth = _clamp_depth(lost_depth.get(dest, 1))
                frame = _edge_frame(edge, cell, dest)
                if not frame:
                    continue
                segments.append([uid, depth, *frame])
        out[filt] = segments
    return dict(out)
