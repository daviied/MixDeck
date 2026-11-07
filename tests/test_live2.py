"""Second live check: meter stream, /xremote pushes from another client, scene save and recall. argv: ip"""
import socket
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "app"))
from x32 import X32, osc_decode, osc_encode  # noqa: E402

ip = sys.argv[1]
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(.2)


def rx(t):
    out, end = [], time.time() + t
    while time.time() < end:
        try:
            out.append(osc_decode(s.recv(65535)))
        except socket.timeout:
            pass
    return out


# Raw meter stream
for m in ("/meters/1", "/meters/2", "/meters/3"):
    s.sendto(osc_encode("/meters", m), (ip, 10023))
got = rx(2)
cnt = {}
for a, args in got:
    cnt[a] = cnt.get(a, 0) + 1
print("meter packets in 2 s:", cnt)
for a, args in got:
    if a.startswith("/meters/") and args:
        b = args[0]
        n = struct.unpack("<i", b[:4])[0]
        v = struct.unpack(f"<{n}f", b[4:4 + 4 * n])
        print(" ", a, "len", len(b), "count", n, "nonzero", sum(1 for x in v if x), "max", max(v), "min", min(v))
        cnt[a] = 0
        if not any(cnt.values()):
            break
print("after 12 s without renewal:")
time.sleep(12)
rx(.2)
print(" ", len([1 for a, _ in rx(1) if a.startswith("/meters/")]), "meter packets in 1 s")

# Push: another client changes a value; the driver must hear it
x = X32("A", ip)
time.sleep(1.5)
p = "/ch/31/mix/fader"
x.send(p)
time.sleep(.3)
old = x.state[p]
s.sendto(osc_encode(p, 0.222), (ip, 10023))
end = time.time() + 2
while time.time() < end and abs(x.state[p] - .222) > .002:
    time.sleep(.02)
print("PASS" if abs(x.state[p] - .222) < .002 else "FAIL", "push from other client", x.state[p], f"after {2 - (end - time.time()):.2f}s")
s.sendto(osc_encode(p, old), (ip, 10023))
time.sleep(.3)

# Scene: slot 99, only if empty
H = "/-show/showfile/scene/099/hasdata"
x.read_paths([H, "/-show/showfile/scene/099/name", "/-show/prepos/current"])
time.sleep(.5)
print("scene 99 before:", x.state.get(H), repr(x.state.get("/-show/showfile/scene/099/name")), "current", x.state.get("/-show/prepos/current"))
if x.state.get(H):
    print("SKIP scene test: slot 99 in use")
else:
    print(x.scene("save", 99, "MDtest"))
    time.sleep(1)
    print("after save:", x.state.get(H), repr(x.state.get("/-show/showfile/scene/099/name")))
    print(x.scene("recall", 99))
    time.sleep(1.2)
    x.read_paths(["/-show/prepos/current"])
    time.sleep(.3)
    print("current after recall:", x.state.get("/-show/prepos/current"))
    x.send("/delete", "scene", 99)
    time.sleep(.3)
    x.read_paths([H, "/-show/showfile/scene/099/name"])
    time.sleep(.3)
    print("after delete:", x.state.get(H), repr(x.state.get("/-show/showfile/scene/099/name")))
x.stop()
