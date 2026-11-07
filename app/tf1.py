"""Yamaha TF1 driver: text protocol over TCP 49280.

Maps TF parameters onto the X32-shaped paths the app uses. Yamaha publishes no TF spec; the commands come from
github.com/bitfocus/companion-module-yamaha-rcp and github.com/BrenekH/yamaha-rcp-docs. Not yet tested on hardware.
"""
import shlex
import socket
import threading
import time

from console import Console, db_to_fader, fader_to_db

PORT = 49280
PRE = "MIXER:Current/"
KINDS = {"ch": ("ch", "InCh", 40), "auxin": ("auxin", "StInCh", 4), "fxrtn": ("fxrtn", "FxRtnCh", 4),
         "bus": ("bus", "Mix", 20), "mtx": ("mtx", "Mtrx", 4)}
BUSES = 20


def f_out(f):
    return -32768 if f <= 0 else min(1000, int(round(fader_to_db(f) * 100)))


def f_in(v):
    return 0.0 if v <= -9000 else db_to_fader(v / 100)


def pan_out(p):
    return int(round((p - 0.5) * 126))


def pan_in(v):
    return (v + 63) / 126


def same(v):
    return v


def build_map():
    """path -> (rcp address, x, y, to console, from console, is text)."""
    m = {}
    for key, (seg, rcp, n) in KINDS.items():
        for i in range(n):
            b = f"/{seg}/{i + 1:02d}"
            m[f"{b}/mix/fader"] = (f"{PRE}{rcp}/Fader/Level", i, 0, f_out, f_in)
            m[f"{b}/mix/on"] = (f"{PRE}{rcp}/Fader/On", i, 0, int, int)
            m[f"{b}/config/name"] = (f"{PRE}{rcp}/Label/Name", i, 0, str, str)
            if key == "ch":
                m[f"{b}/mix/pan"] = (f"{PRE}InCh/ToSt/Pan", i, 0, pan_out, pan_in)
                for j in range(BUSES):
                    s = f"{b}/mix/{j + 1:02d}"
                    m[f"{s}/level"] = (f"{PRE}InCh/ToMix/Level", i, j, f_out, f_in)
                    m[f"{s}/on"] = (f"{PRE}InCh/ToMix/On", i, j, int, int)
    for i in range(8):
        b = f"/dca/{i + 1}"
        m[f"{b}/fader"] = (f"{PRE}DCA/Fader/Level", i, 0, f_out, f_in)
        m[f"{b}/on"] = (f"{PRE}DCA/Fader/On", i, 0, int, int)
        m[f"{b}/config/name"] = (f"{PRE}DCA/Label/Name", i, 0, str, str)
    m["/main/st/mix/fader"] = (f"{PRE}St/Fader/Level", 0, 0, f_out, f_in)
    m["/main/st/mix/on"] = (f"{PRE}St/Fader/On", 0, 0, int, int)
    m["/main/st/config/name"] = (f"{PRE}St/Label/Name", 0, 0, str, str)
    m["/main/m/mix/fader"] = (f"{PRE}Mono/Fader/Level", 0, 0, f_out, f_in)
    m["/main/m/mix/on"] = (f"{PRE}Mono/Fader/On", 0, 0, int, int)
    m["/main/m/config/name"] = (f"{PRE}Mono/Label/Name", 0, 0, str, str)
    return m


MAP = build_map()
REV = {(a, x, y): (p, frm) for p, (a, x, y, _, frm) in MAP.items()}
# St has an L and an R fader on TF. Keep them together.
TWIN = {"/main/st/mix/fader", "/main/st/mix/on"}


class TF1(Console):
    kind = "tf1"
    caps = {"type": "tf1", "ch": 40, "aux": 4, "fx": 4, "bus": 20, "mtx": 4, "dca": 8, "mono": True, "full": False,
            "meters": False, "sceneNames": False}

    def __init__(self, slot, ip, name="", port=PORT):
        super().__init__(slot, ip, name)
        self.port = port
        self.sock = None
        self.tx_lock = threading.Lock()
        self.total_reads = len(MAP)
        self.is_connected = False
        self.last_rx = 0.0
        threading.Thread(target=self._run, daemon=True).start()

    @property
    def connected(self):
        return self.is_connected

    def stop(self):
        self.stopped = True
        self._close()

    def _close(self):
        s, self.sock = self.sock, None
        self.is_connected = False
        if s:
            try:
                s.close()
            except OSError:
                pass

    def _tx(self, line):
        s = self.sock
        if not s:
            return
        try:
            with self.tx_lock:
                s.sendall(line.encode() + b"\n")
        except OSError:
            self._close()

    def write(self, path, value, origin="app"):
        e = MAP.get(path)
        if not e:
            return  # the TF has no such parameter
        addr, x, y, to, _ = e
        v = to(value)
        txt = '"' + str(v).replace('"', "") + '"' if to is str else str(v)
        self._tx(f"set {addr} {x} {y} {txt}")
        if path in TWIN:
            self._tx(f"set {addr} 1 {y} {txt}")
        self._store(path, value, origin)

    def refresh(self):
        threading.Thread(target=self._read_all, daemon=True).start()

    def _read_all(self):
        # Faders, mutes and names first, then sends.
        order = sorted(MAP, key=lambda p: ("/mix/0" in p or "/mix/1" in p or "/mix/2" in p))
        self.reading = True
        try:
            for p in order:
                if not self.sock:
                    return
                a, x, y, _, _ = MAP[p]
                self._tx(f"get {a} {x} {y}")
                time.sleep(0.005)
            time.sleep(0.3)  # late replies are still part of the read
        finally:
            self.reading = False

    def scene(self, action, slot=0, name="", note=""):
        bank = "scene_a"
        if action == "recall":
            self._tx(f"ssrecall_ex {bank} {int(slot)}")
            threading.Timer(0.8, self.refresh).start()
            return True, f"Scene A{slot:02d} recalled"
        if action == "save":
            self._tx(f"ssupdate_ex {bank} {int(slot)}")
            return True, f"Scene A{slot:02d} saved"
        return False, "Bad action"

    def _run(self):
        while not self.stopped:
            if not self.ip:
                time.sleep(1)
                continue
            try:
                s = socket.create_connection((self.ip, self.port), timeout=3)
                s.settimeout(1.0)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.sock = s
                self.is_connected = True
                self.info = f"Yamaha TF at {self.ip}"
                self.refresh()
                buf = b""
                while not self.stopped and self.sock:
                    try:
                        d = s.recv(65536)
                    except socket.timeout:
                        continue
                    if not d:
                        break
                    buf += d
                    *lines, buf = buf.split(b"\n")
                    for ln in lines:
                        self._line(ln.decode("utf-8", "replace").strip())
            except OSError:
                pass
            self._close()
            time.sleep(2)

    def _line(self, ln):
        # OK get <addr> <x> <y> <val> ["text"] / NOTIFY set <addr> <x> <y> <val> ["text"]
        if not ln.startswith(("OK", "NOTIFY")):
            return
        try:
            t = shlex.split(ln)
        except ValueError:
            return
        if len(t) < 6 or not t[2].startswith("MIXER:"):
            return
        status, action = t[0], t[1]
        if status != "NOTIFY" and action != "get":
            return
        e = REV.get((t[2], int(t[3]), int(t[4])))
        if not e:
            return
        path, frm = e
        try:
            self._store(path, frm(int(t[5])) if frm is not str else t[5], "desk")
        except ValueError:
            pass
