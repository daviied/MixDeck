// Follow mode: this screen shows the page and channel that the X32 screen shows.
import { S, G, $, el, write, set, scope, store, onAny, events, toast, stripDef, stripColor, meters, db2f, FADER, SCL, lin, log, ownRecent } from "./core.js";
import { pr, tog, enumSel, bitButtons } from "./ui.js";
import { followCards, disposeCards } from "./inspector.js";
import { buildFx, buildScenes, setRack, fxHooks } from "./pages.js";
import { knobLayers } from "./knobs.js";

export const SCREENS = [
  { k: "CHAN", t: "Home", pages: ["Home", "Config", "Gate", "Dyn", "EQ", "Sends", "Main"] },
  { k: "METER", t: "Meters", pages: ["Channel", "Mix bus", "Aux/FX", "In/Out", "RTA"] },
  { k: "ROUTE", t: "Routing", pages: ["Home", "Out 1-16", "Aux out", "P16 out", "Card out", "AES50-A", "AES50-B", "XLR out"] },
  { k: "SETUP", t: "Setup", pages: ["Global", "Config", "Remote", "Network", "Names", "Preamps", "Card"] },
  { k: "LIB", t: "Library", pages: ["Channel", "Effects", "Routing"] },
  { k: "FX", t: "Effects", pages: ["Home", "FX 1", "FX 2", "FX 3", "FX 4", "FX 5", "FX 6", "FX 7", "FX 8"] },
  { k: "MON", t: "Monitor", pages: ["Monitor", "Talk A", "Talk B", "Oscillator"] },
  { k: "USB", t: "USB", pages: ["Home", "Config"] },
  { k: "SCENE", t: "Scenes", pages: ["Home", "Scenes", "Snippets", "Param safe", "Chan safe", "MIDI"] },
  { k: "ASSIGN", t: "Assign", pages: ["Home", "Set A", "Set B", "Set C"] },
];
const CHAN_PAGES = ["home", "config", "gate", "dyn", "eq", "sends", "main"];
const SCREEN = "/-stat/screen/screen", SEL = "/-stat/selidx";
const pagePath = (i) => `/-stat/screen/${SCREENS[i].k}/page`;
const pad = (n) => String(n).padStart(2, "0");

let active = false, goView = null, dirty = false, shown = "", wake = null;
const view = { s: 0, p: 0, sel: 0 };
let pageSc = scope(), barSc = scope(), mtrs = [], mtrRaf = 0;

export const isFollow = () => active;
export const twoWay = () => store.get("followTwoWay", true);

export function baseOfSel(i) {
  if (i < 32) return `/ch/${pad(i + 1)}`;
  if (i < 40) return `/auxin/${pad(i - 31)}`;
  if (i < 48) return `/fxrtn/${pad(i - 39)}`;
  if (i < 64) return `/bus/${pad(i - 47)}`;
  if (i < 70) return `/mtx/${pad(i - 63)}`;
  if (i === 70) return "/main/st";
  if (i === 71) return "/main/m";
  return `/dca/${i - 71}`;
}

function readConsole() {
  view.s = S.get(SCREEN) ?? 0;
  view.p = SCREENS[view.s] ? S.get(pagePath(view.s)) ?? 0 : 0;
  view.sel = S.get(SEL) ?? 0;
  G.selected = baseOfSel(view.sel);
}

function schedule() {
  if (dirty) return;
  dirty = true;
  queueMicrotask(() => { dirty = false; if (active) render(); });
}

// A change from the console always wins over a local tap.
onAny((p, v) => {
  if (!active) return;
  if (p === SEL) { view.sel = v; G.selected = baseOfSel(v); }
  else if (p === SCREEN) { view.s = v; view.p = SCREENS[v] ? S.get(pagePath(v)) ?? 0 : 0; }
  else {
    const m = /^\/-stat\/screen\/([A-Z]+)\/page$/.exec(p);
    if (!m) { layerHint(p); return; }
    const i = SCREENS.findIndex((x) => x.k === m[1]);
    if (i !== (S.get(SCREEN) ?? 0)) return;
    view.s = i; view.p = v;
  }
  schedule();
});

function tapScreen(i) {
  view.s = i; view.p = S.get(pagePath(i)) ?? 0;
  if (twoWay()) write(SCREEN, i);
  schedule();
}
function tapPage(p) {
  view.p = p;
  if (twoWay()) write(pagePath(view.s), p);
  schedule();
}
function tapSel(i) {
  view.sel = Math.max(0, Math.min(71, i)); G.selected = baseOfSel(view.sel);
  if (twoWay()) write(SEL, view.sel);
  schedule();
}
fxHooks.rack = (r) => { if (active) tapPage(r); };

export function followTabs() {
  const n = $("#views"); n.innerHTML = "";
  SCREENS.forEach((s, i) => {
    const b = el("button", i === view.s ? "on" : "", s.t);
    b.onclick = () => tapScreen(i);
    n.append(b);
  });
}

function drawBar() {
  barSc.dispose(); barSc = scope();
  const bar = $("#fbar"), s = SCREENS[view.s]; bar.innerHTML = "";
  if (s) {
    const seg = el("div", "seg");
    s.pages.forEach((t, i) => {
      const b = el("button", i === view.p ? "on" : "", t);
      b.onclick = () => tapPage(i);
      seg.append(b);
    });
    bar.append(seg);
  }
  if (view.s !== 0) return;
  const def = stripDef(G.selected); if (!def) return;
  const box = el("div", "fsel");
  const prev = el("button", null, "‹"), next = el("button", null, "›");
  prev.title = "Previous channel"; next.title = "Next channel";
  prev.disabled = view.sel <= 0; next.disabled = view.sel >= 71;
  prev.onclick = () => tapSel(view.sel - 1); next.onclick = () => tapSel(view.sel + 1);
  const sw = el("div", "swatch"); barSc.on(def.base + "/config/color", (v) => (sw.style.background = stripColor(v)));
  const nm = el("input", "name"); nm.maxLength = 12; nm.placeholder = def.label;
  barSc.on(def.base + "/config/name", (v) => { if (document.activeElement !== nm) nm.value = v || ""; });
  nm.onchange = () => set(def.base + "/config/name", nm.value);
  nm.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") nm.blur(); };
  box.append(prev, sw, el("b", null, def.label), nm, next);
  bar.append(box);
}

// ---- the six knobs under the console screen ----
let knobSc = scope(), knobKey = "", knobLayer = 0, burst = 0, burstAt = 0;

// The console does not report its knob layer. When a value that exists only on another layer
// changes at the console, that layer must be in use. Faders move without the knobs, so they do not count.
function layerHint(p) {
  const now = performance.now();
  if (now - burstAt > 300) { burst = 0; burstAt = now; }
  if (++burst > 6) return;  // many values at once: a scene recall, not a knob
  if (ownRecent(p) || /\/(mix\/)?fader$/.test(p)) return;
  const layers = knobLayers(view.s, view.p, G.selected);
  if (!layers || layers.length < 2) return;
  const has = (l) => l.some((c) => c[2] === p);
  if (!layers[knobLayer] || has(layers[knobLayer])) return;
  const i = layers.findIndex(has);
  if (i >= 0) { knobLayer = i; drawKnobs(); }
}
function drawKnobs() {
  knobSc.dispose(); knobSc = scope();
  const bar = $("#kbar"); bar.innerHTML = "";
  bar.hidden = !active || !store.get("followKnobs", true);
  if (bar.hidden) return;
  const key = `${view.s}/${view.p}`;
  if (key !== knobKey) { knobKey = key; knobLayer = 0; }
  const layers = knobLayers(view.s, view.p, G.selected);
  if (!layers) { bar.append(el("p", "note", "The manual does not list the knobs for this page.")); return; }
  if (!layers.length) { bar.append(el("p", "note", "The knobs have no function on this page.")); return; }
  if (knobLayer >= layers.length) knobLayer = 0;
  if (layers.length > 1) {
    const b = el("button", "klayer"); b.title = "Show the other knob layer";
    b.append(el("small", null, "Layer"), el("b", null, `${knobLayer + 1}/${layers.length}`));
    b.onclick = () => { knobLayer = (knobLayer + 1) % layers.length; drawKnobs(); };
    bar.append(b);
  }
  const row = el("div", "krow");
  layers[knobLayer].forEach(([turn, push, vp, scale, pp, inv], i) => {
    const c = el("div", "kn" + (turn || push ? "" : " none"));
    const dial = el("i", null, i + 1), val = el("span", "kv"), name = el("b", null, turn || (push ? "" : "—")), pu = el("small", "kp", push ? `Push: ${push}` : "");
    const txt = el("div", "kt"); txt.append(name, pu);
    c.append(dial, txt, val);
    if (vp && scale) knobSc.on(vp, (v) => { val.textContent = v == null ? "" : scale.fmt(v); });
    if (pp) knobSc.on(pp, (v) => { pu.classList.toggle("on", inv ? v === 0 : !!v); });
    row.append(c);
  });
  bar.append(row);
}

// ---- pages this mode adds ----
function note(title, text) {
  const w = el("div", "empty"); w.append(el("h2", null, title), el("p", "note", text));
  return w;
}

const LUT = Array.from({ length: 256 }, (_, b) => (b ? db2f(b / 2.55 - 80) : 0));
function meterCell(idx, num, name) {
  const c = el("div", "fm"), m = el("div", "mtr"), cover = el("div", "cover");
  m.append(cover); c.append(m, el("b", null, num), el("small", null, name || ""));
  mtrs.push({ idx, cover, v: 0, last: -1 });
  return c;
}
function meterLoop() {
  mtrRaf = requestAnimationFrame(meterLoop);
  const fresh = performance.now() - meters.at < 1000;
  for (const t of mtrs) {
    const target = fresh ? LUT[meters.b[t.idx]] : 0;
    t.v = target > t.v ? target : Math.max(target, t.v - .012);
    const n = Math.round(t.v * 200);
    if (n !== t.last) { t.last = n; t.cover.style.transform = `scaleY(${1 - n / 200})`; }
  }
}
function meterGroup(title, cells) {
  const g = el("div", "fmg"); g.append(el("h3", null, title));
  const row = el("div", "fmr"); row.style.setProperty("--n", cells.length); row.append(...cells);
  g.append(row); return g;
}
function meterPage(p) {
  const name = (b) => S.get(b + "/config/name") || "";
  const set_ = (label, base, offset, count) => Array.from({ length: count }, (_, i) => meterCell(offset + i, i + 1, name(`/${base}/${pad(i + 1)}`)));
  const w = el("div", "fmeters");
  if (p === 0) {
    w.append(meterGroup("Channels 1-16", set_("", "ch", 0, 16)));
    const hi = Array.from({ length: 16 }, (_, i) => meterCell(16 + i, i + 17, name(`/ch/${pad(i + 17)}`)));
    w.append(meterGroup("Channels 17-32", hi));
  } else if (p === 1) {
    w.append(meterGroup("Mix buses", set_("", "bus", 96, 16)));
    w.append(meterGroup("Matrix and main", [...set_("", "mtx", 112, 6), meterCell(118, "L", "Main"), meterCell(119, "R", "Main"), meterCell(120, "M/C", "")]));
  } else if (p === 2) {
    w.append(meterGroup("Aux inputs", set_("", "auxin", 151, 8)));
    w.append(meterGroup("FX returns", set_("", "fxrtn", 159, 8)));
    w.append(meterGroup("Aux outputs", Array.from({ length: 6 }, (_, i) => meterCell(145 + i, i + 1, ""))));
  } else return note(SCREENS[1].pages[p], "This meter page is not in this version. Use the console screen.");
  meterLoop();
  return w;
}

const SEND_MODE = ["PFL", "AFL"];
function card(title, ...kids) {
  const c = el("div", "card show"); c.append(el("h3", null, title), ...kids);
  return c;
}
function row(...kids) { const r = el("div", "row"); r.append(...kids); return r; }
function monitorPage(p) {
  const sc = pageSc, w = el("div", "fcards fmon");
  if (p === 0) {
    const P = "/config/solo/";
    w.append(card("Monitor",
      pr(sc, P + "level", "Level", FADER),
      enumSel(sc, P + "source", "Source", ["Off", "LR", "LR+C", "LR PFL", "LR AFL", "Aux 5-6", "Aux 7-8"]),
      pr(sc, P + "sourcetrim", "Source trim", lin(-18, 18, " dB")),
      row(tog(sc, P + "mono", "Mono"), tog(sc, P + "mute", "Mute", "red")),
      row(tog(sc, P + "dim", "Dim", "amber"), tog(sc, P + "dimpfl", "Dim PFL")),
      pr(sc, P + "dimatt", "Dim level", lin(-40, 0, " dB")),
      row(tog(sc, P + "delay", "Delay")),
      pr(sc, P + "delaytime", "Delay", lin(.3, 500, " ms"))));
    w.append(card("Solo",
      enumSel(sc, P + "chmode", "Channel", SEND_MODE),
      enumSel(sc, P + "busmode", "Bus", SEND_MODE),
      enumSel(sc, P + "dcamode", "DCA", SEND_MODE),
      row(tog(sc, P + "exclusive", "Exclusive"), tog(sc, P + "followsel", "Follow select"), tog(sc, P + "followsolo", "Follow solo")),
      row(tog(sc, P + "masterctrl", "Master control"))));
  } else if (p === 1 || p === 2) {
    const k = p === 1 ? "A" : "B", P = `/config/talk/${k}/`;
    const dest = [...Array.from({ length: 16 }, (_, i) => `${i + 1}`), "L/R", "M/C"];
    w.append(card(`Talkback ${k}`,
      row(tog(sc, "/config/talk/enable", "Talk on", "amber")),
      enumSel(sc, "/config/talk/source", "Mic", ["Internal", "External"]),
      pr(sc, P + "level", "Level", FADER),
      row(tog(sc, P + "dim", "Dim"), tog(sc, P + "latch", "Latch"))));
    w.append(card("Send to", bitButtons(sc, P + "destmap", 18, "", dest)));
  } else {
    const P = "/config/osc/";
    const dest = [...Array.from({ length: 16 }, (_, i) => `Bus ${i + 1}`), "L", "R", "L+R", "M/C", ...Array.from({ length: 6 }, (_, i) => `Matrix ${i + 1}`)];
    w.append(card("Oscillator",
      pr(sc, P + "level", "Level", FADER),
      enumSel(sc, P + "type", "Type", ["Sine", "Pink", "White"]),
      enumSel(sc, P + "fsel", "Frequency", ["F1", "F2"]),
      pr(sc, P + "f1", "F1", log(20, 20000, "Hz")),
      pr(sc, P + "f2", "F2", log(20, 20000, "Hz")),
      enumSel(sc, P + "dest", "Send to", dest),
      el("p", "note", "Turn the oscillator on at the console.")));
  }
  return w;
}

function clearPage() {
  pageSc.dispose(); pageSc = scope();
  cancelAnimationFrame(mtrRaf); mtrs = [];
  disposeCards();
}

export function buildFollowPage() {
  clearPage();
  const v = $("#v-follow"); v.innerHTML = "";
  const s = SCREENS[view.s];
  if (!s) v.append(note("Console is locked", "Unlock it at the console."));
  else if (view.s === 0) v.append(followCards(CHAN_PAGES[view.p] || "home", stripDef(G.selected)));
  else if (view.s === 1) v.append(meterPage(view.p));
  else if (view.s === 6) v.append(monitorPage(view.p));
  else if (view.s === 8) v.append(note(s.pages[view.p], "This scene page is not in this version. Use the console screen."));
  else v.append(note(s.t, "This screen is not in this version. Use the console screen."));
}

function render(force) {
  const key = `${G.slot}/${view.s}/${view.p}/${G.selected}`;
  followTabs(); drawBar(); drawKnobs();
  if (!force && key === shown) return;
  shown = key;
  const s = SCREENS[view.s];
  if (s && s.k === "FX") {
    clearPage();
    if (view.p > 0) setRack(view.p);
    G.view === "fx" ? buildFx() : goView("fx");
  } else if (s && s.k === "SCENE" && view.p < 2) {
    clearPage();
    G.view === "scenes" ? buildScenes() : goView("scenes");
  } else if (s && s.k === "ROUTE") {
    clearPage();
    if (G.view !== "patch") goView("patch");
    $('#rtabs [data-tab="route"]')?.click();
    $(`#mode [data-mode="${view.p === 0 ? "in" : "out"}"]`)?.click();
  } else if (G.view === "follow") buildFollowPage();
  else goView("follow");
  followTabs();
}

async function keepAwake() {
  try { if (active && navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => (wake = null)); } } catch { /* needs HTTPS */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });

export function enterFollow(fromTap) {
  if (!G.caps || !G.caps.full) return toast("Follow mode needs an X32", true);
  active = true; shown = ""; store.set("follow", true);
  document.body.classList.add("follow");
  $("#fbar").hidden = false; $("#follow").classList.add("on");
  readConsole(); render(true); keepAwake();
  if (fromTap) {
    const d = document.documentElement, f = d.requestFullscreen || d.webkitRequestFullscreen;
    if (f) { const r = f.call(d); r && r.catch && r.catch(() => {}); }
  }
}
export function exitFollow() {
  active = false; store.set("follow", false);
  clearPage(); drawKnobs();
  document.body.classList.remove("follow");
  $("#fbar").hidden = true; $("#follow").classList.remove("on");
  if (wake) { wake.release().catch(() => {}); wake = null; }
  const x = document.exitFullscreen || document.webkitExitFullscreen;
  if ((document.fullscreenElement || document.webkitFullscreenElement) && x) { const r = x.call(document); r && r.catch && r.catch(() => {}); }
  goView(store.get("view", "mix"));
}
export function initFollow(go) { goView = go; }

// New data for this console: start again from what the console shows.
events.addEventListener("full", () => {
  if (!active) { if (store.get("follow", false) && G.caps && G.caps.full && goView) enterFollow(false); return; }
  if (!G.caps || !G.caps.full) { exitFollow(); toast("Follow mode needs an X32", true); return; }
  readConsole(); render(true);
});
events.addEventListener("sources", (e) => {  // inserts also send this: rebuild only when a source changes
  if (active && G.view === "follow" && view.s === 0 && JSON.stringify(e.detail) !== JSON.stringify(G.sources)) buildFollowPage();
});
