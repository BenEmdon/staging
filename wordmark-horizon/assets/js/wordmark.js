// A terminal can only change whole character cells, on a clock tick. The
// wordmark follows that limit literally. Its art is a fixed grid of
// character cells; a cell's colour changes only once per 75ms tick, in
// place, as a whole-cell swap to another palette colour. There is no
// fade, no drift, and no sub-cell rendering: a cell sits at one rung of
// the shade ladder or at rest.
//
// Hover carries a pool of light across the word. A cell's rung is its
// distance from the pointer, measured between true cell centres, so the
// pool crosses letter boundaries in steps instead of snapping column to
// column the way the old single-column light did. The core takes the
// accent, the rings around it step down the ladder toward the resting
// ink. Pointer speed stretches the pool along the direction of travel;
// a resting pointer keeps a tight round pool. The idle animation is the
// same pool crossing the word on its own, one column per tick, on the
// schedule the old refresh scan kept. The original text remains the
// no-JS fallback; the heading has its own label.

const BLOCK_GLYPH = "█";

// The grid width comes from the block glyph itself, never from a metric
// named after a different character. The subset font loaded for the
// wordmark contains no "0", so a ch-based width is a guess each engine
// resolves through its own fallback fonts, and it lands differently
// from the advance the glyphs are actually laid out with; raw text
// advances are rounded by the shaper besides (at phone size the subset's
// 0.6em advance lays out as a flat 4px). Measured instead: twenty block
// glyphs set as plain text in the wordmark's own font at its current
// size, divided by twenty. Whatever the engine really does to the art,
// every column is then sized by that one number.
function measureCellWidth(wordmark) {
  const style = getComputedStyle(wordmark);
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;" +
    `font-family:${style.fontFamily};font-size:${style.fontSize};` +
    `font-weight:${style.fontWeight};`;
  probe.textContent = BLOCK_GLYPH.repeat(20);
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width / 20;
  probe.remove();
  return width;
}

function sizeCells(wordmark) {
  const width = measureCellWidth(wordmark);
  if (width > 0) {
    wordmark.style.setProperty("--wordmark-cell-w", `${width}px`);
  }
}

// Split the art into one span per character: block glyphs get
// .wordmark__cell, spaces get .wordmark__gap so they take the measured
// width too, instead of whatever advance the surrounding text happens
// to give them. Returns the lit-able cells grouped by column.
function splitWordmark(wordmark) {
  const rows = wordmark.textContent.split("\n");
  const columnCount = Math.max(...rows.map((row) => [...row].length));
  const columns = Array.from({ length: columnCount }, () => []);
  const fragment = document.createDocumentFragment();

  rows.forEach((row, y) => {
    [...row].forEach((glyph, x) => {
      const el = document.createElement("span");
      el.className = glyph === " " ? "wordmark__gap" : "wordmark__cell";
      el.textContent = glyph;
      fragment.append(el);
      if (glyph !== " ") columns[x].push(el);
    });
    if (y < rows.length - 1) fragment.append("\n");
  });
  wordmark.replaceChildren(fragment);
  return columns;
}

// The touch-device split: no scan runs there, but the fixed cells are
// still what keep the letters from merging in a phone browser. Like the
// animated path, it waits for the font, so the split and the measured
// cell width come from the loaded glyphs rather than a fallback, and it
// re-measures when the viewport changes the wordmark's size.
export async function setUpStaticWordmark(wordmark) {
  if (!wordmark) return;
  await document.fonts.ready;
  if (!wordmark.isConnected) return;
  splitWordmark(wordmark);
  sizeCells(wordmark);
  new ResizeObserver(() => sizeCells(wordmark)).observe(wordmark);
}

export async function animateWordmark(wordmark, reduced) {
  if (!wordmark || !matchMedia("(hover: hover)").matches) return;
  await document.fonts.ready;
  if (!wordmark.isConnected) return;

  const TICK = 75;
  splitWordmark(wordmark);

  // The pool is computed in pixels, not columns. After the split, walk
  // the spans in document order to give every block cell its grid
  // position; the "\n" text nodes the split leaves between span runs
  // are the row breaks. Each cell's centre is then measured from its
  // own box, so distance is true distance and the pool pays no
  // attention to where one letter ends and the next begins.
  const cells = [];
  {
    let x = 0;
    let y = 0;
    for (const node of wordmark.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        y += 1;
        x = 0;
      } else {
        if (node.classList.contains("wordmark__cell")) {
          cells.push({ el: node, x, y, cx: 0, cy: 0, rung: 0 });
        }
        x += 1;
      }
    }
  }

  const RUNG_CLASS = ["", "is-pool-1", "is-pool-2", "is-pool-3"];
  let cellWidth = 0;
  let markWidth = 0;
  let midY = 0;
  let coreR = 0;
  let nearR = 0;
  let farR = 0;

  // Font metrics are measured once after loading, then only on resize.
  // The rung radii are counted in cell widths, so the pool keeps its
  // proportions whatever size the wordmark is rendered at.
  function measure() {
    sizeCells(wordmark);
    const origin = wordmark.getBoundingClientRect();
    markWidth = origin.width;
    for (const cell of cells) {
      const box = cell.el.getBoundingClientRect();
      cell.cx = box.left - origin.left + box.width / 2;
      cell.cy = box.top - origin.top + box.height / 2;
    }
    if (cells.length) cellWidth = cells[0].el.getBoundingClientRect().width;
    const middle = cells.find((cell) => cell.y === 2);
    if (middle) midY = middle.cy;
    coreR = cellWidth * 2.2;
    nearR = cellWidth * 4.4;
    farR = cellWidth * 7;
  }
  measure();
  new ResizeObserver(measure).observe(wordmark);

  let lastInteract = 0;
  let tickTimer = 0;

  // The pointer target. Events only write this; the tick reads it, so
  // nothing on screen ever changes between ticks.
  const pointer = { active: false, x: 0, y: 0, dirX: 1, dirY: 0, speed: 0 };
  let lastPX = null;
  let lastPY = null;
  let lastPT = 0;

  // The idle sweep: a pool centre crossing the word at mid height, one
  // column per tick, on the old refresh scan's schedule.
  let sweeping = false;
  let sweepX = 0;

  function setRung(cell, rung) {
    if (cell.rung === rung) return;
    if (cell.rung) cell.el.classList.remove(RUNG_CLASS[cell.rung]);
    cell.rung = rung;
    if (rung) cell.el.classList.add(RUNG_CLASS[rung]);
  }

  function clearPool() {
    for (const cell of cells) setRung(cell, 0);
  }

  // One frame of the pool: every cell's rung from its distance to the
  // centre. The distance is elliptical under way: the offset is split
  // along and across the direction of travel, and the along part is
  // divided by the stretch, so a fast pointer throws a long pool along
  // its path while a slow one keeps a tight round pool.
  function paintPool(cx, cy, dirX, dirY, speed) {
    const stretch = 1 + Math.min(speed, 2.5) * 0.8;
    for (const cell of cells) {
      const dx = cell.cx - cx;
      const dy = cell.cy - cy;
      let dist;
      if (stretch > 1) {
        const along = dx * dirX + dy * dirY;
        const across = dy * dirX - dx * dirY;
        dist = Math.hypot(along / stretch, across);
      } else {
        dist = Math.hypot(dx, dy);
      }
      setRung(cell, dist <= coreR ? 3 : dist <= nearR ? 2 : dist <= farR ? 1 : 0);
    }
  }

  function stopTick() {
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  function tick() {
    if (pointer.active) {
      // Speed bleeds off on the tick, so a pointer that stops moving
      // watches its pool relax back to round instead of staying
      // stretched around a position it has already left behind.
      pointer.speed *= 0.7;
      paintPool(pointer.x, pointer.y, pointer.dirX, pointer.dirY, pointer.speed);
    } else if (sweeping) {
      sweepX += cellWidth;
      if (sweepX - farR > markWidth) {
        sweeping = false;
        stopTick();
        clearPool();
        return;
      }
      paintPool(sweepX, midY, 1, 0, 0);
    } else {
      stopTick();
      clearPool();
    }
  }

  function startTick() {
    if (!tickTimer) tickTimer = setInterval(tick, TICK);
  }

  function sweep() {
    if (reduced.matches || document.hidden || sweeping || pointer.active) return;
    sweeping = true;
    sweepX = -farR;
    startTick();
  }

  function notePointer(event) {
    const origin = wordmark.getBoundingClientRect();
    const x = event.clientX - origin.left;
    const y = event.clientY - origin.top;
    const now = performance.now();
    if (lastPX !== null) {
      const dt = Math.max(now - lastPT, 1);
      const dx = x - lastPX;
      const dy = y - lastPY;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.5) {
        pointer.dirX = dx / dist;
        pointer.dirY = dy / dist;
      }
      pointer.speed = pointer.speed * 0.5 + (dist / dt) * 0.5;
    }
    lastPX = x;
    lastPY = y;
    lastPT = now;
    pointer.x = x;
    pointer.y = y;
  }

  function releasePointer() {
    pointer.active = false;
    pointer.speed = 0;
    lastPX = null;
    stopTick();
    clearPool();
  }

  wordmark.addEventListener("pointermove", (event) => {
    if (reduced.matches) return;
    if (event.pointerType === "touch" && !pointer.active) return;
    lastInteract = performance.now();
    sweeping = false;
    notePointer(event);
    if (event.pointerType !== "touch") pointer.active = true;
    startTick();
  }, { passive: true });

  wordmark.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") releasePointer();
  });

  // Touch on a hover-capable device: a tap lights the pool where the
  // finger lands, a drag carries it, and lifting the finger clears it
  // in one step. No-hover devices never reach this function and keep
  // the static split instead.
  wordmark.addEventListener("pointerdown", (event) => {
    if (reduced.matches || event.pointerType !== "touch") return;
    lastInteract = performance.now();
    sweeping = false;
    lastPX = null;
    pointer.speed = 0;
    notePointer(event);
    pointer.active = true;
    startTick();
  }, { passive: true });

  wordmark.addEventListener("pointerup", (event) => {
    if (event.pointerType === "touch") releasePointer();
  });
  wordmark.addEventListener("pointercancel", (event) => {
    if (event.pointerType === "touch") releasePointer();
  });

  // First sweep once the boot screen (about 1.3s) has cleared, then
  // again every 20s while the page is visible and nobody has hovered
  // recently.
  const firstSweep = setTimeout(sweep, 1600);
  const idleSweep = setInterval(() => {
    if (performance.now() - lastInteract > 12000) sweep();
  }, 20000);

  reduced.addEventListener("change", () => {
    sweeping = false;
    releasePointer();
    clearTimeout(firstSweep);
    clearInterval(idleSweep);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      sweeping = false;
      stopTick();
      clearPool();
    }
  });
}

// The horizon scene: an experiment the home page masthead tries in
// place of the pool. The pointer's height over the word sets a horizon
// line, and the whole grid becomes a small landscape laid over the
// name: sky above the line in two stepped shades, a far hill band on
// the line itself, and below it a grassy field stepping darker toward
// the baseline, its lowest rows carrying clustered grass tufts. A sun
// rides the line: a small disc of whole cells, bright core with one
// halo rung, its height set by the pointer's row and its column by the
// pointer's column, clamped so the disc stays inside the word. Light
// mode grades the scene as dawn, dark mode as dusk; the composition
// and the interaction are the same in both.
//
// The interaction is the gauge the split first shipped with, unchanged:
// the line snaps to the nearest row boundary (the pointer's row is
// read off the measured row bands, never a fraction of a row), and the
// bottom two rows stay filled whenever the pointer is over the word,
// however low it sits; they are now the field's front band and the
// hill above it. Changes step in place on the 75ms tick: positions
// take their scene shade in the one lighting order (baseline first,
// Bayer order inside a row, so a band that is still arriving reads as
// scatter, never a wipe), and positions leaving the scene clear in the
// reverse order, the top of the picture first. Every grid position
// takes part, the letter gaps as well as the block cells: a gap in the
// scene shows the block glyph in the scene's shade, and at rest it is
// a space again, so leaving returns the plain wordmark exactly. Cells
// still only swap whole colours in place; nothing fades, nothing
// drifts, and the sun's cells light and unlight where they sit like
// every other cell.
export async function animateWordmarkHorizon(wordmark, reduced) {
  if (!wordmark || !matchMedia("(hover: hover)").matches) return;
  await document.fonts.ready;
  if (!wordmark.isConnected) return;

  const TICK = 75;
  const BATCH = 30;
  const MIN_FILL = 2;
  splitWordmark(wordmark);

  // Every grid position with its coordinates, walked in document order
  // the same way the pool walks it: block cells and gap spans alike,
  // each carrying the shade it currently shows ("" is rest).
  const positions = [];
  {
    let x = 0;
    let y = 0;
    for (const node of wordmark.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        y += 1;
        x = 0;
      } else {
        positions.push({
          el: node,
          x,
          y,
          gap: node.classList.contains("wordmark__gap"),
          shown: "",
          target: "",
        });
        x += 1;
      }
    }
  }
  const rowCount = positions.reduce((max, pos) => Math.max(max, pos.y), 0) + 1;
  const colCount = positions.reduce((max, pos) => Math.max(max, pos.x), 0) + 1;

  // The one lighting order for the whole word: the baseline row first,
  // then the row above it, and inside a row the Bayer 4x4 threshold at
  // the position's own coordinates, roughened by a fixed hash so equal
  // thresholds do not march in lockstep. The same order every hover.
  // Clearing walks it backwards, which takes the top of the scene
  // first.
  const BAYER4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  function bayerKey(pos) {
    const hash = ((pos.x * 73856093) ^ (pos.y * 19349663)) >>> 0;
    return BAYER4[pos.y % 4][pos.x % 4] * 1024 + (hash % 1024);
  }
  const order = [...positions].sort(
    (a, b) => b.y - a.y || bayerKey(a) - bayerKey(b),
  );

  // Grass tufts: pairs of neighbouring columns share one hash, so a
  // tuft is a two-cell cluster, never a lone speckled cell. The hash
  // is read from its high bits, where the multiplication has mixed
  // it; the low bits cycle with the column and would plant the tufts
  // in a regular march.
  function isTuft(x, y) {
    const hash = (((x >> 1) * 73856093) ^ (y * 19349663)) >>> 0;
    return (hash >>> 16) % 4 === 0;
  }

  // Row bands, measured from the spans' own boxes: each row's top and
  // bottom, relative to the wordmark's origin. The pointer's row is
  // whichever band its height lands in, so the line only ever rests on
  // a row boundary. The cell width turns the pointer's x into a
  // column for the sun.
  const rowTop = new Array(rowCount).fill(Infinity);
  const rowBottom = new Array(rowCount).fill(-Infinity);
  let cellW = 0;
  function measure() {
    sizeCells(wordmark);
    const origin = wordmark.getBoundingClientRect();
    rowTop.fill(Infinity);
    rowBottom.fill(-Infinity);
    for (const pos of positions) {
      const box = pos.el.getBoundingClientRect();
      const top = box.top - origin.top;
      rowTop[pos.y] = Math.min(rowTop[pos.y], top);
      rowBottom[pos.y] = Math.max(rowBottom[pos.y], top + box.height);
      if (!cellW) cellW = box.width;
    }
  }
  measure();
  new ResizeObserver(measure).observe(wordmark);

  function rowForHeight(y) {
    for (let row = 0; row < rowCount; row += 1) {
      if (y < rowBottom[row]) return row;
    }
    return rowCount - 1;
  }

  // The pointer target. Events only write this; the tick reads it, so
  // nothing on screen ever changes between ticks.
  const pointer = { active: false, y: 0, col: Math.floor(colCount / 2) };
  let tickTimer = 0;

  function topRow() {
    if (!pointer.active) return rowCount;
    return Math.min(rowForHeight(pointer.y), rowCount - MIN_FILL);
  }

  // The shade one position should show, from the line and the sun.
  // Above the line, sky: the row touching the line is the near shade,
  // everything higher the far one. On the line, the hill. Below it,
  // the field in three bands by distance from the line, the lowest
  // rows trading their band shade for the tuft shade where the tuft
  // hash lands. The sun overrides whatever its cells would be: the
  // disc straddles the line, five cells wide, its middle three the
  // core and the cells flanking them the halo.
  function roleFor(pos) {
    if (!pointer.active) return "";
    const top = topRow();
    const dx = Math.abs(pos.x - pointer.col);
    if (dx <= 2 && (pos.y === top || pos.y === top - 1)) {
      return dx <= 1 ? "sun-core" : "sun-halo";
    }
    if (pos.y < top) return top - pos.y >= 2 ? "sky-far" : "sky-near";
    if (pos.y === top) return "hill";
    const below = pos.y - top;
    if ((below >= 3 || pos.y >= rowCount - 2) && isTuft(pos.x, pos.y)) {
      return "tuft";
    }
    return below === 1 ? "field-far" : below === 2 ? "field-mid" : "field-front";
  }

  function applyRole(pos, role) {
    if (pos.shown === role) return;
    if (pos.shown) pos.el.classList.remove(`is-${pos.shown}`);
    pos.shown = role;
    if (role) pos.el.classList.add(`is-${role}`);
    if (pos.gap) pos.el.textContent = role ? BLOCK_GLYPH : " ";
  }

  function clearAll() {
    for (const pos of positions) applyRole(pos, "");
  }

  // One tick toward the scene the pointer asks for: bring up to a
  // batch of positions to their scene shade, in the lighting order,
  // and clear up to a batch of positions whose target is rest, walking
  // the order backwards so the top of the scene clears first. When
  // nothing is left to move, the tick stops.
  function tick() {
    for (const pos of positions) pos.target = roleFor(pos);
    let moved = 0;
    for (const pos of order) {
      if (moved >= BATCH) break;
      if (pos.shown !== pos.target && pos.target !== "") {
        applyRole(pos, pos.target);
        moved += 1;
      }
    }
    moved = 0;
    for (let i = order.length - 1; i >= 0 && moved < BATCH; i -= 1) {
      const pos = order[i];
      if (pos.shown !== pos.target && pos.target === "") {
        applyRole(pos, "");
        moved += 1;
      }
    }
    if (!positions.some((pos) => pos.shown !== pos.target)) stopTick();
  }

  function startTick() {
    if (!tickTimer) tickTimer = setInterval(tick, TICK);
  }

  function stopTick() {
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  // Reduced motion: no stepping. The scene the pointer asks for is
  // simply there, in one cut, and leaving clears it in one cut.
  function applyInstant() {
    for (const pos of positions) applyRole(pos, roleFor(pos));
  }

  function notePointer(event) {
    const origin = wordmark.getBoundingClientRect();
    pointer.y = event.clientY - origin.top;
    if (cellW > 0) {
      const col = Math.floor((event.clientX - origin.left) / cellW);
      pointer.col = Math.min(Math.max(col, 2), colCount - 3);
    }
  }

  function engage(event) {
    notePointer(event);
    pointer.active = true;
    if (reduced.matches) applyInstant();
    else startTick();
  }

  function release() {
    pointer.active = false;
    if (reduced.matches) {
      stopTick();
      clearAll();
    } else {
      startTick();
    }
  }

  wordmark.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" && !pointer.active) return;
    engage(event);
  }, { passive: true });

  wordmark.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") release();
  });

  // Touch: a tap sets the line where the finger lands and the sun
  // follows it, a drag carries both, and lifting the finger clears
  // the scene again.
  wordmark.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    engage(event);
  }, { passive: true });

  wordmark.addEventListener("pointerup", (event) => {
    if (event.pointerType === "touch") release();
  });
  wordmark.addEventListener("pointercancel", (event) => {
    if (event.pointerType === "touch") release();
  });

  reduced.addEventListener("change", () => {
    pointer.active = false;
    stopTick();
    clearAll();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pointer.active = false;
      stopTick();
      clearAll();
    }
  });
}
