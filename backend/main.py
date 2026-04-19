from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .shadow import default_index
from .shadows import shadows_geojson
from .weather import get_weather
from .reports import (
    ReportRequest,
    submit_report,
    list_reports,
    close_report,
    apply_report,
    check_admin,
)

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


@app.post("/report")
def report(req: ReportRequest):
    bar = _index._bar_by_id(req.bar_id)
    if bar is None:
        raise HTTPException(400, f"unknown bar {req.bar_id}")
    try:
        when = datetime.fromisoformat(req.datetime)
    except ValueError:
        raise HTTPException(400, "datetime invalide")
    az, el = _index.sun_position(when)
    return submit_report(req, bar, az, el)


@app.get("/admin")
def admin_page(token: str = Query(...)):
    check_admin(token)
    return FileResponse(FRONTEND / "admin.html")


@app.get("/api/reports")
def api_reports(token: str = Query(...)):
    check_admin(token)
    return list_reports()


@app.post("/api/reports/{number}/close")
def api_close_report(number: int, token: str = Query(...), reason: str = "rejected"):
    check_admin(token)
    return close_report(number, reason)


@app.post("/api/reports/{number}/apply")
def api_apply_report(number: int, token: str = Query(...), actor: str = ""):
    check_admin(token)
    return apply_report(number, actor)


@app.get("/")
def root():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
app.mount("/data", StaticFiles(directory=DATA), name="data")
