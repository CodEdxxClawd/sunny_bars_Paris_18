from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .shadow import default_index
from .shadows import shadows_geojson
from .weather import get_weather

app = FastAPI(title="Sunny Bars 18e")
_index = default_index()

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DATA = ROOT / "data"


@app.get("/sunshine")
def sunshine(datetime_iso: str = Query(..., alias="datetime")):
    when = datetime.fromisoformat(datetime_iso)
    result = _index.compute(when)
    result["weather"] = get_weather(when)
    return result


@app.get("/forecast")
def forecast(bar_id: str = Query(..., alias="id"),
             datetime_iso: str = Query(..., alias="datetime")):
    when = datetime.fromisoformat(datetime_iso)
    out = _index.forecast_bar(bar_id, when)
    if out is None:
        raise HTTPException(404, f"unknown bar {bar_id}")
    return out


@app.get("/shadows")
def shadows(datetime_iso: str = Query(..., alias="datetime")):
    when = datetime.fromisoformat(datetime_iso)
    return shadows_geojson(_index, when)


@app.get("/")
def root():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
app.mount("/data", StaticFiles(directory=DATA), name="data")
