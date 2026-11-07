"""Console link: changes on one console drive the other, through a strip map."""
import re
import threading
import time

_RE = re.compile(r"^/(ch|auxin|fxrtn|bus|mtx)/(\d\d)/(.+)$")
_DCA = re.compile(r"^/dca/(\d)/(.+)$")
_MAIN = re.compile(r"^/main/(st|m)/(.+)$")
_SEND = re.compile(r"^mix/(\d\d)/(level|on)$")
PAUSE_ON_SCENE = 3.0
ECHO_WINDOW = 0.35
EPS = 0.003
SEG = {"ch": 2, "auxin": 2, "fxrtn": 2, "bus": 2, "mtx": 2}
CAP = {"ch": "ch", "auxin": "aux", "fxrtn": "fx", "bus": "bus", "mtx": "mtx", "dca": "dca"}

DEFAULTS = {"enabled": False, "direction": "a2b", "params": {"fader": True, "mute": True, "pan": True, "name": False, "sends": False}, "map": None}


def strip_key(path):
    """(strip key, rest of path)."""
    m = _RE.match(path)
    if m:
        return f"{m[1]}{int(m[2])}", m[3]
    m = _DCA.match(path)
    if m:
        return f"dca{m[1]}", m[2]
    m = _MAIN.match(path)
    if m:
        return f"main{m[1]}", m[2]
    return None, None


def strip_base(key):
    m = re.match(r"^(ch|auxin|fxrtn|bus|mtx)(\d+)$", key)
    if m:
        return f"/{m[1]}/{int(m[2]):02d}"
    if key.startswith("dca"):
        return f"/dca/{key[3:]}"
    return f"/main/{key[4:]}"


def auto_map(a, b):
    """Same number to same number, up to the smaller console."""
    out = []
    for seg, cap in CAP.items():
        for i in range(1, min(a.get(cap, 0), b.get(cap, 0)) + 1):
            out.append([f"{seg}{i}", f"{seg}{i}"])
    out += [["mainst", "mainst"], ["mainm", "mainm"]]
    return out


class Link:
    def __init__(self, get_consoles, cfg):
        self.get = get_consoles
        self.cfg = {**DEFAULTS, **(cfg or {})}
        self.cfg["params"] = {**DEFAULTS["params"], **self.cfg["params"]}
        self.fwd, self.rev = {}, {}
        self.touched = {}
        self.paused_until = 0.0
        self.count = 0
        self.last = ""
        self.lock = threading.Lock()
        self.rebuild()

    def rebuild(self):
        a, b = self.get()
        if self.cfg.get("map") is None and a and b:
            self.cfg["map"] = auto_map(a.caps, b.caps)
        pairs = self.cfg.get("map") or []
        self.fwd = {x: y for x, y in pairs if y}
        self.rev = {y: x for x, y in pairs if y}

    def attach(self, console):
        console.listeners.append(self.on_change)

    def view(self):
        reading = any(c and c.reading for c in self.get())
        return {**self.cfg, "count": self.count, "last": self.last, "paused": reading or time.time() < self.paused_until}

    def _param_on(self, rest):
        p = self.cfg["params"]
        if rest in ("mix/fader", "fader"):
            return p["fader"]
        if rest in ("mix/on", "on"):
            return p["mute"]
        if rest == "mix/pan":
            return p["pan"]
        if rest == "config/name":
            return p["name"]
        return bool(p["sends"] and _SEND.match(rest))

    def _translate(self, table, path):
        key, rest = strip_key(path)
        if not key or key not in table or not self._param_on(rest):
            return None
        m = _SEND.match(rest)
        if m:
            bus = table.get(f"bus{int(m[1])}")
            if not bus:
                return None
            rest = f"mix/{int(bus[3:]):02d}/{m[2]}"
        return f"{strip_base(table[key])}/{rest}"

    def on_change(self, con, path, value, origin):
        if origin in ("link", "read"):
            return
        now = time.time()
        if path.startswith("/-show/prepos/"):
            self.paused_until = now + PAUSE_ON_SCENE  # do not copy a whole scene load
            return
        if not self.cfg["enabled"] or now < self.paused_until:
            return
        d = self.cfg["direction"]
        a, b = self.get()
        if con is a and d in ("a2b", "both"):
            target, table = b, self.fwd
        elif con is b and d in ("b2a", "both"):
            target, table = a, self.rev
        else:
            return
        if not target or self.touched.get((con.slot, path), 0) > now:
            return  # echo of a change this link made
        tp = self._translate(table, path)
        if not tp:
            return
        cur = target.state.get(tp)
        if cur == value or (isinstance(value, float) and isinstance(cur, (int, float)) and abs(cur - value) < EPS):
            return
        self.touched[(target.slot, tp)] = now + ECHO_WINDOW
        target.write(tp, value, "link")
        self.count += 1
        self.last = f"{con.slot} {path} → {target.slot} {tp}"

    def sync(self, direction):
        """Copy all linked values once. Only runs when asked: enabling the link moves nothing."""
        a, b = self.get()
        src, dst, table = (a, b, self.fwd) if direction == "a2b" else (b, a, self.rev)
        if not src or not dst:
            return 0
        n = 0
        for p, v in src.snapshot().items():
            tp = self._translate(table, p)
            if tp and dst.state.get(tp) != v:
                self.touched[(dst.slot, tp)] = time.time() + ECHO_WINDOW + 2
                dst.write(tp, v, "link")
                n += 1
                time.sleep(0.002)
        return n
