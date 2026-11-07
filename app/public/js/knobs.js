// What the six knobs under the X32 screen do on each page, from the Behringer X32 preliminary user manual.
// A cell: [turn, push, value path, scale, push state path, push state inverted]. "" = the manual does not say.
import { G, SCL, FADER, RATIOS, stripDef, linkPath } from "./core.js";
import { bandCount, EQT } from "./eq.js";
import { insLabel } from "./patchpop.js";

const E = (list) => ({ fmt: (i) => list[Math.round(i)] ?? "" });
const X = ["", ""];
const blank = (n = 6) => Array(n).fill(X);
const TAP = ["Tap point", "Assign"], SRC = ["Source", "Assign"];
const BANDS4 = ["Low", "Lo-Mid", "Hi-Mid", "High"], BANDS6 = ["Low", "Low 2", "Lo-Mid", "Hi-Mid", "High 2", "High"];

function strip(b) {
  const def = stripDef(b) || { solo: 1, kind: "ch" };
  const ha = (G.sources[b] || {}).ha;
  const hp = ha != null ? `/headamp/${String(ha).padStart(3, "0")}/` : null;
  const lp = stripDef(b) ? linkPath(def) : null;
  const gain = hp ? ["Gain", "Link", hp + "gain", SCL.ha, lp] : ["Gain", "Link", b + "/preamp/trim", SCL.trim, lp];
  const insPos = ["Insert pre / post", "Insert on", b + "/insert/pos", E(["Pre", "Post"]), b + "/insert/on"];
  const solo = ["", "Solo", null, null, `/-stat/solosw/${String(def.solo).padStart(2, "0")}`];
  const fader = ["Fader", "Mute", b + "/mix/fader", FADER, b + "/mix/on", true];
  const pan = ["Pan", "Main assign", b + "/mix/pan", SCL.pan, b + "/mix/st"];
  const gThr = ["Threshold", "Gate on", b + "/gate/thr", SCL.gthr, b + "/gate/on"];
  const gRng = ["Range", "Ducker", b + "/gate/range", SCL.grange];
  const dThr = ["Threshold", "Comp on", b + "/dyn/thr", SCL.thr, b + "/dyn/on"];
  const dRat = ["Ratio", "Comp / Exp", b + "/dyn/ratio", E(RATIOS.map((r) => r + ":1"))];
  const key = [["Key filter", "Filter on"], ["Filter slope", "Key to solo"], ["Key source", "Assign"]];
  const n = bandCount(def.kind), names = n === 4 ? BANDS4 : BANDS6;
  const band = (k, s, suffix) => {
    const cells = names.map((t, i) => [`${t} ${suffix}`, "", `${b}/eq/${i + 1}/${k}`, s]);
    return n === 4 ? [X, ...cells, X] : cells;
  };
  const gains = band("g", SCL.g, "gain");
  if (n === 4) { gains[0] = ["Low cut", "Low cut on", b + "/preamp/hpf", SCL.hpf, b + "/preamp/hpon"]; gains[5] = ["", "EQ on", null, null, b + "/eq/on"]; }
  return [
    [ // Home
      [gain, gThr, insPos, ["Dyn pre / post EQ", "EQ on", b + "/dyn/pos", E(["Pre", "Post"]), b + "/eq/on"], dThr, pan],
      [["Select channel", "+48V", null, null, hp && hp + "phantom"], ["", "Phase", null, null, b + "/preamp/invert"], ["DCA select", "DCA assign"], ["Mute group select", "Group assign"], solo, fader],
    ],
    [[gain, ["Low cut", "Low cut on", b + "/preamp/hpf", SCL.hpf, b + "/preamp/hpon"], ["Source", "Assign"], ["Delay", "Delay on", b + "/delay/time", SCL.delay, b + "/delay/on"], insPos, ["Insert path", "Assign", b + "/insert/sel", { fmt: (v) => insLabel(v) || "None" }]]], // Config
    [ // Gate
      [gThr, gRng, ["Attack", "", b + "/gate/attack", SCL.att], ["Hold", "", b + "/gate/hold", SCL.hold], ["Release", "", b + "/gate/release", SCL.rel], X],
      [gThr, gRng, X, ...key],
    ],
    [ // Dyn
      [dThr, dRat, ["Attack", "RMS", b + "/dyn/attack", SCL.att], ["Hold", "RMS / Peak, Lin / Log", b + "/dyn/hold", SCL.hold], ["Release", "", b + "/dyn/release", SCL.rel], ["Makeup", "", b + "/dyn/mgain", SCL.mgain]],
      [dThr, dRat, ["Knee", "Pre / post EQ", b + "/dyn/knee", SCL.knee], ...key],
    ],
    [gains, band("f", SCL.f, "freq"), band("q", SCL.q, "Q"), band("type", E(EQT), "mode")], // EQ
    [ // Sends
      [["Send 1 of group", "Mute send"], ["Send 2 of group", "Mute send"], ["Send 3 of group", "Mute send"], ["Send 4 of group", "Mute send"], X, ["Shift 2 sends", "Shift 4 sends"]],
      [["Tap: sends 1-2", ""], X, ["Tap: sends 3-4", ""], X, X, ["Shift 2 sends", "Shift 4 sends"]],
    ],
    [[pan, ["Mono level", "Mono assign", b + "/mix/mlevel", FADER, b + "/mix/mono"], X, X, solo, fader]], // Main
  ];
}

const outPage = (first) => [[[first, ""], X, ["Category", ""], ["Source", "Assign"], TAP, X]];
const blocks = (n) => [Array.from({ length: 6 }, (_, i) => (i < n ? [i === 0 ? "8-ch source" : `Block ${i + 1}`, "Assign"] : X))];
const ROUTE = [
  [[...Array.from({ length: 5 }, (_, i) => [i === 0 ? "Ch 1-8 source" : `Block ${i + 1}`, "Connect"]), X]],
  [[["Output 1-16", ""], X, ["Category", ""], ["Source", "Assign"], TAP, ["Delay", "Delay on"]]],
  outPage("Aux out"), outPage("P16 channel"), blocks(4), blocks(6), blocks(6), null,
];
const SETUP = [
  [[["Preference", "On / off"], ["Linking", "On / off"], ["Pan mode", ""], ["LED brightness", ""], ["Screen brightness", ""], ["LCD brightness", ""]]],
  [[["", "Factory reset"], ["Sample rate", "Assign"], ["Word clock", ""], ["Date / time", "Next field"], ["Bus setup", "Assign"], X]],
  [[["", "Remote layer"], ["Protocol", "Assign"], X, X, X, ["MIDI option", "On / off"]]],
  [[["Field", ""], ["Octet 1", ""], ["Octet 2", ""], ["Octet 3", ""], ["Octet 4", ""], X]],
  null, null, null,
];
const LIB = [
  [[["Recall element", "Include"], ["Scroll presets", "Load"], ["Save slot", "Save"], ["", "Delete"], ["", "USB import"], ["", "USB export"]]],
  [[["Effect slot", ""], ["Scroll presets", "Load"], ["Save slot", "Save"], ["", "Delete"], ["", "USB import"], ["", "USB export"]]],
  [[["Category", "Include"], ["Scroll presets", "Load"], ["Save slot", "Save"], ["", "Delete"], ["", "USB import"], ["", "USB export"]]],
];
function fxPages() {
  const edit = [["Parameter 1", "GEQ on faders"], ["Parameter 2", ""], ["Parameter 3", ""], ["Parameter 4", ""], ["Parameter 5", ""], ["Parameter 6", "Back to Home"]];
  return [[[["Source L", "Assign"], ["Source R", "Assign"], X, X, ["Effect type", "Assign"], ["FX slot", "Edit"]]], ...Array(8).fill([edit])];
}
function monPages() {
  const P = "/config/solo/", F = "/config/osc/";
  const talk = (k) => {
    const T = `/config/talk/${k}/`;
    return [[["", "Talk on", null, null, "/config/talk/enable"], ["", "Int / ext mic", null, null, "/config/talk/source"], ["Gain", "Auto-dim", T + "level", FADER, T + "dim"], ["Destination", "Activate"], ["", "Latch", null, null, T + "latch"], ["Lamp", "Lamp on"]]];
  };
  const hz = { fmt: (v) => { const f = 20 * 1000 ** v; return f >= 1000 ? (f / 1000).toFixed(2) + "k" : f.toFixed(0); } };
  return [
    [[["Level", "", P + "level", FADER], ["Solo mode", "Assign"], ["Delay", "Delay on", P + "delaytime", { fmt: (v) => (.3 + v * 499.7).toFixed(1) + " ms" }, P + "delay"], ["Dim depth", "Dim on", P + "dimatt", { fmt: (v) => (v * 40 - 40).toFixed(0) + " dB" }, P + "dim"], ["Source trim", "Mono", P + "sourcetrim", { fmt: (v) => (v * 36 - 18).toFixed(1) + " dB" }, P + "mono"], ["Source", "Activate", P + "source", E(["Off", "LR", "LR+C", "LR PFL", "LR AFL", "Aux 5-6", "Aux 7-8"])]]],
    talk("A"), talk("B"),
    [[["Level", "Osc on", F + "level", FADER], ["F1", "", F + "f1", hz], ["F2", "Swap F1 / F2", F + "f2", hz, F + "fsel"], ["Type", "Engage", F + "type", E(["Sine", "Pink", "White"])], X, ["Destination", "Assign"]]],
  ];
}
const USB = [
  [[["", "Stop"], ["", "Play"], ["", "Rewind"], ["", "Fast forward"], ["", "Record"], ["Track", "Play track"]]],
  [[["", "Folder"], ["Trim", "L / R input"], ["Category", ""], SRC, ["Tap point", ""], ["", "Folder play"]]],
];
const assignSet = [[["LCD color", ""], ["Control 1-12", ""], ["Category", "Assign"], ["Parameter", "Assign"], ["More parameters", ""], X]];
const ASSIGN = [[Array.from({ length: 5 }, () => ["Move highlight", "Edit"]).concat([X])], assignSet, assignSet, assignSet];
const SCENE_HOME = [[["Scene list", "Go"], ["Skip scene", "Skip"], ["Recent changes", "Undo"], ["Save slot", "Save"], X, ["Safe area", "Select"]]];
const SCENE = [
  SCENE_HOME, null, null,
  [[...Array.from({ length: 4 }, () => ["Move highlight", "Select"]), X, X]],
  [Array.from({ length: 6 }, () => ["Move highlight", "Select"])],
  [[["Scene", ""], ["", "MIDI safe"], ["MIDI event", ""], ["Channel / number / velocity", ""], ["Channel / number / velocity", ""], ["Channel / number / velocity", ""]]],
];

// Layers for one console page. null = the manual gives no list. [] = this page has no knob functions.
export function knobLayers(screen, page, base) {
  switch (screen) {
    case 0: return strip(base)[page] || null;
    case 1: return [];
    case 2: return ROUTE[page] || null;
    case 3: return SETUP[page] || null;
    case 4: return LIB[page] || null;
    case 5: return fxPages()[page] || null;
    case 6: return monPages()[page] || null;
    case 7: return USB[page] || null;
    case 8: return SCENE[page] || null;
    case 9: return ASSIGN[page] || null;
    default: return null;
  }
}
export { blank };
