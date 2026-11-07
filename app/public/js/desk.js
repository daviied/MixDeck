// DiGiCo-style desk: fader banks, one touch column per channel, a rotary per fader.
import { S, G, $, el, set, scope, stripDef, layerStrips, stripColor, fmtDb, db2f, meters, faderPath, onPath, store, clamp, SCL, FADER, events } from "./core.js";
import { drag, tog } from "./ui.js";
import { eqThumb, makeMeter, deskMeters, select, SCALE } from "./mix.js";
import { openFull } from "./inspector.js";
import { openPatch, openInsert, insLabel } from "./patchpop.js";

const LAYERS = [["in", "Inputs"], ["aux", "Aux / FX"], ["bus", "Buses"], ["mtx", "Matrix"], ["dca", "DCA"], ["fav", "★"]];
const pad = (n, w = 2) => String(n).padStart(w, "0");
let sc = scope(), layer = store.get("deskLayer", "in"), page = store.get("deskPage", 0), lastN = 0;
let grs = [];

const isPhone = () => innerWidth <= 760;
function bankSize() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const side = isPhone() ? 0 : (7.5 + (G.caps && G.caps.mono ? 2 : 1) * 5.6) * rem;
  return clamp(Math.floor((innerWidth - side) / (4.4 * rem)), isPhone() ? 3 : 4, 12);
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
  if (act) { d.classList.add("tap"); d.onclick = () => { if (document.body.classList.contains("learning")) return; select(base); act(); }; }
  return d;
}
const none = (name) => el("div", `ds ds-${name} none`);
function tag(path, label, cls) {
  const t = tog(sc, path, label, "dt " + cls);
  t.addEventListener("click", (e) => e.stopPropagation());
  return t;
}
function dynRow(name, def, path, label, scale, gi, pageName) {
  const d = section(name, def.base, () => openFull(pageName));
  const v = el("span", "dv"), bar = el("i", "grb");
  sc.on(path + "/thr", (x) => (v.textContent = scale.fmt(x ?? 0).replace(" dB", "")));
  sc.on(path + "/on", (x) => d.classList.toggle("off", !x));
  d.append(tag(path + "/on", label, name), v);
  const g = el("div", "gr"); g.append(bar); d.append(g);
  if (gi != null) grs.push({ i: gi, bar, last: -1 });
  return d;
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

  // Source: the tap patches this input, as on the desk.
  if (has.input && e.src) {
    const d = section("src", base, () => openPatch(base));
    d.append(el("span", "dl", "IN"), el("b", null, e.plug || e.src));
    d.title = e.src;
    scr.append(d);
  } else scr.append(none("src"));

  // Gain, 48 V, phase
  if (has.input) {
    const d = section("gain", base, () => openFull("config")), v = el("div", "dgv");
    const gp = e.ha != null ? `/headamp/${pad(e.ha, 3)}/` : null;
    const path = gp ? gp + "gain" : base + "/preamp/trim", scale = gp ? SCL.ha : SCL.trim;
    sc.on(path, (x) => (v.textContent = scale.fmt(x ?? 0)));
    let moved = false;
    drag(v, { get: () => S.get(path) ?? 0, put: (x) => { moved = true; set(path, x); }, axis: "y", span: () => 220 });
    v.addEventListener("click", (ev) => { if (moved) { ev.stopPropagation(); moved = false; } });
    const r = el("div", "dgb");
    if (gp) {
      const pt = tog(sc, gp + "phantom", "48V", "dt p48", { confirm: "Tap again to turn on 48 V phantom power" });
      pt.addEventListener("click", (ev) => ev.stopPropagation()); r.append(pt);
    }
    r.append(tag(base + "/preamp/invert", "Ø", "inv"));
    d.append(v, r); scr.append(d);
  } else scr.append(none("gain"));

  if (has.hpf) {
    const d = section("hpf", base, () => openFull("config")), v = el("span", "dv");
    sc.on(base + "/preamp/hpf", (x) => (v.textContent = SCL.hpf.fmt(x ?? 0)));
    d.append(tag(base + "/preamp/hpon", "HPF", "hpf"), v); scr.append(d);
  } else scr.append(none("hpf"));

  if (has.eq) {
    const d = section("eq", base, () => openFull("eq"));
    sc.on(base + "/eq/on", (x) => d.classList.toggle("off", !x));
    d.append(tag(base + "/eq/on", "EQ", "eq"), eqThumb(sc, base, def)); scr.append(d);
  } else scr.append(none("eq"));

  scr.append(has.gate ? dynRow("gate", def, base + "/gate", "GATE", SCL.gthr, def.gate, "gate") : none("gate"));
  scr.append(has.comp ? dynRow("comp", def, base + "/dyn", "COMP", SCL.thr, def.gr, "dyn") : none("comp"));

  if (has.ins) {
    const d = section("ins", base, () => openInsert(base)), v = el("span", "dv");
    sc.on(base + "/insert/sel", (x) => (v.textContent = insLabel(x) || "None"));
    d.append(tag(base + "/insert/on", "INS", "ins"), v); scr.append(d);
  } else scr.append(none("ins"));

  if (has.sends) {
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
  } else scr.append(none("send"));

  if (has.pan && !isSof) {
    const pp = base + "/mix/pan", d = el("div", "ds ds-pan"), bar = el("i"), v = el("span", "dpv");
    sc.on(pp, (x) => { x = x ?? .5; bar.style.left = Math.min(x, .5) * 100 + "%"; bar.style.width = Math.abs(x - .5) * 100 + "%"; v.textContent = SCL.pan.fmt(x); });
    drag(d, { get: () => S.get(pp) ?? .5, put: (x) => set(pp, x), span: () => d.clientWidth * 1.6, reset: .5 });
    d.append(bar, v); scr.append(d);
  } else scr.append(none("pan"));

  // Name: the first tap selects, the next one opens the channel.
  const nm = section("name", base, null);
  nm.classList.add("tap");
  nm.onclick = () => { if (G.selected === base && k !== "dca") openFull("main"); else select(base); };
  const nmt = el("b");
  sc.on(base + "/config/name", (v) => (nmt.textContent = v || (k === "st" ? "Main" : "")));
  nm.append(el("span", "dn", isSof ? `→ Bus ${G.sof}` : def.label), nmt);
  scr.append(nm);
  s.append(scr);

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
  const mOn = G.caps.meters && !isSof;
  def.meter.forEach((i) => fz.append(makeMeter(mOn ? i : null, deskMeters)));
  if (!def.meter.length) fz.append(makeMeter(null, deskMeters));
  pn.append(fz);
  const fv = el("div", "fv");
  sc.on(fp, (v) => { v = v ?? 0; cap.style.bottom = v * 100 + "%"; fv.textContent = fmtDb(v); });
  drag(track, { get: () => S.get(fp) ?? 0, put: (v) => set(fp, v), axis: "y", reset: db2f(0) });
  pn.append(fv);
  s.append(pn);
  return s;
}

function buildRail(n) {
  const rail = el("div", "drail"), banks = el("div", "dbanks");
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
  const fn = el("div", "dfn");
  fn.append(el("h3", null, "Rotary"));
  const rs = el("select");
  rs.title = "What the rotaries control";
  if (G.caps.full) { rs.append(new Option("Gain", "gain"), new Option("HPF", "hpf")); }
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
  rail.append(banks, fn);
  return rail;
}

export function buildDesk() {
  sc.dispose(); sc = scope(); deskMeters.length = 0; grs = [];
  const root = $("#v-desk"); root.innerHTML = "";
  if (!G.caps) { root.append(el("div", "empty", "No console set up. Open Settings.")); return; }
  const n = bankSize(); lastN = n;
  let list = listOf(layer);
  if (!list.length) { layer = "in"; list = listOf("in"); }
  const pages = Math.max(1, Math.ceil(list.length / n));
  if (page >= pages) page = pages - 1;
  root.append(buildRail(n));
  const box = el("div", "dstrips"); box.id = "dstrips";
  const part = list.slice(page * n, (page + 1) * n);
  for (const b of part) box.append(buildStrip(b));
  for (let i = part.length; i < n; i++) box.append(el("div", "dstrip blank"));
  root.append(box);
  if (!isPhone()) {
    const m = el("div", "dmasters"); m.id = "dmasters";
    m.append(buildStrip("/main/st", true));
    if (G.caps.mono) m.append(buildStrip("/main/m", true));
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
events.addEventListener("sources", (e) => {
  if (G.view === "desk" && JSON.stringify(e.detail) !== JSON.stringify(G.sources)) buildDesk();
});
