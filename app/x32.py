"""X32 / M32 driver: OSC over UDP 10023, state cache, meters."""
import math
import socket
import struct
import threading
import time

import mixer
import x32map
from console import Console

XREMOTE_EVERY = 5.0
SCREEN_POLL = 1.0
ROUTING_REREAD = 120.0
READBACK_DELAY = 0.5
STALE_WINDOW = 0.4
METER_IDS = ("/meters/1", "/meters/2", "/meters/3")
METER_LEN = {"/meters/1": 96, "/meters/2": 49, "/meters/3": 22}


def _pad(b):
    return b + b"\0" * (4 - len(b) % 4)


def osc_encode(addr, *args):
    msg = _pad(addr.encode())
    tags = ","
    data = b""
    for a in args:
        if isinstance(a, bool):
            a = int(a)
        if isinstance(a, int):
            tags += "i"
            data += struct.pack(">i", a)
        elif isinstance(a, float):
            tags += "f"
            data += struct.pack(">f", a)
        elif isinstance(a, bytes):
            tags += "b"
            data += struct.pack(">i", len(a)) + a + b"\0" * ((4 - len(a) % 4) % 4)
        else:
            tags += "s"
            data += _pad(str(a).encode())
    return msg + _pad(tags.encode()) + data


def _read_str(buf, i):
    end = buf.index(b"\0", i)
    s = buf[i:end].decode("utf-8", "replace")
    i = end + 1
    i += (4 - i % 4) % 4
    return s, i


def osc_decode(buf):
    addr, i = _read_str(buf, 0)
    if i >= len(buf):
        return addr, []
    tags, i = _read_str(buf, i)
    args = []
    for t in tags[1:]:
        if t == "i":
            args.append(struct.unpack(">i", buf[i:i + 4])[0]); i += 4
        elif t == "f":
            args.append(struct.unpack(">f", buf[i:i + 4])[0]); i += 4
        elif t == "s":
            s, i = _read_str(buf, i); args.append(s)
        elif t == "b":
            n = struct.unpack(">i", buf[i:i + 4])[0]; i += 4
            args.append(buf[i:i + n]); i += n + (4 - n % 4) % 4
    return addr, args


def level_byte(v):
    """Linear meter value to one byte: -80..+20 dB."""
    if v <= 0.0001:
        return 0
    return max(0, min(255, int((20 * math.log10(v) + 80) * 2.55)))


class X32(Console):
    kind = "x32"
    caps = {"type": "x32", "ch": 32, "aux": 8, "fx": 8, "bus": 16, "mtx": 6, "dca": 8, "mono": True, "full": True,
            "meters": True, "sceneNames": True}

    def __init__(self, slot, ip, name="", port=10023):
        super().__init__(slot, ip, name)
        self.port = port
        self.last_rx = 0.0
        self.types = {}
        self.recent = {}
        self.routing_paths = set(x32map.all_read_paths())
        self.fast = mixer.fast_defaults()
        self.slow = mixer.slow_defaults()
        self.total_reads = len(self.routing_paths | set(self.fast) | set(self.slow))
        self.meters = {}
        self.pending_ack = {}
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        self.sock.bind(("0.0.0.0", 0))
        self.sock.settimeout(1.0)
        self.read_lock = threading.Lock()
        threading.Thread(target=self._rx, daemon=True).start()
        threading.Thread(target=self._keepalive, daemon=True).start()
        threading.Thread(target=self._screen_poll, daemon=True).start()
        self.refresh()

    @property
    def connected(self):
        return (time.time() - self.last_rx) < 12

    def stop(self):
        self.stopped = True
        try:
            self.sock.close()
        except OSError:
            pass

    def send(self, addr, *args):
        if not self.ip or self.stopped:
            return
        try:
            self.sock.sendto(osc_encode(addr, *args), (self.ip, self.port))
        except OSError:
            pass

    def set_ip(self, ip):
        self.ip = ip
        self.last_rx = 0
        self.refresh()

    def _typed(self, path, value):
        t = self.types.get(path)
        if t is None:
            t = float if mixer.default_is_float(path) else (str if isinstance(value, str) else int)
        return t(value)

    def write(self, path, value, origin="app"):
        """Mixer write. No read back: fader moves arrive at 25 Hz."""
        v = self._typed(path, value)
        self.send(path, v)
        self.recent[path] = (v, time.time())
        self._store(path, v, origin)

    def set(self, addr, value):
        """Routing write, with read back (from X32 Router)."""
        self.send(addr, value)
        self.recent[addr] = (value, time.time())
        self._store(addr, value, "app")
        threading.Timer(READBACK_DELAY, self.send, (addr,)).start()

    def refresh(self):
        threading.Thread(target=self._refresh, daemon=True).start()

    def _refresh(self):
        if not self.read_lock.acquire(blocking=False):
            return
        self.reading = True
        try:
            self.send("/xinfo")
            self.send("/xremote")
            for p in list(self.fast) + list(self.routing_paths):
                self.send(p)
                time.sleep(0.002)
            for p in self.slow:
                self.send(p)
                time.sleep(0.002)
            for attempt in range(3):  # UDP can drop: read what is missing, slower each pass
                time.sleep(0.3)
                have = self.snapshot()
                missing = [p for p in [*self.fast, *self.routing_paths, *self.slow] if p not in have]
                if not missing:
                    break
                for p in missing:
                    self.send(p)
                    time.sleep(0.004 * (attempt + 1))
        finally:
            self.reading = False
            self.read_lock.release()

    def read_paths(self, paths):
        def go():
            for p in paths:
                self.send(p)
                time.sleep(0.002)
        threading.Thread(target=go, daemon=True).start()

    def scene(self, action, slot=0, name="", note=""):
        if action == "recall":
            self.send("/load", "scene", int(slot))
            self.write("/-show/prepos/current", int(slot))  # so "next scene" follows the recall
            threading.Timer(0.6, self.refresh).start()
            return True, f"Scene {slot:02d} recalled"
        if action == "save":
            self.send("/save", "scene", int(slot), str(name)[:32], str(note)[:32])
            threading.Timer(0.4, self.read_paths, ([f"/-show/showfile/scene/{slot:03d}/name",
                                                    f"/-show/showfile/scene/{slot:03d}/hasdata"],)).start()
            return True, f"Scene {slot:02d} saved"
        return False, "Bad action"

    def _rx(self):
        while not self.stopped:
            try:
                data, _ = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                time.sleep(0.2)
                continue
            try:
                addr, args = osc_decode(data)
            except Exception:
                continue
            was = self.connected
            self.last_rx = time.time()
            if addr == "/xinfo" and len(args) >= 4:
                self.info = f"{args[2]} \"{args[1]}\" fw {args[3]} at {args[0]}"
            elif addr in METER_LEN and args and isinstance(args[0], bytes):
                self._meter(addr, args[0])
            elif addr in ("/load", "/save"):
                pass
            elif args and not addr.startswith("/meters"):
                v = args[0]
                self.types[addr] = type(v) if type(v) in (int, float, str) else int
                r = self.recent.get(addr)
                if not (r and time.time() - r[1] < STALE_WINDOW and v != r[0]):  # old value from before our own set
                    self._store(addr, v, "desk")
            if not was:
                self.bump()
                self.refresh()

    def _meter(self, addr, blob):
        if len(blob) < 4:
            return
        n = struct.unpack("<i", blob[:4])[0]
        n = min(n, (len(blob) - 4) // 4, METER_LEN[addr])
        self.meters[addr] = bytes(level_byte(x) for x in struct.unpack(f"<{n}f", blob[4:4 + n * 4]))
        self.meter_bytes = b"".join(self.meters.get(m, bytes(METER_LEN[m])) for m in METER_IDS)

    def _screen_poll(self):
        """Follow mode: a lost UDP push must not leave the wrong page on screen."""
        paths = [p for p in self.fast if p == "/-stat/selidx" or p.startswith("/-stat/screen/")]
        while not self.stopped:
            time.sleep(SCREEN_POLL)
            if self.ip and self.meter_clients > 0 and self.connected and not self.reading:
                for p in paths:
                    self.send(p)

    def _keepalive(self):
        last_read = time.time()
        while not self.stopped:
            if self.ip:
                self.send("/xremote")
                self.send("/xinfo")
                if self.meter_clients > 0:
                    for m in METER_IDS:
                        self.send("/meters", m)
                if self.connected and time.time() - last_read > ROUTING_REREAD:
                    last_read = time.time()
                    self.read_paths(list(self.routing_paths))
            time.sleep(XREMOTE_EVERY)


def discover(timeout=1.5):
    """Find consoles like X32-Edit does: broadcast /xinfo on UDP 10023."""
    targets = {"255.255.255.255"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                targets.add(".".join(ip.split(".")[:3]) + ".255")
    except OSError:
        pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.bind(("0.0.0.0", 0))
    s.settimeout(0.2)
    for t in targets:
        try:
            s.sendto(osc_encode("/xinfo"), (t, 10023))
        except OSError:
            pass
    found = {}
    end = time.time() + timeout
    while time.time() < end:
        try:
            data, src = s.recvfrom(4096)
            addr, args = osc_decode(data)
        except (socket.timeout, OSError, ValueError):
            continue
        if addr == "/xinfo" and len(args) >= 4:
            found[src[0]] = {"ip": src[0], "name": str(args[1]), "model": str(args[2]), "fw": str(args[3]), "type": "x32"}
    s.close()
    return list(found.values())
