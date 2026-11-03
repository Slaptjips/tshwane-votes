"""Election-night ingest: IEC LGE 2026 results -> docs/data/live.json (+ live-history.json).

Standard library only, so the GitHub Actions job starts in seconds.

The IEC publishes per-voting-district party results as one CSV per province under
  https://results.elections.org.za/home/LGEPublicReports/<event>/Downloadable%20Party%20Results/GP.csv
(event 1887 = LGE 2026, 1091 = LGE 2021). We keep the Tshwane rows, group parties, and aggregate by
ward and ballot. A voting district counts as "reported" once it has any valid votes on that ballot.

Usage:
  python pipeline/live.py                      # fetch the live 2026 file
  python pipeline/live.py --src path/or/url    # any IEC-format CSV (e.g. the 2021 file, for testing)
  python pipeline/live.py --src X --out /tmp/x.json --no-history
Never overwrites good data with a failed or empty fetch: it records the error and keeps the old file.
"""
import argparse
import csv
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import EVENT_LGE2026, GROUPS, MUNI, SITE_DATA, group_of  # noqa: E402

DEFAULT_SRC = ("https://results.elections.org.za/home/LGEPublicReports/{ev}/"
               "Downloadable%20Party%20Results/GP.csv").format(ev=EVENT_LGE2026)
UA = "Mozilla/5.0 (compatible; tshwane-election-map/1.0; +https://github.com/Slaptjips/sandput)"
TOP_N = 10
HISTORY_MAX = 600


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch(src, tries=4):
    if not re.match(r"^https?://", src):
        return Path(src).read_bytes()
    err = None
    for i in range(tries):
        try:
            req = urllib.request.Request(src, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            err = e
        except Exception as e:  # noqa: BLE001 - network hiccups: retry
            err = e
        time.sleep(2 ** (i + 1))
    raise err


def decode(raw):
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def key(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


COLS = {  # normalised header -> field, first match wins
    "ballot": ["ballottype", "ballot"],
    "muni": ["municipality", "municipalityname", "muni"],
    "ward": ["ward", "wardid", "wardno", "wardnumber"],
    "vd": ["votingdistrict", "vdnumber", "vd", "votingdistrictnumber"],
    "party": ["partyname", "spartyname", "party", "spartname", "partyabbreviation"],
    "votes": ["totalvalidvotes", "partyvotes", "votes", "validvotes"],
    "reg": ["registeredvoters", "registeredpopulation", "registered"],
    "spoilt": ["spoiltvotes", "spoilt"],
    "cast": ["totalvotescast", "votescast"],
}


def resolve_columns(header):
    norm = {key(h): h for h in header}
    out = {}
    for field, cands in COLS.items():
        for c in cands:
            if c in norm:
                out[field] = norm[c]
                break
    missing = [f for f in ("muni", "vd", "party", "votes") if f not in out]
    if missing:
        raise ValueError(f"IEC file has unexpected columns {header[:20]}; missing {missing}")
    return out


def num(x):
    try:
        return int(float(str(x).replace(",", "").strip() or 0))
    except ValueError:
        return 0


def parse(text, ward_of_vd=None):
    rdr = csv.DictReader(io.StringIO(text))
    cols = resolve_columns(rdr.fieldnames or [])
    G = {g: i for i, g in enumerate(GROUPS)}
    vds = {}          # vd -> {"w": ward, "reg": int, "ward": [..], "pr": [..], "spoilt": {...}}
    names = {}        # ward -> party name -> votes (ward ballot)
    rows = 0
    for r in rdr:
        muni = str(r.get(cols["muni"], ""))
        if not muni.strip().upper().startswith(MUNI):
            continue
        rows += 1
        ballot = str(r.get(cols.get("ballot", ""), "Ward") or "Ward").strip().lower()
        b = "ward" if ballot.startswith("ward") else ("pr" if ballot.startswith("pr") else None)
        if b is None:
            continue  # district-council ballots do not exist in metros, ignore anything else
        vd = re.sub(r"\D", "", str(r[cols["vd"]]))
        ward = re.sub(r"\D", "", str(r.get(cols.get("ward", ""), "") or "")) or (ward_of_vd or {}).get(vd, "")
        if len(ward) < 8 and ward.isdigit():  # "Ward 12" -> 79900012
            ward = f"799{int(ward):05d}"
        rec = vds.setdefault(vd, {"w": ward, "reg": 0, "ward": [0] * len(GROUPS), "pr": [0] * len(GROUPS),
                                  "sp": {}})
        if "reg" in cols:
            rec["reg"] = max(rec["reg"], num(r[cols["reg"]]))
        if "spoilt" in cols:
            rec["sp"][b] = max(rec["sp"].get(b, 0), num(r[cols["spoilt"]]))
        v = num(r[cols["votes"]])
        party = " ".join(str(r[cols["party"]]).upper().split())
        rec[b][G[group_of(party)]] += v
        if b == "ward" and v:
            nm = names.setdefault(ward, {})
            nm[party] = nm.get(party, 0) + v
    return vds, names, rows


def build(vds, names, src):
    wards = {}
    for vd, r in vds.items():
        w = wards.setdefault(r["w"], {"N": 0, "n": 0, "npr": 0, "reg": 0, "regN": 0,
                                       "v": [0] * len(GROUPS), "pr": [0] * len(GROUPS), "sp": 0})
        w["N"] += 1
        w["regN"] += r["reg"]
        if sum(r["ward"]) > 0:
            w["n"] += 1
            w["reg"] += r["reg"]
            w["v"] = [a + b for a, b in zip(w["v"], r["ward"])]
            w["sp"] += r["sp"].get("ward", 0)
        if sum(r["pr"]) > 0:
            w["npr"] += 1
            w["pr"] = [a + b for a, b in zip(w["pr"], r["pr"])]
    for wid, w in wards.items():
        top = sorted(names.get(wid, {}).items(), key=lambda kv: -kv[1])[:TOP_N]
        w["top"] = [[p, v] for p, v in top]
    counted = sum(1 for r in vds.values() if sum(r["ward"]) > 0)
    city_w = [sum(w["v"][i] for w in wards.values()) for i in range(len(GROUPS))]
    city_pr = [sum(w["pr"][i] for w in wards.values()) for i in range(len(GROUPS))]
    status = "pre" if counted == 0 else ("final" if counted == len(vds) else "counting")
    return {
        "status": status, "updated": now(), "fetched": now(), "source": src, "simulated": False,
        "groups": GROUPS, "vdsTotal": len(vds), "vdsCounted": counted,
        "reg": sum(r["reg"] for r in vds.values()),
        "city": {"ward": city_w, "pr": city_pr},
        "wards": wards,
        # per-VD ward-ballot votes for the browser nowcast; only reported VDs
        "vd": {vd: r["ward"] for vd, r in vds.items() if sum(r["ward"]) > 0},
        "error": None,
    }


def snapshot(live):
    return {"t": live["updated"], "n": live["vdsCounted"], "city": live["city"],
            "w": {k: [w["n"]] + w["v"] for k, w in live["wards"].items() if w["n"]}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out", default=str(SITE_DATA / "live.json"))
    ap.add_argument("--history", default=str(SITE_DATA / "live-history.json"))
    ap.add_argument("--no-history", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    old = json.loads(out.read_text()) if out.exists() else None

    def keep_old(msg):
        base = old or {"status": "pre", "groups": GROUPS, "vdsTotal": 0, "vdsCounted": 0, "wards": {},
                       "city": {"ward": [0] * len(GROUPS), "pr": [0] * len(GROUPS)}, "vd": {},
                       "updated": None, "simulated": False, "source": a.src}
        base["fetched"] = now()
        base["error"] = msg
        out.write_text(json.dumps(base, separators=(",", ":")))
        print("kept previous data:", msg)

    try:
        raw = fetch(a.src)
    except urllib.error.HTTPError as e:
        return keep_old(f"IEC file not available yet (HTTP {e.code})")
    except Exception as e:  # noqa: BLE001
        return keep_old(f"fetch failed: {e}")
    try:
        vds, names, rows = parse(decode(raw))
    except Exception as e:  # noqa: BLE001
        return keep_old(f"could not parse IEC file: {e}")
    if not vds:
        return keep_old(f"no {MUNI} rows in file ({len(raw)} bytes)")
    live = build(vds, names, a.src)
    if old and old.get("vdsCounted", 0) > live["vdsCounted"] and not old.get("simulated"):
        return keep_old(f"new file has fewer counted VDs ({live['vdsCounted']} < {old['vdsCounted']}); ignored")
    if old and old.get("city") == live["city"] and old.get("vdsCounted") == live["vdsCounted"]:
        live["updated"] = old.get("updated") or live["updated"]  # unchanged data keeps its timestamp
    out.write_text(json.dumps(live, separators=(",", ":")))
    print(f"{rows} rows, {live['vdsCounted']}/{live['vdsTotal']} VDs counted, status {live['status']}")
    tot = sum(live["city"]["ward"]) or 1
    print(" ".join(f"{g}:{v / tot * 100:.1f}" for g, v in zip(GROUPS, live["city"]["ward"])))

    if not a.no_history:
        hp = Path(a.history)
        hist = json.loads(hp.read_text()) if hp.exists() else []
        snap = snapshot(live)
        if not hist or hist[-1]["n"] != snap["n"] or hist[-1]["city"] != snap["city"]:
            hist.append(snap)
            hist = hist[-HISTORY_MAX:]
            hp.write_text(json.dumps(hist, separators=(",", ":")))


if __name__ == "__main__":
    main()
