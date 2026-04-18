"""Projection des empreintes de bâtiments en polygones d'ombre selon le soleil."""
from __future__ import annotations
import math
from datetime import datetime

from shapely.affinity import translate
from shapely.geometry import mapping
from shapely.ops import transform, unary_union

from .shadow import SunshineIndex, _to_ll

_cache: dict[tuple[float, float], dict] = {}
EMPTY: dict = {"type": "FeatureCollection", "features": []}
MAX_OFFSET_M = 400.0  # évite les ombres kilométriques à basse élévation


def _project_one(poly, h: float, dx: float, dy: float):
    shifted = translate(poly, xoff=dx, yoff=dy)
    return unary_union([poly, shifted]).convex_hull


def _to_wgs(geom):
    return transform(lambda x, y, z=None: _to_ll.transform(x, y), geom)


def shadows_geojson(index: SunshineIndex, when: datetime) -> dict:
    az, elev = index.sun_position(when)
    if elev <= 1.0:
        return EMPTY
    key = (round(az, 1), round(elev, 1))
    if key in _cache:
        return _cache[key]

    theta = math.radians(az)
    tan_el = math.tan(math.radians(elev))
    # direction *depuis* le soleil → ombre projetée à l'opposé
    ux = -math.sin(theta)
    uy = -math.cos(theta)

    shadows = []
    for b in index.buildings:
        offset = min(b.height / tan_el, MAX_OFFSET_M)
        dx = ux * offset
        dy = uy * offset
        shadows.append(_project_one(b.geom, b.height, dx, dy))

    merged = unary_union(shadows)
    merged_ll = _to_wgs(merged)
    fc = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": mapping(merged_ll)}],
    }
    _cache[key] = fc
    return fc
