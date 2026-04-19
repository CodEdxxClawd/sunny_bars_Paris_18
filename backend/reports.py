"""User reports → GitHub Issues."""
from __future__ import annotations
import base64
import hmac
import json
import os
import re
from datetime import datetime
from typing import Literal

import requests
from fastapi import HTTPException
from pydantic import BaseModel

GEOJSON_PATH = "data/bars_18e.geojson"

GITHUB_API = "https://api.github.com"

REPORT_TYPES = {
    "no_terrace": ("pas de terrasse", "no-terrace"),
    "no_sun_temporary": ("pas de soleil (ponctuel)", "no-sun-temporary"),
    "no_sun_permanent": ("pas de soleil (permanent)", "no-sun-permanent"),
    "has_terrace": ("terrasse bien présente", "has-terrace"),
    "has_sun": ("soleil bien présent", "has-sun"),
}


class ReportRequest(BaseModel):
    bar_id: str
    type: Literal[
        "no_terrace",
        "no_sun_temporary",
        "no_sun_permanent",
        "has_terrace",
        "has_sun",
    ]
    datetime: str


def _cfg():
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPO")
    if not token or not repo:
        raise HTTPException(503, "signalement indisponible (config serveur manquante)")
    return token, repo


def _admin_cfg():
    admin = os.environ.get("ADMIN_TOKEN")
    if not admin:
        raise HTTPException(503, "admin non configuré")
    return admin


def check_admin(token: str):
    expected = _admin_cfg()
    if not hmac.compare_digest(token or "", expected):
        raise HTTPException(401, "token invalide")


def _gh_headers(token: str):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def submit_report(req: ReportRequest, bar, sun_az: float, sun_el: float) -> dict:
    token, repo = _cfg()
    label_human, label_slug = REPORT_TYPES[req.type]
    title = f"[report] {bar.name or '(sans nom)'} — {label_human}"
    maps = f"https://www.google.com/maps?q={bar.lat},{bar.lon}"
    body = (
        f"**bar_id** : `{bar.id}`\n"
        f"**nom** : {bar.name or '(sans nom)'}\n"
        f"**type de rapport** : {label_human}\n"
        f"**coords** : [{bar.lat:.5f}, {bar.lon:.5f}]({maps})\n"
        f"**datetime rapport** : {req.datetime}\n"
        f"**soleil à ce moment** : azimut {sun_az:.1f}°, élévation {sun_el:.1f}°\n"
        f"**catégorie** : {bar.category}\n"
        f"**terrasse OSM confirmée** : {bar.terrace_confirmed}\n"
    )
    payload = {
        "title": title,
        "body": body,
        "labels": ["user-report", label_slug],
    }
    r = requests.post(
        f"{GITHUB_API}/repos/{repo}/issues",
        headers=_gh_headers(token),
        json=payload,
        timeout=10,
    )
    if r.status_code >= 300:
        raise HTTPException(502, f"github: {r.status_code} {r.text[:200]}")
    issue = r.json()
    return {"ok": True, "issue_url": issue["html_url"], "number": issue["number"]}


def list_reports() -> list[dict]:
    token, repo = _cfg()
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/issues",
        headers=_gh_headers(token),
        params={"labels": "user-report", "state": "open", "per_page": 100},
        timeout=10,
    )
    if r.status_code >= 300:
        raise HTTPException(502, f"github: {r.status_code} {r.text[:200]}")
    out = []
    for issue in r.json():
        if "pull_request" in issue:
            continue
        labels = [l["name"] for l in issue.get("labels", [])]
        kind = next((REPORT_TYPES[k][0] for k in REPORT_TYPES if REPORT_TYPES[k][1] in labels), "autre")
        out.append({
            "number": issue["number"],
            "title": issue["title"],
            "body": issue["body"],
            "html_url": issue["html_url"],
            "created_at": issue["created_at"],
            "labels": labels,
            "kind": kind,
        })
    return out


def _get_issue(number: int) -> dict:
    token, repo = _cfg()
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/issues/{number}",
        headers=_gh_headers(token),
        timeout=10,
    )
    if r.status_code >= 300:
        raise HTTPException(502, f"github: {r.status_code} {r.text[:200]}")
    return r.json()


def _extract_bar_id(body: str) -> str | None:
    m = re.search(r"\*\*bar_id\*\*\s*:\s*`([^`]+)`", body or "")
    return m.group(1) if m else None


def apply_report(number: int, actor: str = "") -> dict:
    """Fetches issue, removes feature matching bar_id from the geojson, commits, closes issue."""
    token, repo = _cfg()
    issue = _get_issue(number)
    labels = [l["name"] for l in issue.get("labels", [])]
    if "no-terrace" not in labels:
        raise HTTPException(400, "apply n'est supporté que pour les rapports 'no-terrace'")
    bar_id = _extract_bar_id(issue.get("body", ""))
    if not bar_id:
        raise HTTPException(400, "bar_id introuvable dans le corps de l'issue")

    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/contents/{GEOJSON_PATH}",
        headers=_gh_headers(token),
        timeout=15,
    )
    if r.status_code >= 300:
        raise HTTPException(502, f"github get content: {r.status_code} {r.text[:200]}")
    meta = r.json()
    sha = meta["sha"]
    content = base64.b64decode(meta["content"]).decode("utf-8")
    data = json.loads(content)

    features = data.get("features", [])
    before = len(features)
    data["features"] = [f for f in features if (f.get("id") or f.get("properties", {}).get("id")) != bar_id]
    after = len(data["features"])
    if after == before:
        raise HTTPException(404, f"feature {bar_id} introuvable dans {GEOJSON_PATH}")

    new_content = json.dumps(data, ensure_ascii=True, indent=2) + "\n"
    actor = (actor or "").strip()[:80]
    msg_suffix = f" (by {actor})" if actor else ""
    put = requests.put(
        f"{GITHUB_API}/repos/{repo}/contents/{GEOJSON_PATH}",
        headers=_gh_headers(token),
        json={
            "message": f"remove {bar_id} via report #{number}{msg_suffix}",
            "content": base64.b64encode(new_content.encode("utf-8")).decode("ascii"),
            "sha": sha,
        },
        timeout=20,
    )
    if put.status_code >= 300:
        raise HTTPException(502, f"github put content: {put.status_code} {put.text[:200]}")

    # comment + close
    requests.post(
        f"{GITHUB_API}/repos/{repo}/issues/{number}/comments",
        headers=_gh_headers(token),
        json={"body": f"appliqué via admin dashboard (feature `{bar_id}` retirée){msg_suffix}"},
        timeout=10,
    )
    close = requests.patch(
        f"{GITHUB_API}/repos/{repo}/issues/{number}",
        headers=_gh_headers(token),
        json={"state": "closed"},
        timeout=10,
    )
    if close.status_code >= 300:
        raise HTTPException(502, f"github close: {close.status_code} {close.text[:200]}")
    return {"ok": True, "removed": bar_id}


def close_report(number: int, reason: str = "rejected") -> dict:
    token, repo = _cfg()
    # comment
    requests.post(
        f"{GITHUB_API}/repos/{repo}/issues/{number}/comments",
        headers=_gh_headers(token),
        json={"body": f"fermé via admin dashboard ({reason})"},
        timeout=10,
    )
    r = requests.patch(
        f"{GITHUB_API}/repos/{repo}/issues/{number}",
        headers=_gh_headers(token),
        json={"state": "closed"},
        timeout=10,
    )
    if r.status_code >= 300:
        raise HTTPException(502, f"github: {r.status_code} {r.text[:200]}")
    return {"ok": True}
