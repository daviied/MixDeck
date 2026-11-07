// DiGiCo-style desk: fader banks, one touch column per channel, a rotary per fader.
import { S, G, $, el, set, scope, stripDef, layerStrips, stripColor, fmtDb, db2f, meters, faderPath, onPath, store, clamp, SCL, FADER, events, onAny } from "./core.js";
import { drag, tog } from "./ui.js";
import { eqThumb, makeMeter, deskMeters, select, SCALE } from "./mix.js";
import { openFull, openSection } from "./inspector.js";
import { rtaOn } from "./eq.js";
import { openPatch, openInsert, insLabel } from "./patchpop.js";

const LAYERS = [["in", "Inputs"], ["aux", "Aux / FX"], ["bus", "Buses"], ["mtx", "Matrix"], ["dca", "DCA"], ["fav", "★"]];
const pad = (n, w = 2) => String(n).padStart(w, "0");
let sc = scope(), layer = store.get("deskLayer", "in"), page = store.get("deskPage", 0), lastN = 0;
let grs = [];

const isPhone = () => innerWidth <= 760;
const screenOnly = () => store.get("deskScreen", false);
const followBank = () => !!(G.caps && G.caps.full) && store.get("deskFollow", false);
const side = () => store.get("deskSide", "left");
const CH_BANK = "/-stat/chfaderbank", GRP_BANK = "/-stat/grpfaderbank";
const RIGHT_NAMES = ["DCA 1-8", "Bus 1-8", "Bus 9-16", "Matrix, M/C"];
// Standard: 16 input faders. Compact: 8 input faders, so more layers. The right bank is the same on both.
const compact = () => !!(G.caps && G.caps.type === "x32") && store.get("deskModel", "x32") === "compact";
const LEFT_NAMES = () => compact()
  ? ["CH 1-8", "CH 9-16", "CH 17-24", "CH 25-32", "Aux / USB", "FX returns", "Bus 1-8", "Bus 9-16"]
  : ["CH 1-16", "CH 17-32", "Aux / USB / FX", "Bus masters"];
// The strips under the console's two fader banks, from the bank it reports.
function leftBank() {
  const i = layerStrips("in"), a = layerStrips("aux"), b = layerStrips("bus");
  const banks = compact()
    ? [i.slice(0, 8), i.slice(8, 16), i.slice(16, 24), i.slice(24, 32), a.slice(0, 8), a.slice(8, 16), b.slice(0, 8), b.slice(8, 16)]
    : [i.slice(0, 16), i.slice(16, 32), a, b];
  return banks[S.get(CH_BANK) || 0] || [];
}
function rightBank() {
  const b = layerStrips("bus");
  return [layerStrips("dca"), b.slice(0, 8), b.slice(8, 16), [...layerStrips("mtx"), "/main/m"]][S.get(GRP_BANK) || 0] || [];
}
function bankSize() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const side = isPhone() ? 0 : (7.5 + (G.caps && G.caps.mono ? 2 : 1) * 5.6) * rem;
  return clamp(Math.floor((innerWidth - side) / (4.4 * rem)), isPhone() ? 3 : 4, compact() ? 8 : 12);
}
const listOf = (k) => { const l = layerStrips(k); return k === "bus" && isPhone() ? [...l, "/main/st"] : l; };

// What the rotary above each fader controls.
function rotFn() { return store.get("deskRot", G.caps && G.caps.full ? "gain" : "pan"); }
function rotaryFor(def) {
  const f = rotFn(), b = def.base, k = def.kind;
  if (f === "gain") {
    const ha = (G.sources[b] || {}).ha;
    if (ha != null) return { path: `/headamp/${pad(ha, 3)}/gain`, scale: SCL.ha };
    return k === "ch" || k === "auxin" ? { path: b + "/preamp/trim", scale: SCL.trim, reset: .5, bi: true } : null;
  }
  if (f === "pan") return ["ch", "auxin", "fxrtn", "bus", "st"].includes(k) ? { path: b + "/mix/pan", scale: SCL.pan, reset: .5, bi: true } : null;
  if (f === "hpf") return k === "ch" ? { path: b + "/preamp/hpf", scale: SCL.hpf } : null;
  if (f.startsWith("send:")) return ["ch", "auxin", "fxrtn"].includes(k) ? { path: `${b}/mix/${pad(+f.slice(5))}/level`, scale: FADER, reset: db2f(0) } : null;
  return null;
}

function rotary(def) {
  const w = el("div", "drot"), r = rotaryFor(def);
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  const ring = (cls) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", 20); c.setAttribute("cy", 20); c.setAttribute("r", 17); c.setAttribute("pathLength", 100);
    c.setAttribute("transform", "rotate(135 20 20)"); c.setAttribute("class", cls); return c;
  };
  const back = ring("rb"), val = ring("rv");
  const knob = document.createElementNS(NS, "circle");
  knob.setAttribute("cx", 20); knob.setAttribute("cy", 20); knob.setAttribute("r", 12); knob.setAttribute("class", "rk");
  const tick = document.createElementNS(NS, "line");
  tick.setAttribute("x1", 20); tick.setAttribute("x2", 20); tick.setAttribute("y1", 9); tick.setAttribute("y2", 15); tick.setAttribute("class", "rt");
  svg.append(back, val, knob, tick);
  const txt = el("span", "rval", "–");
  w.append(svg, txt);
  if (!r) { w.classList.add("off"); return w; }
  sc.on(r.path, (v) => {
    v = v ?? 0; txt.textContent = r.scale.fmt(v);
    const a = r.bi ? Math.min(v, .5) : 0, len = r.bi ? Math.abs(v - .5) : v;
    val.setAttribute("stroke-dasharray", `${Math.max(len * 75, .6)} 100`);
    val.setAttribute("stroke-dashoffset", -a * 75);
    tick.setAttribute("transform", `rotate(${v * 270 - 135} 20 20)`);
  });
  drag(w, { get: () => S.get(r.path) ?? 0, put: (v) => set(r.path, v), axis: "y", span: () => 220, reset: r.reset });
  return w;
}

// One touch section. A tap selects the channel and runs the action.
function section(name, base, act) {
  const d = el("div", "ds ds-" + name);
  if (act) { d.classList.add("tap"); d.onclick = () => { if (document.body.classList.contains("learning")) return; const was = G.selected; select(base); act(was); }; }
  return d;
}
const none = (name) => el("div", `ds ds-${name} none`);
function tag(path, label, cls) {
  const t = tog(sc, path, label, "dt " + cls);
  t.addEventListener("click", (e) => e.stopPropagation());
  return t;
}
function dynRow(name, def, path, label, scale, gi, pageName) {
  const d = section(name, def.base, (was) => openSection(pageName, was));
  const v = el("span", "dv"), bar = el("i", "grb");
  sc.on(path + "/thr", (x) => (v.textContent = scale.fmt(x ?? 0).replace(" dB", "")));
  sc.on(path + "/on", (x) => d.classList.toggle("off", !x));
  d.append(tag(path + "/on", label, name), v);
  if (store.get("dynMeters", true)) {
    const g = el("div", "gr"); g.append(bar); d.append(g);
    if (gi != null) grs.push({ i: gi, bar, last: -1 });
  }
  return d;
}

// The X32 has one insert per channel, pre or post. The row you pick is where it goes.
function insRow(base, pos, label) {
  const P = base + "/insert/", here = () => (S.get(P + "pos") ?? 0) === pos;
  const d = section("ins", base, () => {
    const was = here();
    if (!was) set(P + "pos", pos);
    if (was || !S.get(P + "sel")) openInsert(base);
  });
  const t = el("button", "dt ins", label), v = el("span", "dv");
  t.title = `Insert ${label.toLowerCase()}`;
  t.onclick = (e) => {
    e.stopPropagation();
    select(base);
    if (!S.get(P + "sel")) { set(P + "pos", pos); openInsert(base); return; }
    if (here()) set(P + "on", S.get(P + "on") ? 0 : 1);
    else { set(P + "pos", pos); set(P + "on", 1); }
  };
  const draw = () => {
    const h = here();
    d.classList.toggle("active", h); d.classList.toggle("off", !h);
    t.classList.toggle("on", h && !!S.get(P + "on"));
    v.textContent = h ? insLabel(S.get(P + "sel")) || "None" : "–";
  };
  for (const k of ["pos", "on", "sel"]) sc.on(P + k, draw);
  d.append(t, v);
  return d;
}

function rename(host, def) {
  if ($("#dname")) return;
  const path = def.base + "/config/name", i = el("input"), r = host.getBoundingClientRect();
  i.id = "dname"; i.maxLength = G.caps.type === "x32" ? 12 : 32;
  i.value = S.get(path) || ""; i.placeholder = def.label; i.setAttribute("aria-label", `Name of ${def.label}`);
  document.body.append(i);
  i.style.left = Math.max(4, Math.min(r.left, innerWidth - i.offsetWidth - 4)) + "px";
  i.style.top = r.top + (r.height - i.offsetHeight) / 2 + "px";
  let done = false;
  const end = (save) => {
    if (done) return;
    done = true;
    if (save && i.value !== (S.get(path) || "")) set(path, i.value);
    i.remove();
  };
  i.onblur = () => end(true);
  i.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") end(true);
    if (e.key === "Escape") end(false);
  };
  i.focus(); i.select();
}

function buildStrip(base, master) {
  const def = stripDef(base), k = def.kind, full = G.caps.full, s = el("div", "strip dstrip" + (master ? " master" : ""));
  s.dataset.base = base;
  const fp = faderPath(def), op = onPath(def), isSof = fp !== def.fader;
  if (isSof) s.classList.add("sof");
  if (k !== "dca") sc.on(base + "/config/color", (v) => s.style.setProperty("--c", stripColor(v)));
  if (k === "st" && !S.get(base + "/config/color")) s.style.setProperty("--c", "#f2f4f6");
  const has = {
    input: full && (k === "ch" || k === "auxin"), hpf: full && k === "ch", gate: full && k === "ch",
    eq: full && k !== "dca", comp: full && ["ch", "bus", "mtx", "st", "m"].includes(k),
    ins: full && k === "ch", sends: ["ch", "auxin", "fxrtn"].includes(k) || (full && ["bus", "st"].includes(k)),
    pan: ["ch", "auxin", "fxrtn", "bus", "st"].includes(k) && (full || k === "ch"),
  };
  const e = G.sources[base] || {}, scr = el("div", "dscreen");

  // Meters first. Without faders, this row also shows level, mute and solo.
  const lvl = el("div", "ds ds-lvl"), showM = store.get("deskMeters", true);
  if (showM) {
    const mw = el("div", "dlm");
    def.meter.forEach((i) => mw.append(makeMeter(G.caps.meters && !isSof ? i : null, deskMeters)));
    if (!def.meter.length) mw.append(makeMeter(null, deskMeters));
    lvl.append(mw);
  } else lvl.classList.add("nom");
  if (screenOnly()) {
    const info = el("div", "dli"), fv = el("b", "dlv"), m = el("span", "dbadge bm", "M");
    sc.on(fp, (v) => (fv.textContent = fmtDb(v ?? 0)));
    sc.on(op, (v) => { const x = v === 0; m.classList.toggle("on", x); s.classList.toggle("muted", x); });
    info.append(fv, m);
    if (full) {
      const sp = `/-stat/solosw/${pad(def.solo)}`, so = el("span", "dbadge bs", "S");
      sc.on(sp, (v) => so.classList.toggle("on", !!v));
      info.append(so);
    }
    lvl.append(info);
  }
  if (showM || screenOnly()) scr.append(lvl);

  // Source: the tap patches this input, as on the desk.
  if (has.input && e.src) {
    const d = section("src", base, () => openPatch(base));
    d.append(el("span", "dl", "IN"), el("b", null, e.plug || e.src));
    d.title = e.src;
    scr.append(d);
  } else scr.append(none("src"));

  // Gain, with 48 V and phase state. A tap opens the input menu.
  if (has.input) {
    const d = section("gain", base, () => openFull("config")), v = el("div", "dgv");
    const gp = e.ha != null ? `/headamp/${pad(e.ha, 3)}/` : null;
    const path = gp ? gp + "gain" : base + "/preamp/trim", scale = gp ? SCL.ha : SCL.trim;
    sc.on(path, (x) => (v.textContent = scale.fmt(x ?? 0).replace(" dB", "")));
    let moved = false;
    drag(v, { get: () => S.get(path) ?? 0, put: (x) => { moved = true; set(path, x); }, axis: "y", span: () => 220 });
    v.addEventListener("click", (ev) => { if (moved) { ev.stopPropagation(); moved = false; } });
    // 48 V and phase are set in the menu. Here they only show state.
    const r = el("div", "dgb"), ind = (p, t, c) => { const i = el("span", "dgi " + c, t); sc.on(p, (x) => i.classList.toggle("on", !!x)); r.append(i); };
    if (gp) ind(gp + "phantom", "48V", "p48");
    ind(base + "/preamp/invert", "Ø", "inv");
    d.append(v, r); scr.append(d);
  } else scr.append(none("gain"));

  if (has.hpf) {
    const d = section("hpf", base, () => openFull("config")), v = el("span", "dv");
    sc.on(base + "/preamp/hpf", (x) => (v.textContent = SCL.hpf.fmt(x ?? 0)));
    d.append(tag(base + "/preamp/hpon", "HPF", "hpf"), v); scr.append(d);
  } else scr.append(none("hpf"));

  scr.append(has.ins ? insRow(base, 0, "PRE") : none("ins"));

  if (has.eq) {
    const d = section("eq", base, (was) => openSection("eq", was));
    sc.on(base + "/eq/on", (x) => d.classList.toggle("off", !x));
    d.append(tag(base + "/eq/on", "EQ", "eq"), eqThumb(sc, base, def)); scr.append(d);
  } else scr.append(none("eq"));

  scr.append(has.gate ? dynRow("gate", def, base + "/gate", "GATE", SCL.gthr, def.gate, "gate") : none("gate"));
  scr.append(has.comp ? dynRow("comp", def, base + "/dyn", "COMP", SCL.thr, def.gr, "dyn") : none("comp"));
  scr.append(has.ins ? insRow(base, 1, "POST") : none("ins"));

  const showSends = store.get("deskSends", true);
  if (has.sends && showSends) {
    const toMtx = ["bus", "st"].includes(k), n = toMtx ? 6 : G.caps.bus, d = section("send", base, () => openFull("sends"));
    const g = el("div", "dsg"); g.style.setProperty("--n", n > 8 ? 8 : n);
    const hi = rotFn().startsWith("send:") && !toMtx ? +rotFn().slice(5) : 0;
    for (let i = 1; i <= n; i++) {
      const P = `${base}/mix/${pad(i)}/`, c = el("span", i === hi ? "hi" : ""), f = el("i"); c.append(f);
      sc.on(P + "level", (x) => (f.style.height = (x ?? 0) * 100 + "%"));
      sc.on(P + "on", (x) => c.classList.toggle("off", x === 0));
      g.append(c);
    }
    d.append(g); scr.append(d);
  } else if (showSends) scr.append(none("send"));

  if (has.pan && !isSof) {
    const pp = base + "/mix/pan", d = el("div", "ds ds-pan"), bar = el("i"), v = el("span", "dpv");
    sc.on(pp, (x) => { x = x ?? .5; bar.style.left = Math.min(x, .5) * 100 + "%"; bar.style.width = Math.abs(x - .5) * 100 + "%"; v.textContent = SCL.pan.fmt(x); });
    drag(d, { get: () => S.get(pp) ?? .5, put: (x) => set(pp, x), span: () => d.clientWidth * 1.6, reset: .5 });
    d.append(bar, v); scr.append(d);
  } else scr.append(none("pan"));

  // Name: the first tap selects, the next one renames.
  const nm = section("name", base, null);
  nm.classList.add("tap");
  nm.onclick = () => {
    if (G.selected !== base) return select(base);
    if (!document.body.classList.contains("learning")) rename(nm, def);
  };
  const nmt = el("b");
  sc.on(base + "/config/name", (v) => (nmt.textContent = v || (k === "st" ? "Main" : def.label)));
  if (isSof) nm.append(el("span", "dn", `→ Bus ${G.sof}`));
  nm.append(nmt);
  scr.append(nm);
  s.append(scr);
  if (screenOnly()) return s;

  // Worksurface: rotary, buttons, fader
  const pn = el("div", "dpanel");
  pn.append(rotary(def));
  const btns = el("div", "dbtn");
  const sel = el("button", "bsel", "SEL");
  sel.onclick = () => select(base);
  btns.append(sel);
  if (full) {
    const sp = `/-stat/solosw/${pad(def.solo)}`, bs = el("button", "bs", "SOLO");
    sc.on(sp, (v) => bs.classList.toggle("on", !!v));
    bs.onclick = () => set(sp, S.get(sp) ? 0 : 1);
    btns.append(bs);
  }
  const bm = el("button", "bm", "MUTE");
  sc.on(op, (v) => { const m = v === 0; bm.classList.toggle("on", m); s.classList.toggle("muted", m); });
  bm.onclick = () => set(op, S.get(op) === 0 ? 1 : 0);
  btns.append(bm);
  pn.append(btns);

  const fz = el("div", "fz"), scale = el("div", "scale");
  for (const d of SCALE) { const t = el("span", null, d > 0 ? "+" + d : d); t.style.bottom = db2f(d) * 100 + "%"; scale.append(t); }
  const track = el("div", "track"), zero = el("div", "zero"), cap = el("div", "cap");
  zero.style.bottom = db2f(0) * 100 + "%"; track.append(zero, cap);
  fz.append(scale, track);
  pn.append(fz);
  const fv = el("div", "fv");
  sc.on(fp, (v) => { v = v ?? 0; cap.style.bottom = v * 100 + "%"; fv.textContent = fmtDb(v); });
  drag(track, { get: () => S.get(fp) ?? 0, put: (v) => set(fp, v), axis: "y", reset: db2f(0) });
  pn.append(fv);
  s.append(pn);
  return s;
}

function check(label, key, val, fn) {
  const w = el("label", "dchk"), c = el("input");
  c.type = "checkbox"; c.checked = !!val;
  c.onchange = () => { store.set(key, c.checked); if (fn) fn(c.checked); buildDesk(); };
  w.append(c, label);
  return w;
}

function buildRail(n) {
  const rail = el("div", "drail"), banks = el("div", "dbanks");
  if (followBank()) {
    const g = el("div", "dgroup"), sd = el("select");
    g.append(el("h3", null, "Console bank"));
    if (side() !== "right") g.append(el("div", "dnow", LEFT_NAMES()[S.get(CH_BANK) || 0] || "Unknown bank"));
    if (side() !== "left") g.append(el("div", "dnow", RIGHT_NAMES[S.get(GRP_BANK) || 0]));
    g.append(el("h3", null, "Show"));
    sd.append(new Option("Left bank", "left"), new Option("Right bank", "right"), new Option("Both banks", "both"));
    sd.value = side();
    sd.onchange = () => { store.set("deskSide", sd.value); buildDesk(); };
    g.append(sd);
    banks.append(g);
  } else {
    for (const [k, t] of LAYERS) {
      const list = listOf(k);
      if (!list.length) continue;
      const g = el("div", "dgroup"); g.append(el("h3", null, t));
      for (let i = 0; i * n < list.length; i++) {
        const part = list.slice(i * n, (i + 1) * n), a = stripDef(part[0]), z = stripDef(part[part.length - 1]);
        const label = part.length === 1 ? a.label : a.kind === z.kind ? `${a.label.replace(/\d+$/, "")}${a.n}-${z.n}` : `${a.label}…${z.label}`;
        const b = el("button", k === layer && i === page ? "on" : "", k === "fav" ? `${i + 1}` : label);
        b.onclick = () => { layer = k; page = i; store.set("deskLayer", k); store.set("deskPage", i); buildDesk(); };
        g.append(b);
      }
      banks.append(g);
    }
  }
  const fn = el("div", "dfn");
  if (G.caps.type === "x32") {
    const md = el("select");
    md.title = "Fader layout of the console";
    md.append(new Option("X32 standard", "x32"), new Option("X32 Compact", "compact"));
    md.value = compact() ? "compact" : "x32";
    md.onchange = () => { store.set("deskModel", md.value); page = 0; store.set("deskPage", 0); buildDesk(); };
    fn.append(el("h3", null, "Console layout"), md);
  }
  fn.append(check("Hide faders", "deskScreen", screenOnly(), (on) => { if (on) G.sof = 0; }));
  if (G.caps.full) fn.append(check("Follow console bank", "deskFollow", followBank()));
  fn.append(check("Meters", "deskMeters", store.get("deskMeters", true)));
  fn.append(check("Aux sends", "deskSends", store.get("deskSends", true)));
  if (G.caps.full) {
    fn.append(check("EQ, gate, comp in a window", "deskWindow", store.get("deskWindow", true)));
    fn.append(check("EQ RTA", "eqRta", rtaOn(), () => events.dispatchEvent(new CustomEvent("rtaopt"))));
  }
  if (G.caps.full) fn.append(check("Gate / comp metering", "dynMeters", store.get("dynMeters", true)));
  if (screenOnly()) {
    const hide = el("button", null, "Hide this panel");
    hide.onclick = () => { store.set("deskRailOff", true); buildDesk(); };
    fn.append(hide);
  } else {
    fn.append(el("h3", null, "Rotary"));
    const rs = el("select");
    rs.title = "What the rotaries control";
    if (G.caps.full) rs.append(new Option("Gain", "gain"), new Option("HPF", "hpf"));
    rs.append(new Option("Pan", "pan"));
    for (let i = 1; i <= G.caps.bus; i++) { const nm = S.get(`/bus/${pad(i)}/config/name`); rs.append(new Option(`Send ${i}${nm ? " " + nm : ""}`, "send:" + i)); }
    rs.value = rotFn();
    rs.onchange = () => { store.set("deskRot", rs.value); buildDesk(); };
    fn.append(rs);
    const f = rotFn(), n2 = f.startsWith("send:") ? +f.slice(5) : 0;
    const flip = el("button", "dflip" + (G.sof ? " on" : ""), G.sof ? `Flip off (Bus ${G.sof})` : "Flip to faders");
    flip.title = "Set Rotary to a send, then show that send on the faders";
    flip.disabled = !G.sof && !n2;
    flip.onclick = () => { G.sof = G.sof ? 0 : n2; buildDesk(); };
    fn.append(flip);
  }
  rail.append(banks, fn);
  return rail;
}

export function buildDesk() {
  sc.dispose(); sc = scope(); deskMeters.length = 0; grs = [];
  const root = $("#v-desk"); root.innerHTML = "";
  if (!G.caps) { root.append(el("div", "empty", "No console set up. Open Settings.")); return; }
  const n = bankSize(); lastN = n;
  const follow = followBank(), screen = screenOnly();
  root.classList.toggle("screen", screen); root.classList.toggle("fbank", follow);
  if (screen && store.get("deskRailOff", false)) {
    const tab = el("button", "drailtab", "⚙"); tab.title = "Show the panel";
    tab.onclick = () => { store.set("deskRailOff", false); buildDesk(); };
    root.append(tab);
  } else root.append(buildRail(n));
  const box = el("div", "dstrips"); box.id = "dstrips";
  if (follow) {
    const left = side() !== "right" ? leftBank() : [], right = side() !== "left" ? rightBank() : [];
    for (const b of left) box.append(buildStrip(b));
    right.forEach((b, i) => { const x = buildStrip(b); if (i === 0 && left.length) x.classList.add("grpstart"); box.append(x); });
  } else {
    let list = listOf(layer);
    if (!list.length) { layer = "in"; list = listOf("in"); }
    const pages = Math.max(1, Math.ceil(list.length / n));
    if (page >= pages) page = pages - 1;
    const part = list.slice(page * n, (page + 1) * n);
    for (const b of part) box.append(buildStrip(b));
    for (let i = part.length; i < n; i++) box.append(el("div", "dstrip blank"));
  }
  root.append(box);
  if (!isPhone() && (!follow || side() !== "left")) {
    const m = el("div", "dmasters"); m.id = "dmasters";
    m.append(buildStrip("/main/st", true));
    if (G.caps.mono && !follow) m.append(buildStrip("/main/m", true));
    root.append(m);
  }
  root.querySelectorAll(`.strip[data-base="${G.selected}"]`).forEach((x) => x.classList.add("sel"));
}

function grLoop() {
  requestAnimationFrame(grLoop);
  if (G.view !== "desk" || !G.caps || !G.caps.meters) return;
  const fresh = performance.now() - meters.at < 1000;
  for (const g of grs) {
    const b = fresh ? meters.b[g.i] : 0;
    const v = b > 0 ? Math.round(clamp((80 - b / 2.55) / 30) * 100) : 0;
    if (v !== g.last) { g.last = v; g.bar.style.width = v + "%"; }
  }
}
grLoop();

addEventListener("resize", () => {
  if (G.view !== "desk" || !G.caps) return;
  const n = bankSize();
  if (n !== lastN) { page = Math.floor((page * lastN) / n); buildDesk(); }
});
onAny((p) => {
  if (G.view !== "desk" || !followBank()) return;
  if ((p === CH_BANK && side() !== "right") || (p === GRP_BANK && side() !== "left")) queueMicrotask(buildDesk);
});
events.addEventListener("sources", (e) => {
  if (G.view === "desk" && JSON.stringify(e.detail) !== JSON.stringify(G.sources)) buildDesk();
});
