"""Test the X32 driver against a console. Run: python tests/test_live.py <ip>
Writes a few values and restores them. Does not recall or save scenes."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "app"))
from x32 import X32  # noqa: E402

ip = sys.argv[1]


def wait(fn, t):
    end = time.time() + t
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.05)
    return False


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""), flush=True)
    return ok


x = X32("A", ip)
if not check("connect (/xinfo reply)", wait(lambda: x.connected, 6), x.info):
    sys.exit(1)

t0 = time.time()
wait(lambda: x.progress() > .999, 45)
wait(lambda: not x.read_lock.locked(), 20)
have = x.snapshot()
want = [*x.fast, *x.routing_paths, *x.slow]
missing = [p for p in want if p not in have]
check("full read", not missing, f"{len(want) - len(missing)}/{len(want)} in {time.time() - t0:.1f}s")
groups = {}
for p in missing:
    k = "/".join(p.split("/")[1:2]) + " .../" + p.split("/")[-1]
    groups[k] = groups.get(k, 0) + 1
for k, n in sorted(groups.items(), key=lambda a: -a[1])[:25]:
    print(f"     missing {n:4d}  {k}")

# Value types the console reports, against the driver's guess
import mixer  # noqa: E402
bad = [(p, t.__name__) for p, t in x.types.items() if t in (int, float) and p in x.slow and mixer.default_is_float(p) != (t is float)]
check("value types match the guess table", not bad, str(bad[:12]) if bad else "")

for p in ("/ch/01/config/name", "/ch/01/mix/fader", "/ch/01/mix/on", "/ch/01/eq/1/f", "/ch/01/dyn/ratio", "/-stat/solosw/01",
          "/headamp/000/gain", "/-show/prepos/current", "/-show/showfile/scene/000/name", "/fx/1/type", "/config/routing/IN/1-8", "/config/userrout/in/01"):
    print(f"     {p} = {have.get(p)!r}")

# Write, read back, restore
for p, new in (("/ch/32/mix/fader", .123), ("/ch/32/mix/on", None), ("/ch/32/eq/1/g", .6), ("/bus/16/mix/fader", .321), ("/dca/8/fader", .456), ("/ch/32/config/name", "MDtest")):
    old = have.get(p)
    if old is None:
        check(f"write {p}", False, "no old value, skipped")
        continue
    val = (0 if old else 1) if new is None else new
    x.write(p, val)
    time.sleep(.5)
    x.recent.pop(p, None)
    x.state.pop(p, None)
    x.send(p)
    ok = wait(lambda: p in x.state, 2)
    got = x.state.get(p)
    same = ok and (abs(got - val) < .002 if isinstance(val, float) else got == val)
    check(f"write {p}", same, f"sent {val!r} read {got!r}")
    x.write(p, old)
time.sleep(.5)
back = [p for p in ("/ch/32/mix/fader", "/ch/32/mix/on", "/ch/32/eq/1/g", "/bus/16/mix/fader", "/dca/8/fader", "/ch/32/config/name") if p in have]
for p in back:
    x.recent.pop(p, None)
    x.state.pop(p, None)
    x.send(p)
wait(lambda: all(p in x.state for p in back), 2)
check("values restored", all(x.state.get(p) is not None and (abs(x.state[p] - have[p]) < .002 if isinstance(have[p], float) else x.state[p] == have[p]) for p in back))

# Meters
x.meter_clients = 1
for m in ("/meters/1", "/meters/2", "/meters/3"):
    x.send("/meters", m)
ok = wait(lambda: len(x.meters) == 3, 4)
check("meters /1 /2 /3", ok, str({k: len(v) for k, v in x.meters.items()}))
b1 = x.meter_bytes
time.sleep(1)
check("meters move", x.meter_bytes != b1, f"max byte {max(x.meter_bytes) if x.meter_bytes else None}")

# Stays connected past the 10 s /xremote and meter timeouts
time.sleep(12)
check("connected after 12 s", x.connected)
n0 = x.meter_bytes
time.sleep(1)
check("meters still running after 12 s", x.meter_bytes != n0)
x.stop()
