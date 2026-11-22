// The hiring block's grass: a low field along the inside bottom edge of
// the block, behind the copy, and the gusts the pointer sends through it.
//
// Display-style pixels, like everything else on the site. The field is a
// canvas strip of 4px cells on a fixed grid. Tufts are seeded once from a
// fixed seed, so the field is the same field on every load: clusters of
// blades two to five cells tall standing on the strip's baseline, each
// tuft resting at one of the middle rungs of a five-rung green ladder,
// denser toward the ends of the strip than the middle. Nothing ever
// translates or fades: a cell only ever swaps its palette colour whole,
// in place, on the 75ms tick.
//
// A gust borrows the meadow's weather language. It launches at the
// pointer's column and travels in the pointer's horizontal direction,
// its front advancing one column per tick, wobbled by a sum of sines
// across the strip's height so the front arrives uneven, the way wind
// takes a real field unevenly. Blades the front covers step one rung
// brighter (a fast pass throws a strong gust: two rungs, a wider band, a
// longer run), fringe cells join or leave on a fixed Bayer threshold so
// the front's edge is ragged rather than ruled, and blades step back
// down behind the front once the band has passed. A gust that outruns
// its range steps down a rung at a time and dies in the field instead of
// stopping dead at a line.
//
// Touch gets the same weather at finger scale: a tap fires one gust from
// the tap point in a seeded direction, and a drag fires gusts along its
// path. Reduced motion gets the still field only, rendered once.

const CELL = 4; // px per cell, the strip's fixed grid
const ROWS = 7; // 28px of strip: six of grass over a one-cell baseline
const TICK = 75; // ms, the site's own --motion-step
const SEED = 20261122;

// The ladders, brightest first, the meadow's own greens by day and
// their night equivalents from the meadow's night palette.
const DAY_LADDER = ["#bcd26c", "#8fbc5e", "#5da24e", "#3e7f45", "#2b5c46"];
const NIGHT_LADDER = ["#3d6b4f", "#2c5741", "#214636", "#173527", "#10241c"];

// The seeded source, the same mulberry32 the loader's painting uses.
// One stream builds the field; the same stream, continued, picks tap
// directions, so the whole strip is reproducible from the seed alone.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The 4x4 Bayer matrix, the site's dither threshold: a fringe cell is in
// the gust when its threshold falls under the gust's coverage there.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const bayerAt = (col, row) => BAYER[row % 4][col % 4] / 16;

// The front's wobble: a sum of sines over the cell's height up the
// blade, so the front meets tall and short blades at different columns.
const wobble = (height, phase) =>
  1.3 * Math.sin(height * 0.9 + phase) + 0.7 * Math.sin(height * 1.9 + phase * 1.7);

export function setupHiringGusts(block, { reduced, dark, onRepaint }) {
  const canvas = document.createElement("canvas");
  canvas.className = "hiring__grass";
  canvas.setAttribute("aria-hidden", "true");
  block.append(canvas);
  const ctx = canvas.getContext("2d");

  const rng = mulberry32(SEED);
  let cols = 0;
  let blades = []; // per column: null, or { height, rung } at rest
  let gusts = []; // { col, dir, front, strength, band, range, phase }
  let timer = 0;

  // Build the field for the strip's current width. Tufts cluster: a
  // seeded walk starts a tuft where the density roll passes, the tuft
  // runs one to three columns, and its blades vary a cell around the
  // tuft's own height. Density rises toward the ends, so the middle of
  // the strip stays open under the copy's middle lines.
  function buildField() {
    const width = block.clientWidth;
    canvas.width = Math.max(width, CELL);
    canvas.height = ROWS * CELL;
    cols = Math.floor(canvas.width / CELL);
    blades = new Array(cols).fill(null);

    let col = 0;
    while (col < cols) {
      const nx = cols > 1 ? (2 * col) / (cols - 1) - 1 : 0;
      const density = 0.3 + 0.5 * nx * nx;
      if (rng() < density) {
        const tuftCols = 1 + Math.floor(rng() * 3);
        const tuftHeight = 2 + Math.floor(rng() * 4); // two to five cells
        const rung = 1 + Math.floor(rng() * 3); // rest rungs 1 to 3
        for (let i = 0; i < tuftCols && col + i < cols; i++) {
          const vary = Math.floor(rng() * 3) - 1;
          blades[col + i] = {
            height: Math.min(5, Math.max(2, tuftHeight + vary)),
            rung,
          };
        }
        col += tuftCols + Math.floor(rng() * 3); // a gap of open ground
      } else {
        col += 1;
      }
    }
  }

  // One cell of the field at its current rung: the rest rung, stepped
  // brighter by whichever live gust covers it hardest.
  function rungAt(col, height) {
    const blade = blades[col];
    let rung = blade.rung;
    for (const gust of gusts) {
      const front = gust.front + wobble(height, gust.phase);
      const d = (front - col) * gust.dir; // columns behind the front
      if (d < 0) continue;
      const travelled = (gust.front - gust.col) * gust.dir;
      const fade = Math.max(0, Math.floor((travelled - gust.range) / 6));
      const strength = gust.strength - fade;
      if (strength <= 0) continue;
      const core = gust.band * 0.45;
      if (d <= core) {
        rung = Math.min(rung, blade.rung - strength);
      } else if (d <= gust.band) {
        // The fringe: coverage falls off across the band's tail, and a
        // cell joins it only where its Bayer threshold passes, so the
        // tail breaks up instead of ending on a ruled line.
        const coverage = 1 - (d - core) / (gust.band - core);
        if (bayerAt(col, height) < coverage) {
          rung = Math.min(rung, blade.rung - strength);
        } else if (strength > 1) {
          rung = Math.min(rung, blade.rung - (strength - 1));
        }
      }
    }
    return Math.max(0, rung);
  }

  function paint() {
    const ladder = dark() ? NIGHT_LADDER : DAY_LADDER;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // The baseline the tufts stand on: one cell of the deepest rung.
    ctx.fillStyle = ladder[4];
    ctx.fillRect(0, (ROWS - 1) * CELL, cols * CELL, CELL);
    for (let col = 0; col < cols; col++) {
      const blade = blades[col];
      if (!blade) continue;
      for (let h = 0; h < blade.height; h++) {
        ctx.fillStyle = ladder[rungAt(col, h)];
        ctx.fillRect(col * CELL, (ROWS - 2 - h) * CELL, CELL, CELL);
      }
    }
  }

  function tick() {
    for (const gust of gusts) gust.front += gust.dir;
    gusts = gusts.filter((gust) => {
      const travelled = (gust.front - gust.col) * gust.dir;
      const offStrip =
        gust.dir > 0 ? gust.front - gust.band > cols : gust.front + gust.band < 0;
      return !offStrip && travelled - gust.range < 6 * gust.strength;
    });
    paint();
    if (gusts.length === 0) {
      clearInterval(timer);
      timer = 0;
    }
  }

  function launch(col, dir, strength, range) {
    gusts.push({
      col,
      dir,
      front: col,
      strength,
      band: strength > 1 ? 11 : 7,
      range,
      phase: col * 0.35,
    });
    paint();
    if (!timer) timer = setInterval(tick, TICK);
  }

  buildField();
  paint();
  onRepaint(paint);

  if (reduced.matches) return; // the still field only, rendered once

  let lastX = null;
  let lastY = null;
  let lastT = 0;
  let lastDir = 1;
  let lastLaunchX = null;

  // A gust launches once the pointer has covered a little ground since
  // the last one, so a pass lays down a train of gusts along its path
  // rather than a single burst or a flood.
  function gustFromPointer(x, speed, seededDir) {
    const col = Math.floor(x / CELL);
    const dir = seededDir ?? lastDir;
    const strength = speed > 1.2 ? 2 : 1;
    const range =
      strength > 1
        ? cols * 1.1
        : cols * (0.4 + 0.3 * Math.min(speed / 1.2, 1));
    launch(col, dir, strength, range);
    lastLaunchX = x;
  }

  block.addEventListener("pointermove", (event) => {
    if (reduced.matches) return;
    const rect = block.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const now = performance.now();

    if (event.pointerType === "touch") {
      // A drag fires gusts along it, seeded in direction where the
      // drag itself has no horizontal say yet.
      if (lastLaunchX === null || Math.abs(x - lastLaunchX) >= 28) {
        const dx = lastX === null ? 0 : x - lastX;
        gustFromPointer(x, 0.6, dx !== 0 ? Math.sign(dx) : rng() < 0.5 ? -1 : 1);
      }
    } else if (lastX !== null) {
      const dt = Math.max(now - lastT, 1);
      const dx = x - lastX;
      const speed = Math.hypot(dx, y - lastY) / dt;
      if (dx !== 0) lastDir = Math.sign(dx);
      if (lastLaunchX === null || Math.abs(x - lastLaunchX) >= 24) {
        gustFromPointer(x, speed);
      }
    }
    lastX = x;
    lastY = y;
    lastT = now;
  });

  block.addEventListener("pointerdown", (event) => {
    if (reduced.matches || event.pointerType !== "touch") return;
    const rect = block.getBoundingClientRect();
    const x = event.clientX - rect.left;
    lastDir = rng() < 0.5 ? -1 : 1;
    gustFromPointer(x, 0.6, lastDir);
    lastX = x;
    lastY = event.clientY - rect.top;
    lastT = performance.now();
  });

  block.addEventListener("pointerleave", () => {
    lastX = null;
    lastLaunchX = null;
  });

  // The field is seeded per width: a resize rebuilds the same field at
  // the new width and repaints it at rest.
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.floor(block.clientWidth / CELL) !== cols) {
        gusts = [];
        buildField();
        paint();
      }
    }, 150);
  });
}
