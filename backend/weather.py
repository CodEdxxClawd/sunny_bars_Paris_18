"""Open-Meteo weather fetch with hourly lookup and per-date cache."""
from __future__ import annotations
import time
from datetime import datetime, timedelta

import requests

LAT, LON = 48.8927, 2.3479
URL = "https://api.open-meteo.com/v1/forecast"
TTL = 600  # 10 min
CLOUD_THRESHOLD = 60.0

# cache: {date_iso: {"t": epoch, "hours": {hour_iso: {...}}}}
_cache: dict = {}


def _fetch(day: datetime) -> dict:
    date_iso = day.strftime("%Y-%m-%d")
    r = requests.get(URL, params={
        "latitude": LAT, "longitude": LON,
        "hourly": "cloud_cover,precipitation,temperature_2m",
        "timezone": "Europe/Paris",
        "start_date": date_iso,
        "end_date": date_iso,
    }, timeout=8)
    r.raise_for_status()
    h = r.json()["hourly"]
    hours: dict = {}
    for i, t in enumerate(h["time"]):
        hours[t] = {
            "cloud_cover": float(h["cloud_cover"][i] or 0),
            "precipitation": float(h["precipitation"][i] or 0),
            "temperature": float(h["temperature_2m"][i] or 0),
        }
    return hours


def _summarize(raw: dict) -> dict:
    cloud = raw["cloud_cover"]
    precip = raw["precipitation"]
    overcast = cloud >= CLOUD_THRESHOLD
    rain = precip >= 0.2
    if rain:
        warning = f"Pluie ({precip:.1f} mm/h) — terrasse compromise"
    elif overcast:
        warning = f"Ciel couvert ({cloud:.0f}%) — ensoleillement limité"
    else:
        warning = None
    return {
        "cloud_cover": cloud,
        "precipitation": precip,
        "temperature": raw["temperature"],
        "overcast": overcast,
        "rain": rain,
        "warning": warning,
    }


def get_weather(when: datetime | None = None) -> dict | None:
    when = when or datetime.now()
    date_iso = when.strftime("%Y-%m-%d")
    # round to nearest hour for hourly lookup
    hour = when.replace(minute=0, second=0, microsecond=0)
    if when.minute >= 30:
        hour = hour + timedelta(hours=1)
    hour_iso = hour.strftime("%Y-%m-%dT%H:%M")

    entry = _cache.get(date_iso)
    now = time.time()
    if entry is None or now - entry["t"] >= TTL:
        try:
            hours = _fetch(when)
            entry = {"t": now, "hours": hours}
            _cache[date_iso] = entry
        except Exception as e:
            print(f"weather fetch failed: {e}")
            if entry is None:
                return None
            # stale cache ok
    raw = entry["hours"].get(hour_iso)
    if raw is None:
        return None
    return _summarize(raw)
