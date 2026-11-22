// A terminal can only change whole character cells, on a clock tick. The
// wordmark follows that limit literally. Its art is a fixed grid of
// character columns; cells change colour in place, only on the 75ms tick.
// There is no distance falloff, no energy, no fade, and no sub-cell
// position: a cell is accent or it is not.
//
// The pointer works in letters, not columns. The old scan lit one column
// at a time, which sliced through the letterforms and read as a glitch:
// a column is not a unit anyone sees, the letter is. So a sweep across
// the word lights each letter it crosses, whole, and lit letters hold.
// Cross every letter in one visit and the finished word holds for a
// beat, then steps back down together, each letter draining in the same
// steps it filled with. Leaving early drains what was lit the same way.
// A letter fills over three ticks, its columns lighting in slices from
// the left, so the fill itself is stepped rather than a snap.
//
// Touch gets the same build one tap at a time: tap a letter and it
// fills and holds; tap the last unlit one and the payoff runs. Reduced
// motion gets the still word: split into fixed cells, never lit.
//
// The original text remains the no-JS fallback; the heading has its own
// label.

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
// to give them.
//
// Returns the cells grouped two ways. By column, as before. And by
// letter: a column belongs to a letter when any row draws in it, and a
// run of drawn columns separated by columns blank in every row is one
// letter. The letterforms set their own boundaries this way; nothing
// about the wording is hardcoded, so the art can change and the letters
// regroup themselves.
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

  const letters = [];
  for (let x = 0; x < columnCount; x++) {
    if (columns[x].length === 0) continue;
    const last = letters[letters.length - 1];
    if (last && last.end === x - 1) {
      last.end = x;
      last.byColumn.push(columns[x]);
    } else {
      letters.push({ start: x, end: x, byColumn: [columns[x]] });
    }
  }
  return { columns, letters };
}

// The touch-device split: no sweep runs there from this function, but
// the fixed cells are still what keep the letters from merging in a
// phone browser. Like the animated path, it waits for the font, so the
// split and the measured cell width come from the loaded glyphs rather
// than a fallback, and it re-measures when the viewport changes the
// wordmark's size.
export async function setUpStaticWordmark(wordmark) {
  if (!wordmark) return;
  await document.fonts.ready;
  if (!wordmark.isConnected) return;
  splitWordmark(wordmark);
  sizeCells(wordmark);
  new ResizeObserver(() => sizeCells(wordmark)).observe(wordmark);
}

export async function animateWordmark(wordmark, reduced) {
  if (!wordmark) return;
  const hoverable = matchMedia("(hover: hover)").matches;
  await document.fonts.ready;
  if (!wordmark.isConnected) return;
  if (!hoverable) {
    // Pages with no hover call setUpStaticWordmark after this function,
    // and its split lands in a microtask on the same font promise. Wait
    // one macrotask so the split below is the last one standing: it
    // produces identical markup, and the letter groups it returns are
    // the live elements the tap handling lights.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!wordmark.isConnected) return;
  }

  const TICK = 75;
  // A letter fills in three ticks, columns lighting in slices. Wide
  // letters take bigger slices, so every letter takes the same time.
  const FILL_STEPS = 3;
  // The completed word holds for twelve ticks, about a second, before
  // the drain. Long enough to register as a payoff, short enough that
  // the word is not left shouting.
  const HOLD_TICKS = 12;

  const { letters } = splitWordmark(wordmark);
  for (const letter of letters) {
    letter.step = Math.ceil(letter.byColumn.length / FILL_STEPS);
    letter.litCols = 0;
  }

  let cellWidth = 0;

  // Font metrics are measured once after loading, then only on resize.
  function measure() {
    sizeCells(wordmark);
    const first = letters[0]?.byColumn[0]?.[0];
    if (first) cellWidth = first.getBoundingClientRect().width;
  }
  measure();
  new ResizeObserver(measure).observe(wordmark);

  // State for one visit to the word. crossed holds the letters lit or
  // filling since the visit began; the payoff needs every letter in it.
  // phase walks collecting -> holding -> draining -> idle, and draining
  // is also where an early leave sends a half-built word.
  const crossed = new Set();
  let phase = "idle";
  let holdLeft = 0;
  let timer = 0;
  let lastColumn = -1;

  function paint(letter) {
    letter.byColumn.forEach((cells, x) => {
      const lit = x < letter.litCols;
      for (const el of cells) el.classList.toggle("is-lit", lit);
    });
  }

  function startTimer() {
    if (!timer) timer = setInterval(tick, TICK);
  }

  function stopTimer() {
    clearInterval(timer);
    timer = 0;
  }

  function tick() {
    if (phase === "collecting") {
      let allFull = crossed.size === letters.length;
      for (const i of crossed) {
        const letter = letters[i];
        if (letter.litCols < letter.byColumn.length) {
          letter.litCols = Math.min(
            letter.byColumn.length,
            letter.litCols + letter.step
          );
          paint(letter);
          if (letter.litCols < letter.byColumn.length) allFull = false;
        }
      }
      if (allFull) {
        phase = "holding";
        holdLeft = HOLD_TICKS;
      }
    } else if (phase === "holding") {
      holdLeft -= 1;
      if (holdLeft <= 0) phase = "draining";
    } else if (phase === "draining") {
      let anyLit = false;
      for (const i of crossed) {
        const letter = letters[i];
        if (letter.litCols > 0) {
          letter.litCols = Math.max(0, letter.litCols - letter.step);
          paint(letter);
          if (letter.litCols > 0) anyLit = true;
        }
      }
      if (!anyLit) {
        crossed.clear();
        phase = "idle";
        stopTimer();
      }
    }
  }

  // Light a letter and hold it. Only letters crossed in this visit
  // count, and nothing new starts while a payoff is holding or
  // draining: the word finishes its sentence first.
  function cross(i) {
    if (reduced.matches) return;
    if (phase === "holding" || phase === "draining") return;
    if (crossed.has(i)) return;
    crossed.add(i);
    phase = "collecting";
    startTimer();
  }

  function columnAt(clientX) {
    if (cellWidth <= 0 || letters.length === 0) return -1;
    const origin = wordmark.getBoundingClientRect();
    const column = Math.floor((clientX - origin.left) / cellWidth);
    return Math.max(0, Math.min(letters[letters.length - 1].end, column));
  }

  function letterAt(column) {
    return letters.findIndex(
      (letter) => column >= letter.start && column <= letter.end
    );
  }

  wordmark.addEventListener(
    "pointermove",
    (event) => {
      if (reduced.matches || event.pointerType === "touch") return;
      const column = columnAt(event.clientX);
      if (column < 0) return;
      // Fill the path between events, so a fast sweep crosses the
      // letters it passed over instead of only the ones it sampled.
      const from = lastColumn < 0 ? column : Math.min(lastColumn, column);
      const to = lastColumn < 0 ? column : Math.max(lastColumn, column);
      letters.forEach((letter, i) => {
        if (letter.end >= from && letter.start <= to) cross(i);
      });
      lastColumn = column;
    },
    { passive: true }
  );

  wordmark.addEventListener("pointerleave", (event) => {
    // A touch pointer "leaves" the moment the finger lifts: that is
    // the tap ending, not the visit. Only a mouse leaving mid-build
    // drains what was lit, in the same steps it filled with. Leaving
    // during the payoff's hold lets it finish either way.
    if (event.pointerType === "touch") return;
    lastColumn = -1;
    if (phase === "collecting") phase = "draining";
  });

  // One tap, one letter. A tap in a gap between letters counts for the
  // nearer one: fingers are wider than the grid, and a miss that lights
  // nothing teaches nothing.
  wordmark.addEventListener("pointerdown", (event) => {
    if (reduced.matches || event.pointerType !== "touch") return;
    const column = columnAt(event.clientX);
    if (column < 0) return;
    let i = letterAt(column);
    if (i < 0) {
      let best = Infinity;
      letters.forEach((letter, j) => {
        const dist =
          column < letter.start ? letter.start - column : column - letter.end;
        if (dist < best) {
          best = dist;
          i = j;
        }
      });
    }
    if (i >= 0) cross(i);
  });

  // Reduced motion arriving mid-visit, or the page going hidden, ends
  // the show in one cut: nothing is on screen to watch it happen.
  function clearInOneCut() {
    stopTimer();
    crossed.clear();
    phase = "idle";
    lastColumn = -1;
    for (const letter of letters) {
      letter.litCols = 0;
      paint(letter);
    }
  }

  reduced.addEventListener("change", () => {
    if (reduced.matches) clearInOneCut();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInOneCut();
  });
}
