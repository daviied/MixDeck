// Shell: login, navigation, console switch, keys.
import { S, G, $, el, api, set, store, openStream, events, undo, canUndo, scope, FADER, stripDef, layerStrips, onAny, toast, clearSolos } from "./core.js";
import { buildMix, select } from "./mix.js";
import { buildInspector, initInspector } from "./inspector.js";
import { buildFx, buildScenes, buildLink, buildSettings, applyDisplay } from "./pages.js";
import { buildMidi, initMidi, midi } from "./midi.js";
import { pr } from "./ui.js";
import { buildDesk } from "./desk.js";
import { isFollow, followTabs, enterFollow, exitFollow, initFollow, buildFollowPage } from "./follow.js";

const ICON = {
  desk: "M4 3h16v8H4zM7 14v7M12 14v7M17 14v7M5 17h4M10 15h4M15 19h4",
  mix: "M6 3v8m0 4v6M12 3v2m0 4v12M18 3v10m0 4v4M4 11h4v4H4zM10 5h4v4h-4zM16 13h4v4h-4z",
  fx: "M3 12c3-8 6-8 9 0s6 8 9 0",
  scenes: "M4 6h16M4 12h16M4 18h10",
  patch: "M7 4v5a5 5 0 0 0 10 0V4M12 14v6",
  link: "M9 15l6-6M8 12l-2 2a3.5 3.5 0 0 0 5 5l2-2M16 12l2-2a3.5 3.5 0 0 0-5-5l-2 2",
  midi: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM7 12h.01M9 8.5h.01M15 8.5h.01M17 12h.01M12 7h.01",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1",
};
const VIEWS = [["mix", "Mix"], ["desk", "DiGiCo"], ["fx", "FX"], ["scenes", "Scenes"], ["patch", "Patch"], ["link", "Link"], ["midi", "MIDI"], ["settings", "Settings"]];

function drawNav() {
  if (isFollow()) return followTabs();
  const n = $("#views"); n.innerHTML = "";
  for (const [k, t] of VIEWS) {
    const b = el("button", k === G.view ? "on" : "");
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[k]}"/></svg>`;
    b.append(t); b.onclick = () => go(k); n.append(b);
  }
}
const BUILD = { mix: () => { buildMix(); buildInspector({}); }, desk: () => { buildMix(); buildDesk(); }, fx: buildFx, scenes: buildScenes, link: buildLink, midi: buildMidi, settings: buildSettings, patch: () => {}, follow: buildFollowPage };
function go(v) {
  G.view = v; if (!isFollow()) store.set("view", v);
  drawNav();
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
  window.Router && Router.show(v === "patch");
  if (v === "patch") $("#noRouting").hidden = !!Object.values(G.status).some((c) => c && c.kind === "x32");
  BUILD[v]();
}
document.addEventListener("goto", (e) => go(e.detail));

function drawConsoles() {
  const box = $("#consoles"); box.innerHTML = "";
  for (const s of ["A", "B"]) {
    const st = G.status[s]; if (!st) continue;
    const b = el("button", s === G.slot ? "on" : ""), d = el("span", "dot " + (st.connected ? "ok" : "bad"));
    b.append(d, el("b", null, st.name || s));
    b.title = `${st.kind.toUpperCase()} ${st.ip} ${st.connected ? "connected" : "not connected"}`;
    b.onclick = () => { if (G.slot !== s) { G.slot = s; store.set("slot", s); openStream(); } };
    box.append(b);
  }
  const L = G.link, chip = $("#linkChip");
  chip.hidden = !(L && L.enabled);
  if (L) chip.textContent = L.paused ? "Link paused" : { a2b: "Link A→B", b2a: "Link B→A", both: "Link A↔B" }[L.direction];
  const cur = G.status[G.slot], rb = $("#readBar");
  rb.hidden = !cur || !cur.connected || cur.progress >= .995;
  if (cur) rb.firstChild.style.width = cur.progress * 100 + "%";
}

let monSc = scope();
function drawMon() {
  monSc.dispose(); monSc = scope();
  const m = $("#mon"); m.innerHTML = "";
  if (G.caps && G.caps.full) m.append(pr(monSc, "/config/solo/level", "Mon", FADER));
  m.firstChild && (m.firstChild.style.flex = "1");
  $("#clearSolo").hidden = !(G.caps && G.caps.full);
  $("#follow").hidden = !(G.caps && G.caps.full);
}

function soloState() {
  let any = false;
  for (let i = 1; i <= 80 && !any; i++) if (S.get(`/-stat/solosw/${String(i).padStart(2, "0")}`)) any = true;
  $("#clearSolo").classList.toggle("active", any);
}

events.addEventListener("full", () => {
  if (G.caps && !stripDef(G.selected)) G.selected = "/ch/01";
  if (G.caps) { const base = G.selected; const d = stripDef(base); if (d && d.kind === "ch" && d.n > G.caps.ch) G.selected = "/ch/01"; }
  drawConsoles(); drawMon(); soloState();
  if (G.view === "patch" || isFollow()) return;  // follow.js handles its own rebuild
  BUILD[G.view]();
  midi.rebindFeedback();
});
events.addEventListener("status", () => { drawConsoles(); if (G.view === "link" && !document.activeElement?.closest?.("#v-link select")) refreshLinkNote(); });
function refreshLinkNote() { const n = document.querySelector("#v-link .sec .row .note"); if (n && G.link) n.textContent = G.link.last ? `${G.link.count} moves. Last: ${G.link.last}` : "No linked moves yet."; }
events.addEventListener("sources", (e) => {  // inserts and routing also send this: rebuild only when this channel's source changes
  const src = (m) => JSON.stringify((m || {})[G.selected] || {});
  if (G.view === "mix" && src(e.detail) !== src(G.sources)) buildInspector({});
});
events.addEventListener("undo", () => ($("#undo").disabled = !canUndo()));
onAny((p) => { if (p.startsWith("/-stat/solosw/")) soloState(); });

$("#undo").onclick = undo;
$("#clearSolo").onclick = clearSolos;
$("#follow").onclick = () => (isFollow() ? exitFollow() : enterFollow(true));

document.addEventListener("keydown", (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  const desk = G.view === "desk";
  if (e.ctrlKey || e.metaKey || e.altKey || (G.view !== "mix" && !desk) || !G.caps) return;
  const list = [...document.querySelectorAll(desk ? "#dstrips .strip" : "#strips .strip")].map((x) => x.dataset.base);
  const d = stripDef(G.selected), key = e.key.toLowerCase();
  if (!desk && key >= "1" && key <= "6") { G.layer = ["in", "aux", "bus", "mtx", "dca", "fav"][+key - 1]; buildMix(); }
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    const n = list[list.indexOf(G.selected) + (e.key === "ArrowRight" ? 1 : -1)];
    if (n) { select(n); document.querySelector(`#strips .strip[data-base="${n}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" }); }
  } else if (key === "m" && d) set(d.on, S.get(d.on) === 0 ? 1 : 0);
  else if (key === "s" && d && G.caps.full) { const p = `/-stat/solosw/${String(d.solo).padStart(2, "0")}`; set(p, S.get(p) ? 0 : 1); }
  else if (!desk && key === "i") { store.set("inspOpen", !store.get("inspOpen", true)); buildInspector({}); buildMix(); }
});
let lastW = innerWidth <= 760;
addEventListener("resize", () => { const n = innerWidth <= 760; if (n !== lastW) { lastW = n; if (G.view === "mix") BUILD.mix(); } });

async function start() {
  $("#login").hidden = true; $("#app").hidden = false;
  G.meta = await api("/api/meta");
  G.slot = store.get("slot", "A"); G.layer = store.get("layer", "in"); G.view = store.get("view", "mix");
  initInspector(); initFollow(go);
  await Router.init().catch(() => {});
  openStream(); go(G.view); initMidi();
}
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  try { await api("/api/login", { password: $("#pw").value }); location.reload(); }
  catch (err) { $("#loginErr").textContent = err.message; }
};
applyDisplay();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
fetch("/api/auth").then((r) => r.json()).then((j) => { if (j.authed) start(); else $("#login").hidden = false; }).catch(() => ($("#login").hidden = false));
export { toast, layerStrips };
