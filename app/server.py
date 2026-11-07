"""MixDeck web server. Stdlib only."""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import mixer
import routing as R
import sim
import x32map as M
from link import Link
from tf1 import TF1
from x32 import X32, discover

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"
DATA = Path(os.environ.get("DATA_DIR", "/data"))
CONFIG_FILE = DATA / "config.json"
PASSWORD = os.environ.get("APP_PASSWORD", "")
SECRET = (os.environ.get("SESSION_SECRET") or secrets.token_hex(32)).encode()
PORT = int(os.environ.get("PORT", "8080"))
MOCK = os.environ.get("X32_MOCK") == "1"
SESSION_DAYS = 30
COOKIE = "mixdeck"

if not PASSWORD:
    raise SystemExit("APP_PASSWORD is not set. Refusing to start without a password.")


def load_cfg():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        s32 = dict(M.PRESETS["S32"], id="s32", preset="S32", inStart=17)
        return {"devices": [s32], "consoles": {
            "A": {"type": os.environ.get("CONSOLE_A_TYPE", "x32"), "ip": os.environ.get("X32_IP", ""), "name": "Console A"},
            "B": {"type": "tf1" if MOCK else "none", "ip": "", "name": "Console B"},
        }}


def save_cfg(c):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(c, indent=2))
    tmp.replace(CONFIG_FILE)


CFG = load_cfg()
CONS = {"A": None, "B": None}
SIMS = {}
cons_lock = threading.Lock()


def make_console(slot):
    c = CFG["consoles"][slot]
    t = c.get("type")
    if t == "x32":
        if MOCK:
            s = SIMS.setdefault((slot, "x32"), None) or sim.X32Sim()
            SIMS[(slot, "x32")] = s
            return X32(slot, "127.0.0.1", c.get("name", ""), port=s.port)
        return X32(slot, c.get("ip", ""), c.get("name", ""))
    if t == "tf1":
        if MOCK:
            s = SIMS.get((slot, "tf1")) or sim.TF1Sim()
            SIMS[(slot, "tf1")] = s
            return TF1(slot, "127.0.0.1", c.get("name", ""), port=s.port)
        return TF1(slot, c.get("ip", ""), c.get("name", ""))
    return None


def routing_console():
    a, b = CONS["A"], CONS["B"]
    return a if a and a.kind == "x32" else (b if b and b.kind == "x32" else None)


def setup_console(slot):
    old = CONS[slot]
    if old:
        old.stop()
    CONS[slot] = make_console(slot)
    if CONS[slot]:
        LINK.attach(CONS[slot])
    R.init(routing_console(), CFG, save_cfg)
    LINK.rebuild()


LINK = Link(lambda: (CONS["A"], CONS["B"]), CFG.get("link"))
for _s in "AB":
    setup_console(_s)


# ---------- auth ----------
def make_token():
    exp = str(int(time.time()) + SESSION_DAYS * 86400)
    return f"{exp}.{hmac.new(SECRET, exp.encode(), hashlib.sha256).hexdigest()}"


def check_token(tok):
    try:
        exp, sig = tok.split(".")
        good = hmac.new(SECRET, exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except Exception:
        return False


login_hits = {}


def rate_ok(ip):
    now = time.time()
    hits = [t for t in login_hits.get(ip, []) if now - t < 60]
    login_hits[ip] = hits
    if len(hits) >= 8:
        return False
    hits.append(now)
    return True


META = {"fxTypes": M.FX_TYPES, "fx5Types": M.FX5_TYPES}


def statuses():
    return {s: (c.status() if c else None) for s, c in CONS.items()}


def strip_sources(c):
    """X32 only: what feeds each channel, for the strips and the headamp."""
    if not c or c.kind != "x32" or routing_console() is not c:
        return {}
    st = c.snapshot()
    out = {}
    for f in M.FADERS:
        r = M.resolve_fader(f, st)
        key = f"/ch/{int(f[2:]):02d}" if f.startswith("ch") else f"/auxin/{int(f[3:]):02d}"
        e = {}
        if "phys" in r:
            port, n = r["phys"]
            lab = R.phys_label([R.dev_defaults(d) for d in CFG.get("devices", [])], port, n)
            e["src"] = lab[0]
            if lab[2]:
                d = next(x for x in CFG["devices"] if x["id"] == lab[2])
                e["plug"] = d.get("labels", {}).get("in", {}).get(str(lab[3]), "")
            if port == "LOCAL":
                e["ha"] = n - 1
            elif port == "A":
                e["ha"] = 31 + n
            elif port == "B":
                e["ha"] = 79 + n
        elif r["kind"] != "?":
            e["src"] = M.source_text(r)
        out[key] = e
    return out


class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def make_server(port):
    try:
        return DualStackServer(("::", port), H)
    except OSError:
        srv = ThreadingHTTPServer(("0.0.0.0", port), H)
        srv.daemon_threads = True
        return srv


class H(BaseHTTPRequestHandler):
    server_version = "MixDeck"
    protocol_version = "HTTP/1.1"  # keep-alive: fader writes reuse one connection
    disable_nagle_algorithm = True

    def log_message(self, *a):
        pass

    def _json(self, code, obj, headers=None):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def _route_reply(self, code, res):
        if code == 200 and R.X:
            res = {**res, "state": R.build_state()}
        return self._json(code, res)

    def _events(self, slot):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        c = CONS.get(slot)
        counted = c

        def send(ev, obj):
            self.wfile.write(f"event: {ev}\ndata: {json.dumps(obj)}\n\n".encode())

        try:
            if c:
                c.meter_clients += 1
                for m in ("/meters/1", "/meters/2", "/meters/3"):
                    if c.kind == "x32":
                        c.send("/meters", m)
            seq = c.seq if c else 0
            send("full", {"values": c.snapshot() if c else {}, "status": statuses(), "sources": strip_sources(c), "link": LINK.view()})
            rv = c.routing_version if c else 0
            r_rv = None
            last_status = last_ping = 0.0
            last_meter = b""
            last_mtime = 0.0
            last_rta = b""
            while True:
                time.sleep(0.04)
                now = time.time()
                if CONS.get(slot) is not c:  # console changed in settings
                    send("reload", {})
                    self.wfile.flush()
                    return
                if c:
                    d, seq2 = c.since(seq)
                    if d is None:
                        send("full", {"values": c.snapshot(), "status": statuses(), "sources": strip_sources(c), "link": LINK.view()})
                    elif d:
                        send("d", d)
                    seq = seq2
                    if c.meter_bytes and (c.meter_bytes != last_meter or now - last_mtime > .4):  # a steady level is still live
                        last_meter, last_mtime = c.meter_bytes, now
                        self.wfile.write(b"event: m\ndata: " + base64.b64encode(last_meter) + b"\n\n")
                    if c.rta_bytes and c.rta_bytes != last_rta:
                        last_rta = c.rta_bytes
                        self.wfile.write(b"event: r\ndata: " + base64.b64encode(last_rta) + b"\n\n")
                    if c.routing_version != rv:
                        rv = c.routing_version
                        send("sources", strip_sources(c))
                x = R.X
                if x and x.routing_version != r_rv:
                    r_rv = x.routing_version
                    send("routing", R.build_state())
                if now - last_status > 1:
                    last_status = now
                    send("status", {"status": statuses(), "link": LINK.view()})
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return
        finally:
            if counted:
                counted.meter_clients -= 1

    def _authed(self):
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE and check_token(v):
                return True
        return False

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 500_000:
            self.close_connection = True
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def _client_ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        q = parse_qs(u.query)
        if path.startswith("/api/"):
            if path == "/api/auth":
                return self._json(200, {"authed": self._authed(), "mock": MOCK})
            if not self._authed():
                return self._json(401, {"error": "Login required"})
            if path == "/api/events":
                return self._events((q.get("c") or ["A"])[0])
            if path == "/api/state":
                return self._json(200, R.build_state() if R.X else {"noRouting": True})
            if path == "/api/meta":
                return self._json(200, {**META, **R.STATIC_META, "mock": MOCK})
            if path == "/api/consoles":
                return self._json(200, {"config": CFG["consoles"], "status": statuses()})
            if path == "/api/discover":
                found = discover()
                if MOCK and not found:
                    found = [{"ip": "127.0.0.1", "name": "Sim console", "model": "X32", "fw": "4.06", "type": "x32"}]
                return self._json(200, {"consoles": found})
            return self._json(404, {"error": "Not found"})
        self._static(path)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        f = (PUBLIC / path.lstrip("/")).resolve()
        if not str(f).startswith(str(PUBLIC.resolve())) or not f.is_file():
            f = PUBLIC / "index.html"
        b = f.read_bytes()
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if f.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        if f.suffix == ".js":
            ctype = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        if self.headers.get("X-Requested-With") != "x32r":  # CSRF guard
            return self._json(403, {"error": "Bad request"})
        if path == "/api/login":
            if not rate_ok(self._client_ip()):
                return self._json(429, {"error": "Too many tries. Wait one minute."})
            if not hmac.compare_digest(str(body.get("password", "")).encode(), PASSWORD.encode()):
                return self._json(401, {"error": "Wrong password"})
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
            ck = f"{COOKIE}={make_token()}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_DAYS * 86400}{secure}"
            return self._json(200, {"ok": True}, {"Set-Cookie": ck})
        if path == "/api/logout":
            return self._json(200, {"ok": True}, {"Set-Cookie": f"{COOKIE}=; Path=/; Max-Age=0"})
        if not self._authed():
            return self._json(401, {"error": "Login required"})
        try:
            return self._post(path, body)
        except (ValueError, TypeError, KeyError):
            return self._json(400, {"error": "Bad request"})

    def _post(self, path, body):
        c = CONS.get(str(body.get("c", "A")))
        if path == "/api/set":
            if not c:
                return self._json(409, {"error": "Console not set"})
            for p, v in body["sets"][:400]:
                if mixer.WRITE_OK.match(p) and isinstance(v, (int, float, str)):
                    c.write(p, v, "app")
            return self._json(200, {"ok": True})
        if path == "/api/rta":
            sel = int(body.get("sel", -1))
            if c and c.kind == "x32" and -1 <= sel <= 71:
                c.rta_want(sel)
            return self._json(200, {"ok": True})
        if path == "/api/read":
            if c:
                c.read_paths([p for p in body["paths"][:200] if mixer.READ_OK.match(p)])
            return self._json(200, {"ok": True})
        if path == "/api/scene":
            if not c:
                return self._json(409, {"error": "Console not set"})
            slot = int(body.get("slot", -1))
            if not 0 <= slot <= 99:
                return self._json(400, {"error": "Bad scene"})
            if body.get("action") == "recall":
                LINK.paused_until = time.time() + 3  # the console may not report a recall
            ok, msg = c.scene(str(body.get("action")), slot, str(body.get("name", "")), str(body.get("note", "")))
            return self._json(200 if ok else 400, {"ok": ok, "msg": msg, "error": msg})
        if path == "/api/consoles":
            for slot in "AB":
                n = (body.get("consoles") or {}).get(slot)
                if not isinstance(n, dict):
                    continue
                old = CFG["consoles"][slot]
                new = {"type": n.get("type") if n.get("type") in ("x32", "tf1", "none") else "none",
                       "ip": str(n.get("ip", "")).strip()[:64], "name": str(n.get("name", ""))[:24]}
                changed = (new["type"], new["ip"]) != (old.get("type"), old.get("ip"))
                CFG["consoles"][slot] = new
                if changed:
                    setup_console(slot)
                    LINK.cfg["map"] = None
                    LINK.rebuild()
                elif CONS[slot]:
                    CONS[slot].name = new["name"]
            save_cfg(CFG)
            return self._json(200, {"ok": True, "status": statuses()})
        if path == "/api/link":
            cfg = LINK.cfg
            if "enabled" in body:
                cfg["enabled"] = bool(body["enabled"])
            if body.get("direction") in ("a2b", "b2a", "both"):
                cfg["direction"] = body["direction"]
            if isinstance(body.get("params"), dict):
                cfg["params"] = {k: bool(body["params"].get(k, v)) for k, v in cfg["params"].items()}
            if isinstance(body.get("map"), list):
                cfg["map"] = [[str(a)[:10], str(b)[:10]] for a, b in body["map"][:200]]
            if body.get("autoMap"):
                cfg["map"] = None
            LINK.rebuild()
            CFG["link"] = cfg
            save_cfg(CFG)
            return self._json(200, LINK.view())
        if path == "/api/link/sync":
            d = "a2b" if body.get("direction") == "a2b" else "b2a"
            threading.Thread(target=LINK.sync, args=(d,), daemon=True).start()
            return self._json(200, {"ok": True})
        if path == "/api/refresh":
            if c:
                c.refresh()
            return self._json(200, {"ok": True})
        if path == "/api/sim/desk" and MOCK:
            return self._sim_desk(c, body)
        return self._route(path, body)

    def _sim_desk(self, c, body):
        s = SIMS.get((c.slot, c.kind))
        if c.kind == "x32":
            s.desk(str(body["path"]), body["value"])
        else:
            a, x, y, to, _ = R_TF[str(body["path"])]
            s.desk(a, x, y, to(body["value"]))
        return self._json(200, {"ok": True})

    def _route(self, path, body):
        if not R.X and path.startswith(("/api/route", "/api/block", "/api/config")):
            return self._json(409, {"error": "Routing needs an X32 console."})
        if path == "/api/config":
            with R.cfg_lock:
                if isinstance(body.get("devices"), list):
                    CFG["devices"] = [R.clean_device(d) for d in body["devices"][:32] if isinstance(d, dict)]
                if isinstance(body.get("auxPool"), list):
                    CFG["auxPool"] = sorted({int(n) for n in body["auxPool"] if str(n).isdigit() and 1 <= int(n) <= M.AUX_COUNT})
                save_cfg(CFG)
            R.X.bump()
            return self._route_reply(200, {"ok": True})
        if path == "/api/route/input":
            return self._route_reply(*R.route_input(str(body.get("fader")), str(body.get("device") or ""), int(body.get("jack", 0))))
        if path == "/api/route/output":
            return self._route_reply(*R.route_output(str(body.get("device")), int(body.get("jack", 0)), int(body.get("source", -1))))
        if path == "/api/route/fxinsert":
            return self._route_reply(*R.route_fxinsert(str(body.get("fader"))))
        if path == "/api/route/insert":
            return self._route_reply(*R.route_insert(str(body.get("fader")), str(body.get("device") or ""), int(body.get("slot", 0))))
        if path == "/api/block":
            p, v = str(body.get("path")), int(body.get("value", -1))
            if p not in R.ALLOWED_BLOCKS:
                return self._json(400, {"error": "Bad block"})
            limit = len(M.AUX_BLOCK_OPTS) if p.endswith("/AUX") else (len(M.IN_BLOCK_OPTS) if "/IN/" in p else len(M.OUT_BLOCK_OPTS))
            if not 0 <= v < limit:
                return self._json(400, {"error": "Bad value"})
            old = R.X.snapshot().get(p)
            R.X.set(p, v)
            note = ""
            xo = M.XLR_OPTS.get(p.rsplit("/", 1)[1]) if "/OUT/" in p else None
            if xo and old is not None and 0 <= old < len(xo):
                (ok_, os_), (nk, ns) = xo[old], xo[v]
                if ok_ == "OUT" and nk == "UOUT":
                    st, kept = R.X.snapshot(), 0
                    for i in range(4):
                        if not st.get(M.p_uout(ns + i)):
                            R.X.set(M.p_uout(ns + i), 168 + os_ + i)
                            kept += 1
                    note = f"{kept} jack(s) keep Output {os_}-{os_ + 3} through User Out {ns}-{ns + 3}"
            return self._route_reply(200, {"ok": True, "msg": note})
        return self._json(404, {"error": "Not found"})


from tf1 import MAP as R_TF  # noqa: E402

if __name__ == "__main__":
    print(f"MixDeck on :{PORT}  mock={MOCK}", flush=True)
    make_server(PORT).serve_forever()
