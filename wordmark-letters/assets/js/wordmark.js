// A terminal can only change whole character cells, on a clock tick. The
// wordmark follows that limit literally. Its art is a fixed grid of
// character columns; exactly one column is lit at a time, and the lit
// column changes only once per 75ms tick. There is no distance falloff,
// no energy, no fade, and no sub-cell position: a column is accent or it
// is not, then the next column takes its place.
//
// Hover quantizes the pointer to the nearest character column. The idle
// animation is a refresh scan: one column at a time, left to right, at
// the same fixed tick. The original text remains the no-JS fallback; the
// heading has its own label.
//
// The home page runs the letter variant at the bottom of this file
// instead: there the letter is the unit that lights, not the column.
// The other pages keep the scan above.

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
  const rows = wordmark.textContent.split("\n");
  const columnCount = Math.max(...rows.map((row) => [...row].length));
  const columns = splitWordmark(wordmark);

  let cellWidth = 0;
  let litColumn = -1;
  let lastInteract = 0;
  let scanTimer = 0;
  let scanColumn = -1;

  // Font metrics are measured once after loading, then only on resize.
  function measure() {
    sizeCells(wordmark);
    const first = columns.flat().find(Boolean);
    if (first) cellWidth = first.getBoundingClientRect().width;
  }
  measure();
  new ResizeObserver(measure).observe(wordmark);

  function setColumn(next) {
    if (next === litColumn) return;
    if (litColumn >= 0) {
      for (const el of columns[litColumn]) el.classList.remove("is-lit");
    }
    litColumn = next;
    if (litColumn >= 0) {
      for (const el of columns[litColumn]) el.classList.add("is-lit");
    }
  }

  function stopScan() {
    clearInterval(scanTimer);
    scanTimer = 0;
    scanColumn = -1;
  }

  function sweep() {
    if (reduced.matches || document.hidden || scanTimer) return;
    scanColumn = -1;
    scanTimer = setInterval(() => {
      scanColumn += 1;
      if (scanColumn >= columnCount) {
        stopScan();
        setColumn(-1);
        return;
      }
      setColumn(scanColumn);
    }, TICK);
  }

  wordmark.addEventListener("pointermove", (event) => {
    if (reduced.matches || event.pointerType === "touch") return;
    lastInteract = performance.now();
    stopScan();
    const origin = wordmark.getBoundingClientRect();
    const column = Math.floor((event.clientX - origin.left) / cellWidth);
    setColumn(Math.max(0, Math.min(columnCount - 1, column)));
  }, { passive: true });

  wordmark.addEventListener("pointerleave", () => setColumn(-1));

  // First scan once the boot screen (about 1.3s) has cleared, then again
  // every 20s while the page is visible and nobody has hovered recently.
  const firstSweep = setTimeout(sweep, 1600);
  const idleSweep = setInterval(() => {
    if (performance.now() - lastInteract > 12000) sweep();
  }, 20000);

  reduced.addEventListener("change", () => {
    stopScan();
    setColumn(-1);
    clearTimeout(firstSweep);
    clearInterval(idleSweep);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopScan();
      setColumn(-1);
    }
  });
}

/* ---------- the letter variant (home page) ---------- */

// The scan above lights whatever column the pointer crosses, so a
// letter lights in slices and reads as a glitch: a column is not a
// unit anyone sees. Here the letter is the unit. The letter under the
// pointer fills with accent cells in Bayer order, a batch per 75ms
// tick, and drains in the same steps when the pointer leaves it, so
// sweeping across the name lights it letter by letter. A cell is
// always painted, in the page colour or the accent: the letterform
// never opens up, it only changes colour in place.

// The Bayer 8x8 thresholds from dither.js, restated: a letter's fill
// order is the order these thresholds light a dither in, so the fill
// comes up as pattern density rather than wiping across.
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

// Seeded, so a letter fills the same way on every hover and every
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
// but keep each block cell's grid position with it: the letter
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

// Group the cells into letters. A letter is a run of occupied
// columns: the block font leaves at least one empty column between
// letters, so contiguity is the whole rule and no letter table is
// needed. Each letter's cells are put in fill order once: Bayer
// threshold first, a seeded jitter breaking the ties so equal
// thresholds do not light as a regular lattice. The drain walks the
// same order backwards.
function groupLetters(cells) {
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

  letters.forEach((letter, index) => {
    const rng = mulberry32(20261122 + index);
    for (const cell of letter.cells) cell.jitter = rng();
    letter.cells.sort(
      (a, b) =>
        BAYER_8[a.y % 8][a.x % 8] - BAYER_8[b.y % 8][b.x % 8] ||
        a.jitter - b.jitter,
    );
    letter.level = 0;
    letter.target = 0;
    // A batch per tick, sized so a whole letter lands in six ticks.
    letter.batch = Math.max(1, Math.ceil(letter.cells.length / 6));
  });
  return letters;
}

export async function animateWordmarkLetters(wordmark, reduced) {
  if (!wordmark) return;
  await document.fonts.ready;
  if (!wordmark.isConnected) return;

  const TICK = 75;
  const rows = wordmark.textContent.split("\n");
  const columnCount = Math.max(...rows.map((row) => [...row].length));
  const letters = groupLetters(splitWordmarkCells(wordmark));

  let cellWidth = 0;
  function measure() {
    sizeCells(wordmark);
    const first = letters[0]?.cells[0]?.el;
    if (first) cellWidth = first.getBoundingClientRect().width;
  }
  measure();
  new ResizeObserver(measure).observe(wordmark);

  // One ticker for every letter: on each tick each letter steps one
  // batch toward its target, so a drain and the next fill overlap
  // when the pointer crosses from one letter to the next.
  let timer = 0;
  function stepLetters() {
    let busy = false;
    for (const letter of letters) {
      if (letter.level === letter.target) continue;
      const next =
        letter.target > letter.level
          ? Math.min(letter.target, letter.level + letter.batch)
          : Math.max(letter.target, letter.level - letter.batch);
      for (
        let i = Math.min(letter.level, next);
        i < Math.max(letter.level, next);
        i += 1
      ) {
        letter.cells[i].el.classList.toggle("is-lit", i < next);
      }
      letter.level = next;
      if (letter.level !== letter.target) busy = true;
    }
    if (!busy) {
      clearInterval(timer);
      timer = 0;
    }
  }
  function setTarget(letter, target) {
    if (letter.target === target) return;
    letter.target = target;
    if (!timer) timer = setInterval(stepLetters, TICK);
  }

  function columnAt(clientX) {
    const origin = wordmark.getBoundingClientRect();
    const column = Math.floor((clientX - origin.left) / cellWidth);
    return Math.max(0, Math.min(columnCount - 1, column));
  }

  // The letter a column belongs to. A column in the gap between two
  // letters belongs to the nearer one, so the fill does not flicker
  // on and off as the pointer crosses the one empty column.
  function letterAt(column) {
    let best = null;
    let bestDistance = Infinity;
    for (const letter of letters) {
      const distance =
        column < letter.minX
          ? letter.minX - column
          : column > letter.maxX
            ? column - letter.maxX
            : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = letter;
      }
    }
    return best;
  }

  let hovered = null;
  let latched = null;
  let lastInteract = 0;

  // The idle sweep, in the same unit: with nobody around, the name
  // lights letter by letter, left to right, each letter draining as
  // the next one fills. Same cadence as the scan it replaces.
  let sweepTimer = 0;
  let sweepIndex = -1;
  function stopSweep() {
    if (!sweepTimer) return;
    clearInterval(sweepTimer);
    sweepTimer = 0;
    sweepIndex = -1;
    for (const letter of letters) {
      if (letter !== hovered && letter !== latched) setTarget(letter, 0);
    }
  }
  function sweep() {
    if (reduced.matches || document.hidden || sweepTimer || hovered || latched)
      return;
    sweepIndex = -1;
    sweepTimer = setInterval(() => {
      sweepIndex += 1;
      if (sweepIndex > 0) setTarget(letters[sweepIndex - 1], 0);
      if (sweepIndex >= letters.length) {
        stopSweep();
        return;
      }
      setTarget(letters[sweepIndex], letters[sweepIndex].cells.length);
    }, TICK * 6);
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
        const letter = letterAt(columnAt(event.clientX));
        if (!letter || letter === hovered) return;
        if (hovered) setTarget(hovered, 0);
        hovered = letter;
        setTarget(hovered, hovered.cells.length);
      },
      { passive: true },
    );

    wordmark.addEventListener("pointerleave", () => {
      if (hovered) setTarget(hovered, 0);
      hovered = null;
    });
  } else {
    // Touch has no hover to hold a letter open, so a tap latches it
    // full, the portrait's own pattern; tapping it again drains it.
    wordmark.addEventListener("click", (event) => {
      if (reduced.matches) return;
      lastInteract = performance.now();
      stopSweep();
      const letter = letterAt(columnAt(event.clientX));
      if (!letter) return;
      if (latched === letter) {
        setTarget(letter, 0);
        latched = null;
        return;
      }
      if (latched) setTarget(latched, 0);
      latched = letter;
      setTarget(letter, letter.cells.length);
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
    for (const letter of letters) {
      letter.target = 0;
      for (let i = 0; i < letter.level; i += 1) {
        letter.cells[i].el.classList.remove("is-lit");
      }
      letter.level = 0;
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
