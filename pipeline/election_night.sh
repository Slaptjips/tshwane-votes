#!/bin/sh
# Local fallback for election night if GitHub's scheduler lags: ingest every 2 minutes and push.
# Run from the repo root on a machine that can reach results.elections.org.za.
while true; do
  python3 pipeline/live.py
  git add docs/data/live.json docs/data/live-history.json
  git diff --cached --quiet || { git commit -qm "Live results $(date -u +%H:%MZ)"; git pull -q --rebase; git push -q; }
  sleep 120
done
