// Patch one channel in place: a socket panel over the current page. Esc closes it.
import { S, G, $, el, api, store, toast } from "./core.js";

let box = null, fader = "", dev = "", state = null, meta = null;
const faderOf = (base) => {
  const m = /^\/(ch|auxin)\/(\d\d)$/.exec(base);
  return m ? (m[1] === "ch" ? "ch" : "aux") + +m[2] : "";
};
const short = (f) => (f.startsWith("ch") ? `Ch ${f.slice(2)}` : `Aux ${f.slice(3)}`);

function racks() {
  const own = (state.devices || []).filter((d) => d.kind === "box" && d.inCount);
  return [...own, ...((meta && meta.consoleDevs) || [])];
}
function currentJack() {
  for (const [d, jacks] of Object.entries(state.jacksIn || {})) for (const [j, list] of Object.entries(jacks)) if (list.includes(fader)) return [d, +j];
  return [null, 0];
}

function draw() {
  const list = state.faders || [], item = list.find((f) => f.id === fader);
  const i = list.indexOf(item), [cd, cj] = currentJack();
  const all = racks();
  if (!all.some((d) => d.id === dev)) dev = cd || (all[0] && all[0].id) || "";
  const d = all.find((x) => x.id === dev);
  box.innerHTML = "";

  const head = el("div", "pp-head");
  const prev = el("button", null, "‹"), next = el("button", null, "›");
  prev.title = "Previous channel"; next.title = "Next channel";
  prev.disabled = i <= 0; next.disabled = i >= list.length - 1;
  prev.onclick = () => { fader = list[i - 1].id; draw(); };
  next.onclick = () => { fader = list[i + 1].id; draw(); };
  const t = el("div", "pp-title");
  t.append(el("b", null, `${item.label}${item.name ? " · " + item.name : ""}`), el("small", null, item.src ? `Now: ${item.src}${item.via ? " via " + item.via : ""}` : "Not patched"));
  const adv = el("label", "chk"), ac = el("input"); ac.type = "checkbox"; ac.checked = store.get("patchAdvance", false);
  ac.onchange = () => store.set("patchAdvance", ac.checked); adv.append(ac, "Next channel after patch");
  const off = el("button", "danger", "Unpatch"); off.onclick = () => patch("", 0);
  const page = el("button", null, "Patch page"); page.onclick = () => { close(); document.dispatchEvent(new CustomEvent("goto", { detail: "patch" })); };
  const esc = el("button", "primary", "Esc"); esc.title = "Close (Esc)"; esc.onclick = close;
  head.append(prev, t, next, el("span", "grow"), adv, off, page, esc);
  box.append(head);

  const body = el("div", "pp-body");
  const side = el("div", "pp-racks");
  all.forEach((r) => {
    const b = el("button", r.id === dev ? "on" : "", r.name);
    if (r.id === cd) b.classList.add("cur");
    b.onclick = () => { dev = r.id; draw(); };
    side.append(b);
  });
  const grid = el("div", "pp-grid");
  if (d) for (let j = 1; j <= d.inCount; j++) {
    const users = ((state.jacksIn || {})[d.id] || {})[j] || [];
    const label = ((d.labels || {}).in || {})[j] || "";
    const b = el("button", "pp-sock" + (d.id === cd && j === cj ? " on" : "") + (users.length ? " used" : ""));
    b.append(el("b", null, j), el("span", null, label), el("small", null, users.map(short).join(", ")));
    b.onclick = () => patch(d.id, j);
    grid.append(b);
  }
  body.append(side, grid);
  box.append(body);
}

async function patch(device, jack) {
  try {
    const r = await api("/api/route/input", { fader, device, jack });
    toast(r.msg);
    if (r.state) state = r.state; else state = await api("/api/state");
    if (window.Router) Router.setState(state);
    if (jack && store.get("patchAdvance", false)) {
      const list = state.faders, i = list.findIndex((f) => f.id === fader);
      if (i < list.length - 1) fader = list[i + 1].id;
    }
    if (box) draw();
  } catch (e) { toast(e.message, true); }
}

// ---- inserts: the same panel, with insert points in place of sockets ----
export function insLabel(v) {
  if (v >= 1 && v <= 16) return `FX${Math.ceil(v / 2)}${v % 2 ? "L" : "R"}`;
  if (v >= 17 && v <= 22) return `Aux ${v - 16}`;
  return "";
}
function insRacks() {
  const own = (state.devices || []).filter((d) => d.kind === "insert" && d.insCount);
  return [...own, { id: "@fx", name: "Internal FX", insCount: 16 }, { id: "@aux", name: "Aux inserts", insCount: 6 }];
}
const directValue = (id, s) => (id === "@fx" ? s : 16 + s);
function directUsers(id, s) {
  const out = [];
  for (let i = 1; i <= 32; i++) {
    const p = `/ch/${String(i).padStart(2, "0")}/insert/`;
    if (S.get(p + "on") && S.get(p + "sel") === directValue(id, s)) out.push(`ch${i}`);
  }
  return out;
}
function fxName(v) {
  const rack = Math.ceil(v / 2), list = rack <= 4 ? meta.fxTypes : meta.fx5Types;
  return (list || [])[S.get(`/fx/${rack}/type`) ?? -1] || "";
}

function drawInsert() {
  const list = (state.faders || []).filter((f) => f.id.startsWith("ch")), item = list.find((f) => f.id === fader);
  const i = list.indexOf(item), all = insRacks();
  if (!all.some((d) => d.id === dev)) dev = all[0].id;
  const d = all.find((x) => x.id === dev);
  const sel = S.get(`/ch/${fader.slice(2).padStart(2, "0")}/insert/sel`) || 0;
  box.innerHTML = "";

  const head = el("div", "pp-head");
  const prev = el("button", null, "‹"), next = el("button", null, "›");
  prev.title = "Previous channel"; next.title = "Next channel";
  prev.disabled = i <= 0; next.disabled = i >= list.length - 1;
  prev.onclick = () => { fader = list[i - 1].id; drawInsert(); };
  next.onclick = () => { fader = list[i + 1].id; drawInsert(); };
  const t = el("div", "pp-title");
  t.append(el("b", null, `${item.label}${item.name ? " · " + item.name : ""} · Insert`), el("small", null, item.ins ? `Now: ${item.ins}${item.insOn ? "" : " (off)"}` : "No insert"));
  const off = el("button", "danger", "Remove"); off.onclick = () => insert("", 0);
  const esc = el("button", "primary", "Esc"); esc.title = "Close (Esc)"; esc.onclick = close;
  head.append(prev, t, next, el("span", "grow"), off, esc);
  box.append(head);

  const body = el("div", "pp-body"), side = el("div", "pp-racks");
  all.forEach((r) => {
    const b = el("button", r.id === dev ? "on" : "", r.name);
    b.onclick = () => { dev = r.id; drawInsert(); };
    side.append(b);
  });
  const grid = el("div", "pp-grid");
  for (let s = 1; s <= d.insCount; s++) {
    const direct = d.id.startsWith("@");
    const users = direct ? directUsers(d.id, s) : ((state.slots || {})[d.id] || {})[s] || [];
    const here = direct ? sel === directValue(d.id, s) : users.includes(fader);
    const name = direct ? insLabel(directValue(d.id, s)) : ((d.labels || {}).ins || {})[s] || (d.insCount > 1 ? `${d.name} ${s}` : d.name);
    const info = d.id === "@fx" ? fxName(s) : "";
    const b = el("button", "pp-sock" + (here ? " on" : "") + (users.length ? " used" : ""));
    b.append(el("b", null, name), el("span", null, info), el("small", null, users.map(short).join(", ")));
    b.onclick = () => insert(d.id, s);
    grid.append(b);
  }
  body.append(side, grid);
  box.append(body);
}

async function insert(device, slot) {
  try {
    const r = await api("/api/route/insert", { fader, device, slot });
    toast(r.msg, r.warn);
    state = r.state || await api("/api/state");
    if (window.Router) Router.setState(state);
    if (box) {
      drawInsert();
      const open = box;  // the highlight reads live values, which arrive just after the reply
      setTimeout(() => { if (box === open) drawInsert(); }, 400);
    }
  } catch (e) { toast(e.message, true); }
}

export async function openInsert(base) {
  const f = faderOf(base);
  if (!f.startsWith("ch")) return toast("Only input channels have insert points here", true);
  try {
    meta = meta || G.meta || await api("/api/meta");
    state = await api("/api/state");
  } catch (e) { return toast(e.message, true); }
  if (state.noRouting) return toast("Inserts need an X32", true);
  close();
  fader = f; dev = "";
  const back = el("div", "pp-back");
  back.onpointerdown = (e) => { if (e.target === back) close(); };
  box = el("div", "pp");
  back.append(box); $("#app").append(back);
  document.addEventListener("keydown", onKey, true);
  drawInsert();
}

function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
}
export function closePatch() { close(); }
function close() {
  if (!box) return;
  box.parentElement.remove(); box = null;
  document.removeEventListener("keydown", onKey, true);
}

export async function openPatch(base) {
  const f = faderOf(base);
  if (!f) return toast("This strip has no patchable input", true);
  try {
    meta = meta || G.meta || await api("/api/meta");
    state = await api("/api/state");
  } catch (e) { return toast(e.message, true); }
  if (state.noRouting) return toast("Patching needs an X32", true);
  close();
  fader = f; dev = "";
  const back = el("div", "pp-back");
  back.onpointerdown = (e) => { if (e.target === back) close(); };
  box = el("div", "pp");
  back.append(box); $("#app").append(back);
  document.addEventListener("keydown", onKey, true);
  draw();
}
