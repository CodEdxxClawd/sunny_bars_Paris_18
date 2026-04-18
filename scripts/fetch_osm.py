"""Fetch bars (terrasses) + bâtiments du 18e depuis Overpass et écrit 2 GeoJSON."""
import json
from pathlib import Path
import requests

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# BBox ~18e arr.: south, west, north, east
BBOX_18E = "48.8811,2.3210,48.9022,2.3748"

BARS_QUERY = f"""
[out:json][timeout:90];
(
  node["amenity"~"^(bar|pub|cafe|biergarten|restaurant)$"]({BBOX_18E});
  way["amenity"~"^(bar|pub|cafe|biergarten|restaurant)$"]({BBOX_18E});
);
out center tags;
"""

BUILDINGS_QUERY = f"""
[out:json][timeout:180];
way["building"]({BBOX_18E});
out geom;
"""

STREETS_QUERY = f"""
[out:json][timeout:60];
way["highway"]["name"]({BBOX_18E});
out center tags;
"""


def overpass(query: str) -> dict:
    last_err = None
    for url in OVERPASS_ENDPOINTS:
        try:
            print(f"  → {url}")
            r = requests.post(url, data={"data": query}, timeout=240)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_err = e
            print(f"    échec: {e}")
    raise RuntimeError(f"tous les endpoints Overpass ont échoué: {last_err}")


def bars_to_geojson(data: dict) -> dict:
    features = []
    for el in data["elements"]:
        if el["type"] == "node":
            lon, lat = el["lon"], el["lat"]
        else:
            c = el.get("center")
            if not c:
                continue
            lon, lat = c["lon"], c["lat"]
        tags = el.get("tags", {})
        outdoor = tags.get("outdoor_seating")
        terrace_confirmed = outdoor in ("yes", "limited")
        amenity = tags.get("amenity")
        category = "restaurant" if amenity == "restaurant" else "bar_cafe"
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": f"{el['type']}/{el['id']}",
                "name": tags.get("name", "(sans nom)"),
                "amenity": amenity,
                "category": category,
                "terrace": outdoor,
                "terrace_confirmed": terrace_confirmed,
            },
        })
    n_conf = sum(1 for f in features if f["properties"]["terrace_confirmed"])
    print(f"  {len(features)} lieux ({n_conf} terrasses confirmées)")
    return {"type": "FeatureCollection", "features": features}


def parse_height(tags: dict) -> float | None:
    h = tags.get("height")
    if h:
        try:
            return float(str(h).split()[0].replace(",", "."))
        except ValueError:
            pass
    lvl = tags.get("building:levels")
    if lvl:
        try:
            return float(lvl) * 3.0 + 1.0  # 3m / level + attique
        except ValueError:
            pass
    return None


def buildings_to_geojson(data: dict) -> dict:
    features = []
    heights = []
    for el in data["elements"]:
        if el["type"] != "way" or "geometry" not in el:
            continue
        coords = [[pt["lon"], pt["lat"]] for pt in el["geometry"]]
        if len(coords) < 4 or coords[0] != coords[-1]:
            continue
        tags = el.get("tags", {})
        h = parse_height(tags)
        if h is not None:
            heights.append(h)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [coords]},
            "properties": {
                "id": f"way/{el['id']}",
                "height": h,
            },
        })
    # Fallback: hauteur médiane pour les bâtiments sans info
    median = sorted(heights)[len(heights) // 2] if heights else 18.0
    for f in features:
        if f["properties"]["height"] is None:
            f["properties"]["height"] = median
            f["properties"]["height_fallback"] = True
    print(f"  {len(features)} bâtiments, médiane={median:.1f}m, "
          f"{sum(1 for f in features if f['properties'].get('height_fallback'))} fallbacks")
    return {"type": "FeatureCollection", "features": features}


def streets_to_json(data: dict) -> list[dict]:
    seen = {}
    for el in data["elements"]:
        name = el.get("tags", {}).get("name")
        c = el.get("center")
        if not name or not c or name in seen:
            continue
        seen[name] = {"name": name, "lat": c["lat"], "lon": c["lon"]}
    out = sorted(seen.values(), key=lambda s: s["name"].lower())
    print(f"  {len(out)} rues")
    return out


def main():
    DATA_DIR.mkdir(exist_ok=True)
    print("Fetching bars…")
    bars = bars_to_geojson(overpass(BARS_QUERY))
    (DATA_DIR / "bars_18e.geojson").write_text(json.dumps(bars))
    print("Fetching buildings… (peut prendre 1-2 min)")
    buildings = buildings_to_geojson(overpass(BUILDINGS_QUERY))
    (DATA_DIR / "buildings_18e.geojson").write_text(json.dumps(buildings))
    print("Fetching streets…")
    streets = streets_to_json(overpass(STREETS_QUERY))
    (DATA_DIR / "streets_18e.json").write_text(json.dumps(streets, ensure_ascii=False))


if __name__ == "__main__":
    main()
