"""Neighbor smoothing, majority cleanup, and activity centers."""

from __future__ import annotations

from collections import Counter, defaultdict, deque

import h3

from .config import FILTERS, Config
from .extract import CellAcc, UserIndex
from .weights import user_color_index

FilterCell = dict[str, dict]


def sparse_threshold(cfg: Config, filt: str) -> int:
    sc = cfg.sparse_count
    if isinstance(sc, dict):
        return int(sc.get(filt, sc.get("all", 20)))
    return int(sc)


def _raw_scores(acc: dict[int, list[float]]) -> dict[int, float]:
    return {uid: rec[1] for uid, rec in acc.items()}


def smooth_filter(
    cells_with_data: dict[str, dict[int, list[float]]],
    all_cells: set[str],
    cfg: Config,
) -> tuple[dict[str, dict[int, float]], dict[str, int], dict[str, float]]:
    """Return S' per cell/user, winner uid (0 = none), winner score."""
    raw: dict[str, dict[int, float]] = {
        cell: _raw_scores(acc) for cell, acc in cells_with_data.items()
    }
    user_max: dict[int, float] = defaultdict(float)
    for scores in raw.values():
        for uid, val in scores.items():
            if val > user_max[uid]:
                user_max[uid] = val

    smoothed: dict[str, dict[int, float]] = {}
    for cell in all_cells:
        disk1 = list(h3.grid_disk(cell, 1))
        ring2: list[str] = []
        if cfg.beta:
            try:
                ring2 = list(h3.grid_ring(cell, 2))
            except Exception:
                inner = set(h3.grid_disk(cell, 1))
                ring2 = [c for c in h3.grid_disk(cell, 2) if c not in inner]
        users: set[int] = set(raw.get(cell, {}))
        for n in disk1[1:]:
            users.update(raw.get(n, {}))
        for n in ring2:
            users.update(raw.get(n, {}))
        if not users:
            continue
        cell_scores: dict[int, float] = {}
        for uid in users:
            s0 = raw.get(cell, {}).get(uid, 0.0)
            s1 = sum(raw.get(n, {}).get(uid, 0.0) for n in disk1[1:])
            s2 = sum(raw.get(n, {}).get(uid, 0.0) for n in ring2)
            sp = s0 + cfg.alpha * s1 + cfg.beta * s2
            neighbor_activity = sum(1 for n in disk1[1:] if raw.get(n, {}).get(uid, 0.0) > 0)
            peak = user_max.get(uid, 0.0)
            if neighbor_activity > cfg.core_neighbor_min and peak > 0:
                if s0 > cfg.core_zone1 * peak:
                    sp *= cfg.core_bonus_z1
                elif s0 > cfg.core_zone2 * peak:
                    sp *= cfg.core_bonus_z2
            if sp > 0:
                cell_scores[uid] = sp
        if cell_scores:
            smoothed[cell] = cell_scores

    winners: dict[str, int] = {}
    win_score: dict[str, float] = {}
    for cell, scores in smoothed.items():
        uid, val = max(scores.items(), key=lambda kv: kv[1])
        winners[cell] = uid
        win_score[cell] = val

    _majority_filter(winners, win_score, smoothed, cfg)
    return smoothed, winners, win_score


def _majority_filter(
    winners: dict[str, int],
    win_score: dict[str, float],
    smoothed: dict[str, dict[int, float]],
    cfg: Config,
) -> None:
    for cell, uid in list(winners.items()):
        neigh = [n for n in h3.grid_disk(cell, 1) if n != cell]
        other = [winners[n] for n in neigh if n in winners]
        if len(other) < cfg.majority_neighbor_min:
            continue
        most, cnt = Counter(other).most_common(1)[0]
        if most == uid or cnt < cfg.majority_neighbor_min:
            continue
        own = smoothed.get(cell, {}).get(uid, 0.0)
        rival = smoothed.get(cell, {}).get(most, 0.0)
        if own < rival * cfg.majority_margin or own == 0:
            winners[cell] = most
            win_score[cell] = rival if rival > 0 else own


def connected_territories(winners: dict[str, int]) -> list[list[str]]:
    visited: set[str] = set()
    comps: list[list[str]] = []
    for start, uid in winners.items():
        if not uid or start in visited:
            continue
        stack = deque([start])
        comp: list[str] = []
        while stack:
            cell = stack.pop()
            if cell in visited:
                continue
            if winners.get(cell) != uid:
                continue
            visited.add(cell)
            comp.append(cell)
            for n in h3.grid_disk(cell, 1):
                if n not in visited and winners.get(n) == uid:
                    stack.append(n)
        if comp:
            comps.append(comp)
    return comps


def activity_centers(
    smoothed: dict[str, dict[int, float]],
    cfg: Config,
) -> list[dict]:
    """One activity center per user above the peak threshold (may lie in another user's territory)."""
    user_peak: dict[int, float] = defaultdict(float)
    user_sum: dict[int, float] = defaultdict(float)
    user_argmax: dict[int, str] = {}
    for cell, scores in smoothed.items():
        for uid, val in scores.items():
            user_sum[uid] += val
            if val > user_peak[uid]:
                user_peak[uid] = val
                user_argmax[uid] = cell

    max_peak = max(user_peak.values()) if user_peak else 0.0
    threshold = max(cfg.center_min_peak, cfg.center_peak_frac * max_peak)

    ranked = sorted(user_sum.items(), key=lambda kv: kv[1], reverse=True)
    centers: list[dict] = []
    rank = 0
    for uid, total in ranked:
        peak = user_peak.get(uid, 0.0)
        cell = user_argmax.get(uid)
        if not cell or peak < threshold:
            continue
        rank += 1
        if rank <= cfg.crown_ornate_n:
            tier = 2
        elif rank <= cfg.crown_plain_n:
            tier = 1
        else:
            tier = 0
        centers.append(
            {
                "uid": int(uid),
                "h3": cell,
                "peak": round(peak, 3),
                "total": round(total, 3),
                "rank": rank,
                "tier": tier,
            }
        )
    return centers


def assemble_cell_records(
    acc: CellAcc,
    users: UserIndex,
    all_cells: set[str],
    cfg: Config,
) -> tuple[dict[str, FilterCell], dict[int, dict], dict[str, list[dict]]]:
    """Per-filter territories, user stats, and activity centers."""
    records: dict[str, FilterCell] = {cell: {} for cell in all_cells}
    centers_out: dict[str, list[dict]] = {f: [] for f in FILTERS}
    user_stats: dict[int, dict] = {
        uid: {
            "name": users.names[uid],
            "scores": {f: 0.0 for f in FILTERS},
            "last_ts": 0,
            "specialties": {f: 0.0 for f in FILTERS if f != "all"},
        }
        for uid in range(1, len(users.names))
    }

    for filt in FILTERS:
        print(f"  Filter {filt}…", flush=True)
        data = {cell: acc[cell][filt] for cell in acc if filt in acc[cell]}
        smoothed, winners, win_score = smooth_filter(data, all_cells, cfg)
        centers = activity_centers(smoothed, cfg)

        pending: dict[str, dict] = {}
        limit = sparse_threshold(cfg, filt)
        for cell in all_cells:
            raw = data.get(cell, {})
            count = int(sum(v[0] for v in raw.values()))
            weight_sum = float(sum(v[1] for v in raw.values()))
            age_sum = float(sum((v[3] if len(v) > 3 else 0.0) for v in raw.values()))
            currentness = (weight_sum / count) if count else 0.0
            mean_age = int(round(age_sum / count)) if count else 0
            sparse = count <= limit
            uid = 0 if sparse else winners.get(cell, 0)
            score = 0.0 if sparse else win_score.get(cell, 0.0)
            ranked = sorted(raw.items(), key=lambda kv: kv[1][1], reverse=True)[: cfg.top_users_per_cell]
            top = [
                [int(u), round(vals[1], 3), int(vals[2])]
                for u, vals in ranked
            ]
            name = users.names[uid] if uid and uid < len(users.names) else ""
            pending[cell] = {
                "w": uid,
                "s": round(score, 3),
                "c": round(currentness, 4),
                "n": count,
                "f": mean_age,
                "k": 0,
                "sp": int(sparse),
                "ci": user_color_index(name, cfg.palette_size) if uid else 0,
                "u": top,
            }

        for cell, rec in pending.items():
            records[cell][filt] = rec

        for c in centers:
            rec = records.get(c["h3"], {}).get(filt)
            c["own"] = int(bool(rec) and rec["w"] == c["uid"])
        centers_out[filt] = centers

        for cell, raw in data.items():
            for uid, vals in raw.items():
                st = user_stats[uid]
                st["scores"][filt] += vals[1]
                if vals[2] > st["last_ts"]:
                    st["last_ts"] = int(vals[2])
                if filt != "all":
                    st["specialties"][filt] += vals[1]

    for st in user_stats.values():
        spec_sum = sum(st["specialties"].values())
        if spec_sum > 0:
            st["specialties"] = {
                k: round(v / spec_sum, 4) for k, v in st["specialties"].items()
            }
        st["scores"] = {k: round(v, 3) for k, v in st["scores"].items()}

    return records, user_stats, centers_out


