"""Shared constants for the Tshwane election pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "source"
SITE_DATA = ROOT / "docs" / "data"

MUNI = "TSH"
MUNI_NAME = "City of Tshwane"
WARD_PREFIX = "799"          # IEC/MDB ward ids for Tshwane are 79900001..79900107
N_WARDS = 107
COUNCIL_SEATS = 214          # 107 ward + 107 PR

# IEC event ids on results.elections.org.za
EVENT_LGE2026 = 1887
EVENT_LGE2021 = 1091
EVENT_LGE2016 = 402

# Display groups. Order matters: it is the order used in compact arrays in the site data.
GROUPS = ["ANC", "DA", "EFF", "ASA", "FFP", "MK", "PA", "ACDP", "IND", "OTH"]

GROUP_OF_NAME = {
    "AFRICAN NATIONAL CONGRESS": "ANC",
    "DEMOCRATIC ALLIANCE": "DA",
    "DEMOCRATIC ALLIANCE/DEMOKRATIESE ALLIANSIE": "DA",
    "ECONOMIC FREEDOM FIGHTERS": "EFF",
    "ACTIONSA": "ASA",
    "VRYHEIDSFRONT PLUS": "FFP",
    "FREEDOM FRONT PLUS": "FFP",
    "VRYHEIDSFRONT PLUS | FREEDOM FRONT PLUS": "FFP",
    "UMKHONTO WESIZWE": "MK",
    "UMKHONTO WESIZWE PARTY": "MK",
    "UMKHONTO WE SIZWE PARTY": "MK",
    "PATRIOTIC ALLIANCE": "PA",
    "AFRICAN CHRISTIAN DEMOCRATIC PARTY": "ACDP",
    "INDEPENDENT": "IND",
    # codes already grouped upstream
    "ANC": "ANC", "DA": "DA", "EFF": "EFF", "ASA": "ASA", "FFP": "FFP", "MK": "MK", "PA": "PA",
}


def norm_name(s):
    return " ".join(str(s).upper().split())


def group_of(name):
    n = norm_name(name)
    if n in GROUP_OF_NAME:
        return GROUP_OF_NAME[n]
    if n.startswith("INDEPENDENT") and len(n) <= 14:
        return "IND"
    return "OTH"
