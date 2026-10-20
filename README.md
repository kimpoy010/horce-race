# Retro Horse Race

1980s-style 8-bit horse race for the web. Six numbered horses run a closed track shaped like a "U" lying on its side (opening to the left): they start at the
top-left, run right along the top straight, round the curve, and race back left along the bottom straight to the finish line,
also on the left. A close-up camera follows the pack the whole way (a minimap shows the full track).
Every race has **two winning numbers** (the horses that finish 1st and 2nd) chosen on the **controller page**.

## Run

```
CONTROLLER_KEY=mysecret PORT=8080 node server.js     # no dependencies, Node 16+
```
* Game: `http://localhost:8080/`  * Controller: `http://localhost:8080/controller`
* `npm test` runs the core tests.

### Controller
* Pad/table to set horse A / horse B per race; "exact order" = A wins, B second, otherwise random order of the two.
* Empty rows are fully random. **START RACE** (6 s countdown) or **AUTO-RUN** (races chain automatically).
* The plan is private: viewers only receive the finishing order ~2 s before the gun (`GET /api/public`).
  Controller endpoints (`/api/admin`, `/api/command`) require the `x-controller-key` header.

### Without a server (static hosting)
Host `public/` anywhere. Open `controller.html` and `index.html` in the **same browser** (same origin); they share state
through localStorage and the controller tab must stay open. Browsers partition storage in cross-site iframes, so real
embedding needs the server mode.

## Embedding in another platform
```html
<iframe src="https://YOUR-HOST/index.html" allow="autoplay" style="width:100%;aspect-ratio:16/9;border:0"></iframe>
```
Query params: `?api=https://host` (race server), `?mode=local`, `?sound=0`, `?hud=0`.
The game posts events to the parent window: `{source:'horse-race', type:'countdown'|'start'|'result', raceNo, order, combination}`
and accepts `{target:'horse-race', type:'setSound', on:true}`. See `public/embed-example.html`.

All viewers stay in sync (race is a pure function of a server seed + start time), including late joiners.

Note: the controller deliberately predetermines outcomes. Use it for entertainment, demos and giveaways; do not
present a rigged race as a game of chance for real-money wagering.
