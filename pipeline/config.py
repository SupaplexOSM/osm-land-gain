"""Pipeline parameters for OSM Land Gain (Berlin, H3-9)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

FILTERS = ("all", "highway", "building", "landuse", "place", "furniture")

SPARSE_COUNT: dict[str, int] = {
    "all": 20,
    "highway": 12,
    "building": 8,
    "landuse": 8,
    "place": 3,
    "furniture": 4,
}

# Internal filter id "landuse" = landscape (UI: Landschaft).
LANDSCAPE_KEYS = frozenset({"landuse", "natural", "landcover", "water", "waterway"})
LANDSCAPE_LEISURE = frozenset(
    {
        "park",
        "garden",
        "nature_reserve",
        "village_green",
        "common",
        "recreation_ground",
    }
)

# Einrichtungen: betretbare Orte (Läden, Gastronomie, Bildung, Hotels …).
PLACE_ALWAYS_KEYS = frozenset({"shop", "craft", "office", "healthcare"})
PLACE_AMENITY_VALUES = frozenset(
    {
        "restaurant",
        "cafe",
        "fast_food",
        "bar",
        "pub",
        "biergarten",
        "ice_cream",
        "food_court",
        "pharmacy",
        "doctors",
        "dentist",
        "clinic",
        "hospital",
        "veterinary",
        "bank",
        "school",
        "kindergarten",
        "college",
        "university",
        "library",
        "community_centre",
        "social_facility",
        "townhall",
        "courthouse",
        "place_of_worship",
        "theatre",
        "cinema",
        "nightclub",
        "arts_centre",
        "marketplace",
        "post_office",
        "police",
        "fire_station",
        "embassy",
        "fuel",
        "toilets",
        "nursing_home",
        "childcare",
        "conference_centre",
        "events_venue",
        "internet_cafe",
        "casino",
        "studio",
        "music_venue",
    }
)
PLACE_TOURISM_VALUES = frozenset(
    {
        "hotel",
        "guest_house",
        "hostel",
        "motel",
        "apartment",
        "chalet",
        "museum",
        "gallery",
        "zoo",
        "aquarium",
        "theme_park",
        "attraction",
        "camp_site",
        "caravan_site",
    }
)
PLACE_LEISURE_VALUES = frozenset(
    {
        "sports_centre",
        "fitness_centre",
        "swimming_pool",
        "ice_rink",
        "bowling_alley",
        "stadium",
        "water_park",
    }
)

# Stadtmöbel: öffentliche Ausstattung im Freien, nicht als Laden betretbar.
FURNITURE_AMENITY_VALUES = frozenset(
    {
        "bench",
        "waste_basket",
        "waste_disposal",
        "recycling",
        "drinking_water",
        "fountain",
        "shelter",
        "telephone",
        "post_box",
        "atm",
        "vending_machine",
        "clock",
        "bicycle_parking",
        "motorcycle_parking",
        "parking",
        "parking_space",
        "parking_entrance",
        "taxi",
        "bicycle_repair_station",
        "parcel_locker",
        "letter_box",
        "public_bookcase",
        "bbq",
        "grit_bin",
        "charging_station",
    }
)
FURNITURE_HIGHWAY_VALUES = frozenset({"street_lamp", "bus_stop", "platform"})
FURNITURE_MAN_MADE_VALUES = frozenset(
    {"flagpole", "utility_pole", "street_cabinet", "planter", "surveillance"}
)
FURNITURE_EMERGENCY_VALUES = frozenset({"fire_hydrant", "phone", "defibrillator"})
FURNITURE_TOURISM_VALUES = frozenset({"information", "artwork"})
FURNITURE_HISTORIC_VALUES = frozenset(
    {"memorial", "wayside_shrine", "wayside_cross", "plaque"}
)
FURNITURE_LEISURE_VALUES = frozenset({"picnic_table"})


def _is_place(tags: Mapping[str, str]) -> bool:
    keys = set(tags)
    return bool(
        keys & PLACE_ALWAYS_KEYS
        or tags.get("amenity") in PLACE_AMENITY_VALUES
        or tags.get("tourism") in PLACE_TOURISM_VALUES
        or tags.get("leisure") in PLACE_LEISURE_VALUES
    )


def _is_furniture(tags: Mapping[str, str]) -> bool:
    return bool(
        tags.get("amenity") in FURNITURE_AMENITY_VALUES
        or tags.get("highway") in FURNITURE_HIGHWAY_VALUES
        or tags.get("man_made") in FURNITURE_MAN_MADE_VALUES
        or tags.get("emergency") in FURNITURE_EMERGENCY_VALUES
        or tags.get("tourism") in FURNITURE_TOURISM_VALUES
        or tags.get("historic") in FURNITURE_HISTORIC_VALUES
        or tags.get("leisure") in FURNITURE_LEISURE_VALUES
    )


def filters_for_tags(tags: Mapping[str, str]) -> list[str]:
    keys = set(tags)
    out = ["all"]
    if "highway" in keys:
        out.append("highway")
    if "building" in keys:
        out.append("building")
    if keys & LANDSCAPE_KEYS or tags.get("leisure") in LANDSCAPE_LEISURE:
        out.append("landuse")
    if _is_place(tags):
        out.append("place")
    if _is_furniture(tags):
        out.append("furniture")
    return out


AREA_KEYS = (
    "building",
    "landuse",
    "natural",
    "leisure",
    "amenity",
    "shop",
    "water",
    "wetland",
)
FILTER_PREFIX = {
    "all": "a",
    "highway": "h",
    "building": "b",
    "landuse": "l",
    "place": "p",
    "furniture": "f",
}

GEOFABRIK_BERLIN_PBF = (
    "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf"
)
# Public Geofabrik PBFs omit user/uid/changeset (GDPR). BBBike extracts keep last-editor metadata.
BBBIKE_BERLIN_PBF = "https://download.bbbike.org/osm/bbbike/Berlin/Berlin.osm.pbf"
GEOFABRIK_INTERNAL_PBF = (
    "https://osm-internal.download.geofabrik.de/europe/germany/berlin-latest-internal.osm.pbf"
)

# Approx. Berlin / Geofabrik extract extent (used to fill empty H3 cells).
BERLIN_BBOX = (13.008, 52.325, 13.770, 52.687)  # west, south, east, north


@dataclass
class Config:
    h3_res: int = 9
    alpha: float = 0.7
    beta: float = 0.3
    core_zone1: float = 0.75
    core_zone2: float = 0.50
    core_neighbor_min: int = 4
    core_bonus_z1: float = 1.45
    core_bonus_z2: float = 1.22
    sparse_count: Mapping[str, int] = field(default_factory=lambda: dict(SPARSE_COUNT))
    center_min_peak: float = 8.0
    center_peak_frac: float = 0.02
    crown_ornate_n: int = 3
    crown_plain_n: int = 10
    top_users_per_cell: int = 15
    majority_neighbor_min: int = 4
    majority_margin: float = 1.25
    # PMTiles: which zoom levels are encoded. The map may zoom in past
    # max_zoom (overzoom of the last tile level); camera min zoom is in map.ts.
    min_zoom: int = 10
    max_zoom: int = 14
    palette_size: int = 128
    pbf_url: str = BBBIKE_BERLIN_PBF
    bbox: tuple[float, float, float, float] = BERLIN_BBOX
    extra_area_keys: tuple[str, ...] = field(default_factory=lambda: AREA_KEYS)
