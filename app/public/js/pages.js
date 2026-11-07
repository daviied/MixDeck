// FX, Scenes, Link and Settings pages.
import { S, G, $, el, set, scope, api, toast, lin, log, store, layerStrips, stripDef, on, onAny, openStream } from "./core.js";
import { pr, enumSel } from "./ui.js";

const pad = (n, w = 2) => String(n).padStart(w, "0");
let FX = null;
fetch("/fxdefs.json").then((r) => r.json()).then((j) => (FX = j)).catch(() => (FX = {}));

// ---- FX ----
let fxSc = scope(), rack = 1;
export const fxHooks = { rack: null };
export const setRack = (r) => { rack = r; };
export function buildFx() {
  fxSc.dispose(); fxSc = scope();
  const v = $("#v-fx"); v.innerHTML = "";
  const w = el("div");
  if (!G.caps || !G.caps.full) { w.append(el("div", "empty", "FX racks are available on the X32.")); v.append(w); return; }
  const types = (r) => (r <= 4 ? G.meta.fxTypes : G.meta.fx5Types);
  const list = el("div", "fxl");
  for (let r = 1; r <= 8; r++) {
    const b = el("button", "rack" + (r === rack ? " on" : ""));
    const t = el("small"); b.append(el("b", null, `FX ${r}`), t);
    fxSc.on(`/fx/${r}/type`, (x) => (t.textContent = types(r)[x ?? 0] || "?"));
    b.onclick = () => { rack = r; fxHooks.rack && fxHooks.rack(r); buildFx(); };
    list.append(b);
  }
  w.append(list);
  const sec = el("div", "sec"), top = el("div", "row");
  top.append(el("h2", "grow", `FX ${rack}`));
  sec.append(top);
  const s = el("select"); types(rack).forEach((t, i) => s.append(new Option(t, i)));
  top.append(el("span", "note", rack <= 4 ? "Send rack" : "Insert rack"), s);
  const body = el("div", "fxp"); sec.append(body);
  if (rack <= 4) {
    const srcs = ["Insert", ...Array.from({ length: 16 }, (_, i) => `Bus ${i + 1}`), "M/C"];
    const r = el("div", "gr2"); r.style.marginTop = ".5rem";
    r.append(enumSel(fxSc, `/fx/${rack}/source/l`, "Source L", srcs), enumSel(fxSc, `/fx/${rack}/source/r`, "Source R", srcs));
    sec.insertBefore(r, body);
  }
  const draw = (tv) => {
    s.value = tv ?? 0;
    const name = types(rack)[tv ?? 0];
    const defs = (FX && FX[name]) || [];
    body.innerHTML = "";
    const known = defs.length >= 3;
    const n = known ? defs.length : 32;
    const paths = [];
    const sc = fxSc;
    for (let i = 1; i <= n; i++) {
      const p = `/fx/${rack}/par/${pad(i)}`; paths.push(p);
      const d = defs[i - 1] || { n: `Par ${i}`, a: 0, b: 1, t: "lin" };
      if (d.e) {
        const c = d.e.length;
        const scale = { fmt: (x) => d.e[Math.round(x * (c - 1))] ?? d.e[Math.min(c - 1, Math.round(x))] ?? "", parse: (t) => { const k = d.e.indexOf(t); return k < 0 ? 0 : k / (c - 1); } };
        body.append(pr(sc, p, d.n, scale));
      } else {
        const a = d.a, b = d.b, useLog = d.t === "log" && a > 0;
        const dec = Math.abs(b - a) >= 100 ? 0 : Math.abs(b - a) >= 10 ? 1 : 2;
        body.append(pr(sc, p, d.n, useLog ? log(a, b, "", dec) : lin(a, b, "", dec)));
      }
    }
    api("/api/read", { c: G.slot, paths }).catch(() => {});
    if (!known) body.prepend(el("p", "note", "Names for this effect are not in the table yet. Values show 0 to 1."));
  };
  s.onchange = () => { set(`/fx/${rack}/type`, +s.value); setTimeout(() => draw(+s.value), 250); };
  let shown = -1;
  fxSc.on(`/fx/${rack}/type`, (x) => { if (x !== shown) { shown = x; draw(x); } });
  w.append(sec); v.append(w);
}

// ---- Scenes ----
let scnSc = scope(), scnFilter = "";
export function buildScenes() {
  scnSc.dispose(); scnSc = scope();
  const v = $("#v-scenes"); v.innerHTML = "";
  const w = el("div");
  if (!G.caps) { w.append(el("div", "empty", "No console.")); v.append(w); return; }
  const named = G.caps.sceneNames;
  const cur = () => S.get("/-show/prepos/current") ?? -1;
  const bar = el("div", "nextbar");
  const armed = {};
  const recall = (i, btn) => {
    const now = performance.now();
    if (!armed[i] || now - armed[i] > 3000) {
      armed[i] = now; const t = btn.textContent; btn.textContent = "Confirm"; btn.classList.add("primary");
      setTimeout(() => { btn.textContent = t; btn.classList.remove("primary"); }, 3000);
      return;
    }
    armed[i] = 0;
    api("/api/scene", { c: G.slot, action: "recall", slot: i }).then((r) => toast(r.msg)).catch((e) => toast(e.message, true));
  };
  if (named) {
    const go = el("button", "go primary", "Next scene");
    const lbl = el("span", "note");
    const used = (i) => S.get(`/-show/showfile/scene/${pad(i, 3)}/hasdata`) || S.get(`/-show/showfile/scene/${pad(i, 3)}/name`);
    const nextIdx = () => { for (let i = cur() + 1; i < 100; i++) if (used(i)) return i; return -1; };
    const upd = () => { const n = nextIdx(); lbl.textContent = n < 0 ? "No next scene" : `Next: ${pad(n)} ${S.get(`/-show/showfile/scene/${pad(n, 3)}/name`) || ""}`; go.disabled = n < 0; };
    scnSc.on("/-show/prepos/current", upd);
    go.onclick = () => { const n = nextIdx(); if (n >= 0) recall(n, go); };
    const f = el("input"); f.placeholder = "Filter"; f.value = scnFilter; f.oninput = () => { scnFilter = f.value; draw(); };
    f.onkeydown = (e) => e.stopPropagation();
    bar.append(go, lbl, el("span", "grow"), f);
  } else bar.append(el("p", "note", "The TF1 protocol does not give scene names here. Scene bank A by number. Recall and save send the command; check the console."));
  w.append(bar);
  const list = el("div", "sec"); w.append(list);
  function draw() {
    list.innerHTML = "";
    for (let i = 0; i < 100; i++) {
      const P = `/-show/showfile/scene/${pad(i, 3)}/`;
      const nm = S.get(P + "name") || "", has = named ? S.get(P + "hasdata") || nm : 1;
      if (scnFilter && !nm.toLowerCase().includes(scnFilter.toLowerCase())) continue;
      const r = el("div", "scn" + (i === cur() ? " cur" : "") + (has ? "" : " empty2"));
      r.append(el("span", "no", pad(i)), el("span", "grow", has ? nm || "(no name)" : "Empty"));
      if (has) { const g = el("button", null, "Recall"); g.onclick = () => recall(i, g); r.append(g); }
      const sv = el("button", null, "Save");
      sv.onclick = () => {
        let name = nm;
        if (named) { name = prompt(`Save the live desk to scene ${pad(i)}. Name:`, nm || `Scene ${i}`); if (name == null) return; }
        else if (!confirm(`Overwrite scene A${pad(i)} on the TF1?`)) return;
        api("/api/scene", { c: G.slot, action: "save", slot: i, name }).then((x) => toast(x.msg)).catch((e) => toast(e.message, true));
      };
      r.append(sv); list.append(r);
    }
  }
  draw();
  let due = 0;
  scnSc.add(onAny((p) => { if (p.startsWith("/-show/") && !due) due = setTimeout(() => { due = 0; if (G.view === "scenes") draw(); }, 200); }));
  v.append(w);
}

// ---- Link ----
export function stripOptions(caps) {
  const out = [];
  for (const layer of ["in", "aux", "bus", "mtx", "dca"]) for (const b of layerStrips(layer, caps)) out.push(b);
  out.push("/main/st"); if (caps.mono) out.push("/main/m");
  return out;
}
const keyOf = (b) => { const m = /^\/(ch|auxin|fxrtn|bus|mtx)\/(\d\d)$/.exec(b); if (m) return m[1] + +m[2]; const d = /^\/dca\/(\d)$/.exec(b); if (d) return "dca" + d[1]; return b === "/main/st" ? "mainst" : "mainm"; };
const nameOfKey = (b) => { const d = stripDef(b); return d ? d.label : b; };

export function buildLink() {
  const v = $("#v-link"); v.innerHTML = "";
  const w = el("div"), A = G.status.A, B = G.status.B, L = G.link;
  if (!A || !B) {
    const s = el("div", "sec"); s.append(el("h2", null, "Console link"), el("p", "note", "Set up two consoles in Settings. A move on one console then drives the other, across the network. Matched or mismatched: X32 and Yamaha TF1."));
    w.append(s); v.append(w); return;
  }
  const post = async (b) => { G.link = await api("/api/link", b); buildLink(); };
  const top = el("div", "sec");
  const head = el("div", "row"); head.append(el("h2", "grow", "Console link"));
  const onb = el("button", L.enabled ? "primary" : "", L.enabled ? "Link on" : "Link off");
  onb.onclick = () => post({ enabled: !L.enabled });
  head.append(onb); top.append(head);
  const nm = (s) => s.name || s.slot;
  top.append(el("p", "note", `${nm(A)} (${A.kind.toUpperCase()}${A.connected ? "" : ", offline"}) and ${nm(B)} (${B.kind.toUpperCase()}${B.connected ? "" : ", offline"}). Turning the link on moves nothing until a control moves. A scene recall pauses the link for 3 s.`));
  const seg = el("div", "seg");
  for (const [k, t] of [["a2b", `${nm(A)} controls ${nm(B)}`], ["b2a", `${nm(B)} controls ${nm(A)}`], ["both", "Both ways"]]) {
    const b = el("button", L.direction === k ? "on" : "", t); b.onclick = () => post({ direction: k }); seg.append(b);
  }
  top.append(seg);
  const pr2 = el("div", "row"); pr2.style.marginTop = ".5rem";
  for (const [k, t] of [["fader", "Faders"], ["mute", "Mutes"], ["pan", "Pan"], ["name", "Names"], ["sends", "Sends"]]) {
    const l = el("label", "chk"), c = el("input"); c.type = "checkbox"; c.checked = L.params[k];
    c.onchange = () => post({ params: { ...L.params, [k]: c.checked } });
    l.append(c, t); pr2.append(l);
  }
  top.append(pr2);
  const r3 = el("div", "row"); r3.style.marginTop = ".5rem";
  const sync = (d, t) => { const b = el("button", null, t); let a = 0; b.onclick = () => {
    if (performance.now() - a > 3000) { a = performance.now(); toast("Tap again. This moves the faders on the other console."); return; }
    api("/api/link/sync", { direction: d }).then(() => toast("Sync sent"));
  }; return b; };
  r3.append(sync("a2b", `Copy ${nm(A)} → ${nm(B)}`), sync("b2a", `Copy ${nm(B)} → ${nm(A)}`));
  const act = el("span", "note", L.last ? `${L.count} moves. Last: ${L.last}` : "No linked moves yet.");
  r3.append(act); top.append(r3); w.append(top);

  const sec = el("div", "sec");
  const h2 = el("div", "row"); h2.append(el("h2", "grow", "Strip map"));
  const auto = el("button", null, "Same number to same number"); auto.onclick = () => post({ autoMap: true }).then(() => toast("Map reset"));
  h2.append(auto); sec.append(h2);
  sec.append(el("p", "note", `${A.kind.toUpperCase()} has ${A.caps.ch} input channels and ${B.kind.toUpperCase()} has ${B.caps.ch}. Choose which strip on ${nm(B)} follows each strip on ${nm(A)}.`));
  const map = new Map((L.map || []).map(([a, b]) => [a, b]));
  const box = el("div", "mapbox"), t = el("table", "tbl");
  const hr = el("tr"); hr.append(el("th", null, nm(A)), el("th", null, nm(B))); t.append(hr);
  const bOpts = stripOptions(B.caps);
  const save = () => post({ map: [...map] }).catch((e) => toast(e.message, true));
  for (const a of stripOptions(A.caps)) {
    const k = keyOf(a), tr = el("tr"), s = el("select");
    s.append(new Option("Not linked", ""));
    for (const b of bOpts) s.append(new Option(nameOfKey(b), keyOf(b)));
    s.value = map.get(k) || "";
    s.onchange = () => { if (s.value) map.set(k, s.value); else map.delete(k); save(); };
    const td = el("td"); td.append(s);
    const n = G.slot === "A" ? S.get(a + "/config/name") : "";
    tr.append(el("td", null, nameOfKey(a) + (n ? ` · ${n}` : "")), td); t.append(tr);
  }
  box.append(t); sec.append(box); w.append(sec);
  v.append(w);
}

// ---- Settings ----
export async function buildSettings() {
  const v = $("#v-settings"); v.innerHTML = "";
  const w = el("div");
  const { config, status } = await api("/api/consoles");
  const sec = el("div", "sec"); sec.append(el("h2", null, "Consoles"));
  for (const slot of ["A", "B"]) {
    const c = config[slot], st = status[slot], card = el("div", "consolecard");
    const fld = (t, n) => { const l = el("label", "field", t); l.append(n); return l; };
    const ty = el("select"); [["x32", "Behringer X32 / M32"], ["tf1", "Yamaha TF1"], ["none", "None"]].forEach(([k, t]) => ty.append(new Option(t, k)));
    ty.value = c.type || "none";
    const ip = el("input"); ip.value = c.ip || ""; ip.placeholder = "192.168.1.50"; ip.inputMode = "decimal";
    const nm = el("input"); nm.value = c.name || ""; nm.maxLength = 24;
    for (const i of [ip, nm]) i.onkeydown = (e) => e.stopPropagation();
    const save = el("button", "primary", "Save");
    save.onclick = async () => {
      try { await api("/api/consoles", { consoles: { [slot]: { type: ty.value, ip: ip.value, name: nm.value } } }); toast(`Console ${slot} saved`); setTimeout(() => { openStream(); buildSettings(); }, 200); }
      catch (e) { toast(e.message, true); }
    };
    const s = el("span", "pill" + (st && st.connected ? " ok" : ""), !st ? "Not set" : st.connected ? st.info || "Connected" : "Not connected");
    card.append(fld(`Console ${slot}`, ty), fld("Name", nm), fld("IP address", ip));
    const rw = el("div", "field"); rw.append(s, save); card.append(rw);
    sec.append(card);
  }
  const r = el("div", "row");
  const find = el("button", null, "Find X32 on network"), rd = el("button", null, "Re-read console"), found = el("div", "row");
  find.onclick = async () => {
    found.textContent = "Searching…";
    try {
      const { consoles } = await api("/api/discover"); found.innerHTML = "";
      if (!consoles.length) found.append(el("span", "note", "None found. Check the network and host networking, or type the IP."));
      for (const c of consoles) found.append(el("span", "pill", `${c.model} "${c.name}" ${c.ip} fw ${c.fw}`));
    } catch (e) { found.textContent = e.message; }
  };
  rd.onclick = () => api("/api/refresh", { c: G.slot }).then(() => toast("Reading console"));
  r.append(find, rd, found); sec.append(r); w.append(sec);

  const ui = el("div", "sec"); ui.append(el("h2", null, "Display"));
  const row = el("div", "row");
  const size = el("div", "seg");
  for (const [t, px] of [["S", 14], ["M", 16], ["L", 18], ["XL", 21]]) {
    const b = el("button", store.get("size", 16) === px ? "on" : "", t);
    b.onclick = () => { store.set("size", px); applyDisplay(); buildSettings(); }; size.append(b);
  }
  const th = el("div", "seg");
  for (const [k, t] of [["dark", "Dark"], ["light", "Daylight"]]) {
    const b = el("button", store.get("theme", "dark") === k ? "on" : "", t);
    b.onclick = () => { store.set("theme", k); applyDisplay(); buildSettings(); }; th.append(b);
  }
  const syn = el("label", "chk"), sc = el("input"); sc.type = "checkbox"; sc.checked = store.get("syncSel", false);
  sc.onchange = () => store.set("syncSel", sc.checked); syn.append(sc, "Selecting here also selects on the desk");
  const fw = el("label", "chk"), fc = el("input"); fc.type = "checkbox"; fc.checked = store.get("followTwoWay", true);
  fc.onchange = () => store.set("followTwoWay", fc.checked); fw.append(fc, "Follow mode: taps here also change the console screen");
  const fk = el("label", "chk"), kc = el("input"); kc.type = "checkbox"; kc.checked = store.get("followKnobs", true);
  kc.onchange = () => store.set("followKnobs", kc.checked); fk.append(kc, "Follow mode: show what the console knobs do");
  row.append(el("span", "note", "Size"), size, el("span", "note", "Theme"), th, syn, fw, fk); ui.append(row);
  ui.append(el("p", "note", "Keys: 1-6 layers, ← → channel, M mute, S solo, I channel panel, Ctrl+Z undo. Shift while dragging for fine moves. Double click a value to type it. Double click a fader for 0 dB."));
  w.append(ui);
  const out = el("div", "sec"); const lo = el("button", null, "Log out");
  lo.onclick = async () => { await api("/api/logout", {}); location.reload(); };
  out.append(lo);
  if (G.meta && G.meta.mock) out.prepend(el("p", "warn", "Demo mode: this runs on simulated consoles (X32_MOCK=1)."));
  w.append(out); v.append(w);
}

export function applyDisplay() {
  document.documentElement.style.setProperty("--size", store.get("size", innerWidth <= 760 ? 14 : 16) + "px");
  document.documentElement.dataset.theme = store.get("theme", "dark");
}
export { on };
