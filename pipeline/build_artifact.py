"""Write a claude.ai Artifact version of the site: the page body without its document wrapper.

Usage: python pipeline/build_artifact.py OUT.html
The Artifact publishes docs/assets, docs/vendor and docs/data alongside it as supporting files.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / "docs" / "index.html").read_text()
title = re.search(r"<title>.*?</title>", src, re.S).group(0)
body = re.search(r"<!--APP-START-->(.*?)<!--APP-END-->", src, re.S).group(1)
head_links = "\n".join(re.findall(r'<link rel="stylesheet"[^>]*>', src))
out = f"""{title}
<link rel="preconnect" href="https://fonts.googleapis.com">
{head_links}
<style>html, body {{ height: 100%; }}</style>
{body}
<script src="vendor/leaflet/leaflet.js"></script>
<script src="vendor/maplibre/maplibre-gl.js"></script>
<script src="vendor/maplibre/leaflet-maplibre-gl.js"></script>
<script src="assets/app.js"></script>
"""
Path(sys.argv[1]).write_text(out)
print("wrote", sys.argv[1], len(out), "bytes")
