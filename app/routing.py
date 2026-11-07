"""Stage box routing logic, from X32 Router. Works on one X32 console."""
import threading
import uuid

import x32map as M

X = None          # the X32 console that routing applies to
CFG = None
cfg_lock = threading.Lock()
save_cfg = None


def init(console, cfg, saver):
    global X, CFG, save_cfg
    X, CFG, save_cfg = console, cfg, saver


# ---------- validation ----------
PORTS_IN = M.IN_PORTS
PORTS_OUT = M.OUT_PORTS


def clean_device(d):
    def i(v, lo, hi, dflt):
        try:
            v = int(v)
        except Exception:
            return dflt
        return max(lo, min(hi, v))
    in_port = d.get("inPort") if d.get("inPort") in PORTS_IN else "A"
    out_port = d.get("outPort") if d.get("outPort") in PORTS_OUT else ""
    in_start = i(d.get("inStart"), 1, M.PORT_SIZE[in_port], 1)
    in_count = i(d.get("inCount"), 0, M.PORT_SIZE[in_port] - in_start + 1, 0)
    out_start = i(d.get("outStart"), 1, M.PORT_SIZE[out_port] if out_port else 1, 1)
    out_count = i(d.get("outCount"), 0, (M.PORT_SIZE[out_port] - out_start + 1) if out_port else 0, 0)
    kind = "insert" if d.get("kind") == "insert" else "box"
    ins_type = d.get("insType") if d.get("insType") in M.INS_TYPES else "AUX"
    ins_max = M.INS_TYPES[ins_type][1]
    ins_start = 1 if ins_type == "POOL" else i(d.get("insStart"), 1, ins_max, 1)
    ins_count = i(d.get("insCount"), 0, ins_max - ins_start + 1, 0)
    if kind == "insert":
        in_count = out_count = 0
    else:
        ins_count = 0
    return {
        "id": str(d.get("id") or uuid.uuid4().hex[:8])[:16],
        "name": str(d.get("name") or "Device")[:40],
        "preset": str(d.get("preset") or "CUSTOM")[:10],
        "kind": kind,
        "inPort": in_port, "inStart": in_start, "inCount": in_count,
        "outPort": out_port, "outStart": out_start, "outCount": out_count,
        "insType": ins_type, "insStart": ins_start, "insCount": ins_count,
        "cols": i(d.get("cols"), 1, 16, 8),
        "labels": clean_labels(d.get("labels"), {"in": in_count, "out": out_count, "ins": ins_count}),
        "io": clean_io(d.get("io"), ins_count) if kind == "insert" and ins_type in ("AUX", "POOL") else {},
    }


def clean_io(io, cnt):
    """Outboard wiring per slot: {"1": {"send": "devId:jack", "ret": "devId:jack"}}."""
    out = {}
    io = io if isinstance(io, dict) else {}
    for s, v in io.items():
        try:
            s = int(s)
        except (TypeError, ValueError):
            continue
        if not (1 <= s <= cnt) or not isinstance(v, dict):
            continue
        e = {}
        for k in ("send", "ret"):
            x = str(v.get(k) or "")[:40]
            if x.count(":") == 1:
                e[k] = x
        if e:
            out[str(s)] = e
    return out


def split_ref(ref):
    try:
        dev, j = ref.split(":")
        return dev, int(j)
    except (AttributeError, ValueError):
        return None, 0


def clean_labels(lab, counts):
    out = {}
    lab = lab if isinstance(lab, dict) else {}
    for k, cnt in counts.items():
        src = lab.get(k) if isinstance(lab.get(k), dict) else {}
        m = {}
        for j, v in src.items():
            try:
                j = int(j)
            except (TypeError, ValueError):
                continue
            v = str(v).strip()[:32]
            if 1 <= j <= cnt and v:
                m[str(j)] = v
        out[k] = m
    return out


def dev_defaults(d):
    """Fill fields missing in configs saved by older versions."""
    return {**M.PRESETS["CUSTOM"], "inCount": 0, "outCount": 0, "outPort": "",
            "labels": {"in": {}, "out": {}, "ins": {}}, "io": {}, **d}


def allowed_block_paths():
    p = {M.p_in_block(b) for b in M.IN_BLOCKS}
    p.add(M.p_in_block("AUX"))
    for port in M.BLOCK_OUT_PORTS:
        p |= {M.p_out_block(port, b) for b in M.out_blocks(port)}
    p |= {M.p_xlr_block(b) for b in M.XLR_BLOCKS}
    return p


ALLOWED_BLOCKS = allowed_block_paths()

# ---------- state view ----------
def find_jack(devices, port, n):
    for d in devices:
        if d["inPort"] == port and d["inStart"] <= n < d["inStart"] + d["inCount"]:
            return d, n - d["inStart"] + 1
    return None, None


def phys_label(devices, port, n):
    if port in M.PORT_NAMES:
        d, j = find_jack(devices, port, n)
        base = f"{M.PORT_SHORT[port]}{n}"
        return (f"{d['name']} In {j}", base, d["id"], j) if d else (f"{M.PORT_NAMES[port]} {n}", base, None, None)
    if port == "OFF":
        return ("Off", "", None, None)
    if port == "TB":
        return ("Talkback", "", None, None)
    return ("?", "", None, None)


def build_state():
    st = X.snapshot()
    with cfg_lock:
        devices = [dev_defaults(d) for d in CFG.get("devices", [])]
        ip = CFG.get("x32Ip", "")
    jacks_in = {d["id"]: {} for d in devices}
    slots = {d["id"]: {} for d in devices}
    faders = []
    for f in M.FADERS:
        r = M.resolve_fader(f, st)
        name = st.get(M.p_ch_name(int(f[2:]))) if f.startswith("ch") else st.get(M.p_aux_name(int(f[3:])))
        item = {"id": f, "label": M.fader_label(f), "name": name or "", "kind": r["kind"], "n": r["n"]}
        if r["kind"] == "UIN":
            item["via"] = f"User In {r['n']}"
        if "phys" in r:
            lab, short, did, j = phys_label(devices, *r["phys"])
            item["src"], item["srcShort"] = lab, short
            if did:
                jacks_in[did].setdefault(j, []).append(f)
                dv = next(x for x in devices if x["id"] == did)
                item["plug"] = dv["labels"].get("in", {}).get(str(j), "")
        else:
            item["src"] = M.source_text(r)
        item["routable"] = r["kind"] == "UIN"
        # insert
        iv = st.get(M.p_ins_sel(f))
        ion = st.get(M.p_ins_on(f))
        item["ins"] = M.ins_label(iv)
        item["insOn"] = bool(ion)
        t, n = M.ins_from_value(iv)
        unit = pool_assign().get(str(n)) if t == "AUX" else None
        pd, pch = split_ref(unit) if unit else (None, 0)
        pdev = next((d for d in devices if d["id"] == pd and d["insType"] == "POOL"), None)
        if pdev and 1 <= pch <= pdev["insCount"]:
            item["ins"] = f"{pdev['name']} {pch} (Aux {n})" if pdev["insCount"] > 1 else f"{pdev['name']} (Aux {n})"
            if ion:
                slots[pdev["id"]].setdefault(pch, []).append(f)
        elif t:
            for d in devices:
                if d["kind"] == "insert" and d["insType"] == t and d["insStart"] <= n < d["insStart"] + d["insCount"]:
                    s = n - d["insStart"] + 1
                    item["ins"] = f"{d['name']} {s}"
                    slots[d["id"]].setdefault(s, []).append(f)
        faders.append(item)
    jacks_out = {}
    for d in devices:
        o = {}
        if d["outPort"]:
            for j in range(1, d["outCount"] + 1):
                r = M.resolve_dev_output(d["outPort"], d["outStart"] + j - 1, st)
                pick = "mix" if r["kind"] == "MIX" else ("uout" if r["kind"] == "UOUT" else "")
                o[j] = {"label": r["label"], "routable": bool(pick), "pick": pick, "src": r.get("src"),
                        "via": f"User Out {r['n']}" if r["kind"] == "UOUT" else ""}
        jacks_out[d["id"]] = o
    blocks = {
        "in": [{"path": M.p_in_block(b), "label": f"Ch {b}", "value": st.get(M.p_in_block(b))} for b in M.IN_BLOCKS],
        "aux": {"path": M.p_in_block("AUX"), "label": "Aux 1-6", "value": st.get(M.p_in_block("AUX"))},
        "out": {port: [{"path": M.p_out_block(port, b), "label": f"{M.PORT_NAMES[port]} Out {b}",
                        "value": st.get(M.p_out_block(port, b))} for b in M.out_blocks(port)] for port in M.BLOCK_OUT_PORTS},
        "xlr": [{"path": M.p_xlr_block(b), "label": f"XLR Out {b}", "block": b, "value": st.get(M.p_xlr_block(b))} for b in M.XLR_BLOCKS],
    }
    slot_info = {}
    for d in devices:
        if d["kind"] != "insert":
            continue
        info = {}
        for s in range(1, d["insCount"] + 1):
            n = d["insStart"] + s - 1
            e = {}
            if d["insType"] == "FX":
                rack = (n + 1) // 2
                fi = M.fx_type_info(st.get(M.p_fx_type(rack)), rack)
                e = {"fx": f"FX{rack} {fi['type']}", "warn": "" if fi["insertOk"] is not False
                     else f"FX{rack} has {fi['type']} loaded. That is a send-type effect, not an insert type."}
            else:
                io = d["io"].get(str(s), {})
                e = {"send": ref_label(devices, io.get("send"), "out"), "ret": ref_label(devices, io.get("ret"), "in")}
                if d["insType"] == "POOL":
                    unit = f"{d['id']}:{s}"
                    e["aux"] = next((int(k) for k, u in pool_assign().items() if u == unit and slots[d["id"]].get(s)), 0)
                    if not (e["send"] and e["ret"]):
                        e["warn"] = "Set the send and return jacks on the Devices tab."
            info[s] = e
        slot_info[d["id"]] = info
    return {
        "connected": X.connected, "info": X.info, "mock": False, "x32Ip": X.ip,
        "devices": devices, "faders": faders, "jacksIn": jacks_in, "jacksOut": jacks_out,
        "slots": slots, "slotInfo": slot_info, "blocks": blocks,
        "auxPool": aux_pool(), "auxUse": aux_use_view(st, devices),
    }


def aux_pool():
    return [n for n in CFG.get("auxPool", list(range(1, M.AUX_COUNT + 1))) if 1 <= n <= M.AUX_COUNT]


def pool_assign():
    return CFG.setdefault("auxAssign", {})


def aux_in_use(st):
    """Aux N -> fader using it as an insert (insert on)."""
    use = {}
    for f in M.FADERS:
        t, n = M.ins_from_value(st.get(M.p_ins_sel(f)))
        if t == "AUX" and st.get(M.p_ins_on(f)):
            use.setdefault(n, f)
    return use


def uin_users(st, n):
    return [M.fader_label(f) for f in M.FADERS if f.startswith("ch")
            and (r := M.resolve_fader(f, st))["kind"] == "UIN" and r["n"] == n]


def aux_use_view(st, devices):
    use = aux_in_use(st)
    out = []
    for n in range(1, M.AUX_COUNT + 1):
        unit = pool_assign().get(str(n))
        dev_id, ch = split_ref(unit) if unit else (None, 0)
        d = next((x for x in devices if x["id"] == dev_id), None)
        out.append({"aux": n, "pool": n in aux_pool(), "fader": M.fader_label(use[n]) if n in use else "",
                    "unit": (f"{d['name']} {ch}" if d and d["insCount"] > 1 else d["name"]) if d and n in use else "",
                    "uinBusy": ", ".join(uin_users(st, n))})
    return out


def ref_label(devices, ref, side):
    dev_id, j = split_ref(ref)
    d = next((x for x in devices if x["id"] == dev_id), None) or get_dev(dev_id)
    if not d:
        return ""
    lab = d["labels"].get(side, {}).get(str(j), "")
    return f"{d['name']} {'In' if side == 'in' else 'Out'} {j}" + (f" ({lab})" if lab else "")


# The console's own rear jacks. Always there for insert wiring, no device needed.
CONSOLE_DEVS = [
    {"id": "@xlr", "name": "Console XLR", "kind": "box", "inPort": "LOCAL", "inStart": 1, "inCount": 32,
     "outPort": "XLR", "outStart": 1, "outCount": 16},
    {"id": "@aux", "name": "Console Aux", "kind": "box", "inPort": "AUX", "inStart": 1, "inCount": 6,
     "outPort": "AUXOUT", "outStart": 1, "outCount": 6},
]


STATIC_META = {
    "inOpts": M.in_block_options(), "auxOpts": M.aux_block_options(), "outOpts": M.out_block_options(), "xlrOpts": M.xlr_block_options(), "consoleDevs": CONSOLE_DEVS,
    "uoutSources": M.uout_source_groups(), "mixSources": M.mix_source_groups(),
    "presets": M.PRESETS, "portNames": M.PORT_NAMES, "portSize": M.PORT_SIZE,
    "inPorts": M.IN_PORTS, "outPorts": M.OUT_PORTS,
    "insTypes": {k: {"name": M.INS_TYPE_NAMES[k], "count": v[1]} for k, v in M.INS_TYPES.items()},
}


def get_dev(dev_id):
    d = next((x for x in CFG["devices"] if x["id"] == dev_id), None)
    d = d or next((x for x in CONSOLE_DEVS if x["id"] == dev_id), None)
    return dev_defaults(d) if d else None


# ---------- routing actions ----------
def route_input(fader, dev_id, jack):
    """jack 0 or dev_id empty = unassign (User In set to Off)."""
    if fader not in M.FADERS:
        return 400, {"error": "Bad fader"}
    r = M.resolve_fader(fader, X.snapshot())
    if r["kind"] in ("OFF", "FX", "BUS", "USB"):
        return 409, {"error": f"{M.fader_label(fader)} source is {M.source_text(r)}. Set its source to an input on the console."}
    if r["kind"] != "UIN":
        return 409, {"error": f"{M.fader_label(fader)} is not fed by a User In. Set its block to User In on the Blocks tab."}
    if not dev_id:
        X.set(M.p_uin(r["n"]), 0)
        return 200, {"ok": True, "msg": f"{M.fader_label(fader)} unassigned (User In {r['n']} = Off)"}
    d = get_dev(dev_id)
    if not d or not (1 <= jack <= d["inCount"]):
        return 400, {"error": "Bad device input"}
    n = d["inStart"] + jack - 1
    v = M.src_value(d["inPort"], n)
    X.set(M.p_uin(r["n"]), v)
    return 200, {"ok": True, "msg": f"{d['name']} In {jack} ({M.PORT_NAMES[d['inPort']]} {n}) → User In {r['n']} → {M.fader_label(fader)}"}


def route_output(dev_id, jack, source):
    """source 0 = unassign (Off)."""
    d = get_dev(dev_id)
    if not d or not d["outPort"] or not (1 <= jack <= d["outCount"]):
        return 400, {"error": "Bad device output"}
    m = d["outStart"] + jack - 1
    port = d["outPort"]
    r = M.resolve_dev_output(port, m, X.snapshot())
    if r["kind"] == "MIX":
        if not (0 <= source <= M.MIX_MAX):
            return 400, {"error": "Bad source"}
        X.set(M.p_local_out(port, r["n"]), source)
        return 200, {"ok": True, "msg": f"{M.mix_label(source)} → {d['name']} Out {jack} ({M.PORT_NAMES[port]} {m})"}
    if not (0 <= source <= M.UOUT_MAX):
        return 400, {"error": "Bad source"}
    if r["kind"] != "UOUT":
        return 409, {"error": f"{M.PORT_NAMES[port]} {m} is not fed by a User Out. Set its block to User Out on the Blocks tab."}
    X.set(M.p_uout(r["n"]), source)
    return 200, {"ok": True, "msg": f"{M.src_label(source)} → User Out {r['n']} → {d['name']} Out {jack}"}


pool_lock = threading.Lock()


def free_pool_aux(n, st):
    """Forget the unit on Aux n and switch its send jack off."""
    unit = pool_assign().pop(str(n), None)
    if not unit:
        return
    dev_id, ch = split_ref(unit)
    d = get_dev(dev_id)
    if not d:
        return
    sdev, sj = split_ref(d["io"].get(str(ch), {}).get("send"))
    od = get_dev(sdev) if sdev else None
    if od and od["outPort"] != "AUXOUT" and 1 <= sj <= od["outCount"]:
        r = M.resolve_dev_output(od["outPort"], od["outStart"] + sj - 1, st)
        if r["kind"] == "UOUT" and r.get("src") == 200 + n:
            X.set(M.p_uout(r["n"]), 0)


def route_insert(fader, dev_id, slot):
    """Empty dev_id = remove insert."""
    if fader not in M.FADERS:
        return 400, {"error": "Bad fader"}
    if fader not in M.INS_FADERS:
        return 409, {"error": "Aux In channels have no insert point on the X32."}
    if dev_id in ("@fx", "@aux"):
        return route_insert_direct(fader, dev_id, slot)
    if not dev_id:
        with pool_lock:
            st = X.snapshot()
            t, n = M.ins_from_value(st.get(M.p_ins_sel(fader)))
            X.set(M.p_ins_on(fader), 0)
            X.set(M.p_ins_sel(fader), 0)
            note = ""
            if t == "AUX" and str(n) in pool_assign():
                free_pool_aux(n, st)
                with cfg_lock:
                    save_cfg(CFG)
                note = f" · Aux {n} is free again"
        return 200, {"ok": True, "msg": f"{M.fader_label(fader)} insert removed{note}"}
    d = get_dev(dev_id)
    if not d or d["kind"] != "insert" or not (1 <= slot <= d["insCount"]):
        return 400, {"error": "Bad insert slot"}
    if d["insType"] == "POOL":
        with pool_lock:
            return route_pool_insert(fader, d, slot)
    v = M.ins_value(d["insType"], d["insStart"] + slot - 1)
    X.set(M.p_ins_sel(fader), v)
    X.set(M.p_ins_on(fader), 1)
    msg = f"{d['name']} {slot} ({M.ins_label(v)}) inserted on {M.fader_label(fader)}"
    notes = []
    if d["insType"] == "AUX":
        notes = route_outboard_io(d, slot)
    else:
        rack = (d["insStart"] + slot) // 2
        fi = M.fx_type_info(X.snapshot().get(M.p_fx_type(rack)), rack)
        if fi["insertOk"] is False:
            notes.append(f"Warning: FX{rack} has {fi['type']} loaded (send-type effect). Load an insert-type effect.")
    return 200, {"ok": True, "msg": " · ".join([msg] + notes), "warn": any(n.startswith("Warning") for n in notes)}


def route_insert_direct(fader, dev_id, slot):
    """Pick an X32 insert point with no device set up. It does not route the Aux jacks."""
    typ, top = ("FX", 16) if dev_id == "@fx" else ("AUX", M.AUX_COUNT)
    if not 1 <= slot <= top:
        return 400, {"error": "Bad insert slot"}
    t, n = M.ins_from_value(X.snapshot().get(M.p_ins_sel(fader)))
    if t == "AUX" and str(n) in pool_assign():
        route_insert(fader, "", 0)  # gives the auto Aux back to the pool
    v = M.ins_value(typ, slot)
    X.set(M.p_ins_sel(fader), v)
    X.set(M.p_ins_on(fader), 1)
    msg = f"{M.ins_label(v)} inserted on {M.fader_label(fader)}"
    if typ == "AUX":
        return 200, {"ok": True, "msg": f"{msg} · Patch Aux Out {slot} and Aux In {slot} to your unit"}
    rack = (slot + 1) // 2
    fi = M.fx_type_info(X.snapshot().get(M.p_fx_type(rack)), rack)
    if fi["insertOk"] is False:
        return 200, {"ok": True, "warn": True, "msg": f"{msg} · Warning: FX{rack} has {fi['type']} loaded (send-type effect). Load an insert-type effect."}
    return 200, {"ok": True, "msg": msg}


def route_pool_insert(fader, d, ch):
    """Insert an outboard unit: pick a free Aux, route its send and return, set the insert."""
    st = X.snapshot()
    unit = f"{d['id']}:{ch}"
    uname = f"{d['name']} {ch}" if d["insCount"] > 1 else d["name"]
    io = d["io"].get(str(ch), {})
    sdev, sj = split_ref(io.get("send"))
    rdev, rj = split_ref(io.get("ret"))
    od = get_dev(sdev) if sdev else None
    idev = get_dev(rdev) if rdev else None
    if not (od and od["outPort"] and 1 <= sj <= od["outCount"]):
        return 409, {"error": f"{uname}: set its send jack on the Devices tab."}
    pinned = 0  # local Aux Out k carries the Aux k insert send itself: the unit must use Aux k
    if od["outPort"] == "AUXOUT":
        pinned = od["outStart"] + sj - 1
    elif M.resolve_dev_output(od["outPort"], od["outStart"] + sj - 1, st)["kind"] != "UOUT":
        hint = (f"set XLR Out block {M.XLR_BLOCKS[(od['outStart'] + sj - 2) // 4]} to User Out"
                if od["outPort"] == "XLR" else "set its block to User Out")
        return 409, {"error": f"{uname}: the send jack {od['name']} Out {sj} is not fed by a User Out. On the Blocks tab, {hint}."}
    if not (idev and 1 <= rj <= idev["inCount"]):
        return 409, {"error": f"{uname}: set its return jack on the Devices tab."}

    assign, use, pool = pool_assign(), aux_in_use(st), aux_pool()
    for k, u in assign.items():
        if u == unit and int(k) in use and use[int(k)] != fader:
            return 409, {"error": f"{uname} is already inserted on {M.fader_label(use[int(k)])}. Remove it there first."}
    t, cur = M.ins_from_value(st.get(M.p_ins_sel(fader)))
    cur = cur if t == "AUX" and st.get(M.p_ins_on(fader)) else 0
    prev = next((int(k) for k, u in assign.items() if u == unit), 0)
    order = [n for n in [cur, prev] + pool if n]
    reasons, n = [], 0
    if pinned:
        order = [pinned]
    for cand in dict.fromkeys(order):
        if cand not in pool:
            if pinned:
                reasons.append(f"its send is local Aux Out {cand}, but Aux {cand} is not in the Aux pool")
            continue
        if cand in use and use[cand] != fader:
            reasons.append(f"Aux {cand} on {M.fader_label(use[cand])}")
            continue
        busy = uin_users(st, cand)
        if busy:
            reasons.append(f"Aux {cand} return needs User In {cand} (used by {', '.join(busy)})")
            continue
        n = cand
        break
    if not n:
        return 409, {"error": "No free Aux for an insert. " + ("; ".join(dict.fromkeys(reasons)) or "The Aux pool is empty (Devices tab).")}

    notes = []
    if cur and cur != n and str(cur) in assign:
        free_pool_aux(cur, st)
    if prev and prev != n:
        assign.pop(str(prev), None)
    if assign.get(str(n)) not in (None, unit):
        free_pool_aux(n, st)
    want = M.AUX_BLOCK_OPTS.index(("UIN", 6))
    av = st.get(M.p_in_block("AUX"))
    kind, c = M.AUX_BLOCK_OPTS[av] if av is not None and 0 <= av < len(M.AUX_BLOCK_OPTS) else ("?", 0)
    if not (kind == "UIN" and n <= c):
        X.set(M.p_in_block("AUX"), want)
        notes.append("Aux In block set to User In 1-6")
    if not pinned:
        code, res = route_output(od["id"], sj, 200 + n)
        if code != 200:
            return code, res
    X.set(M.p_uin(n), M.src_value(idev["inPort"], idev["inStart"] + rj - 1))
    X.set(M.p_ins_sel(fader), M.ins_value("AUX", n))
    X.set(M.p_ins_on(fader), 1)
    assign[str(n)] = unit
    with cfg_lock:
        save_cfg(CFG)
    msg = (f"{uname} inserted on {M.fader_label(fader)} using Aux {n} "
           f"(send → {od['name']} Out {sj}, return ← {idev['name']} In {rj})")
    return 200, {"ok": True, "msg": " · ".join([msg] + notes), "aux": n}


def route_outboard_io(d, slot):
    """Route Aux Out N (send) and Aux In N (return) to the stage box jacks set for this slot."""
    n = d["insStart"] + slot - 1  # Aux number
    io = d["io"].get(str(slot), {})
    # Internal Aux N and the rear Aux jacks are separate: no wiring set = route nothing, only set the insert.
    notes = []
    if not io.get("send") and not io.get("ret"):
        notes.append(f"wiring not set: route Aux Out {n} / Aux In {n} yourself, or set the jacks on the Devices tab")
    st = X.snapshot()
    # send: Aux Out N -> stage box output (needs a User Out output)
    sdev, sj = split_ref(io.get("send"))
    if sdev:
        od = get_dev(sdev)
        if od and od["outPort"] in M.BLOCK_OUT_PORTS + ("XLR",) and 1 <= sj <= od["outCount"]:
            code, res = route_output(sdev, sj, 200 + n)
            notes.append(f"send → {od['name']} Out {sj}" if code == 200 else "Warning: " + res["error"])
        elif od and od["outPort"] == "AUXOUT" and od["outStart"] + sj - 1 == n:
            notes.append(f"send on rear Aux Out {n}")
        else:
            notes.append(f"Warning: send not routed. Aux {n} insert send can go to an AES50/Card output, an XLR Out on a User Out block, or rear Aux Out {n}.")
    # return: stage box input -> Aux In N
    rdev, rj = split_ref(io.get("ret"))
    if rdev:
        idev = get_dev(rdev)
        if not idev or not (1 <= rj <= idev["inCount"]):
            notes.append("Warning: return jack not found.")
        else:
            port, pn = idev["inPort"], idev["inStart"] + rj - 1
            av = st.get(M.p_in_block("AUX"))
            kind, c = M.AUX_BLOCK_OPTS[av] if av is not None and 0 <= av < len(M.AUX_BLOCK_OPTS) else ("?", 0)
            if port == "AUX" and pn == n and (kind == "AUX" or n > c):
                notes.append(f"return on Aux In {n}")
            elif kind == "UIN" and n <= c:
                users = [M.fader_label(f) for f in M.FADERS if f.startswith("ch")
                         and (r := M.resolve_fader(f, st))["kind"] == "UIN" and r["n"] == n]
                if users:
                    notes.append(f"Warning: return not routed. Aux {n} returns through User In {n} "
                                 f"(Aux In block is on User In), but User In {n} feeds {', '.join(users)}. "
                                 f"Move those channels to other User Ins.")
                else:
                    X.set(M.p_uin(n), M.src_value(port, pn))
                    notes.append(f"return ← {idev['name']} In {rj} via User In {n}")
            elif kind == port and n <= c and pn == n:
                notes.append(f"return ← {idev['name']} In {rj}")
            else:
                notes.append(f"Warning: return not routed. Set the Aux In block to User In 1-{max(2, n + n % 2)} on the Blocks tab.")
    return notes


def route_fxinsert(fader):
    """Put the first free insert (unit or slot) on the fader."""
    if fader not in M.FADERS:
        return 400, {"error": "Bad fader"}
    if fader not in M.INS_FADERS:
        return 409, {"error": "Aux In channels have no insert point on the X32."}
    st = X.snapshot()
    if st.get(M.p_ins_sel(fader)) and st.get(M.p_ins_on(fader)):
        return 409, {"error": f"{M.fader_label(fader)} already has an insert ({M.ins_label(st.get(M.p_ins_sel(fader)))}). Remove it first."}
    used = {st.get(M.p_ins_sel(f)) for f in M.FADERS if st.get(M.p_ins_on(f))}
    use = aux_in_use(st)
    busy_units = {u for k, u in pool_assign().items() if int(k) in use}
    last_err = None
    for d in (dev_defaults(x) for x in CFG["devices"]):
        if d["kind"] != "insert":
            continue
        for s in range(1, d["insCount"] + 1):
            if d["insType"] == "POOL":
                if f"{d['id']}:{s}" in busy_units:
                    continue
                code, res = route_insert(fader, d["id"], s)
                if code == 200:
                    return code, res
                last_err = (code, res)
            elif M.ins_value(d["insType"], d["insStart"] + s - 1) not in used:
                return route_insert(fader, d["id"], s)
    return last_err or (409, {"error": "No free insert. Add an insert device or remove an insert."})
