"""Run: python tests/test_backend.py  (uses the simulators, no console needed)"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "app"))
import sim  # noqa: E402
import tf1  # noqa: E402
from console import db_to_fader, fader_to_db  # noqa: E402
from link import Link  # noqa: E402
from tf1 import TF1  # noqa: E402
from x32 import X32, osc_decode, osc_encode  # noqa: E402


def wait(fn, t=25.0):
    end = time.time() + t
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.02)
    return False


def main():
    # fader law
    for d in (10, 0, -10, -30, -60, -89):
        assert abs(fader_to_db(db_to_fader(d)) - d) < 0.01, d
    # OSC round trip with blob
    assert osc_decode(osc_encode("/a", 1, 0.5, "x", b"abc")) == ("/a", [1, 0.5, "x", b"abc"])

    xs, ts = sim.X32Sim(), sim.TF1Sim()
    a = X32("A", "127.0.0.1", port=xs.port)
    b = TF1("B", "127.0.0.1", port=ts.port)
    assert wait(lambda: a.connected), "x32 connect"
    assert wait(lambda: b.connected), "tf1 connect"
    assert wait(lambda: a.state.get("/ch/01/config/name") == "Kick In"), "x32 name"
    assert wait(lambda: a.progress() > .999), f"x32 read all {a.progress()}"
    assert wait(lambda: b.state.get("/ch/01/config/name") == "Kick In"), "tf1 name"
    assert wait(lambda: abs(b.state.get("/ch/02/mix/fader", 0) - db_to_fader(-10)) < .001), "tf1 fader"
    assert wait(lambda: b.progress() > .999), f"tf1 read all {b.progress()}"

    # value types follow the console
    assert isinstance(a.state["/ch/01/mix/on"], int) and isinstance(a.state["/ch/01/mix/fader"], float)
    a.write("/ch/05/mix/fader", 1, "app")
    assert wait(lambda: isinstance(xs.state["/ch/05/mix/fader"], float) and xs.state["/ch/05/mix/fader"] == 1.0), "float coercion"
    a.write("/ch/05/mix/on", 0.0, "app")
    assert wait(lambda: xs.state["/ch/05/mix/on"] == 0 and isinstance(xs.state["/ch/05/mix/on"], int)), "int coercion"

    # meters
    a.meter_clients = 1
    a.send("/meters", "/meters/1")
    a.send("/meters", "/meters/2")
    a.send("/meters", "/meters/3")
    assert wait(lambda: len(a.meter_bytes) == 167), f"meters {len(a.meter_bytes)}"

    # TF scale
    b.write("/ch/03/mix/fader", db_to_fader(-20), "app")
    assert wait(lambda: any(c.endswith("InCh/Fader/Level 2 0 -2000") for c in ts.commands)), "tf set"
    b.write("/main/st/mix/fader", db_to_fader(0), "app")
    assert wait(lambda: any(c.endswith("St/Fader/Level 1 0 0") for c in ts.commands)), "tf st R"
    b.write("/ch/03/mix/fader", 0.0, "app")
    assert wait(lambda: any(c.endswith("InCh/Fader/Level 2 0 -32768") for c in ts.commands)), "tf -inf"
    b.write("/ch/07/config/name", 'Hi "x"', "app")
    assert wait(lambda: any('Label/Name 6 0 "Hi x"' in c for c in ts.commands)), "tf name"

    # link: X32 surface drives TF1
    assert wait(lambda: not a.reading and not b.reading), "read done"
    lk = Link(lambda: (a, b), {"enabled": True, "direction": "a2b"})
    lk.attach(a)
    lk.attach(b)
    assert lk.fwd["ch32"] == "ch32" and "ch33" not in lk.fwd
    ts.commands.clear()
    xs.desk("/ch/04/mix/fader", db_to_fader(-5))
    assert wait(lambda: any(c.endswith("InCh/Fader/Level 3 0 -500") for c in ts.commands)), "a2b fader"
    xs.desk("/ch/04/mix/on", 0)
    assert wait(lambda: any(c.endswith("InCh/Fader/On 3 0 0") for c in ts.commands)), "a2b mute"
    # direction: TF move must not reach X32 in a2b
    before = xs.state["/ch/06/mix/fader"]
    ts.desk(f"{tf1.PRE}InCh/Fader/Level", 5, 0, -300)
    assert wait(lambda: abs(b.state["/ch/06/mix/fader"] - db_to_fader(-3)) < .002), "tf notify"
    time.sleep(.2)
    assert xs.state["/ch/06/mix/fader"] == before, "a2b leaked"

    # both ways, custom map: TF ch 33 -> X32 ch 1, and no echo storm
    lk.cfg.update(direction="both", map=[["ch1", "ch33"], ["ch2", "ch2"]])
    lk.rebuild()
    n0 = lk.count
    ts.desk(f"{tf1.PRE}InCh/Fader/Level", 32, 0, -700)
    assert wait(lambda: abs(xs.state["/ch/01/mix/fader"] - db_to_fader(-7)) < .002), "b2a map"
    time.sleep(.3)
    assert lk.count == n0 + 1, f"echo count {lk.count - n0}"
    # unmapped strip does nothing
    ts.commands.clear()
    xs.desk("/ch/09/mix/fader", .3)
    time.sleep(.2)
    assert not ts.commands, ts.commands

    # scene recall on the desk pauses the link
    lk.cfg.update(direction="a2b", map=[["ch1", "ch1"]])
    lk.rebuild()
    xs.desk("/-show/prepos/current", 3)
    assert wait(lambda: lk.paused_until > time.time()), "pause"
    ts.commands.clear()
    xs.desk("/ch/01/mix/fader", .2)
    time.sleep(.2)
    assert not ts.commands, "copied during pause"
    # sync
    lk.paused_until = 0
    lk.cfg["params"]["name"] = True
    lk.sync("a2b")
    assert wait(lambda: abs(b.state["/ch/01/mix/fader"] - .2) < .002)

    # A console read must never reach the other console, with the link on from the start
    xs2, ts2 = sim.X32Sim(), sim.TF1Sim()
    holder = {}
    lk2 = Link(lambda: (holder.get("a"), holder.get("b")), {"enabled": True, "direction": "both", "map": [["ch1", "ch1"], ["ch2", "ch2"]]})
    holder["b"] = TF1("B", "127.0.0.1", port=ts2.port)
    lk2.attach(holder["b"])
    holder["a"] = a2 = X32("A", "127.0.0.1", port=xs2.port)
    lk2.attach(a2)
    lk2.rebuild()
    assert wait(lambda: a2.progress() > .999 and holder["b"].progress() > .999), "read 2"
    time.sleep(.4)
    assert lk2.count == 0, f"read was copied {lk2.count} times: {lk2.last}"
    # A real move still links after the read, and a re-read with a new value does not
    wait(lambda: not a2.reading and not holder["b"].reading)
    xs2.desk("/ch/01/mix/fader", db_to_fader(-12))
    assert wait(lambda: any(c.endswith("InCh/Fader/Level 0 0 -1200") for c in ts2.commands)), "move after read"
    n = lk2.count
    xs2.state["/ch/02/mix/fader"] = .111  # changed while we were not looking, as in a scene recall
    a2.refresh()
    assert wait(lambda: abs(a2.state["/ch/02/mix/fader"] - .111) < .002), "reread"
    time.sleep(.2)
    assert lk2.count == n, "re-read was copied"

    # Follow mode: the console reports its screen, and the screen paths reach the console
    import mixer
    assert wait(lambda: a2.state.get("/-stat/screen/screen") == 0), "screen read"
    xs2.desk("/-stat/selidx", 4)
    xs2.desk("/-stat/screen/screen", 0)
    xs2.desk("/-stat/screen/CHAN/page", 4)
    assert wait(lambda: a2.state.get("/-stat/selidx") == 4 and a2.state.get("/-stat/screen/CHAN/page") == 4), "follow push"
    assert lk2.count == n, "screen change was linked"
    for p in ("/-stat/selidx", "/-stat/screen/screen", "/-stat/screen/FX/page", "/config/solo/source", "/config/talk/A/destmap", "/config/osc/f1"):
        assert mixer.WRITE_OK.match(p), p
    a2.write("/-stat/screen/FX/page", 3, "app")
    assert wait(lambda: xs2.state.get("/-stat/screen/FX/page") == 3), "page write"
    assert isinstance(xs2.state["/-stat/screen/FX/page"], int)
    a2.write("/config/osc/f1", 0.25, "app")
    assert wait(lambda: xs2.state.get("/config/osc/f1") == 0.25), "float write"

    # Channel link and insert position from the channel menu
    for p in ("/config/chlink/1-2", "/config/mtxlink/5-6", "/ch/01/insert/pos", "/ch/01/insert/on"):
        assert mixer.WRITE_OK.match(p), p
    assert wait(lambda: a2.state.get("/config/chlink/31-32") == 0), "link read"
    a2.write("/config/chlink/3-4", 1, "app")
    assert wait(lambda: xs2.state.get("/config/chlink/3-4") == 1), "link write"
    assert isinstance(xs2.state["/config/chlink/3-4"], int)

    # Direct insert: no device set up
    import routing
    routing.X, routing.CFG = a2, {"devices": [], "auxPool": []}
    code, r = routing.route_insert("ch5", "@fx", 3)
    assert code == 200, r
    assert wait(lambda: xs2.state.get("/ch/05/insert/sel") == 3 and xs2.state.get("/ch/05/insert/on") == 1), "fx insert"
    code, r = routing.route_insert("ch5", "@aux", 2)
    assert code == 200 and "Aux Out 2" in r["msg"], r
    assert wait(lambda: xs2.state.get("/ch/05/insert/sel") == 18), "aux insert"
    assert routing.route_insert("ch5", "@fx", 17)[0] == 400
    assert routing.route_insert("aux1", "@fx", 1)[0] == 409
    code, r = routing.route_insert("ch5", "", 0)
    assert code == 200 and wait(lambda: xs2.state.get("/ch/05/insert/sel") == 0 and xs2.state.get("/ch/05/insert/on") == 0), r

    # The source label follows the channel source, not the channel number
    import x32map as M
    st = {M.p_in_block(M.IN_BLOCKS[0]): 0, M.p_in_block("AUX"): 0}
    base = M.resolve_fader("ch1", st)
    assert base == M.resolve_fader("ch1", {**st, "/ch/01/config/source": 1})
    moved = M.resolve_fader("ch1", {**st, "/ch/01/config/source": 5})
    assert moved["kind"] == base["kind"] and moved["n"] == base["n"] + 4, moved
    assert M.resolve_fader("ch9", {**st, "/ch/09/config/source": 3})["n"] == base["n"] + 2
    for v, kind, n, text in ((0, "OFF", 0, "Off"), (39, "USB", 1, "USB L"), (40, "USB", 2, "USB R"),
                             (41, "FX", 1, "FX 1L"), (48, "FX", 8, "FX 4R"), (49, "BUS", 1, "Bus 01"), (64, "BUS", 16, "Bus 16")):
        r = M.resolve_fader("ch1", {**st, "/ch/01/config/source": v})
        assert (r["kind"], r["n"], M.source_text(r)) == (kind, n, text), (v, r)
    assert M.resolve_fader("ch1", {**st, "/ch/01/config/source": 33}) == M.resolve_fader("aux1", st)
    assert M.resolve_fader("aux7", {})["kind"] == "USB" and M.resolve_fader("aux8", {})["n"] == 2
    assert wait(lambda: a2.state.get("/ch/07/config/source") == 7 and a2.state.get("/auxin/08/config/source") == 40), "source read"
    v = a2.routing_version
    xs2.desk("/ch/07/config/source", 0)
    assert wait(lambda: a2.routing_version > v), "source change updates the label"
    code, r = routing.route_input("ch7", "", 0)
    assert code == 409 and "source is Off" in r["error"], r
    print("ALL OK")


main()
