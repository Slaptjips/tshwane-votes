"""Extract Tshwane-only source tables from a local checkout of gavacharles/lge2026-ward-forecast.

That repository holds IEC voting-district (VD) results (LGE 2011-2021, NPE 2014-2024) already
parsed from the IEC's downloadable results CSVs, the 2026 ward -> VD delimitation scraped from the
IEC results portal, and the MDB 2026 ward boundaries. We keep only the Tshwane rows so this repo is
self-contained. `fetch_sources.py` re-derives the same tables from the IEC/MDB directly (run it in
GitHub Actions, where those hosts are reachable).

Usage: python pipeline/bootstrap_sources.py /path/to/lge2026-ward-forecast
"""
import json
import sys
from pathlib import Path

import pandas as pd

from common import MUNI, SOURCE, WARD_PREFIX, norm_name

KEEP = ["lge2016_ward", "lge2016_pr", "lge2021_ward", "lge2021_pr", "npe2024", "npe2019"]
CODE_NAME = {"ANC": "AFRICAN NATIONAL CONGRESS", "DA": "DEMOCRATIC ALLIANCE",
             "EFF": "ECONOMIC FREEDOM FIGHTERS", "ASA": "ACTIONSA", "FFP": "VRYHEIDSFRONT PLUS",
             "MK": "UMKHONTO WESIZWE PARTY", "PA": "PATRIOTIC ALLIANCE", "IFP": "INKATHA FREEDOM PARTY"}


def decode_topo(topo, keep):
    """Minimal TopoJSON -> GeoJSON for Polygon/MultiPolygon geometries."""
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append([round(x * sx + tx, 5), round(y * sy + ty, 5)])
        arcs.append(pts)

    def ring(idx):
        out = []
        for i in idx:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(pts if not out else pts[1:])
        return out

    feats = []
    for g in topo["objects"]["wards"]["geometries"]:
        if not keep(g["properties"]):
            continue
        if g["type"] == "Polygon":
            coords = [ring(r) for r in g["arcs"]]
        else:
            coords = [[ring(r) for r in poly] for poly in g["arcs"]]
        feats.append({"type": "Feature", "properties": g["properties"],
                      "geometry": {"type": g["type"], "coordinates": coords}})
    return {"type": "FeatureCollection", "features": feats}


def main(repo):
    repo = Path(repo)
    interim = repo / "data" / "interim"
    SOURCE.mkdir(parents=True, exist_ok=True)

    m26 = pd.read_csv(interim / "wards2026_vd.csv", dtype=str)
    m26 = m26[m26.muni == MUNI][["ward", "vd"]].sort_values(["ward", "vd"])
    m26.to_csv(SOURCE / "tsh_wards2026_vd.csv", index=False)

    meta = pd.read_parquet(interim / "vd_meta.parquet")
    meta = meta[meta.election.isin(KEEP) & ((meta.muni == MUNI) | meta.vd.isin(m26.vd))]
    meta = meta[["election", "vd", "ward", "registered"]].sort_values(["election", "vd"])
    meta.to_csv(SOURCE / "tsh_vd_meta.csv", index=False)
    keys = meta[["election", "vd"]]

    votes = pd.read_parquet(interim / "vd_votes.parquet").merge(keys, on=["election", "vd"])
    named = votes[votes.party != "OTH"].copy()
    named["party"] = named.party.map(CODE_NAME)
    oth = pd.read_parquet(interim / "vd_other_parties.parquet").merge(keys, on=["election", "vd"])
    oth = oth.rename(columns={"party_name": "party"})
    allv = pd.concat([named[["election", "vd", "party", "votes"]], oth[["election", "vd", "party", "votes"]]])
    allv["party"] = allv.party.map(norm_name)
    allv = allv[allv.votes > 0].groupby(["election", "vd", "party"], as_index=False).votes.sum()
    allv["votes"] = allv.votes.astype(int)
    allv.sort_values(["election", "vd", "votes"], ascending=[True, True, False]).to_csv(
        SOURCE / "tsh_vd_votes.csv", index=False)

    topo = json.load(open(repo / "docs" / "data" / "wards.topo.json"))
    gj = decode_topo(topo, lambda p: p.get("CAT_B") == MUNI)
    for f in gj["features"]:
        p = f["properties"]
        f["properties"] = {"ward": str(p["WardID"]), "no": int(p["WardNo"])}
    json.dump(gj, open(SOURCE / "tsh_wards2026.geojson", "w"), separators=(",", ":"))

    cand = pd.read_csv(repo / "config" / "candidates_2026.csv", dtype=str)
    cand = cand[cand.ward.str.startswith(WARD_PREFIX)]
    cand.to_csv(SOURCE / "tsh_candidates_2026.csv", index=False)

    print("wards", m26.ward.nunique(), "vds", m26.vd.nunique(), "features", len(gj["features"]))
    print(allv.groupby("election").votes.sum())


if __name__ == "__main__":
    main(sys.argv[1])
