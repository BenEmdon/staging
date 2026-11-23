// Ambient dither fields for the home page's stages (experiment:
// dither-inside, after the card stages on thisisask.com).
//
// Each section, and the hiring block, gets a canvas laid over its own
// box, behind the content. The canvas carries a generated Bayer dither
// field on the site's fixed 8px grid: density shades across the stage,
// denser toward the bottom-left, sparse toward the top-right, so every
// box shares one light direction. The field is ground, never picture:
// cells are masked away from every glyph and every piece of media or
// control, so text always sits on the clean surface it already had.
//
// The fields answer the pointer in whole-cell steps. While the pointer
// (or keyboard focus) is inside a stage, that stage's density phase
// steps up, two steps at most, one step per 75ms tick, and the extra
// cells it lights burn in the accent family rather than the field ink.
// When the pointer rests, nothing moves: the field is a still pattern
// that happens to reflect where the pointer is. Reduced motion locks
// the phase at zero and the fields are static pictures.
//
// Cells only ever swap whole, in place, on the fixed grid: no fades,
// no drift, no velocity. The matrix is the same Bayer 8x8 the portrait
// dither uses (dither.js), so the page speaks one dither language.
//
// Ben's dither direction (2026-11-22) governs the look: the pixels are
// shades of blue from the theme's own ramp, never black and white, and
// there is only a little of it. The density range and the probe
// colours in components.css are set to exactly that.

const CELL = 8;
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];
const LEVELS = 64;

// How far the pointer phase can push a stage's density, and how much
// density one phase step adds. Two steps is a clear answer without the
// field ever crowding the content it surrounds. Ben's standing word on
// dither (2026-11-22): use a little of it, in the theme's blue shades.
// The densities here are capped with that in mind: the whole field,
// pointer phase included, stays a light dusting rather than a texture
// the page sits in.
const PHASE_MAX = 2;
const PHASE_LIFT = 0.06;
const STEP_MS = 75;

// Clearance kept around every masked rect, so a glyph's anti-aliased
// edge never shares a cell with the field. Four pixels, not two: a
// text line's rect is about 20px tall on a 24px pitch, so at 4px the
// keep-out zones of neighbouring lines overlap and no cell can ever
// thread the gap between two lines of a paragraph. The field lives in
// the true stage areas only: heading bands, the gaps between blocks,
// and the margins around them.
const CLEARANCE = 4;

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

// The two field colours, read off probe elements the stylesheet paints
// (components.css, .dither-field-probe--*). Reading a resolved `color`
// sidesteps light-dark(), which getPropertyValue hands back
// unevaluated; the portrait dither in main.js uses the same trick.
function fieldColours() {
  const ink = document.querySelector(".dither-field-probe--ink");
  const accent = document.querySelector(".dither-field-probe--accent");
  return {
    ink: getComputedStyle(ink).color,
    accent: getComputedStyle(accent).color,
  };
}

// Every rect inside the stage that the field must keep off: the runs of
// every text node, plus the boxes of media and controls. Returned in
// stage-relative CSS pixels, each grown by the clearance.
function maskRects(stage, stageRect) {
  const rects = [];
  const push = (r) => {
    if (r.width === 0 || r.height === 0) return;
    rects.push({
      left: r.left - stageRect.left - CLEARANCE,
      top: r.top - stageRect.top - CLEARANCE,
      right: r.right - stageRect.left + CLEARANCE,
      bottom: r.bottom - stageRect.top + CLEARANCE,
    });
  };

  const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest("canvas, script, style")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = document.createRange();
  while (walker.nextNode()) {
    range.selectNodeContents(walker.currentNode);
    for (const r of range.getClientRects()) push(r);
  }

  for (const el of stage.querySelectorAll(
    "img, canvas:not(.dither-field), button, input, select, textarea, video, svg, .dither",
  )) {
    push(el.getBoundingClientRect());
  }
  return rects;
}

function buildField(stage, index) {
  const canvas = document.createElement("canvas");
  canvas.className = "dither-field";
  canvas.dataset.fieldIndex = String(index);
  canvas.setAttribute("aria-hidden", "true");
  const inBlock = stage.hasAttribute("data-hiring");
  if (inBlock) {
    // The hiring block paints its own subtle background as a positioned
    // element (it has been position:relative all along), so its field
    // rides inside the block at the bloom cells' level: z-index 0,
    // first child, with the bloom and the copy above it.
    canvas.style.zIndex = "0";
    stage.prepend(canvas);
  } else {
    // A section's field cannot live inside the section: giving the
    // section a containing block (position:relative) re-rasterizes its
    // small text with different anti-aliasing, a measured 50k-pixel
    // drift from master. So section fields are page-level canvases,
    // placed over the section's box in document coordinates and left
    // behind everything at z-index -1. The sections themselves keep
    // their exact shipped rendering; only the empty stage around the
    // content gains the field.
    document.body.append(canvas);
  }

  const ctx = canvas.getContext("2d");
  const field = {
    stage,
    canvas,
    ctx,
    phase: 0,
    target: 0,
    cols: 0,
    rows: 0,
    // Per cell: the Bayer threshold and the base density, or -1 for a
    // masked cell the field never touches.
    cells: new Float32Array(0),
    layout,
    paint,
  };

  function layout() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    canvas.width = width;
    canvas.height = height;
    if (!inBlock) {
      const rect = stage.getBoundingClientRect();
      canvas.style.left = `${rect.left + window.scrollX}px`;
      canvas.style.top = `${rect.top + window.scrollY}px`;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    field.cols = Math.ceil(width / CELL);
    field.rows = Math.ceil(height / CELL);
    const rects = maskRects(stage, stage.getBoundingClientRect());
    const cells = new Float32Array(field.cols * field.rows);
    for (let row = 0; row < field.rows; row += 1) {
      for (let col = 0; col < field.cols; col += 1) {
        const x = col * CELL;
        const y = row * CELL;
        const masked = rects.some(
          (r) => x < r.right && x + CELL > r.left && y < r.bottom && y + CELL > r.top,
        );
        if (masked) {
          cells[row * field.cols + col] = -1;
          continue;
        }
        // The light direction: density grows toward the bottom and
        // toward the left, so the top-right of every stage is the
        // sparse edge and the bottom-left the dense one. The range is
        // deliberately small (0.04 to 0.34): a little dither, per
        // Ben's direction, never a heavy field.
        const nx = field.cols === 1 ? 0 : col / (field.cols - 1);
        const ny = field.rows === 1 ? 0 : row / (field.rows - 1);
        cells[row * field.cols + col] = 0.04 + 0.3 * (0.62 * ny + 0.38 * (1 - nx));
      }
    }
    field.cells = cells;
    paint();
  }

  function paint() {
    const { ink, accent } = fieldColours();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const lift = field.phase * PHASE_LIFT;
    for (let row = 0; row < field.rows; row += 1) {
      const bayerRow = BAYER_8[row % 8];
      for (let col = 0; col < field.cols; col += 1) {
        const base = field.cells[row * field.cols + col];
        if (base < 0) continue;
        const threshold = (bayerRow[col % 8] + 0.5) / LEVELS;
        if (threshold < base) {
          ctx.fillStyle = ink;
        } else if (threshold < Math.min(0.9, base + lift)) {
          ctx.fillStyle = accent;
        } else {
          continue;
        }
        ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
      }
    }
  }

  if (!reduced.matches) {
    const raise = () => {
      field.target = PHASE_MAX;
      startStepper();
    };
    const lower = () => {
      field.target = 0;
      startStepper();
    };
    stage.addEventListener("pointerenter", raise);
    stage.addEventListener("pointerleave", lower);
    stage.addEventListener("focusin", raise);
    stage.addEventListener("focusout", (event) => {
      if (!stage.contains(event.relatedTarget)) lower();
    });
  }

  return field;
}

// One shared stepper: while any field's phase is away from its target,
// step every such field one step per tick and repaint it. When all
// fields settle, the interval stops and the page is still.
const fields = [];
let stepper = null;
function startStepper() {
  if (stepper !== null) return;
  stepper = window.setInterval(() => {
    let moving = false;
    for (const field of fields) {
      if (field.phase === field.target) continue;
      field.phase += Math.sign(field.target - field.phase);
      field.paint();
      moving = true;
    }
    if (!moving) {
      window.clearInterval(stepper);
      stepper = null;
    }
  }, STEP_MS);
}

function init() {
  // The colour probes live in the document so the stylesheet can paint
  // them; the script reads their resolved colours back at paint time.
  for (const kind of ["ink", "accent"]) {
    const probe = document.createElement("span");
    probe.className = `dither-field-probe dither-field-probe--${kind}`;
    probe.setAttribute("aria-hidden", "true");
    document.body.append(probe);
  }

  const stages = document.querySelectorAll("main .section, [data-hiring]");
  stages.forEach((stage, index) => fields.push(buildField(stage, index)));
  const layoutAll = () => {
    for (const field of fields) field.layout();
  };
  layoutAll();

  // Type settling (the self-hosted Iosevka arriving) moves text runs,
  // so the masks are rebuilt once the fonts are in.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(layoutAll);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layoutAll, 150);
  });

  // A theme change recolours the fields; geometry does not move, so a
  // repaint is enough. The mode lives in [data-theme] when pinned and
  // in the OS scheme when not.
  const repaintAll = () => {
    for (const field of fields) field.paint();
  };
  new MutationObserver(repaintAll).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  systemDark.addEventListener("change", repaintAll);
}

init();
