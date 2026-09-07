"""Age weights and user-color hashing (shared with the web palette)."""

from __future__ import annotations

from datetime import date, datetime, timezone

_YEAR_DAYS = 365.25
_PLATEAU_YEARS = 0.5


def age_weight_years(age_years: float) -> float:
    """Score for a last-editor age in years. Plateau 6 months, then logistic.

    w(t) = 1                         if t <= 0.5
    w(t) = 17 / (16 + 4^(t - 0.5))   if t > 0.5
    """
    if age_years <= _PLATEAU_YEARS:
        return 1.0
    return 17.0 / (16.0 + 4.0 ** (age_years - _PLATEAU_YEARS))


def age_weight(timestamp: datetime, today: date | None = None) -> float:
    if timestamp.tzinfo is not None:
        timestamp = timestamp.astimezone(timezone.utc).replace(tzinfo=None)
    day = today or date.today()
    age_years = (day - timestamp.date()).days / _YEAR_DAYS
    return age_weight_years(age_years)


def user_color_index(name: str, palette_size: int = 128) -> int:
    """Stable palette index so the same mapper keeps the same meeple color."""
    h = 2166136261
    for ch in name:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h % palette_size
