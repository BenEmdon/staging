/*
  Experiment (dither-outside-v2): the background dither field.

  An ordered Bayer dither on the fixed 8px grid, drawn on a canvas
  behind the page, in the theme's blues (the ramp lives in
  bg-dither.css as --bgd-1..4). The production page is untouched:
  the content column keeps its solid ground, and the field exists
  only behind and around it. The JS also masks the column's rect
  out of the drawing, so the field is never even painted under
  text.

  A tiny bit only. Density (the share of cells lit) is capped at
  DENSITY_CAP = 0.10 anywhere, at any moment: with an 8x8 Bayer
  matrix the lit share steps in sixty-fourths, and the cap admits
  at most 6 of 64 cells (0.09375). At rest the field peaks at
  0.05 at the viewport edges and sits near 0.015 at the centre:
  the background reads as close to plain, the dither faintly
  present. Scrolling and pointer movement stir it: energy from
  either source raises the density a step at a time and, near
  the pointer, shifts lit cells toward the stronger rungs. When
  the reader stops, the energy decays in whole steps and the
  field settles still. Cells only ever swap solid colours in
  place on the grid: no fades, no drift, no motion of any pixel.

  Reduced motion: one static field at the rest density, no stir.
  Without JS there is no canvas and the page is production.
*/

const CELL = 8;
const DENSITY_CAP = 0.1;
const REST_EDGE = 0.05;
const REST_CENTRE = 0.015;
const POINTER_RADIUS = 14; // cells
const POINTER_BOOST = 0.05;
const SCROLL_BOOST = 0.03;
const SCROLL_STEP_PX = 96; // one Bayer phase cell per this much scroll
const TICK_MS = 150;

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

const canvas = document.createElement("canvas");
canvas.className = "bg-dither";
canvas.setAttribute("aria-hidden", "true");
document.body.prepend(canvas);
const ctx = canvas.getContext("2d");
const column = document.querySelector(".page");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let cols = 0;
let rows = 0;
let palette = null; // { bg, rungs: [c1, c2, c3, c4] } as rgb() strings
let pointerCell = null; // { x, y } in cell coords, or null
let stir = 0; // pointer energy, 0..1
let scrollStir = 0; // scroll energy, 0..1
let phase = 0; // Bayer phase from scroll, 0..7
let timer = null;
let lastSignature = "";

/* Deterministic per-cell hash in [0, 1): which rung a lit cell
   wears is a property of its position, so a cell never changes
   rung unless the pointer's brightness shifts the distribution. */
function cellHash(x, y) {
  let h = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663);
  h = Math.imul(h ^ (h >>> 13), 83492791);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* The palette is read off a probe element's computed colour: the
   custom properties carry light-dark() token streams, which a
   canvas fillStyle cannot parse, but a real element's computed
   color is fully resolved. */
function resolvePalette() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const read = (value) => {
    probe.style.color = value;
    return getComputedStyle(probe).color;
  };
  const next = {
    bg: read("var(--page-background)"),
    rungs: [read("var(--bgd-1)"), read("var(--bgd-2)"), read("var(--bgd-3)"), read("var(--bgd-4)")],
  };
  probe.remove();
  if (JSON.stringify(next) !== JSON.stringify(palette)) {
    palette = next;
    lastSignature = "";
    draw();
  }
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  cols = Math.ceil(w / CELL);
  rows = Math.ceil(h / CELL);
  lastSignature = "";
  draw();
}

/* Energy is quantised to eighths before it touches the field, so
   the pattern changes in whole steps and holds still between
   them, never sliding. */
function quantised(v) {
  return Math.round(v * 8) / 8;
}

function stateSignature() {
  return [
    cols,
    rows,
    pointerCell ? pointerCell.x + "," + pointerCell.y : "-",
    quantised(stir),
    quantised(scrollStir),
    phase,
    palette ? palette.bg : "",
  ].join("|");
}

function draw() {
  if (!palette || cols === 0) return;

  /* The column's rect in viewport coordinates: cells under it are
     not painted at all. The mask is part of the state signature:
     it moves with scroll even when nothing else changes. */
  const rect = column ? column.getBoundingClientRect() : null;
  const maskX0 = rect ? Math.floor(rect.left / CELL) : -1;
  const maskX1 = rect ? Math.ceil(rect.right / CELL) - 1 : -1;
  const maskY0 = rect ? Math.floor(rect.top / CELL) : -1;
  const maskY1 = rect ? Math.ceil(rect.bottom / CELL) - 1 : -1;

  const signature =
    stateSignature() + "|" + maskX0 + "," + maskX1 + "," + maskY0 + "," + maskY1;
  if (signature === lastSignature) return;
  lastSignature = signature;

  const stirQ = quantised(stir);
  const scrollQ = quantised(scrollStir);

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < rows; y++) {
    const v = rows > 1 ? y / (rows - 1) : 0.5;
    for (let x = 0; x < cols; x++) {
      if (rect && x >= maskX0 && x <= maskX1 && y >= maskY0 && y <= maskY1) continue;

      const u = cols > 1 ? x / (cols - 1) : 0.5;
      const edge = Math.max(Math.abs(2 * u - 1), Math.abs(2 * v - 1));
      let density = REST_CENTRE + (REST_EDGE - REST_CENTRE) * edge * edge;
      density += SCROLL_BOOST * scrollQ;

      let bright = 0;
      if (pointerCell && stirQ > 0) {
        const dx = x - pointerCell.x;
        const dy = y - pointerCell.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const prox = Math.max(0, 1 - dist / POINTER_RADIUS);
        density += POINTER_BOOST * stirQ * prox;
        bright = stirQ * prox;
      }
      if (density > DENSITY_CAP) density = DENSITY_CAP;

      /* Ordered dither: the cell lights when its Bayer threshold
         falls under the local density, so the lit share of any
         neighbourhood is the density itself, in 1/64 steps. */
      const threshold = (BAYER8[(y + phase) & 7][x & 7] + 0.5) / 64;
      if (threshold >= density) continue;

      const h = cellHash(x, y);
      const p4 = 0.03 + 0.12 * bright;
      const p3 = 0.1 + 0.15 * bright;
      const p2 = 0.25 + 0.15 * bright;
      let rung;
      if (h < p4) rung = 3;
      else if (h < p4 + p3) rung = 2;
      else if (h < p4 + p3 + p2) rung = 1;
      else rung = 0;

      ctx.fillStyle = palette.rungs[rung];
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
}

function ensureTicking() {
  if (timer !== null || reducedMotion.matches) return;
  timer = window.setInterval(() => {
    stir *= 0.78;
    scrollStir *= 0.78;
    if (stir < 0.02) stir = 0;
    if (scrollStir < 0.02) scrollStir = 0;
    draw();
    if (stir === 0 && scrollStir === 0) {
      window.clearInterval(timer);
      timer = null;
    }
  }, TICK_MS);
}

function onPointerMove(event) {
  const x = Math.floor(event.clientX / CELL);
  const y = Math.floor(event.clientY / CELL);
  if (!pointerCell || pointerCell.x !== x || pointerCell.y !== y) {
    pointerCell = { x, y };
    stir = Math.min(1, stir + 0.5);
    ensureTicking();
    draw();
  }
}

function onScroll() {
  const nextPhase = Math.floor(window.scrollY / SCROLL_STEP_PX) & 7;
  if (nextPhase !== phase) {
    phase = nextPhase;
    scrollStir = Math.min(1, scrollStir + 0.6);
    ensureTicking();
  }
  draw(); // the column mask moves with scroll even when the phase holds
}

function start() {
  resolvePalette();
  resize();
  if (reducedMotion.matches) {
    draw(); // one static field at rest density; no listeners, no stir
    return;
  }
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerleave", () => {
    pointerCell = null;
    draw();
  });
  window.addEventListener("scroll", onScroll, { passive: true });
}

window.addEventListener("resize", resize);
new MutationObserver(() => {
  resolvePalette();
  draw(); // the boot-hide attribute leaving <html> unhides the column
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme", "data-boot-hide"],
});
/* The column's box is the mask, and the box moves without any
   window event: the boot screen hides <main> until its tasks
   settle, and fonts settling shift the column's height. A
   ResizeObserver on the column catches both, so the mask is
   never stale from before the page appeared. */
if (column && "ResizeObserver" in window) {
  new ResizeObserver(() => resize()).observe(column);
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", resolvePalette);
reducedMotion.addEventListener("change", () => {
  stir = 0;
  scrollStir = 0;
  lastSignature = "";
  draw();
});

start();
