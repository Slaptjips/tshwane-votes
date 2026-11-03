"""Build docs/data/static.json and docs/data/wards.geojson from data/source.

Past results are re-added inside the 2026 ward boundaries one voting district (VD) at a time, so
2016, 2021 and 2024 results are comparable with the 2026 count ward-for-ward.
"""
import csv
import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from shapely.geometry import shape

from common import GROUPS, MUNI, MUNI_NAME, SITE_DATA, SOURCE, group_of

ELECTIONS = {
    "lge2021_ward": {"label": "2021 local · ward ballot", "short": "2021 ward", "date": "2021-11-01"},
    "lge2021_pr": {"label": "2021 local · PR ballot", "short": "2021 PR", "date": "2021-11-01"},
    "npe2024": {"label": "2024 national ballot", "short": "2024 nat.", "date": "2024-05-29"},
    "lge2016_ward": {"label": "2016 local · ward ballot", "short": "2016 ward", "date": "2016-08-03"},
    "lge2016_pr": {"label": "2016 local · PR ballot", "short": "2016 PR", "date": "2016-08-03"},
}
TOP_N = 8
MAJOR_PLACES = {
    "Mamelodi", "Soshanguve", "Atteridgeville", "Centurion", "Hammanskraal", "Ga-Rankuwa", "Mabopane", "Akasia",
    "Laudium", "Olievenhoutbosch", "Bronkhorstspruit", "Cullinan", "Rayton", "Garsfontein", "Montana", "Sunnyside",
    "Arcadia", "Pretoria North", "Wonderboom", "Eersterust", "Saulsville", "Winterveld", "Temba", "Refilwe",
    "Ekangala", "Zithobeni", "Waterkloof", "Silverton", "Hatfield", "Lotus Gardens", "Irene", "Faerie Glen",
    "Moreleta Park", "Pretoria", "Lyttelton", "Kwaggasrand", "Danville", "Pretoria West", "Sinoville", "Theresapark",
    "Rosslyn", "Nellmapius", "Stinkwater", "Babelegi", "Dilopye", "Kekana Gardens", "Eersterus", "Soshanguve South",
}


def round_geom(g, nd=5):
    def r(c):
        return [round(c[0], nd), round(c[1], nd)] if isinstance(c[0], (int, float)) else [r(x) for x in c]
    return {"type": g["type"], "coordinates": r(g["coordinates"])}


def vec(d):
    return [int(d.get(g, 0)) for g in GROUPS]


def hex_layout(points, fill=1.35, seed_w=0.5):
    """Assign each point to a cell of a pointy-top hex grid (odd rows shifted right), keeping
    geography recognisable while giving every ward the same area."""
    from scipy.optimize import linear_sum_assignment

    p = np.asarray(points, float)
    n = len(p)

    def spread(a):
        z = (a - a.min()) / (a.max() - a.min())
        r = a.argsort().argsort() / (n - 1)
        return seed_w * z + (1 - seed_w) * r

    x, y = spread(p[:, 0]), spread(p[:, 1])
    aspect = (p[:, 0].max() - p[:, 0].min()) / (p[:, 1].max() - p[:, 1].min())
    rows = int(math.ceil(math.sqrt(n * fill / aspect / 0.866)))
    cols = int(math.ceil(n * fill / rows))
    cells = []
    for r in range(rows):
        for c in range(cols):
            cells.append((c, r, (c + 0.5 * (r % 2)) / (cols - 0.5), r / (rows - 1)))
    cells = np.array(cells)
    # y grows northwards in data but rows grow downwards on screen
    pts = np.column_stack([x, 1 - y])
    cost = ((pts[:, None, 0] - cells[None, :, 2]) * (cols - 0.5)) ** 2 + \
           ((pts[:, None, 1] - cells[None, :, 3]) * (rows - 1) * 0.866) ** 2
    ri, ci = linear_sum_assignment(cost)
    out = [None] * n
    for i, j in zip(ri, ci):
        out[i] = [int(cells[j, 0]), int(cells[j, 1])]
    # trim empty leading rows/cols, keeping row parity
    minr = min(o[1] for o in out)
    minr -= minr % 2
    minc = min(o[0] for o in out)
    return [[o[0] - minc, o[1] - minr] for o in out]


def main():
    m26 = pd.read_csv(SOURCE / "tsh_wards2026_vd.csv", dtype=str)
    meta = pd.read_csv(SOURCE / "tsh_vd_meta.csv", dtype={"vd": str, "ward": str})
    votes = pd.read_csv(SOURCE / "tsh_vd_votes.csv", dtype={"vd": str})
    votes["grp"] = votes.party.map(group_of)
    hi = SOURCE / "mdb_tsh_wards2026.geojson"   # MDB direct (fetch_sources.py); else the bootstrap copy
    gj = json.load(open(hi if hi.exists() else SOURCE / "tsh_wards2026.geojson"))
    cand = pd.read_csv(SOURCE / "tsh_candidates_2026.csv", dtype=str)

    wards = sorted(m26.ward.unique())
    widx = {w: i for i, w in enumerate(wards)}
    vd_ward = dict(zip(m26.vd, m26.ward))
    n_vd = m26.groupby("ward").vd.nunique()

    # ---- ward-level history on 2026 boundaries
    hist = {w: {} for w in wards}
    city = {}
    for e in ELECTIONS:
        v = votes[(votes.election == e) & votes.vd.isin(vd_ward)].copy()
        v["ward"] = v.vd.map(vd_ward)
        reg = meta[(meta.election == e) & meta.vd.isin(vd_ward)].copy()
        reg["ward"] = reg.vd.map(vd_ward)
        g = v.groupby(["ward", "grp"]).votes.sum().unstack(fill_value=0)
        r = reg.groupby("ward").registered.sum()
        matched = reg.groupby("ward").vd.nunique()
        top = v.groupby(["ward", "party"]).votes.sum().reset_index()
        for w in wards:
            if w not in g.index:
                continue
            t = top[top.ward == w].sort_values("votes", ascending=False)
            hist[w][e] = {
                "v": vec(g.loc[w].to_dict()),
                "reg": int(r.get(w, 0)),
                "cov": round(float(matched.get(w, 0)) / float(n_vd[w]), 3),
                "top": [[p, int(x)] for p, x in zip(t.party.head(TOP_N), t.votes.head(TOP_N))],
            }
        # city totals use every Tshwane VD of that election (official-boundary totals)
        allv = votes[(votes.election == e) & votes.vd.isin(meta[(meta.election == e)].vd)]
        ct = allv.groupby("grp").votes.sum().to_dict()
        top_city = allv.groupby("party").votes.sum().sort_values(ascending=False)
        city[e] = {
            "v": vec(ct),
            "reg": int(meta[(meta.election == e) & meta.vd.isin(allv.vd.unique())].registered.sum()),
            "all": [[p, group_of(p), int(x)] for p, x in top_city.items() if x > 0],
        }

    # ---- VD baselines for the election-night nowcast
    def vd_vec(e):
        v = votes[(votes.election == e) & votes.vd.isin(vd_ward)]
        return v.groupby(["vd", "grp"]).votes.sum().unstack(fill_value=0).reindex(columns=GROUPS, fill_value=0)

    b21, b24 = vd_vec("lge2021_ward"), vd_vec("npe2024")
    r21 = meta[meta.election == "lge2021_ward"].set_index("vd").registered
    r24 = meta[meta.election == "npe2024"].set_index("vd").registered
    vds = []
    for vd, w in sorted(vd_ward.items(), key=lambda kv: (kv[1], kv[0])):
        vds.append([
            vd, widx[w],
            int(r21.get(vd, 0) or 0), int(r24.get(vd, 0) or 0),
            [int(x) for x in b21.loc[vd].tolist()] if vd in b21.index else None,
            [int(x) for x in b24.loc[vd].tolist()] if vd in b24.index else None,
        ])

    # ---- geometry, centroids, hex layout
    feats = {f["properties"]["ward"]: f for f in gj["features"]}
    cents = []
    for w in wards:
        s = shape(feats[w]["geometry"])
        c = s.representative_point()
        cents.append([c.x, c.y])
    lat0 = math.radians(np.mean([c[1] for c in cents]))
    hexes = hex_layout([[c[0] * math.cos(lat0), c[1]] for c in cents])

    # ---- candidates on the 2026 ward ballot
    cnt = cand.groupby("ward").size()
    ind = cand[cand.party.str.upper().str.startswith("INDEPENDENT")].groupby("ward").size()

    # ---- voting-district polygons, station names, places (from fetch_sources.py when present)
    vd_names, places, ward_places = {}, [], {w: [] for w in wards}
    vdf = SOURCE / "mdb_vds2026_bbox.geojson"
    if vdf.exists():
        vg = json.load(open(vdf))
        feats_vd = []
        for f in vg["features"]:
            pr = f["properties"]
            if pr.get("MunicCode") != MUNI or str(pr.get("VDNumber")) not in vd_ward:
                continue
            vd = str(pr["VDNumber"])
            vd_names[vd] = (pr.get("VotingStat") or "").strip()
            feats_vd.append({"type": "Feature", "properties": {"vd": vd, "w": vd_ward[vd]},
                             "geometry": round_geom(f["geometry"])})
        json.dump({"type": "FeatureCollection", "features": feats_vd}, open(SITE_DATA / "vds.geojson", "w"),
                  separators=(",", ":"))
        print("vds.geojson", len(feats_vd), round((SITE_DATA / "vds.geojson").stat().st_size / 1e3), "KB")
    plf = SOURCE / "osm_places.json"
    if plf.exists():
        from shapely.geometry import Point
        shapes = {w: shape(feats[w]["geometry"]) for w in wards}
        seen = set()
        for pl in json.load(open(plf)):
            pt = Point(pl["lon"], pl["lat"])
            w = next((w for w, sh in shapes.items() if sh.contains(pt)), None)
            if not w or pl["name"].lower() in seen:
                continue
            seen.add(pl["name"].lower())
            major = pl["type"] in ("city", "town") or pl["name"] in MAJOR_PLACES
            rank = {"city": 3, "town": 2}.get(pl["type"], 1 if pl["name"] in MAJOR_PLACES else 0)
            places.append({"name": pl["name"], "lon": pl["lon"], "lat": pl["lat"], "ward": w, "major": major, "r": rank})
            ward_places[w].append((not major, pl["name"]))
        stf = SOURCE / "mdb_stations2026_bbox.geojson"
        if stf.exists():
            sub = {}
            for f in json.load(open(stf))["features"]:
                pr = f["properties"]
                if pr.get("MUNICCODE") != MUNI:
                    continue
                for nm in {pr.get("SUBURB"), pr.get("TOWN")}:
                    nm = " ".join(str(nm or "").split()).title()
                    if len(nm) > 2 and nm.lower() not in seen:
                        sub.setdefault(nm, []).append(str(pr["WARDID"]))
            for nm, ws in sub.items():
                w = max(set(ws), key=ws.count)
                if w in widx:
                    places.append({"name": nm, "ward": w})
        print("places", len(places), "major", sum(1 for p in places if p.get("major")))

    out_wards = []
    for i, w in enumerate(wards):
        s = shape(feats[w]["geometry"])
        out_wards.append({
            "id": w, "no": int(w[-3:]), "nvd": int(n_vd[w]),
            "c": [round(cents[i][0], 4), round(cents[i][1], 4)],
            "km2": round(s.area * (111.32 ** 2) * math.cos(lat0), 1),
            "hex": hexes[i],
            "cands": int(cnt.get(w, 0)), "ind": int(ind.get(w, 0)),
            "places": [n for _, n in sorted(ward_places[w])][:8],
            "h": hist[w],
        })

    polls = []
    with open(SOURCE.parent.parent / "pipeline" / "polls_tshwane.csv") as f:
        for row in csv.DictReader(f):
            shares = {g: float(row[g]) for g in GROUPS if row.get(g) not in (None, "")}
            polls.append({k: row[k] for k in ("pollster", "sponsor", "fieldwork_start", "fieldwork_end",
                                               "published", "source", "note")}
                         | {"n": int(row["sample"]), "s": shares})

    static = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "muni": MUNI_NAME, "groups": GROUPS, "elections": ELECTIONS,
        "electionDay": "2026-11-04", "seats": 214, "wardSeats": 107,
        "wards": out_wards, "city": city, "vds": vds, "polls": polls,
        "vdNames": vd_names, "places": places,
        "sources": [
            {"name": "IEC results (LGE 2016, 2021; NPE 2024), per voting district", "url": "https://results.elections.org.za/"},
            {"name": "IEC 2026 ward → voting district delimitation", "url": "https://results.elections.org.za/home/Downloads/ME-Results"},
            {"name": "Municipal Demarcation Board 2026 ward boundaries", "url": "https://spatialhub-mdb-sa.opendata.arcgis.com/"},
            {"name": "OpenStreetMap place names", "url": "https://www.openstreetmap.org/copyright"},
            {"name": "VD results and 2026 ward-VD list first extracted via gavacharles/lge2026-ward-forecast; checked against IEC/MDB originals", "url": "https://github.com/gavacharles/lge2026-ward-forecast"},
        ],
    }
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    json.dump(static, open(SITE_DATA / "static.json", "w"), separators=(",", ":"))

    for f in gj["features"]:
        f["properties"] = {"id": f["properties"]["ward"], "no": f["properties"]["no"]}
        f["geometry"] = round_geom(f["geometry"])
    json.dump(gj, open(SITE_DATA / "wards.geojson", "w"), separators=(",", ":"))

    # ---- report
    for e in ELECTIONS:
        tot = np.array([sum(hist[w][e]["v"][k] for w in wards if e in hist[w]) for k in range(len(GROUPS))])
        cv = np.array(city[e]["v"])
        print(f"{e:13s} on-2026-wards " + " ".join(f"{g}:{x/tot.sum()*100:5.1f}" for g, x in zip(GROUPS, tot))
              + f" | city {cv.sum():,} valid, reg {city[e]['reg']:,}")
    print("vds", len(vds), "no-2021", sum(v[4] is None for v in vds), "no-2024", sum(v[5] is None for v in vds))
    print("static.json", round((SITE_DATA / 'static.json').stat().st_size / 1e3), "KB")


if __name__ == "__main__":
    main()
