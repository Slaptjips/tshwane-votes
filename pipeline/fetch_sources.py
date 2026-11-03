"""Fetch primary sources (IEC, MDB, OpenStreetMap) for Tshwane. Run where those hosts are reachable
(GitHub Actions: .github/workflows/fetch-sources.yml). Each step is independent; a failure is
recorded in data/probe/report.json and does not stop the others.

Outputs
  data/source/mdb_tsh_wards2026.geojson   MDB 2026 ward boundaries, Tshwane, light generalisation
  data/source/iec_lge2021_tsh.csv         IEC LGE 2021 per-VD party results, Tshwane rows only
  data/source/iec_lge2016_tsh.csv         IEC LGE 2016 per-VD party results, Tshwane rows only
  data/source/osm_places.json             suburb / township names with coordinates (map labels, search)
  data/probe/*                            what the IEC 2026 results endpoint returns right now
"""
import csv
import io
import json
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import EVENT_LGE2016, EVENT_LGE2021, EVENT_LGE2026, ROOT, SOURCE  # noqa: E402
import live  # noqa: E402

PROBE = ROOT / "data" / "probe"
UA = {"User-Agent": "Mozilla/5.0 (compatible; tshwane-election-map/1.0; +https://github.com/Slaptjips/sandput)"}
MDB = "https://services7.arcgis.com/oeoyTUJC8HEeYsRB/arcgis/rest/services"
IEC = "https://results.elections.org.za/home/LGEPublicReports/{ev}/Downloadable%20Party%20Results/GP.csv"
report = {}


def get(url, params=None, timeout=300, data=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), dict(r.headers), r.status


def step(fn):
    def run():
        try:
            report[fn.__name__] = {"ok": True, **(fn() or {})}
        except Exception as e:  # noqa: BLE001
            report[fn.__name__] = {"ok": False, "error": repr(e), "trace": traceback.format_exc()[-1500:]}
        print(fn.__name__, json.dumps(report[fn.__name__])[:400], flush=True)
    run.__name__ = fn.__name__
    return run


@step
def mdb_wards():
    feats, start = [], 0
    while True:
        raw, _, _ = get(f"{MDB}/MDB_Wards_2026/FeatureServer/0/query", {
            "where": "CAT_B='TSH'", "outFields": "WardID,WardNo,CAT_B", "outSR": 4326,
            "maxAllowableOffset": 0.00008, "geometryPrecision": 5, "resultOffset": start,
            "resultRecordCount": 200, "f": "geojson"})
        page = json.loads(raw)["features"]
        feats += page
        if len(page) < 200:
            break
        start += 200
    for f in feats:
        p = f["properties"]
        f["properties"] = {"ward": str(p["WardID"]), "no": int(p["WardNo"])}
    out = SOURCE / "mdb_tsh_wards2026.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    return {"features": len(feats), "bytes": out.stat().st_size}


@step
def mdb_services():
    raw, _, _ = get(MDB, {"f": "json"})
    services = [s["name"] for s in json.loads(raw).get("services", [])]
    (PROBE / "mdb_services.json").write_text(json.dumps(services, indent=1))
    return {"count": len(services), "vd_like": [s for s in services if "vot" in s.lower() or "vd" in s.lower()]}


def iec_tsh(ev, name):
    raw, hdr, _ = get(IEC.format(ev=ev), timeout=900)
    text = live.decode(raw)
    rdr = csv.reader(io.StringIO(text))
    header = next(rdr)
    cols = live.resolve_columns(header)
    mi = header.index(cols["muni"])
    out = SOURCE / name
    n = 0
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        for row in rdr:
            if len(row) > mi and row[mi].strip().upper().startswith("TSH"):
                w.writerow(row)
                n += 1
    vds, names, rows = live.parse(out.read_text(encoding="utf-8"))
    built = live.build(vds, names, "test")
    tot = sum(built["city"]["ward"]) or 1
    return {"bytes_total": len(raw), "header": header, "tsh_rows": n, "vds": len(vds),
            "ward_shares": {g: round(v / tot * 100, 2) for g, v in zip(built["groups"], built["city"]["ward"])},
            "last_modified": hdr.get("Last-Modified")}


@step
def iec_2021():
    return iec_tsh(EVENT_LGE2021, "iec_lge2021_tsh.csv")


@step
def iec_2016():
    return iec_tsh(EVENT_LGE2016, "iec_lge2016_tsh.csv")


@step
def iec_2026_probe():
    url = IEC.format(ev=EVENT_LGE2026)
    try:
        raw, hdr, status = get(url, timeout=600)
    except urllib.error.HTTPError as e:
        (PROBE / "iec2026.txt").write_text(f"HTTP {e.code}\n{dict(e.headers)}\n{e.read()[:3000]!r}")
        return {"status": e.code}
    text = live.decode(raw)
    (PROBE / "iec2026_head.csv").write_text("\n".join(text.splitlines()[:40]))
    info = {"status": status, "bytes": len(raw), "headers": hdr}
    try:
        vds, names, rows = live.parse(text)
        info.update({"tsh_rows": rows, "tsh_vds": len(vds)})
        mapping = sorted({(r["w"], vd) for vd, r in vds.items()})
        with open(PROBE / "iec2026_tsh_ward_vd.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["ward", "vd"])
            w.writerows(mapping)
    except Exception as e:  # noqa: BLE001
        info["parse_error"] = repr(e)
    return info


@step
def osm_places():
    q = """[out:json][timeout:120];
    area["name"="City of Tshwane Metropolitan Municipality"]["boundary"="administrative"]->.a;
    (node["place"~"^(city|town|suburb|township|village|quarter|neighbourhood)$"](area.a););
    out body;"""
    body = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for ep in ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
               "https://overpass.private.coffee/api/interpreter"):
        try:
            req = urllib.request.Request(ep, data=body, headers={
                **UA, "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"})
            with urllib.request.urlopen(req, timeout=180) as r:
                els = json.loads(r.read())["elements"]
            break
        except Exception as e:  # noqa: BLE001
            last = e
    else:
        raise last
    places = [{"name": e["tags"].get("name"), "type": e["tags"].get("place"), "lon": round(e["lon"], 5),
               "lat": round(e["lat"], 5), "pop": e["tags"].get("population")} for e in els if e["tags"].get("name")]
    (SOURCE / "osm_places.json").write_text(json.dumps(places, separators=(",", ":"), ensure_ascii=False))
    return {"places": len(places)}


TSH_BBOX = "27.85,-26.10,29.10,-25.10"   # generous lon/lat envelope around Tshwane


def arcgis_bbox(service, name, where="1=1", offset=0.00004):
    """All features of an MDB layer intersecting the Tshwane envelope (paged), raw properties kept."""
    base = f"{MDB}/{service}/FeatureServer/0"
    raw, _, _ = get(base, {"f": "json"})
    layer = json.loads(raw)
    (PROBE / f"{service}_fields.json").write_text(json.dumps(
        [(f["name"], f["type"]) for f in layer.get("fields", [])], indent=0))
    feats, start = [], 0
    while True:
        raw, _, _ = get(f"{base}/query", {
            "where": where, "geometry": TSH_BBOX, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "outSR": 4326,
            "maxAllowableOffset": offset, "geometryPrecision": 5, "resultOffset": start,
            "resultRecordCount": 1000, "f": "geojson"})
        page = json.loads(raw).get("features", [])
        feats += page
        if len(page) < 1000:
            break
        start += 1000
    out = SOURCE / name
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    return {"features": len(feats), "bytes": out.stat().st_size,
            "sample_props": feats[0]["properties"] if feats else None}


@step
def mdb_vds():
    return arcgis_bbox("VotingDistricts2026_Final", "mdb_vds2026_bbox.geojson")


@step
def mdb_stations():
    return arcgis_bbox("VotingStations_March2026", "mdb_stations2026_bbox.geojson")


STEPS = {f.__name__: f for f in (mdb_wards, mdb_services, mdb_vds, mdb_stations, osm_places, iec_2026_probe,
                                  iec_2021, iec_2016)}


def main():
    import os
    PROBE.mkdir(parents=True, exist_ok=True)
    SOURCE.mkdir(parents=True, exist_ok=True)
    rp = PROBE / "report.json"
    if rp.exists():
        report.update(json.loads(rp.read_text()))
    wanted = [w for w in os.environ.get("STEPS", "").split(",") if w] or list(STEPS)
    for name in wanted:
        STEPS[name]()
    rp.write_text(json.dumps(report, indent=1, default=str))


if __name__ == "__main__":
    main()
