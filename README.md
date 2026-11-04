# Tshwane Votes 2026

A ward-by-ward map of the City of Tshwane municipal election (4 November 2026): past results,
a poll-based projection, and the live IEC count with a nowcast, for all 107 wards and 796 voting districts.

The site is static (`docs/`). A GitHub Actions job pulls the IEC results file every 5 minutes on election
night and commits `docs/data/live.json`; the page re-reads it every 60 seconds.

## What it shows

| Mode | Map | Side panel |
|---|---|---|
| **Live count** | Leader per ward (shade = how settled), projected winner, party share, change since 2021, counting progress, turnout. Ward or voting-district level. | VDs counted, vote share counted vs projected final, nowcast council (214 seats, 108 to govern) with coalition builder and odds, wards changing hands, a feed of events, a timeline to replay the count. |
| **Polls & projection** | Favourite per ward (shade = confidence), party share, win chance, change since 2021. | 7 Tshwane polls with the weighted average, "what if" sliders that re-run the model live, projected shares with 80% ranges, seat projection and coalition odds, closest wards. |
| **Past results** | 2016 / 2021 local (ward and PR ballots) and 2024 national results, all re-added inside today's ward boundaries. | Totals, council seats recomputed from IEC votes, wards won. |

Click any ward for its history (2016 → 2021 → 2024 → projection → live), all parties on the ballot,
and its voting districts with voting station names. Search by ward number or suburb. "Equal wards" switches to
a hex map where every ward has the same size. **Run a rehearsal count** (before results arrive) replays a
simulated count so you can see the live view working; it is labelled as a simulation throughout.

## How it works

- **Past results on 2026 boundaries.** IEC results are published per voting district (VD). Every 2026 ward is a
  set of VDs (IEC 2026 delimitation; checked against the MDB's 2026 VD layer: 796/796 VDs, all ward
  assignments agree), so older results are re-added VD by VD. Recomputed councils match the official ones
  (2021: ANC 75, DA 69, EFF 23, ActionSA 19, FF Plus 17, ACDP 2, PA 1 and 8 single seats; 2016: DA 93, ANC 89, EFF 25…).
- **Projection.** Ward baseline = 65% 2021 ward ballot + 35% 2024 national ballot. Shares are scaled ward by
  ward (iterative proportional fitting) until the city total matches the poll average (30-day half-life,
  √n weights). 1,000 simulations add city-wide error (poll spread + 2 pts) and ward error, giving win chances
  and seat ranges. Seats use the Municipal Structures Act quota/largest-remainder formula on ward + PR votes,
  with small parties allocated individually.
- **Nowcast.** Each uncounted VD gets a prior (its ward's projection adjusted to the VD's own past profile).
  As VDs report, the city-wide swing against those priors, a ward-level correction (shrunk), and the turnout
  ratio are applied to the VDs still out. Uncertainty shrinks as the count progresses.

These are statistical estimates. Only the IEC declares results.

## Data

| File | Source |
|---|---|
| `data/source/iec_lge2021_tsh.csv`, `iec_lge2016_tsh.csv` | IEC per-VD results (Tshwane rows), fetched by `pipeline/fetch_sources.py` |
| `data/source/mdb_*.geojson` | Municipal Demarcation Board 2026 wards, voting districts and stations |
| `data/source/osm_places.json` | OpenStreetMap place names (labels and search) |
| `data/source/tsh_*.csv` | VD results for 2016/2021/2024 and the 2026 ward→VD list, first extracted from [gavacharles/lge2026-ward-forecast](https://github.com/gavacharles/lge2026-ward-forecast) (IEC/MDB-derived); totals verified against the IEC originals above |
| `pipeline/polls_tshwane.csv` | Tshwane polls: Ipsos, SRF/The Common Sense, MarkData/eNCA, SABI/News24 (sources in the file) |

## Run and deploy

```sh
python3 pipeline/build_static.py              # data/source -> docs/data/static.json, wards.geojson, vds.geojson
python3 -m http.server -d docs 8000           # open http://localhost:8000
python3 pipeline/live.py                      # fetch the live IEC file once
python3 pipeline/live.py --src FILE_OR_URL    # any IEC-format CSV (e.g. the 2021 file, for testing)
```

**Hosting:** Cloudflare Workers (static assets), connected to this repository. Every push to `main`,
including the live-results commits, triggers a Cloudflare build that publishes `docs/` (see `wrangler.jsonc`).
No GitHub secrets are needed.

**Election night:** `.github/workflows/live-results.yml` runs every 5 minutes from 19:00 SAST on 4 Nov to
7 Nov (scheduled workflows only run on the default branch). If the IEC changes its file location, run the
workflow by hand with the `src` input set to the new CSV URL. If GitHub's scheduler lags, run
`sh pipeline/election_night.sh` on any machine that can reach the IEC.

`.github/workflows/fetch-sources.yml` re-downloads the IEC/MDB/OSM sources and probes the 2026 results URL.
