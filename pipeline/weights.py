"""Age weights and user-color hashing (shared with the web palette)."""

from __future__ import annotations

from datetime import date, datetime, timezone


def age_weight(timestamp: datetime, today: date | None = None) -> float:
    if timestamp.tzinfo is not None:
        timestamp = timestamp.astimezone(timezone.utc).replace(tzinfo=None)
    day = today or date.today()
    age_years = (day - timestamp.date()).days / 365.25
    if age_years < 1:
        return 1.0
    if age_years < 2:
        return 0.8
    if age_years < 3:
        return 0.5
    if age_years < 4:
        return 0.2
    if age_years < 5:
        return 0.1
    return 0.05


def user_color_index(name: str, palette_size: int = 128) -> int:
    """Stable palette index so the same mapper keeps the same meeple color."""
    h = 2166136261
    for ch in name:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h % palette_size
