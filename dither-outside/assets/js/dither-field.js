/*
  Experiment (staging only): the ambient dither field.

  The home page rebuilt around one continuous ordered-dither field.
  The field is the ground of the page: a fixed canvas behind the
  content, drawn on the site's 8px pixel grid, whose density shades
  across the viewport. The light logic is a lamp above the top centre
  of the page, where the name and the orb sit: density is sparse near
  the light and gathers toward the edges and the foot of the page,
  the way light falls off. Content floats on the field as solid
  islands; the field is never drawn under text, because the islands
  carry their own surfaces and the field lives only in the surround.

  Everything steps, nothing flows:
  - Scrolling advances the field in discrete states. The scroll
    position is quantized to fixed steps; each step raises the base
    density by one Bayer increment and shifts the pattern phase by
    one cell. Between steps the field is pixel-identical.
  - The pointer is a second, smaller light. Inside its radius the
    density thins in whole-cell steps, computed from the pointer's
    cell, so the pattern only changes when the pointer crosses a
    cell boundary, and it is still at rest.
  - Reduced motion gets one static field: no scroll stepping, no
    pointer response.

  The orb beside the name is drawn from the same system: a sphere
  shaded purely by dither density, dense at the base, thinning up
  the crown to a sparse bright cap where the light catches. One
  material for the ground and the mark, the lesson taken from
  thisisask.com, where the dithered orb logo and the dither card
  stages are visibly the same language.
*/

const CELL = 8;

// The 8x8 Bayer matrix, thresholds normalized to (n + 0.5) / 64 so a
// density of v lights the fraction v of cells, evenly spread.
const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
].map((row) => row.map((n) => (n + 0.5) / 64));

const bayerAt = (x, y) => BAYER[((y % 8) + 8) % 8][((x % 8) + 8) % 8];

const SCROLL_STEP_PX = 96; // one field state per this much travel
const SCROLL_DENSITY = 1 / 32; // one Bayer increment per state
const POINTER_RADIUS = 12; // cells
const POINTER_THIN = 0.55; // density removed at the pointer's centre

function resolvedDark() {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// The ink is resolved through a probe element's real `color`
// property, never read off the custom property directly: --page-color
// is declared with light-dark(), and a custom property's computed
// value keeps that function as an unresolved token stream, which a
// canvas fillStyle cannot parse (it would silently stay black in
// both themes). A real property resolves it against the theme.
const inkProbe = document.createElement("span");
inkProbe.style.cssText =
  "position:absolute;visibility:hidden;color:var(--field-ink)";
document.body.append(inkProbe);

function inkColour() {
  // The field is drawn in the page's own ink on the page's paper:
  // ink dots on white in light mode, pale dots on near-black in
  // dark. The ink comes from --field-ink, which dither-field.css
  // points at --page-color, so the field follows the palette rather
  // than carrying a copy of it. The separate variable exists so a
  // verifier can repaint the field in a marker colour and census
  // exactly where field pixels land.
  return { ink: getComputedStyle(inkProbe).color };
}

/* ---------------- the field ---------------- */

const fieldCanvas = document.querySelector("[data-field]");
const orbCanvas = document.querySelector("[data-orb]");

if (fieldCanvas) {
  const ctx = fieldCanvas.getContext("2d");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  let cols = 0;
  let rows = 0;
  let step = 0;
  let pointer = null; // {cx, cy} in cell coordinates, or null
  let drawnKey = "";

  // Density at a cell, 0..1: the share of its Bayer neighbourhood
  // that lights. The lamp term is radial distance from the light
  // centre above the top middle of the viewport; the scroll term
  // raises the whole field one increment per state; the pointer
  // term thins the field around the pointer's cell.
  function densityAt(cx, cy) {
    const nx = cols > 1 ? cx / (cols - 1) : 0.5;
    const ny = rows > 1 ? cy / (rows - 1) : 0;
    const dx = nx - 0.5;
    const dy = ny * 0.92 + 0.08;
    const dist = Math.min(1, Math.sqrt(dx * dx * 1.44 + dy * dy) / 1.02);
    // A gentle falloff: nearly clear under the lamp, gathering
    // toward the far corners. The ceiling matters as much as the
    // slope: past about half density the Bayer pattern locks into
    // its checkerboard form and the ground stops reading as a
    // graded field, so the whole range, scroll steps included,
    // stays well under it.
    let v = 0.03 + 0.35 * Math.pow(dist, 1.5);
    v += step * SCROLL_DENSITY;
    if (pointer) {
      const pdx = cx - pointer.cx;
      const pdy = cy - pointer.cy;
      const pd = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pd < POINTER_RADIUS) v -= (1 - pd / POINTER_RADIUS) * POINTER_THIN;
    }
    return Math.max(0, Math.min(0.4, v));
  }

  function draw() {
    const key = `${cols}x${rows}|${step}|${pointer ? `${pointer.cx},${pointer.cy}` : "-"}|${resolvedDark()}`;
    if (key === drawnKey) return;
    drawnKey = key;
    const { ink } = inkColour();
    ctx.clearRect(0, 0, cols, rows);
    ctx.fillStyle = ink;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        // The scroll state also shifts the phase by one cell, so a
        // step is visible as a step even where density saturates.
        if (bayerAt(x + step, y) < densityAt(x, y)) ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  function resize() {
    cols = Math.ceil(window.innerWidth / CELL);
    rows = Math.ceil(window.innerHeight / CELL);
    fieldCanvas.width = cols;
    fieldCanvas.height = rows;
    drawnKey = "";
    draw();
  }

  let scrollQueued = false;
  function onScroll() {
    if (reduced.matches || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      const next = Math.floor(window.scrollY / SCROLL_STEP_PX);
      if (next !== step) {
        step = next;
        draw();
      }
    });
  }

  window.addEventListener("resize", resize);
  window.addEventListener("scroll", onScroll, { passive: true });

  if (window.matchMedia("(hover: hover)").matches) {
    window.addEventListener(
      "pointermove",
      (event) => {
        if (reduced.matches) return;
        const cx = Math.floor(event.clientX / CELL);
        const cy = Math.floor(event.clientY / CELL);
        if (!pointer || pointer.cx !== cx || pointer.cy !== cy) {
          pointer = { cx, cy };
          draw();
        }
      },
      { passive: true }
    );
    window.addEventListener("pointerleave", () => {
      pointer = null;
      draw();
    });
    document.documentElement.addEventListener("pointerleave", () => {
      pointer = null;
      draw();
    });
  }

  // The theme can move under the field (the scene control, the OS):
  // redraw in the new grade. The pattern is unchanged, only the ink.
  new MutationObserver(() => {
    drawnKey = "";
    draw();
    drawOrb();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      drawnKey = "";
      draw();
      drawOrb();
    });

  resize();

  /* ---------------- the orb ---------------- */

  // A sphere of 17x17 cells, shaded by the same Bayer system. The
  // shading value is a lambert term for a light above and to the
  // left, plus a small ambient floor so the dark limb never goes
  // fully solid: density runs from near-solid at the base, through
  // the midtones at the flanks, to a sparse cap at the crown where
  // the light catches.
  function drawOrb() {
    if (!orbCanvas) return;
    const octx = orbCanvas.getContext("2d");
    const N = orbCanvas.width;
    const { ink } = inkColour();
    const cx = (N - 1) / 2;
    const cy = (N - 1) / 2;
    const R = N / 2 - 0.5;
    octx.clearRect(0, 0, N, N);
    octx.fillStyle = ink;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const nx = (x - cx) / R;
        const ny = (y - cy) / R;
        const r2 = nx * nx + ny * ny;
        if (r2 > 1) continue;
        const nz = Math.sqrt(1 - r2);
        // Light direction: mostly toward the viewer and above, so
        // the face is lit and the darkening is a limb effect,
        // strongest at the base, rather than a terminator slicing
        // the disc into a crescent.
        const facing = Math.max(0, nx * -0.18 + ny * -0.42 + nz * 1.0);
        const bright = Math.max(0, Math.min(1, 0.08 + facing * 0.95));
        const density = 1 - bright;
        if (bayerAt(x, y) < density) octx.fillRect(x, y, 1, 1);
      }
    }
  }

  drawOrb();

  // A small instrument for whoever verifies the page: the field's
  // own numbers, read from the same functions that draw it, and a
  // repaint for when a variable the field reads has moved.
  window.DitherField = {
    cell: CELL,
    densityAt,
    canvas: fieldCanvas,
    orb: orbCanvas,
    state: () => ({ step, pointer, cols, rows }),
    repaint: () => {
      drawnKey = "";
      draw();
      drawOrb();
    },
  };
}
