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

/* ---------- the word variant (home page) ---------- */

// The letter variant lights one letter at a time. Here the unit is
// the word: BEN or EMDON. Hovering anywhere over a word fills the
// whole word, its cells lighting in Bayer order across all its
// letters at once, so the fill reads as one word coming up rather
// than its letters racing. Leaving drains it in the same steps
// reversed, and crossing from one word to the other drains the
// first while the second fills. A cell is always painted, in the
// page colour or the accent: the letterforms never open up, they
// only change colour in place.

// The Bayer 8x8 thresholds from dither.js, restated: a word's fill
// order is the order these thresholds light a dither in, so the
// fill comes up as pattern density rather than wiping across.
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

// Seeded, so a word fills the same way on every hover and every
// visit, never from Math.random at interaction time. The boot
// screen's own generator.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Split the art into one span per character, as splitWordmark does,
// but keep each block cell's grid position with it: the word
// animation thinks in cells at known columns and rows.
function splitWordmarkCells(wordmark) {
  const rows = wordmark.textContent.split("\n");
  const fragment = document.createDocumentFragment();
  const cells = [];

  rows.forEach((row, y) => {
    [...row].forEach((glyph, x) => {
      const el = document.createElement("span");
      el.className = glyph === " " ? "wordmark__gap" : "wordmark__cell";
      el.textContent = glyph;
      fragment.append(el);
      if (glyph !== " ") cells.push({ el, x, y });
    });
    if (y < rows.length - 1) fragment.append("\n");
  });
  wordmark.replaceChildren(fragment);
  return cells;
}

// Group the cells into words, in two passes over the art's own
// spacing. Letters first: a letter is a run of occupied columns,
// since the block font leaves at least one empty column between
// letters. Words next: in this art the gap between letters inside
// a word is exactly one empty column and the gap between the two
// words is five, so a break wider than one column is a word
// boundary. No letter table and no word table: the split is read
// off the art. Each word's cells are put in fill order once, across
// the whole word: Bayer threshold first, a seeded jitter breaking
// the ties so equal thresholds do not light as a regular lattice.
// The drain walks the same order backwards.
function groupWords(cells) {
  const byColumn = new Map();
  for (const cell of cells) {
    if (!byColumn.has(cell.x)) byColumn.set(cell.x, []);
    byColumn.get(cell.x).push(cell);
  }

  const letters = [];
  for (const x of [...byColumn.keys()].sort((a, b) => a - b)) {
    const last = letters[letters.length - 1];
    if (last && x === last.maxX + 1) {
      last.maxX = x;
      last.cells.push(...byColumn.get(x));
    } else {
      letters.push({ minX: x, maxX: x, cells: [...byColumn.get(x)] });
    }
  }

  const words = [];
  for (const letter of letters) {
    const last = words[words.length - 1];
    if (last && letter.minX - last.maxX - 1 <= 1) {
      last.maxX = letter.maxX;
      last.cells.push(...letter.cells);
    } else {
      words.push({ minX: letter.minX, maxX: letter.maxX, cells: [...letter.cells] });
    }
  }

  words.forEach((word, index) => {
    const rng = mulberry32(20261122 + index);
    for (const cell of word.cells) cell.jitter = rng();
    word.cells.sort(
      (a, b) =>
        BAYER_8[a.y % 8][a.x % 8] - BAYER_8[b.y % 8][b.x % 8] ||
        a.jitter - b.jitter,
    );
    word.level = 0;
    word.target = 0;
    // A batch per tick, sized so a whole word lands in nine ticks,
    // whichever of the two words it is.
    word.batch = Math.max(1, Math.ceil(word.cells.length / 9));
  });
  return words;
}

export async function animateWordmarkWords(wordmark, reduced) {
  if (!wordmark) return;
  await document.fonts.ready;
  if (!wordmark.isConnected) return;

  const TICK = 75;
  const rows = wordmark.textContent.split("\n");
  const columnCount = Math.max(...rows.map((row) => [...row].length));
  const words = groupWords(splitWordmarkCells(wordmark));

  let cellWidth = 0;
  function measure() {
    sizeCells(wordmark);
    const first = words[0]?.cells[0]?.el;
    if (first) cellWidth = first.getBoundingClientRect().width;
  }
  measure();
  new ResizeObserver(measure).observe(wordmark);

  // One ticker for both words: on each tick each word steps one
  // batch toward its target, so a drain and the next fill overlap
  // when the pointer crosses from one word to the other.
  let timer = 0;
  function stepWords() {
    let busy = false;
    for (const word of words) {
      if (word.level === word.target) continue;
      const next =
        word.target > word.level
          ? Math.min(word.target, word.level + word.batch)
          : Math.max(word.target, word.level - word.batch);
      for (
        let i = Math.min(word.level, next);
        i < Math.max(word.level, next);
        i += 1
      ) {
        word.cells[i].el.classList.toggle("is-lit", i < next);
      }
      word.level = next;
      if (word.level !== word.target) busy = true;
    }
    if (!busy) {
      clearInterval(timer);
      timer = 0;
    }
  }
  function setTarget(word, target) {
    if (word.target === target) return;
    word.target = target;
    if (!timer) timer = setInterval(stepWords, TICK);
  }

  function columnAt(clientX) {
    const origin = wordmark.getBoundingClientRect();
    const column = Math.floor((clientX - origin.left) / cellWidth);
    return Math.max(0, Math.min(columnCount - 1, column));
  }

  // The word a column belongs to. A column in a gap belongs to the
  // nearer word, so the fill does not flicker on and off as the
  // pointer crosses the empty columns, the wide word gap included.
  function wordAt(column) {
    let best = null;
    let bestDistance = Infinity;
    for (const word of words) {
      const distance =
        column < word.minX
          ? word.minX - column
          : column > word.maxX
            ? column - word.maxX
            : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = word;
      }
    }
    return best;
  }

  let hovered = null;
  let latched = null;
  let lastInteract = 0;

  // The idle sweep, in the same unit: with nobody around, BEN
  // lights, then EMDON lights as BEN drains. Same idea as the
  // letter sweep, one word per step instead of one letter.
  let sweepTimer = 0;
  let sweepIndex = -1;
  function stopSweep() {
    if (!sweepTimer) return;
    clearInterval(sweepTimer);
    sweepTimer = 0;
    sweepIndex = -1;
    for (const word of words) {
      if (word !== hovered && word !== latched) setTarget(word, 0);
    }
  }
  function sweep() {
    if (reduced.matches || document.hidden || sweepTimer || hovered || latched)
      return;
    sweepIndex = -1;
    sweepTimer = setInterval(() => {
      sweepIndex += 1;
      if (sweepIndex > 0) setTarget(words[sweepIndex - 1], 0);
      if (sweepIndex >= words.length) {
        stopSweep();
        return;
      }
      setTarget(words[sweepIndex], words[sweepIndex].cells.length);
    }, TICK * 10);
  }
  const firstSweep = setTimeout(sweep, 1600);
  const idleSweep = setInterval(() => {
    if (performance.now() - lastInteract > 12000) sweep();
  }, 20000);

  if (matchMedia("(hover: hover)").matches) {
    wordmark.addEventListener(
      "pointermove",
      (event) => {
        if (reduced.matches || event.pointerType === "touch") return;
        lastInteract = performance.now();
        stopSweep();
        const word = wordAt(columnAt(event.clientX));
        if (!word || word === hovered) return;
        if (hovered) setTarget(hovered, 0);
        hovered = word;
        setTarget(hovered, hovered.cells.length);
      },
      { passive: true },
    );

    wordmark.addEventListener("pointerleave", () => {
      if (hovered) setTarget(hovered, 0);
      hovered = null;
    });
  } else {
    // Touch has no hover to hold a word open, so a tap latches it
    // full; tapping it again drains it, and tapping the other word
    // moves the latch across.
    wordmark.addEventListener("click", (event) => {
      if (reduced.matches) return;
      lastInteract = performance.now();
      stopSweep();
      const word = wordAt(columnAt(event.clientX));
      if (!word) return;
      if (latched === word) {
        setTarget(word, 0);
        latched = null;
        return;
      }
      if (latched) setTarget(latched, 0);
      latched = word;
      setTarget(word, word.cells.length);
    });
  }

  reduced.addEventListener("change", () => {
    stopSweep();
    clearTimeout(firstSweep);
    clearInterval(idleSweep);
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
    // One cut back to the still wordmark, never steps.
    for (const word of words) {
      word.target = 0;
      for (let i = 0; i < word.level; i += 1) {
        word.cells[i].el.classList.remove("is-lit");
      }
      word.level = 0;
    }
    hovered = null;
    latched = null;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopSweep();
      if (hovered) {
        setTarget(hovered, 0);
        hovered = null;
      }
    }
  });
}
