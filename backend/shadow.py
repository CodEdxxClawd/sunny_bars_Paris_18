"""Calcul d'ensoleillement par ray-casting contre les bâtiments OSM."""
from __future__ import annotations
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
from pvlib.solarposition import get_solarposition, sun_rise_set_transit_spa
from pyproj import Transformer
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
RAY_LENGTH_M = 250.0  # longueur max de l'ombre projetée qu'on considère
PARIS_TZ = "Europe/Paris"

# WGS84 → Lambert93 (métrique, adapté à la France)
_to_m = Transformer.from_crs("EPSG:4326", "EPSG:2154", always_xy=True)
_to_ll = Transformer.from_crs("EPSG:2154", "EPSG:4326", always_xy=True)


@dataclass
class Bar:
    id: str
    name: str
    lat: float
    lon: float
    x: float  # en EPSG:2154
    y: float
    terrace_confirmed: bool = False
    category: str = "bar_cafe"


@dataclass
class Building:
    geom: object  # polygon EPSG:2154
    height: float


class SunshineIndex:
    def __init__(self, bars_path: Path, buildings_path: Path):
        self.bars: list[Bar] = []
        for f in json.loads(bars_path.read_text())["features"]:
            lon, lat = f["geometry"]["coordinates"]
            x, y = _to_m.transform(lon, lat)
            self.bars.append(Bar(
                id=f["properties"]["id"],
                name=f["properties"]["name"],
                lat=lat, lon=lon, x=x, y=y,
                terrace_confirmed=bool(f["properties"].get("terrace_confirmed", False)),
                category=f["properties"].get("category", "bar_cafe"),
            ))
        self.buildings: list[Building] = []
        for f in json.loads(buildings_path.read_text())["features"]:
            poly = shape(f["geometry"])
            # reproject
            coords = [_to_m.transform(x, y) for x, y in poly.exterior.coords]
            poly_m = shape({"type": "Polygon", "coordinates": [coords]})
            h = float(f["properties"]["height"])
            self.buildings.append(Building(geom=poly_m, height=h))
        self._geoms = [b.geom for b in self.buildings]
        self._tree = STRtree(self._geoms)
        print(f"Loaded {len(self.bars)} bars, {len(self.buildings)} buildings")

    def _bar_by_id(self, bar_id: str) -> Bar | None:
        for b in self.bars:
            if b.id == bar_id:
                return b
        return None

    def sunrise_sunset(self, when: datetime) -> tuple[datetime, datetime] | tuple[None, None]:
        ts = pd.Timestamp(when)
        if ts.tzinfo is None:
            ts = ts.tz_localize(PARIS_TZ)
        # pvlib rounds to noon UTC; pass noon local to avoid day drift
        noon = ts.normalize() + pd.Timedelta(hours=12)
        day = pd.DatetimeIndex([noon])
        r = sun_rise_set_transit_spa(day, 48.8927, 2.3479)
        sr = r["sunrise"].iloc[0]
        ss = r["sunset"].iloc[0]
        if pd.isna(sr) or pd.isna(ss):
            return None, None
        return sr.tz_convert(PARIS_TZ).to_pydatetime(), ss.tz_convert(PARIS_TZ).to_pydatetime()

    def forecast_bar(self, bar_id: str, when: datetime,
                     step_minutes: int = 15, horizon_minutes: int = 240) -> dict | None:
        bar = self._bar_by_id(bar_id)
        if bar is None:
            return None
        ts = pd.Timestamp(when)
        if ts.tzinfo is None:
            ts = ts.tz_localize(PARIS_TZ)
        _, sunset = self.sunrise_sunset(ts.to_pydatetime())
        az0, el0 = self.sun_position(ts.to_pydatetime())
        currently_sunny = self.is_sunny(bar, az0, el0) if el0 > 1.0 else False

        minutes_left = None
        minutes_until = None
        capped = False
        step = timedelta(minutes=step_minutes)
        max_steps = horizon_minutes // step_minutes

        if currently_sunny:
            elapsed = 0
            t = ts
            for _ in range(max_steps):
                t = t + step
                if sunset is not None and t.to_pydatetime() >= sunset:
                    minutes_left = elapsed
                    break
                az, el = self.sun_position(t.to_pydatetime())
                if el <= 1.0 or not self.is_sunny(bar, az, el):
                    minutes_left = elapsed
                    break
                elapsed += step_minutes
            else:
                minutes_left = elapsed
                capped = True
        else:
            elapsed = 0
            t = ts
            for _ in range(max_steps):
                t = t + step
                if sunset is not None and t.to_pydatetime() >= sunset:
                    break
                elapsed += step_minutes
                az, el = self.sun_position(t.to_pydatetime())
                if el > 1.0 and self.is_sunny(bar, az, el):
                    minutes_until = elapsed
                    break
        stable = currently_sunny and (
            capped or (minutes_left is not None and minutes_left >= 45)
        )
        shadow_at = None
        if currently_sunny and minutes_left is not None and not capped:
            shadow_at = (ts + timedelta(minutes=minutes_left)).isoformat()
        sun_at = None
        if not currently_sunny and minutes_until is not None:
            sun_at = (ts + timedelta(minutes=minutes_until)).isoformat()
        return {
            "id": bar.id,
            "name": bar.name,
            "sunny": currently_sunny,
            "minutes_left": minutes_left,
            "minutes_until_sunny": minutes_until,
            "capped": capped,
            "horizon_minutes": horizon_minutes,
            "shadow_at": shadow_at,
            "sun_at": sun_at,
            "stable": stable,
        }

    def sun_position(self, when: datetime) -> tuple[float, float]:
        """Retourne (azimuth_deg, elevation_deg) pour le 18e à `when` (heure locale Paris)."""
        ts = pd.Timestamp(when)
        if ts.tzinfo is None:
            ts = ts.tz_localize(PARIS_TZ)
        # centre approximatif du 18e
        sp = get_solarposition(ts, latitude=48.8927, longitude=2.3479)
        return float(sp["azimuth"].iloc[0]), float(sp["elevation"].iloc[0])

    def is_sunny(self, bar: Bar, azimuth_deg: float, elevation_deg: float) -> bool:
        if elevation_deg <= 1.0:
            return False
        # azimut OSM/astronomique : 0 = Nord, sens horaire
        theta = math.radians(azimuth_deg)
        dx = math.sin(theta) * RAY_LENGTH_M
        dy = math.cos(theta) * RAY_LENGTH_M
        origin = Point(bar.x, bar.y)
        ray = LineString([(bar.x, bar.y), (bar.x + dx, bar.y + dy)])
        tan_elev = math.tan(math.radians(elevation_deg))
        for idx in self._tree.query(ray):
            geom = self._geoms[idx]
            # ignore le bâtiment qui contient directement le point (bar au pied de l'immeuble)
            if geom.contains(origin):
                continue
            inter = geom.intersection(ray)
            if inter.is_empty:
                continue
            d = origin.distance(inter)
            if d < 1.0:
                continue
            b = self.buildings[idx]
            if b.height > d * tan_elev:
                return False
        return True

    def _stability_check(self, bar: Bar, when: datetime,
                         step_minutes: int = 15, threshold_minutes: int = 45) -> tuple[int, bool]:
        """Mini-forecast borné au seuil. Retourne (minutes_left_jusqu'au_seuil, stable)."""
        ts = pd.Timestamp(when)
        if ts.tzinfo is None:
            ts = ts.tz_localize(PARIS_TZ)
        _, sunset = self.sunrise_sunset(ts.to_pydatetime())
        step = timedelta(minutes=step_minutes)
        max_steps = threshold_minutes // step_minutes
        elapsed = 0
        t = ts
        for _ in range(max_steps):
            t = t + step
            if sunset is not None and t.to_pydatetime() >= sunset:
                return elapsed, False
            az, el = self.sun_position(t.to_pydatetime())
            if el <= 1.0 or not self.is_sunny(bar, az, el):
                return elapsed, False
            elapsed += step_minutes
        return elapsed, True

    def compute(self, when: datetime) -> list[dict]:
        az, elev = self.sun_position(when)
        out = []
        for bar in self.bars:
            sunny = self.is_sunny(bar, az, elev) if elev > 1.0 else False
            minutes_left = None
            stable = False
            if sunny:
                minutes_left, stable = self._stability_check(bar, when)
            out.append({
                "id": bar.id,
                "name": bar.name,
                "lat": bar.lat,
                "lon": bar.lon,
                "sunny": sunny,
                "terrace_confirmed": bar.terrace_confirmed,
                "category": bar.category,
                "minutes_left": minutes_left,
                "stable": stable,
            })
        sr, ss = self.sunrise_sunset(when)
        return {
            "azimuth": az,
            "elevation": elev,
            "sunrise": sr.isoformat() if sr else None,
            "sunset": ss.isoformat() if ss else None,
            "bars": out,
        }


def default_index() -> SunshineIndex:
    return SunshineIndex(
        DATA_DIR / "bars_18e.geojson",
        DATA_DIR / "buildings_18e.geojson",
    )
