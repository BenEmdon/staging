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

// The horizon split: an experiment the home page masthead tries in place
// of the pool. The pointer's height over the word sets a line, and the
// word answers by rows. Rows at and below the pointer's row swap to the
// accent, so the name fills from its baseline up to the pointer like a
// gauge; rows above stay ink. The fill climbs row by row from the
// baseline, and inside a row the cells light in Bayer order across the
// full word, a dithered scatter rather than a wipe. Lowering the pointer
// drains the band from its top down. The whole word is one instrument:
// there is no per-letter logic, and the letter gaps fill or drain with
// their row like every other cell. Two guards keep a parked line from
// reading as a printing fault: the line snaps to the nearest row
// boundary (the pointer's row is read off the measured row bands, never
// a fraction of a row), and the bottom two rows stay filled whenever the
// pointer is over the word, however low it sits. Cells still only swap
// whole colours in place, once per 75ms tick.
export async function animateWordmarkHorizon(wordmark, reduced) {
  if (!wordmark || !matchMedia("(hover: hover)").matches) return;
  await document.fonts.ready;
  if (!wordmark.isConnected) return;

  const TICK = 75;
  const BATCH = 30;
  const MIN_FILL = 2;
  splitWordmark(wordmark);

  // Every block cell with its grid position, walked in document order
  // the same way the pool walks it.
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
          cells.push({ el: node, x, y, lit: false });
        }
        x += 1;
      }
    }
  }
  const rowCount = cells.reduce((max, cell) => Math.max(max, cell.y), 0) + 1;

  // The one lighting order for the whole word: the baseline row first,
  // then the row above it, and inside a row the Bayer 4x4 threshold at
  // the cell's own position, roughened by a fixed hash so equal
  // thresholds do not march in lockstep. The same order every hover.
  // Draining walks it backwards, which takes the top of the band first.
  const BAYER4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  function bayerKey(cell) {
    const hash = ((cell.x * 73856093) ^ (cell.y * 19349663)) >>> 0;
    return BAYER4[cell.y % 4][cell.x % 4] * 1024 + (hash % 1024);
  }
  const order = [...cells].sort(
    (a, b) => b.y - a.y || bayerKey(a) - bayerKey(b),
  );

  // Row bands, measured from the cells' own boxes: each row's top and
  // bottom, relative to the wordmark's origin. The pointer's row is
  // whichever band its height lands in, so the line only ever rests on
  // a row boundary.
  const rowTop = new Array(rowCount).fill(Infinity);
  const rowBottom = new Array(rowCount).fill(-Infinity);
  function measure() {
    sizeCells(wordmark);
    const origin = wordmark.getBoundingClientRect();
    rowTop.fill(Infinity);
    rowBottom.fill(-Infinity);
    for (const cell of cells) {
      const box = cell.el.getBoundingClientRect();
      const top = box.top - origin.top;
      rowTop[cell.y] = Math.min(rowTop[cell.y], top);
      rowBottom[cell.y] = Math.max(rowBottom[cell.y], top + box.height);
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
  const pointer = { active: false, y: 0 };
  let tickTimer = 0;

  function topRow() {
    if (!pointer.active) return rowCount;
    return Math.min(rowForHeight(pointer.y), rowCount - MIN_FILL);
  }

  function setLit(cell, lit) {
    if (cell.lit === lit) return;
    cell.lit = lit;
    cell.el.classList.toggle("is-horizon", lit);
  }

  function clearAll() {
    for (const cell of cells) setLit(cell, false);
  }

  // One tick toward the target band: light up to a batch of unlit cells
  // inside the band, in the lighting order, and unlight up to a batch of
  // lit cells outside it, walking the order backwards so the top of the
  // band drains first. When nothing is left to move, the tick stops.
  function tick() {
    const top = topRow();
    let moved = 0;
    for (const cell of order) {
      if (moved >= BATCH) break;
      if (!cell.lit && cell.y >= top) {
        setLit(cell, true);
        moved += 1;
      }
    }
    moved = 0;
    for (let i = order.length - 1; i >= 0 && moved < BATCH; i -= 1) {
      const cell = order[i];
      if (cell.lit && cell.y < top) {
        setLit(cell, false);
        moved += 1;
      }
    }
    if (!order.some((cell) => cell.lit !== (cell.y >= top))) stopTick();
  }

  function startTick() {
    if (!tickTimer) tickTimer = setInterval(tick, TICK);
  }

  function stopTick() {
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  // Reduced motion: no gauge, no tick. The band the pointer asks for is
  // simply there, in one cut, and leaving clears it in one cut.
  function applyInstant() {
    const top = topRow();
    for (const cell of cells) setLit(cell, cell.y >= top);
  }

  function notePointer(event) {
    const origin = wordmark.getBoundingClientRect();
    pointer.y = event.clientY - origin.top;
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

  // Touch: a tap fills to the tap's row, a drag up or down moves the
  // line, and lifting the finger drains the word again.
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
