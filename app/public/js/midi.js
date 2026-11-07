// MIDI control through Web MIDI: learn, Mackie Control preset, motor fader feedback, soft takeover.
import { S, G, $, el, set, store, api, toast, on, stripDef, faderPath, onPath, emit, clearSolos } from "./core.js";

// A mapping: { key:"cc:0:7"|"pb:0"|"note:0:16", t:"bank"|"strip"|"act", n, base, role:"fader"|"mute"|"solo"|"pan"|act name }
const M = { access: null, maps: store.get("midiMaps", []), soft: store.get("midiSoft", true), learn: null, inputs: new Set(store.get("midiIn", [])), last: "", motorOff: new Map() };
const bankSize = 8;
const pad = (n) => String(n).padStart(2, "0");
let fb = [];
const pending = new Map();

const stripsNow = () => [...document.querySelectorAll("#strips .strip")].map((s) => s.dataset.base);
function targetPath(m) {
  let base = m.base;
  if (m.t === "bank") base = stripsNow()[G.bank + m.n];
  if (!base) return null;
  const def = stripDef(base); if (!def) return null;
  if (m.role === "fader") return faderPath(def);
  if (m.role === "mute") return onPath(def);
  if (m.role === "solo") return `/-stat/solosw/${pad(def.solo)}`;
  if (m.role === "pan") return base + "/mix/pan";
  return null;
}

function actions(a) {
  const n = stripsNow().length;
  if (a === "bankUp") G.bank = Math.min(Math.max(0, n - bankSize), G.bank + bankSize);
  if (a === "bankDown") G.bank = Math.max(0, G.bank - bankSize);
  if (a === "chanUp") G.bank = Math.min(Math.max(0, n - bankSize), G.bank + 1);
  if (a === "chanDown") G.bank = Math.max(0, G.bank - 1);
  if (a === "clearSolo") clearSolos();
  if (a.startsWith("bank") || a.startsWith("chan")) { toast(`MIDI bank ${G.bank + 1}-${G.bank + bankSize}`); midi.onBankChange(); scrollBank(); }
}
function scrollBank() { const s = document.querySelectorAll("#strips .strip")[G.bank]; if (s) s.scrollIntoView({ inline: "start", block: "nearest" }); }

// Parse one message. Exposed for tests as midi.handle.
function handle(bytes) {
  const [st, d1, d2] = bytes, kind = st & 0xf0, ch = st & 0x0f;
  let key, val = null, press = false;
  if (kind === 0xb0) { key = `cc:${ch}:${d1}`; val = d2 / 127; }
  else if (kind === 0xe0) { key = `pb:${ch}`; val = ((d2 << 7) | d1) / 16383; }
  else if (kind === 0x90 && d2 > 0) { key = `note:${ch}:${d1}`; press = true; }
  else return;
  M.last = key; emit("midi");
  if (M.learn) { finishLearn(key); return; }
  for (const m of M.maps) {
    if (m.key !== key) continue;
    if (m.t === "act") { if (press || val > .5) actions(m.role); continue; }
    const p = targetPath(m); if (!p) continue;
    if (val != null && !["mute", "solo"].includes(m.role)) {
      // Soft takeover: a fader without a motor must reach the current value first.
      const cur = S.get(p) ?? 0;
      if (M.soft && !m.motor && !m.caught) {
        const prev = m.prev ?? val; m.prev = val;
        if (Math.abs(val - cur) > .03 && (prev - cur) * (val - cur) > 0) continue;
        m.caught = true;
      }
      M.motorOff.set(p, performance.now());
      set(p, val);
    } else if (press || (val != null && val > .5)) {
      const c = S.get(p);
      if (m.role === "mute") set(p, c === 0 ? 1 : 0); else set(p, c ? 0 : 1);
    }
  }
}

// Feedback to motor faders and button LEDs
function send(bytes) { if (!M.access) return; for (const o of M.access.outputs.values()) { if (M.inputs.has(o.name)) { try { o.send(bytes); } catch { /* device gone */ } } } }
function feedback(m, v) {
  const [k, a, b] = m.key.split(":"); const ch = +a;
  if (k === "pb") { const x = Math.round((v ?? 0) * 16383); send([0xe0 | ch, x & 127, x >> 7]); }
  else if (k === "cc") send([0xb0 | ch, +b, Math.round((v ?? 0) * 127)]);
  else if (k === "note") {
    const lit = m.role === "mute" ? v === 0 : !!v;
    send([0x90 | ch, +b, lit ? 127 : 0]);
  }
}
function rebindFeedback() {
  fb.forEach((f) => f()); fb = [];
  for (const m of M.maps) {
    if (m.t === "act") continue;
    m.caught = false; m.prev = undefined;
    const p = targetPath(m); if (!p) continue;
    const fn = (v) => {
      const t = M.motorOff.get(p);
      if (t && performance.now() - t < 300 && m.role === "fader") return;
      feedback(m, v);
    };
    fb.push(on(p, fn)); fn(S.get(p));
  }
}

// ---- learn ----
function startLearn(target) { M.learn = target; emit("midi"); toast("Move a fader or press a button on the MIDI device"); }
function finishLearn(key) {
  const t = M.learn; M.learn = null;
  M.maps = M.maps.filter((m) => m.key !== key);
  M.maps.push({ key, ...t, motor: key.startsWith("pb") });
  save(); stopLearnMode(); toast(`${key} → ${describe(M.maps.at(-1))}`);
}
function describe(m) {
  if (m.t === "act") return { bankUp: "Bank up", bankDown: "Bank down", chanUp: "Shift right", chanDown: "Shift left", clearSolo: "Clear solo" }[m.role] || m.role;
  const role = { fader: "fader", mute: "mute", solo: "solo", pan: "pan" }[m.role];
  if (m.t === "bank") return `Bank slot ${m.n + 1} ${role}`;
  const d = stripDef(m.base); return `${d ? d.label : m.base} ${role}`;
}
function save() { store.set("midiMaps", M.maps.map(({ caught, prev, ...x }) => x)); rebindFeedback(); if (G.view === "midi") buildMidi(); }

let armedEl = null;
function learnClick(e) {
  const t = e.target.closest("[data-learn]"); if (!t) return;
  e.preventDefault(); e.stopPropagation();
  const strip = t.closest(".strip"); const base = strip.dataset.base;
  if (armedEl) armedEl.classList.remove("armed");
  armedEl = t; t.classList.add("armed");
  const inBank = store.get("midiLearnBank", false) && strip.closest("#strips");
  const idx = stripsNow().indexOf(base);
  startLearn(inBank ? { t: "bank", n: idx - G.bank, role: t.dataset.learn } : { t: "strip", base, role: t.dataset.learn });
}
function startLearnMode() { document.body.classList.add("learning"); document.addEventListener("pointerdown", learnClick, true); document.dispatchEvent(new CustomEvent("goto", { detail: "mix" })); toast("Tap a fader, mute or solo, then move the MIDI control"); }
function stopLearnMode() { document.body.classList.remove("learning"); document.removeEventListener("pointerdown", learnClick, true); if (armedEl) armedEl.classList.remove("armed"); armedEl = null; M.learn = null; if (G.view === "midi") buildMidi(); }

// ---- presets ----
function presetMcu() {
  const out = [];
  for (let n = 0; n < 8; n++) {
    out.push({ key: `pb:${n}`, t: "bank", n, role: "fader", motor: true });
    out.push({ key: `note:0:${16 + n}`, t: "bank", n, role: "mute" });
    out.push({ key: `note:0:${8 + n}`, t: "bank", n, role: "solo" });
  }
  out.push({ key: "pb:8", t: "strip", base: "/main/st", role: "fader", motor: true });
  out.push({ key: "note:0:46", t: "act", role: "bankDown" }, { key: "note:0:47", t: "act", role: "bankUp" }, { key: "note:0:48", t: "act", role: "chanDown" }, { key: "note:0:49", t: "act", role: "chanUp" });
  M.maps = out; save(); toast("Mackie Control map loaded");
}
function presetCC() {
  const out = [];
  for (let n = 0; n < 8; n++) out.push({ key: `cc:0:${n + 1}`, t: "bank", n, role: "fader", motor: false });
  out.push({ key: "cc:0:9", t: "strip", base: "/main/st", role: "fader", motor: false });
  M.maps = out; save(); toast("8 CC faders loaded: CC 1-8, CC 9 main");
}

// ---- device access ----
async function enable(silent) {
  if (!navigator.requestMIDIAccess) { if (!silent) toast("This browser has no Web MIDI. Use Chrome or Edge.", true); return; }
  try {
    M.access = await navigator.requestMIDIAccess({ sysex: false });
    M.access.onstatechange = () => { attach(); if (G.view === "midi") buildMidi(); };
    attach(); store.set("midiOn", true); rebindFeedback();
    if (G.view === "midi") buildMidi();
  } catch (e) { if (!silent) toast("MIDI access was refused: " + e.message, true); }
}
function attach() {
  if (!M.access) return;
  for (const i of M.access.inputs.values()) i.onmidimessage = M.inputs.has(i.name) ? (e) => handle(e.data) : null;
}

export const midi = { onBankChange: () => rebindFeedback(), handle, maps: () => M.maps, presetMcu, presetCC, _state: M, rebindFeedback };
window.__midi = midi;

export function initMidi() { if (store.get("midiOn", false)) enable(true); }

export function buildMidi() {
  const v = $("#v-midi"); v.innerHTML = "";
  const w = el("div");
  const sec = el("div", "sec"); sec.append(el("h2", null, "MIDI control"));
  if (!navigator.requestMIDIAccess) sec.append(el("p", "warn", "This browser has no Web MIDI. Chrome and Edge have it. Safari and iPhone do not."));
  else if (!isSecureContext) sec.append(el("p", "warn", "Web MIDI needs HTTPS or localhost. Open this page through your nginx HTTPS address."));
  sec.append(el("p", "note", "Connect a MIDI fader controller to the device that runs this page. The controller drives the console through the server."));
  if (!M.access) {
    const b = el("button", "primary", "Turn on MIDI"); b.onclick = () => enable(false); sec.append(b);
  } else {
    const list = el("div", "row");
    const ins = [...M.access.inputs.values()];
    if (!ins.length) list.append(el("span", "note", "No MIDI devices found. Plug one in."));
    for (const i of ins) {
      const l = el("label", "chk"), c = el("input"); c.type = "checkbox"; c.checked = M.inputs.has(i.name);
      c.onchange = () => { c.checked ? M.inputs.add(i.name) : M.inputs.delete(i.name); store.set("midiIn", [...M.inputs]); attach(); rebindFeedback(); };
      l.append(c, i.name); list.append(l);
    }
    sec.append(list);
    sec.append(el("p", "note", `Last message: ${M.last || "none"}`));
  }
  w.append(sec);

  const ms = el("div", "sec"); ms.append(el("h2", null, "Mappings"));
  const r = el("div", "row");
  const lb = el("button", document.body.classList.contains("learning") ? "primary" : "", "Learn");
  lb.onclick = () => startLearnMode();
  const bank = el("label", "chk"), bc = el("input"); bc.type = "checkbox"; bc.checked = store.get("midiLearnBank", false);
  bc.onchange = () => store.set("midiLearnBank", bc.checked); bank.append(bc, "Learned faders follow the visible layer");
  const mcu = el("button", null, "Mackie Control / motor faders"), cc = el("button", null, "8 CC faders"), clr = el("button", "danger", "Clear all");
  mcu.onclick = presetMcu; cc.onclick = presetCC; clr.onclick = () => { if (confirm("Delete all MIDI mappings?")) { M.maps = []; save(); } };
  const soft = el("label", "chk"), sc = el("input"); sc.type = "checkbox"; sc.checked = M.soft;
  sc.onchange = () => { M.soft = sc.checked; store.set("midiSoft", sc.checked); }; soft.append(sc, "Soft takeover for faders without motors");
  r.append(lb, bank, mcu, cc, clr, soft); ms.append(r);
  ms.append(el("p", "note", "Soft takeover stops a jump: the fader takes control only after it reaches the current value."));
  const t = el("table", "tbl"), hr = el("tr"); hr.append(el("th", null, "MIDI"), el("th", null, "Controls"), el("th", null, "Motor"), el("th")); t.append(hr);
  for (const m of M.maps) {
    const tr = el("tr"), d = el("button", "tog", "Delete");
    d.onclick = () => { M.maps = M.maps.filter((x) => x !== m); save(); };
    const mc = el("input"); mc.type = "checkbox"; mc.checked = !!m.motor; mc.onchange = () => { m.motor = mc.checked; save(); };
    const td1 = el("td"); td1.append(el("span", "kbd", m.key));
    const td2 = el("td"); if (m.t !== "act" && m.role === "fader") td2.append(mc);
    const td3 = el("td"); td3.append(d);
    tr.append(td1, el("td", null, describe(m)), td2, td3); t.append(tr);
  }
  if (M.maps.length) ms.append(t); else ms.append(el("p", "note", "No mappings. Use Learn or a preset."));
  w.append(ms);
  v.append(w);
}
export { api };
