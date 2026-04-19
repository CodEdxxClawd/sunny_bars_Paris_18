---
title: Sunny Bars Paris 18
emoji: ☀️
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# Sunny Bars — 18e

Trouve les bars dont la terrasse est au soleil à une heure donnée.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/fetch_osm.py           # télécharge bars + bâtiments (18e)
uvicorn backend.main:app --reload
# puis ouvrir http://localhost:8000
```

## Données

- **Bars** : OSM via Overpass, `amenity=bar|pub|cafe` + `outdoor_seating=yes`
- **Bâtiments** : OSM via Overpass, `building=*`, hauteurs via `height` ou `building:levels * 3 m`

## Algo

Pour chaque bar et un datetime donné :
1. Position du soleil (pvlib) → azimut + élévation
2. Ray-cast depuis la terrasse en direction du soleil (200 m)
3. Pour chaque bâtiment intersecté à distance `d` : ombre si `hauteur > d * tan(élévation)`
