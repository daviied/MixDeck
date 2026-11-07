"""X32 mixer parameter paths, in read order. Canonical path space for all console drivers."""
import re

BANDS = (("type", 2), ("f", 0.5), ("g", 0.5), ("q", 0.46))
DYN = {"on": 0, "mode": 0, "det": 0, "env": 1, "thr": 1.0, "ratio": 3, "knee": 0.2, "mgain": 0.0, "attack": 0.08,
       "hold": 0.5, "release": 0.5, "pos": 0, "mix": 1.0, "auto": 0}
GATE = {"on": 0, "mode": 3, "thr": 0.0, "range": 1.0, "attack": 0.0, "hold": 0.5, "release": 0.5}


def _eq(base, n):
    out = {f"{base}/eq/on": 1}
    for b in range(1, n + 1):
        for k, d in BANDS:
            out[f"{base}/eq/{b}/{k}"] = d
        out[f"{base}/eq/{b}/f"] = {1: 0.25, 2: 0.45, 3: 0.65, 4: 0.85, 5: 0.9, 6: 0.95}[b]
    return out


def _sends(base, n, pans=True):
    out = {}
    for i in range(1, n + 1):
        out[f"{base}/mix/{i:02d}/on"] = 1
        out[f"{base}/mix/{i:02d}/level"] = 0.0
        if pans and i % 2:
            out[f"{base}/mix/{i:02d}/pan"] = 0.5
            out[f"{base}/mix/{i:02d}/type"] = 3
    return out


def strips():
    """Yield (base, kind, count info) of all strips."""
    for i in range(1, 33):
        yield f"/ch/{i:02d}", "ch"
    for i in range(1, 9):
        yield f"/auxin/{i:02d}", "aux"
    for i in range(1, 9):
        yield f"/fxrtn/{i:02d}", "fx"
    for i in range(1, 17):
        yield f"/bus/{i:02d}", "bus"
    for i in range(1, 7):
        yield f"/mtx/{i:02d}", "mtx"
    yield "/main/st", "st"
    yield "/main/m", "m"


def fast_defaults():
    """What the mix page needs first: {path: default}."""
    d = {}
    for b, k in strips():
        d[f"{b}/config/name"] = ""
        d[f"{b}/config/color"] = 0
        d[f"{b}/mix/on"] = 1
        d[f"{b}/mix/fader"] = 0.75 if k in ("bus", "mtx", "st", "m") else 0.0
        if k != "mtx" and k != "m":
            d[f"{b}/mix/pan"] = 0.5
    for i in range(1, 9):
        d[f"/dca/{i}/on"] = 1
        d[f"/dca/{i}/fader"] = 0.75
        d[f"/dca/{i}/config/name"] = ""
        d[f"/dca/{i}/config/color"] = 0
    for i in range(1, 81):
        d[f"/-stat/solosw/{i:02d}"] = 0
    for i in range(1, 7):
        d[f"/config/mute/{i}"] = 0
    d["/config/solo/level"] = 0.5
    d["/config/solo/dim"] = 0
    d["/config/solo/mono"] = 0
    d["/-show/prepos/current"] = 0
    d["/-stat/selidx"] = 0
    d["/-stat/chfaderbank"] = 0
    d["/-stat/grpfaderbank"] = 0
    d["/-stat/screen/screen"] = 0
    for s in ("CHAN", "METER", "ROUTE", "SETUP", "LIB", "FX", "MON", "USB", "SCENE", "ASSIGN"):
        d[f"/-stat/screen/{s}/page"] = 0
    return d


def monitor_defaults():
    """The Monitor screen: monitor and solo, talkback, oscillator."""
    d = {f"/config/solo/{k}": 0 for k in ("source", "chmode", "busmode", "dcamode", "exclusive", "followsel", "followsolo",
                                          "delay", "masterctrl", "mute", "dimpfl")}
    d.update({"/config/solo/sourcetrim": 0.5, "/config/solo/dimatt": 0.5, "/config/solo/delaytime": 0.0})
    d.update({"/config/talk/enable": 0, "/config/talk/source": 0})
    for k in "AB":
        d.update({f"/config/talk/{k}/level": 0.5, f"/config/talk/{k}/dim": 0, f"/config/talk/{k}/latch": 0, f"/config/talk/{k}/destmap": 0})
    d.update({"/config/osc/level": 0.0, "/config/osc/f1": 0.5, "/config/osc/f2": 0.5, "/config/osc/fsel": 0, "/config/osc/type": 0, "/config/osc/dest": 0})
    for kind, count in (("ch", 32), ("aux", 8), ("fx", 8), ("bus", 16), ("mtx", 6)):
        for i in range(1, count, 2):
            d[f"/config/{kind}link/{i}-{i + 1}"] = 0
    for i in range(1, 33):
        d[f"/ch/{i:02d}/insert/pos"] = 0
    return d


def slow_defaults():
    d = monitor_defaults()
    for b, k in strips():
        if k == "ch":
            d.update({f"{b}/preamp/trim": 0.5, f"{b}/preamp/invert": 0, f"{b}/preamp/hpon": 0,
                      f"{b}/preamp/hpslope": 0, f"{b}/preamp/hpf": 0.3, f"{b}/delay/on": 0, f"{b}/delay/time": 0.0})
            d.update({f"{b}/gate/{p}": v for p, v in GATE.items()})
        if k == "aux":
            d.update({f"{b}/preamp/trim": 0.5, f"{b}/preamp/invert": 0})
        if k in ("ch", "bus", "mtx", "st", "m"):
            d.update({f"{b}/dyn/{p}": v for p, v in DYN.items()})
            d[f"{b}/insert/on"] = 0
        if k in ("ch", "aux", "fx"):
            d.update(_eq(b, 4))
            d.update(_sends(b, 16))
            d[f"{b}/mix/st"] = 1
            d[f"{b}/mix/mono"] = 0
            d[f"{b}/mix/mlevel"] = 0.0
        else:
            d.update(_eq(b, 6))
        if k in ("bus", "st"):
            d.update(_sends(b, 6))
        if k == "bus":
            d[f"{b}/mix/st"] = 1
            d[f"{b}/mix/mono"] = 0
            d[f"{b}/mix/mlevel"] = 0.0
        if k in ("ch", "aux", "fx", "bus", "mtx", "st", "m"):
            d[f"{b}/grp/dca"] = 0
            d[f"{b}/grp/mute"] = 0
    for i in range(0, 128):
        d[f"/headamp/{i:03d}/gain"] = 0.1666
        d[f"/headamp/{i:03d}/phantom"] = 0
    for i in range(0, 100):
        d[f"/-show/showfile/scene/{i:03d}/name"] = ""
        d[f"/-show/showfile/scene/{i:03d}/hasdata"] = 0
    for r in range(1, 9):
        d[f"/fx/{r}/type"] = 0
        if r <= 4:
            d[f"/fx/{r}/source/l"] = 0
            d[f"/fx/{r}/source/r"] = 0
    return d


# Writes allowed from the browser
WRITE_OK = re.compile(r"^/(ch|auxin|fxrtn|bus|mtx)/\d\d/[a-z0-9/]+$|^/main/(st|m)/[a-z0-9/]+$|^/dca/[1-8]/[a-z/]+$"
                      r"|^/fx/[1-8]/(type|source/[lr]|par/\d\d)$|^/headamp/\d{3}/(gain|phantom)$"
                      r"|^/config/mute/[1-6]$|^/config/solo/[a-z]+$|^/config/talk/(enable|source|[AB]/[a-z]+)$|^/config/osc/[a-z0-9]+$"
                      r"|^/config/(ch|aux|fx|bus|mtx)link/\d+-\d+$"
                      r"|^/-stat/(solosw/\d\d|selidx|screen/screen|screen/[A-Z]+/page)$|^/-action/clearsolo$")
READ_OK = re.compile(r"^/fx/[1-8]/(type|par/\d\d)$")

# Value type when the console has not told us yet
_FLOAT = re.compile(r"/(fader|level|pan|trim|hpf|time|thr|range|attack|hold|release|knee|mgain|mix|f|g|q|gain|mlevel|sourcetrim|dimatt|delaytime|f1|f2)$")


def default_is_float(path):
    return bool(_FLOAT.search(path)) or "/par/" in path
