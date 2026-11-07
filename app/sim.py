"""Console simulators for X32_MOCK=1 and tests. They speak the real protocols, so the drivers run unchanged."""
import math
import random
import shlex
import socket
import struct
import threading
import time

import mixer
import tf1
import x32map as M
from x32 import osc_decode, osc_encode

NAMES = ["Kick In", "Kick Out", "Snare Top", "Snare Bot", "Hat", "Rack Tom", "Floor Tom", "OH L", "OH R", "Bass DI", "Bass Amp",
         "Gtr L", "Gtr R", "Keys L", "Keys R", "Acoustic", "Lead Vox", "BGV 1", "BGV 2", "BGV 3", "Spare", "Click", "Track L", "Track R"]
COLORS = [1, 1, 1, 1, 3, 3, 3, 3, 3, 4, 4, 2, 2, 5, 5, 2, 6, 6, 6, 6, 0, 7, 5, 5]


class X32Sim:
    def __init__(self):
        s = mixer.fast_defaults()
        s.update(mixer.slow_defaults())
        s.update({p: 0 for p in M.all_read_paths()})
        s.update({M.p_source(f): (int(f[2:]) if f.startswith("ch") else 32 + int(f[3:])) for f in M.FADERS})
        for i, b in enumerate(M.IN_BLOCKS):
            s[M.p_in_block(b)] = 20 + i
        for port in ("A", "B", "CARD"):
            for i, b in enumerate(M.out_blocks(port)):
                s[M.p_out_block(port, b)] = M.OUT_BLOCK_OPTS.index(("UOUT", i * 8 + 1)) if port == "A" else 20
        for i in range(1, 33):
            s[M.p_uin(i)] = M.src_value("A", 16 + i)
        for i in range(1, 49):
            s[M.p_uout(i)] = 168 + ((i - 1) % 16) + 1
        for i in range(1, 17):
            s[M.p_local_out("XLR", i)] = 3 + i
        for i, b in enumerate(M.XLR_BLOCKS):
            s[M.p_xlr_block(b)] = M.XLR_OPTS[b].index(("OUT", i * 4 + 1))
        for r, t in ((1, 0), (2, 10), (3, 28), (4, 38)):
            s[M.p_fx_type(r)] = t
        for i, n in enumerate(NAMES):
            b = f"/ch/{i + 1:02d}"
            s[f"{b}/config/name"] = n
            s[f"{b}/config/color"] = COLORS[i]
            s[f"{b}/mix/fader"] = 0.55 + random.random() * 0.2
            s[f"{b}/mix/pan"] = 0.5 + random.choice((0, 0, -.3, .3))
            s[f"{b}/eq/2/g"] = 0.5 + random.random() * .3 - .15
            s[f"{b}/eq/3/g"] = 0.5 + random.random() * .3 - .15
            s[f"{b}/eq/4/g"] = 0.5 + random.random() * .3 - .1
            s[f"{b}/preamp/hpon"] = 1 if i > 1 else 0
            s[f"{b}/dyn/on"] = 1 if i % 3 != 2 else 0
            s[f"{b}/gate/on"] = 1 if i < 7 else 0
            s[f"{b}/dyn/thr"] = 0.6
            s[f"{b}/gate/thr"] = 0.6
            s[M.p_ch_name(i + 1)] = n
        for i, n in enumerate(["Drums", "Band", "Vocals", "FX"]):
            s[f"/dca/{i + 1}/config/name"] = n
            s[f"/dca/{i + 1}/config/color"] = i + 1
        for i, n in enumerate(["Wedge 1", "Wedge 2", "IEM Dr", "IEM Bass", "IEM Gtr", "IEM Vox"]):
            s[f"/bus/{i + 1:02d}/config/name"] = n
            s[f"/bus/{i + 1:02d}/config/color"] = 4 + i % 3
            s[f"/ch/{(i % 8) + 1:02d}/mix/{i + 1:02d}/level"] = .6
        for i, n in enumerate(["Hall", "Plate", "Delay", "Chorus"]):
            s[f"/fxrtn/{i + 1:02d}/config/name"] = n
            s[f"/fxrtn/{i + 1:02d}/config/color"] = 5
            s[f"/fxrtn/{i + 1:02d}/mix/fader"] = .6
        s["/main/st/config/name"] = "Main"
        for i, n in enumerate(["Walk In", "Band Line Check", "Set 1", "Set 2 Acoustic", "Encore"]):
            s[f"/-show/showfile/scene/{i:03d}/name"] = n
            s[f"/-show/showfile/scene/{i:03d}/hasdata"] = 1
        for r in range(1, 9):
            for i in range(1, 65):
                s[f"/fx/{r}/par/{i:02d}"] = 0.5
        self.state = s
        self.client = None
        self.meter_subs = {}
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.env = [random.random() for _ in range(64)]
        threading.Thread(target=self._rx, daemon=True).start()
        threading.Thread(target=self._meters, daemon=True).start()

    def desk(self, path, value):
        """A change made on the console surface: pushed to the /xremote client."""
        self.state[path] = value
        if self.client:
            self.sock.sendto(osc_encode(path, value), self.client)

    def _rx(self):
        while True:
            data, peer = self.sock.recvfrom(65535)
            addr, args = osc_decode(data)
            if addr == "/xinfo":
                self.sock.sendto(osc_encode("/xinfo", "127.0.0.1", "Sim X32", "X32", "4.06"), peer)
            elif addr == "/xremote":
                self.client = peer
            elif addr == "/meters":
                self.meter_subs[args[0]] = (peer, time.time() + 10)
            elif addr in ("/load", "/save"):
                if addr == "/save" and len(args) >= 3:
                    self.state[f"/-show/showfile/scene/{args[1]:03d}/name"] = args[2]
                    self.state[f"/-show/showfile/scene/{args[1]:03d}/hasdata"] = 1
                if addr == "/load":
                    self.state["/-show/prepos/current"] = args[1]
                self.sock.sendto(osc_encode(addr, args[0], 1), peer)
            elif addr == "/-action/clearsolo":
                for i in range(1, 81):
                    self.desk(f"/-stat/solosw/{i:02d}", 0)
            elif args:
                self.state[addr] = args[0]
            elif addr in self.state:
                self.sock.sendto(osc_encode(addr, self.state[addr]), peer)

    def _meters(self):
        t = 0
        while True:
            time.sleep(0.05)
            t += 1
            now = time.time()
            lvl = []
            for i in range(32):
                self.env[i] = max(0.0, self.env[i] * 0.86)
                if random.random() < (0.12 if i < 9 else 0.04):
                    self.env[i] = random.random() * .9 + .1
                speak = i < len(NAMES) and NAMES[i] != "Spare"
                lvl.append(self.env[i] * (.5 + .3 * math.sin(i)) * (1 if speak else 0))
            gate = [1.0 if v > .02 else .3 for v in lvl]
            dyn = [min(1.0, 1 - max(0, v - .25) * .9) for v in lvl]
            buses = [sum(lvl[:8]) / 8 * (1 + .1 * i) for i in range(16)]
            main = sum(lvl) / 12
            m2 = buses + buses[:6] + [main, main * .97, main * .7] + [1.0] * 16 + [1.0] * 6 + [.9, 1.0]
            m3 = buses[:6] + [v * .5 for v in lvl[:8]] + [v * .6 for v in lvl[8:16]]
            pack = {"/meters/1": lvl + gate + dyn, "/meters/2": m2, "/meters/3": m3}
            for k, (peer, until) in list(self.meter_subs.items()):
                if now < until and k in pack:
                    f = pack[k]
                    self.sock.sendto(osc_encode(k, struct.pack("<i", len(f)) + struct.pack(f"<{len(f)}f", *f)), peer)


class TF1Sim:
    def __init__(self):
        self.state = {}
        for p, (a, x, y, to, _) in tf1.MAP.items():
            d = "" if to is str else (1 if a.endswith("/On") else 0)
            if a.endswith("/Level"):
                d = -32768 if "ToMix" in a else -1000
            self.state[(a, x, y)] = d
        for i, n in enumerate(NAMES[:16]):
            self.state[(f"{tf1.PRE}InCh/Label/Name", i, 0)] = n
        self.state[(f"{tf1.PRE}St/Label/Name", 0, 0)] = "ST"
        self.conns = []
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(4)
        self.port = self.srv.getsockname()[1]
        self.commands = []
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            c, _ = self.srv.accept()
            self.conns.append(c)
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    def desk(self, a, x, y, v):
        self.state[(a, x, y)] = v
        for c in self.conns:
            try:
                c.sendall(f"NOTIFY set {a} {x} {y} {v} \"{v}\"\n".encode())
            except OSError:
                pass

    def _client(self, c):
        buf = b""
        while True:
            try:
                d = c.recv(65536)
            except OSError:
                return
            if not d:
                return
            buf += d
            *lines, buf = buf.split(b"\n")
            for ln in lines:
                t = shlex.split(ln.decode())
                self.commands.append(ln.decode())
                if len(t) >= 4 and t[0] == "get":
                    v = self.state.get((t[1], int(t[2]), int(t[3])), 0)
                    txt = f'"{v}"' if isinstance(v, str) else f'{v} "{v}"'
                    c.sendall(f"OK get {t[1]} {t[2]} {t[3]} {txt}\n".encode())
                elif len(t) >= 5 and t[0] == "set":
                    v = t[4]
                    self.state[(t[1], int(t[2]), int(t[3]))] = v if not v.lstrip("-").isdigit() else int(v)
                    c.sendall(f"OK set {t[1]} {t[2]} {t[3]} {t[4]}\n".encode())
