# MixDeck

Console control with a modern UI: a replacement for X32-Edit. Installable web app (PWA) for laptop, tablet and phone. It runs in Docker on a Raspberry Pi or any Linux host.

Supports Behringer X32 / M32 (full) and Yamaha TF1 (faders, mutes, names, pan, aux sends, scene recall by number).

## Features

- **Mix**: all strips with live meters, EQ curve on each strip, gate/comp/insert lights, jack name from your patch. Sends on fader. Multi-touch faders that never jump on touch. Undo. Favorites layer. S, M, L, XL size and a daylight theme.
- **Channel panel**: gain, 48 V, trim, low cut, delay, gate, EQ graph, compressor, sends, DCA and mute groups on one screen. Drag values; double click to type; Shift for fine moves. The ⤢ button on a section shows it full screen; Esc closes it.
- **DiGiCo view**: a DiGiCo-style layout (not affiliated with DiGiCo). Fader banks of up to 12, a touch column per channel (source, gain with 48 V and phase indicators, HPF, EQ, insert pre, gate, comp, insert post, sends, pan, name), a rotary per fader (gain, HPF, pan or a send), and Flip to faders. Tap a section to expand it; tap the source to patch. Tap the gain section for 48 V and phase. Tap a channel name to select the channel, and tap again to rename it. The X32 has one insert per channel: the pre or post row you pick is where it goes. **Hide faders** shows only the touch screen, with level, meters and mute and solo state. As on a DiGiCo, the gate row has three lights (green open, amber reducing, red closed at the gate range) and the comp row has a gain reduction meter (0 to 24 dB, top down). **Gate lights**, **Comp meter**, **Meters**, **Aux sends** and **Gate / comp graph metering** (the graphs on the gate and comp pages) turn those displays off. The aux style choice shows sends as bars or as knobs (sends 1-8 or 9-16): drag a knob to set the level, tap it to turn the send on or off, and tap the AUX header for the sends page. **EQ, gate, comp in a window** opens those sections in a small window beside the strip, not full screen. **Sync select with console** (on by default) selects the same channel on the app and the console, both ways. With manual banks, a select on the console also moves the app to the bank that holds that channel. **Follow console bank** (X32) shows the strips of the fader bank up on the console: left bank, right bank or both. **Console layout** sets X32 standard (16 input faders) or X32 Compact (8 input faders, 8 layers). The Compact bank values are assumed to run in layer order, and are not tested on a real Compact. Compact fader extend (two input bank buttons at once): the app assumes a group bank value of 4 or more means an input layer on the right faders. If your console reports something else, turn on **Span 16 inputs** (the right faders then show the next input layer), and read the bank values the panel shows. **Open EQ / dyn with console** opens the gate, comp or EQ section here when the console opens that page, and closes it when the console leaves. On X32 Producer and Rack the bank layout differs and is not tested.
- **Full screen**: the ⛶ button at the top right (not available in iPhone Safari; install the app there).
- **RTA**: the EQ graph shows the channel's spectrum (X32). The console sends RTA data only while a graph is on screen. The app sets the console's RTA source to that channel, and sets the source settings back when the graph closes. Turn it off with the RTA button on the graph.
- **FX**: 8 racks with named parameters.
- **Scenes**: list, filter, next-scene button, recall with a confirm tap, save.
- **Patch**: the X32 Router UI (stage box routing, blocks, devices, inserts, patch bay, printable plan).
- **Patch panel**: "Patch this input" in the channel panel opens a socket grid over the current page. Tap a socket to patch. Esc closes it. Source labels, head amp and patching follow the channel's source setting on the console.
- **Insert and link**: the Input card has "Choose insert" (your insert devices, Internal FX, Aux inserts), insert on, and pre or post. It also links odd-even channel pairs, with a second tap to confirm. Aux In has the link only, because it has no insert point. FX returns, buses and matrix have the link on the Channel card.
- **Follow mode** (X32): the screen shows the page and channel that the console screen shows, full screen. A row shows what the six knobs under the console screen do on that page, from the Behringer preliminary manual. The console does not report its knob layer. The row moves to a layer when a value only on that layer changes at the console. Otherwise tap Layer to match it. Settings: taps also change the console screen; show knob row. Meters and Monitor are included. Setup, Library, USB and Assign show the knob row and a note, not the page.
- **Link**: one console controls the other over the network. A→B, B→A or both, with a strip map for consoles of different sizes. Scene recalls pause the link for 3 s so a scene does not overwrite the other console. Turning the link on moves nothing.
- **MIDI**: learn any fader, mute, solo or pan. Mackie Control preset with motor fader feedback and banks. 8 CC fader preset with soft takeover. Uses Web MIDI: Chrome or Edge over HTTPS or localhost. Safari and iPhone do not have Web MIDI. Mappings are saved per browser.

## Run on the Pi (CasaOS)

1. Push this folder to `github.com/daviied/mixdeck`. The GitHub Action builds `ghcr.io/daviied/mixdeck:latest` (arm64, armv7, amd64).
2. Make the package public (GitHub → Packages → mixdeck → Settings), or log in to GHCR on the Pi.
3. In CasaOS: **Custom Install → Import**, paste `docker-compose.yml`, set `APP_PASSWORD`, `SESSION_SECRET`, `X32_IP`.
4. Open `http://<pi>:8080`, then **Settings** to set Console A and Console B.
5. Put nginx in front with HTTPS (needed for PWA install and Web MIDI). No special nginx config: `proxy_pass` plus `X-Forwarded-Proto`. The app sends `X-Accel-Buffering: no` for its event stream.

The host must reach the X32 on UDP 10023 and the TF1 on TCP 49280. Use a wired network: a full read is about 4,500 values.

## Try it without a console

```bash
cd app && APP_PASSWORD=test X32_MOCK=1 DATA_DIR=../.data python server.py
```

Runs simulated consoles: Console A X32, Console B TF1. Tests: `python tests/test_backend.py`.

## How it works

- `app/x32.py` and `app/tf1.py` are drivers. Both expose X32-shaped paths (`/ch/01/mix/fader`), so the UI and `app/link.py` do not care which console is connected.
- The server pushes changes and meters on Server-Sent Events. The page sends all pending moves in one POST at a time.
- `app/routing.py` and `app/x32map.py` come from X32 Router. Routing applies to the first X32 (Console A if both are X32).

## Limits

- Not yet tested on real hardware. The X32 follows the Unofficial X32/M32 OSC Protocol. The TF1 commands come from third-party sources (bitfocus companion-module-yamaha-rcp, yamaha-rcp-docs); Yamaha publishes no TF spec. TF1 fader range, St L/R handling and scene commands need a check on a console.
- TF1: no meters, EQ, dynamics, FX, solo, routing or scene names yet.
- FX names were extracted from the protocol PDF by `tools/gen_fxdefs.py`. Some effects (GEQ, PQ5 and others) have partial lists and show as generic parameters.
