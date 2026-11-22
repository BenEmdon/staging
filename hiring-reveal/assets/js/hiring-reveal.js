/*
  Experiment: hiring scene reveal.

  The hiring block carries a tiny meadow in its base margin: a field
  strip, a hazed hill, and the meadow tower with its lamp, drawn on a
  fixed grid of cells. At rest the strip is a quiet flat field of the
  block's own background shade. When the pointer enters the block the
  scene assembles cell by cell in a seeded Bayer order, the way the
  portrait reveal works, biased so the build sweeps loosely from the
  edge the pointer entered at. Leaving drains it in reverse order.
  While the pointer stays, the tower lamp blinks on its slow beat.

  The pixel rule holds throughout: cells sit on a fixed grid and light
  in place in discrete steps on the site's 75ms tick. Nothing drifts,
  slides, or fades, and the copy is never covered: the scene lives in
  a strip under the text, in its own reserved space, so the block's
  layout never moves.

  Touch has no hover, so the scene assembles once when the block
  scrolls into view and stands. Reduced motion gets the assembled
  scene in one cut, no stepping. Keyboard focus assembles too, and
  blur drains, so the effect is not pointer-only.
*/

const W = 120;
const H = 13;
const TICK = 75;
const BATCH = 26;

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// One seeded random source, so every load builds the same scene and
// the same reveal, the way the meadow does.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Palette slots. 0 is empty: the block's background shows through, so
// an unrevealed cell and a sky cell are the same quiet flat field.
const LAMP = 11;
const PALETTES = {
  light: {
    1: "#86b04c", // field
    2: "#679a38", // field deep
    3: "#a9c76d", // field highlight, tuft tips
    4: "#93a9b5", // hill, hazed toward the sky
    5: "#5d6d7e", // tower stone
    6: "#46586a", // tower deep: crown underside, bands
    7: "#ffb02e", // lamp, bright rung
    8: "#dd7a33", // lamp, ember rung
    9: "#e9efe2", // cloud
    10: "#f2e394", // flower
  },
  dark: {
    1: "#1e4634",
    2: "#153625",
    3: "#2f5f42",
    4: "#274b63",
    5: "#1d2f42",
    6: "#121f2d",
    7: "#ffb02e",
    8: "#c85a24",
    9: "#33506b",
    10: "#d8e2ee",
  },
};

function buildScene() {
  const grid = new Uint8Array(W * H);
  const rng = mulberry32(20261122);
  const at = (x, y) => y * W + x;
  const set = (x, y, v) => {
    if (x >= 0 && x < W && y >= 0 && y < H) grid[at(x, y)] = v;
  };

  // Field: the bottom four rows. The lowest row runs deep, the rows
  // above it mix deep and highlight cells in seeded patches, so the
  // strip reads as grass texture rather than a flat band.
  for (let x = 0; x < W; x++) {
    for (let y = 9; y < H; y++) set(x, y, 1);
    set(x, 12, rng() < 0.75 ? 2 : 1);
    for (const y of [10, 11]) {
      if (rng() < 0.16) set(x, y, 2);
      else if (rng() < 0.1) set(x, y, 3);
    }
    if (rng() < 0.3) set(x, 9, 3);
  }

  // Hill: a low rise behind the field on the right third, its top
  // edge stepping up toward the tower and back down.
  for (let x = 72; x < 104; x++) {
    const rise = Math.max(0, 3 - Math.floor(Math.abs(x - 88) / 6));
    for (let y = 9 - rise; y < 9; y++) set(x, y, 4);
  }

  // Tower: spike, crown with an overhang, banded body, flared base,
  // and a two-cell window where the lamp lives. Built with what
  // detail its size allows, like the meadow's tower.
  set(88, 1, 5);
  for (let x = 85; x <= 91; x++) set(x, 2, 5);
  set(85, 3, 6);
  set(91, 3, 6);
  for (let y = 3; y <= 8; y++) {
    for (let x = 86; x <= 90; x++) set(x, y, 5);
  }
  for (let x = 86; x <= 90; x++) {
    set(x, 4, 6);
    set(x, 7, 6);
  }
  for (let x = 84; x <= 92; x++) set(x, 8, 5);
  set(88, 5, LAMP);
  set(88, 6, LAMP);

  // Clouds: two small clusters hanging in the strip's sky.
  for (const x of [11, 12, 13, 14, 15]) set(x, 1, 9);
  for (const x of [10, 12, 14, 16, 17]) set(x, 2, 9);
  for (const x of [56, 57, 58, 59]) set(x, 2, 9);
  set(57, 3, 9);

  // Grass tufts poking above the horizon, away from the hill, and a
  // few flowers asleep in the field.
  let placed = 0;
  while (placed < 12) {
    const x = Math.floor(rng() * 68);
    if (grid[at(x, 8)] === 0 && grid[at(x, 9)] !== 0) {
      set(x, 8, 3);
      placed++;
    }
  }
  placed = 0;
  while (placed < 6) {
    const x = Math.floor(rng() * W);
    const y = 10 + Math.floor(rng() * 2);
    if (grid[at(x, y)] === 1) {
      set(x, y, 10);
      placed++;
    }
  }

  return grid;
}

const canvas = document.querySelector("[data-hiring-scene]");
const block = document.querySelector("[data-hiring]");

if (canvas && block) {
  const ctx = canvas.getContext("2d");
  const grid = buildScene();
  const cells = [];
  for (let i = 0; i < W * H; i++) if (grid[i] !== 0) cells.push(i);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hoverable = window.matchMedia("(hover: hover)");

  // The resolved theme, the way meadow.js reads it: a pinned
  // [data-theme] when one is set, else the OS preference.
  const resolvedDark = () =>
    document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;

  let palette = resolvedDark() ? PALETTES.dark : PALETTES.light;
  let shown = new Set();
  let history = []; // cell indices in the order they lit
  let queue = []; // cells waiting to light, in build order
  let target = 0; // 1 building or built, 0 draining or empty
  let timer = 0;
  let ticks = 0;

  function lampLit() {
    // The lamp rests at its ember rung and steps up to the bright
    // rung for two ticks in every forty: a heartbeat, not a strobe.
    return ticks % 40 < 2;
  }

  function paint() {
    ctx.clearRect(0, 0, W, H);
    for (const i of shown) {
      const v = grid[i];
      ctx.fillStyle = v === LAMP ? palette[lampLit() ? 7 : 8] : palette[v];
      ctx.fillRect(i % W, Math.floor(i / W), 1, 1);
    }
  }

  function step() {
    ticks++;
    if (target === 1 && queue.length) {
      for (const i of queue.splice(0, BATCH)) {
        shown.add(i);
        history.push(i);
      }
    } else if (target === 0 && history.length) {
      for (const i of history.splice(-BATCH)) shown.delete(i);
    }
    paint();
    const busy = target === 1 ? queue.length > 0 : history.length > 0;
    if (!busy && !(target === 1 && shown.size === cells.length)) {
      clearInterval(timer);
      timer = 0;
    }
  }

  function run() {
    if (!timer) timer = setInterval(step, TICK);
  }

  function build(originCol) {
    target = 1;
    if (reduced.matches) {
      shown = new Set(cells);
      history = [...cells];
      queue = [];
      paint();
      return;
    }
    const rng = mulberry32(97);
    queue = cells
      .filter((i) => !shown.has(i))
      .map((i) => {
        const x = i % W;
        const y = Math.floor(i / W);
        // Seeded Bayer order first, so the scene scatters in the
        // portrait's own pattern; distance from the entry edge
        // second, so the build still sweeps loosely from the side
        // the pointer came in at.
        const key = BAYER[y & 3][x & 3] * 4096 + Math.abs(x - originCol) * 29 + rng() * 28;
        return { i, key };
      })
      .sort((a, b) => a.key - b.key)
      .map((c) => c.i);
    run();
  }

  function drain() {
    target = 0;
    if (reduced.matches) {
      shown.clear();
      history = [];
      queue = [];
      paint();
      return;
    }
    queue = [];
    run();
  }

  function originFromEvent(event) {
    const rect = block.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(W - 1, Math.floor(ratio * W)));
  }

  if (hoverable.matches) {
    block.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      ticks = 0;
      build(originFromEvent(event));
      // While the pointer stays, the lamp needs its beat even after
      // the build finishes, so the tick keeps running at rest.
      run();
    });
    block.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") return;
      drain();
    });
    block.addEventListener("focus", () => {
      ticks = 0;
      build(Math.floor(W / 2));
      run();
    });
    block.addEventListener("blur", drain);
  } else {
    // Touch: assemble once when the block arrives on screen, and
    // stand. The block is a link, so no tap is ever intercepted.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          build(Math.floor(W / 2));
          io.disconnect();
        }
      },
      { threshold: 0.4 }
    );
    io.observe(block);
  }

  // Repaint under a theme change, keeping whatever is lit lit.
  new MutationObserver(() => {
    palette = resolvedDark() ? PALETTES.dark : PALETTES.light;
    paint();
  }).observe(document.documentElement, { attributeFilter: ["data-theme"] });
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      palette = resolvedDark() ? PALETTES.dark : PALETTES.light;
      paint();
    });

  paint();
}
