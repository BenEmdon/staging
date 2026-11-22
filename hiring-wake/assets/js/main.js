import { attach } from "./dither.js";
import { animateWordmark } from "./wordmark.js";
import { createThemeScene } from "./theme-scene.js";
import { announceBootTask, whenBootTask } from "./boot-tasks.js";
import { runBoot } from "./boot.js?v=20261122l";

const THEME_KEY = "theme";
// The cycle the scene control walks. "system" is where everyone starts, and it is
// less a stored preference than the absence of one: in that mode nothing is
// pinned and color-scheme follows the OS.
const MODES = ["system", "light", "dark"];
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function storedMode() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return MODES.includes(saved) ? saved : "system";
  } catch {
    // Private-mode Safari refuses reads as well as writes.
    return "system";
  }
}

const nextMode = (mode) => MODES[(MODES.indexOf(mode) + 1) % MODES.length];

function setUp() {
  const repaints = [];
  // The boot log's zero: every duration it quotes is measured from here.
  const bootT0 = performance.now();

  // Read by the portrait dissolve and by keyed jumps, so it sits above both
  // rather than inside whichever one happened to need it first.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- portrait ---------- */

  // Eight steps of it, matching the wordmark's own reveal. Few enough that each
  // one lands as a separate frame rather than reading as a fade.
  const DISSOLVE_STEPS = 8;

  // The portrait half of the boot log's scene task: resolved once the
  // dither has decoded the photo and painted its first frame. It never
  // rejects: a portrait that fails resolves with a false flag instead,
  // so a photo problem can never read as a scene failure (see the
  // catch below).
  let resolvePortrait;
  const portraitTask = new Promise((resolve) => {
    resolvePortrait = resolve;
  });

  for (const frame of document.querySelectorAll("[data-dither]")) {
    const canvas = frame.querySelector("[data-dither-canvas]");
    const photo = frame.querySelector("img");

    attach(canvas, photo)
      .then((portrait) => {
        repaints.push(portrait.repaint);
        resolvePortrait(performance.now() - bootT0);

        let step = 0;
        let timer;

        // Driven from here rather than by a CSS transition on opacity, because
        // the point is that the dither comes apart in blocks: cells of it wink
        // out in a scrambled order until the photograph underneath is all that
        // is left. A fade would just make it fainter.
        function dissolve(toward) {
          clearInterval(timer);

          // One jump for anyone who asked not to be animated. They still get
          // the photograph, just not the six frames on the way to it.
          if (reduced.matches) {
            step = toward;
            portrait.reveal(step / DISSOLVE_STEPS);
            return;
          }

          timer = setInterval(() => {
            step += Math.sign(toward - step);
            portrait.reveal(step / DISSOLVE_STEPS);
            if (step === toward) clearInterval(timer);
          }, 320 / DISSOLVE_STEPS);
        }

        const show = () => dissolve(DISSOLVE_STEPS);
        const hide = () => dissolve(0);

        // Keyboard gets it either way.
        frame.addEventListener("focus", show);
        frame.addEventListener("blur", hide);

        if (window.matchMedia("(hover: hover)").matches) {
          frame.addEventListener("pointerenter", show);
          frame.addEventListener("pointerleave", hide);
        } else {
          // Touch has no hover to hold it open, so a tap latches. These cannot
          // both be bound: on touch a tap fires pointerenter, then click, then
          // pointerleave the moment the finger lifts, which would close the
          // photo again the instant the tap opened it.
          let latched = false;
          frame.addEventListener("click", () => {
            latched = !latched;
            dissolve(latched ? DISSOLVE_STEPS : 0);
          });
        }
      })
      // Without the dither the photo simply shows through, so there is
      // nothing to clean up on failure. The boot task still hears about
      // it, but as a resolution carrying a false flag, never a
      // rejection: served cross-origin (a preview host redirecting the
      // photo, say), the photo can taint the canvas and throw, and
      // that is a portrait problem, not a scene failure.
      .catch(() => resolvePortrait(false));
  }

  /* ---------- hiring wake ---------- */

  // The block's background is a still dither field on its fixed 8px
  // grid: a Bayer-ordered mix of the two lowest --wake shades, painted
  // once on a canvas behind the copy. A pointer crossing the block
  // spawns ripples. Each ripple's front advances one cell per 75ms
  // tick; a cell the front reaches lights at the crest shade and then
  // steps down one shade per tick in place until it is field again, so
  // at any moment the ripple reads as concentric rings, one solid shade
  // per ring. Cells never move and never fade: a cell only ever swaps
  // whole to another palette colour on the tick. Pointer speed shapes
  // the ripple as it shaped the old sparkle: slow keeps the radius
  // tight and the crest a shade lower, fast throws it wider and
  // brighter. Touch gets the same wake from a tap or a drag. Reduced
  // motion paints the field once and never ripples.
  const hiring = document.querySelector("[data-hiring]");
  const wakeCanvas = document.querySelector("[data-hiring-wake]");

  if (hiring && wakeCanvas && wakeCanvas.getContext) {
    const ctx = wakeCanvas.getContext("2d");
    const CELL = 8;
    // Bayer 4x4 ordered-dither thresholds, 0..15. The field wears its
    // tint on cells under FIELD_MAX, about a third of the field.
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const FIELD_MAX = 5;

    let cols = 0;
    let rows = 0;
    let levels = new Uint8Array(0);
    let painted = new Int16Array(0);
    let palette = [];
    const sources = [];
    let tickTimer = 0;
    let lastX = null;
    let lastY = null;
    let lastT = 0;
    let lastSpawnX = null;
    let lastSpawnY = null;

    // The ramp lives in CSS as light-dark() pairs, whose computed
    // custom-property value is the unresolved pair; a canvas cannot
    // paint with that. A hidden probe element wearing each shade as
    // its background resolves the pair against the active colour
    // scheme, and its computed background is a plain rgb() the canvas
    // takes. The probe is paint-only: absolute, hidden, no input.
    const probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    hiring.append(probe);

    function readPalette() {
      palette = [0, 1, 2, 3, 4, 5].map((i) => {
        probe.style.backgroundColor = `var(--wake-${i})`;
        return getComputedStyle(probe).backgroundColor;
      });
    }

    function fieldShade(c, r) {
      return BAYER[(r % 4) * 4 + (c % 4)] < FIELD_MAX ? 1 : 0;
    }

    function paintCell(c, r) {
      const i = r * cols + c;
      const shade = levels[i] > 0 ? levels[i] + 1 : fieldShade(c, r);
      if (painted[i] === shade) return;
      painted[i] = shade;
      ctx.fillStyle = palette[shade];
      ctx.fillRect(c, r, 1, 1);
    }

    function paintAll() {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) paintCell(c, r);
      }
    }

    function repaint() {
      painted.fill(-1);
      paintAll();
    }

    function resize() {
      const rect = hiring.getBoundingClientRect();
      cols = Math.max(1, Math.ceil(rect.width / CELL));
      rows = Math.max(1, Math.ceil(rect.height / CELL));
      wakeCanvas.width = cols;
      wakeCanvas.height = rows;
      wakeCanvas.style.inlineSize = `${cols * CELL}px`;
      wakeCanvas.style.blockSize = `${rows * CELL}px`;
      levels = new Uint8Array(cols * rows);
      painted = new Int16Array(cols * rows).fill(-1);
      sources.length = 0;
      readPalette();
      paintAll();
    }

    function tick() {
      levels.fill(0);
      for (let i = sources.length - 1; i >= 0; i--) {
        const s = sources[i];
        s.age += 1;
        if (s.age > s.radius + s.peak) {
          sources.splice(i, 1);
          continue;
        }
        const reach = Math.min(s.age, s.radius);
        for (let dr = -reach; dr <= reach; dr++) {
          for (let dc = -reach; dc <= reach; dc++) {
            const d = Math.round(Math.hypot(dc, dr));
            if (d > reach) continue;
            const level = s.peak - (s.age - d);
            if (level <= 0) continue;
            const c = s.c + dc;
            const r = s.r + dr;
            if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
            const idx = r * cols + c;
            if (level > levels[idx]) levels[idx] = level;
          }
        }
      }
      paintAll();
      if (sources.length === 0) {
        clearInterval(tickTimer);
        tickTimer = 0;
      }
    }

    function spawn(x, y, speed) {
      const c = Math.floor(x / CELL);
      const r = Math.floor(y / CELL);
      const radius = Math.max(3, Math.min(9, Math.round(3 + speed * 3.5)));
      const peak = speed > 0.45 ? 4 : 3;
      const last = sources[sources.length - 1];
      if (last && last.c === c && last.r === r && last.age <= 1) {
        last.radius = Math.max(last.radius, radius);
        last.peak = Math.max(last.peak, peak);
        return;
      }
      sources.push({ c, r, age: 0, radius, peak });
      if (sources.length > 24) sources.shift();
      if (!tickTimer) {
        tickTimer = setInterval(tick, 75);
        tick();
      }
    }

    function pointerPos(event) {
      const rect = hiring.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    hiring.addEventListener("pointermove", (event) => {
      if (reduced.matches) return;
      // A touch only ripples while it is down: a tap, or a drag.
      if (event.pointerType === "touch" && !event.buttons) return;

      const { x, y } = pointerPos(event);
      const now = performance.now();
      let speed = 0;
      if (lastX !== null) {
        const dt = Math.max(now - lastT, 1);
        speed = Math.hypot(x - lastX, y - lastY) / dt;
      }
      if (lastSpawnX === null) {
        spawn(x, y, speed);
        lastSpawnX = x;
        lastSpawnY = y;
      } else {
        // A new ripple only once the pointer has travelled three
        // cells from the last one, interpolated along the path on a
        // fast pass, so each ripple keeps room to read as rings
        // instead of flooding into its neighbours.
        let gap = Math.hypot(x - lastSpawnX, y - lastSpawnY);
        while (gap >= CELL * 3) {
          const t = (CELL * 3) / gap;
          lastSpawnX += (x - lastSpawnX) * t;
          lastSpawnY += (y - lastSpawnY) * t;
          spawn(lastSpawnX, lastSpawnY, speed);
          gap = Math.hypot(x - lastSpawnX, y - lastSpawnY);
        }
      }
      lastX = x;
      lastY = y;
      lastT = now;
    });

    hiring.addEventListener("pointerdown", (event) => {
      if (reduced.matches) return;
      const { x, y } = pointerPos(event);
      spawn(x, y, 0.6);
      lastX = x;
      lastY = y;
      lastSpawnX = x;
      lastSpawnY = y;
      lastT = performance.now();
    });

    hiring.addEventListener("pointerleave", () => {
      lastX = null;
      lastSpawnX = null;
    });

    // Keyboard focus gets one ripple from the middle of the block, the
    // wake's answer to the border pulse focus already gets.
    hiring.addEventListener("focus", () => {
      if (reduced.matches) return;
      const rect = hiring.getBoundingClientRect();
      spawn(rect.width / 2, rect.height / 2, 0.6);
    });

    // A theme change recolours the ramp under the field; repaint from
    // the new palette. The field pattern itself never changes.
    new MutationObserver(() => {
      readPalette();
      repaint();
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    systemDark.addEventListener("change", () => {
      readPalette();
      repaint();
    });

    resize();
    new ResizeObserver(resize).observe(hiring);
  }

  /* ---------- theme ---------- */

  let mode = storedMode();
  let sceneCycleStarted = false;

  const resolvedDark = () =>
    mode === "dark" || (mode === "system" && systemDark.matches);

  // The scene lives twice on the page: the masthead, and the footer
  // system line where it sat before the masthead had one. One mode
  // drives both. Each control keeps its own painter and its own word
  // window: the mode word beside a scene is a tap's receipt, not a
  // permanent readout, and the receipt shows where the tap landed. A
  // tap shows it, it stays for about 2.5 seconds, then it goes away
  // and the control is the picture alone again. The theme itself does
  // not revert when the word hides, and a fresh tap restarts the
  // window on the control that was tapped.
  const sceneControls = [
    ...document.querySelectorAll("[data-theme-scene-control]"),
  ].map((controlEl) => {
    const canvas = controlEl.querySelector("[data-theme-scene]");
    return {
      button: controlEl.querySelector("[data-theme-scene-button]"),
      current: controlEl.querySelector("[data-theme-scene-current]"),
      scene: canvas
        ? createThemeScene(canvas, { dark: resolvedDark() })
        : null,
      revealed: false,
      revealTimer: undefined,
    };
  });
  // The t key works the same control it always did: the first one.
  const sceneButton = sceneControls[0]?.button ?? null;

  function persistMode() {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      // Private-mode Safari refuses writes; the choice still holds this visit.
    }
  }

  // Where a scene click goes. The plain cycle is light, dark, system,
  // and back to light, which is nextMode's order read from light. One
  // exception: the first scene click out of system mode jumps to the
  // opposite of whatever system is currently resolving to, so the
  // click always lands on a visible change. After that first jump the
  // plain cycle runs from wherever it landed, even when the cycle
  // comes back around to system.
  function nextSceneMode() {
    if (!sceneCycleStarted && mode === "system") {
      return resolvedDark() ? "light" : "dark";
    }
    return nextMode(mode);
  }

  // Only light and dark pin [data-theme]. System mode removes it, which is the
  // same state the inline script in <head> leaves the page in before first
  // paint, so there is nothing to flash on load either way.
  function applyMode() {
    if (mode === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = mode;
    }

    // Each scene carries the current mode as its word while its own
    // post-tap window is open, and each button's name says where a
    // click goes next, worked out live so the system first-click rule
    // is in the name, word showing or not.
    for (const control of sceneControls) {
      if (control.current) {
        control.current.textContent = mode;
        control.current.hidden = !control.revealed;
      }
      control.button?.setAttribute(
        "aria-label",
        `Theme: ${mode}. Activate to switch to ${nextSceneMode()}`
      );

      // The little landscape re-lights to match: day in light, night
      // in dark, stepped cell by cell unless reduced motion is on.
      control.scene?.setDark(resolvedDark(), reduced.matches);
    }

    // The dither reads its two colours back out of CSS, so it has to be
    // redrawn whenever the resolved theme could have moved under it.
    repaints.forEach((repaint) => repaint());
  }

  // The picture is the control. The swap is whole and instant, and the
  // button is never hidden or replaced, so focus stays on it.
  for (const control of sceneControls) {
    control.button?.addEventListener("click", () => {
      mode = nextSceneMode();
      sceneCycleStarted = true;
      control.revealed = true;
      persistMode();
      applyMode();
      // The word is a receipt with a short life: restart its window
      // on every tap, then let applyMode hide it when the window
      // closes. Hiding only flips the label's hidden flag; the mode,
      // and the scenes lit for it, stay as the tap left them.
      clearTimeout(control.revealTimer);
      control.revealTimer = setTimeout(() => {
        control.revealed = false;
        applyMode();
      }, 2500);
    });
  }

  // Only in system mode does the OS still get a vote.
  systemDark.addEventListener("change", () => {
    if (mode === "system") applyMode();
  });

  applyMode();

  /* ---------- section in view ---------- */

  const sections = document.querySelectorAll(".section");

  // A zero-height band a third of the way down the viewport, two-thirds
  // toward the top (Ben's call, 2026-11-22): inset the root 33.333% from the
  // top and 66.667% from the bottom and no box is left, so a section
  // "intersects" exactly while it straddles that line, and the framed section
  // sits in the upper part of the screen with more of what follows in view.
  // Sections do not overlap, so at most one qualifies at a time. Cheaper and
  // steadier than measuring rects on every scroll event. On a desktop the
  // pointer is the frame's source instead: the hover rule in layout.css
  // stands this one down while the mouse is over any section. Dead centre
  // was the old line.
  // While a keyed jump is in flight the observer stands down: see frame().
  let jumpingUntil = 0;

  function frame(section) {
    for (const other of sections) other.classList.toggle("is-active", other === section);
  }

  const focusLine = new IntersectionObserver(
    (entries) => {
      if (performance.now() < jumpingUntil) return;

      // Between two sections sit a divider and its margins, about 72px where
      // nothing is at the line. Clearing the frame there makes it strobe, so
      // whichever section reached the line last keeps it until the next one
      // arrives.
      const arrived = entries.findLast((entry) => entry.isIntersecting);
      if (arrived) frame(arrived.target);
    },
    { rootMargin: "-33.333% 0px -66.667% 0px" }
  );

  for (const section of sections) focusLine.observe(section);

  /* ---------- keys ---------- */

  const keys = document.querySelector("[data-keys]");
  const keysToggle = document.querySelector("[data-keys-toggle]");

  function showKeys(open) {
    keys.hidden = !open;
    keysToggle.setAttribute("aria-expanded", String(open));
  }

  // Landing a section at the top of the viewport puts the focus line past the
  // short ones and into whatever follows, so the frame would confirm the wrong
  // section. Rather than move the line, hold the observer off for the length of
  // the scroll and frame the target directly; once the lock lapses there is no
  // further scroll to correct it, and the next real one hands control back.
  function jump(section) {
    section.scrollIntoView({
      behavior: reduced.matches ? "auto" : "smooth",
      block: "start",
    });
    jumpingUntil = performance.now() + (reduced.matches ? 0 : 1000);
    frame(section);
    history.replaceState(null, "", `#${section.querySelector("[id]").id}`);
  }

  document.addEventListener("keydown", (event) => {
    // ? is Shift+/, so shiftKey has to stay allowed.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const el = event.target;
    if (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName)) return;

    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= sections.length) {
      jump(sections[digit - 1]);
    } else if (event.key === "t") {
      sceneButton?.click();
    } else if (event.key === "?") {
      showKeys(keys.hidden);
    } else if (event.key === "Escape") {
      showKeys(false);
    } else {
      return;
    }

    event.preventDefault();
  });

  keysToggle.addEventListener("click", () => showKeys(keys.hidden));

  /* ---------- wordmark boot ---------- */

  const wordmark = document.querySelector(".wordmark");

  // The block glyphs are served display=block, so for up to three seconds the
  // wordmark is laid out but painting nothing. Starting the reveal on load
  // would run it against an empty box and pop the finished art in afterwards.
  // fonts.ready resolves either way, including on a failed load, so the class is
  // always eventually added.
  document.fonts.ready.then(() => wordmark?.classList.add("is-booting"));

  animateWordmark(wordmark, reduced);

  /* ---------- boot ---------- */

  // The log is an instrument now, not theatre: every line names a real
  // startup process and resolves only when that process actually
  // finishes, with the value the process itself reports. The three
  // tasks are the scene (the portrait dither plus the meadow, which
  // announces itself from meadow.js once its reveal has finished
  // generating, or at first paint when the figure is off-screen and
  // nothing is generating yet), the music demo's render or cache
  // read (announced from music-demo.js, which now renders in the
  // background at load instead of waiting for a first press of play),
  // and the footer clock's first tick, resolved from tick() below.
  // The surfaces themselves, the full screen for a session's first
  // load and the segmented indicator for the loads after, live in
  // boot.js, shared with the other two pages.
  let resolveClock;
  const clockTask = new Promise((resolve) => {
    resolveClock = resolve;
  });
  announceBootTask("clock", clockTask);

  const sceneTask = Promise.all([portraitTask, whenBootTask("meadow")]).then(
    () => performance.now() - bootT0
  );

  runBoot(
    [
      {
        label: "building pixel scene",
        promise: sceneTask,
        format: (ms) => `${Math.round(ms)} ms`,
      },
      {
        label: "rendering music",
        promise: whenBootTask("music"),
        // The demo registers its own render task with the
        // loader where the work runs (music-demo.js), so this
        // entry is for the boot screen only: runBoot does not
        // register the same work a second time.
        selfReports: true,
        format: (r) =>
          r.fromCache
            ? `from cache · ${Math.round(r.ms)} ms`
            : `rendered in ${Math.round(r.renderMs)} ms`,
      },
      {
        label: "syncing clock",
        promise: clockTask,
        format: (r) => r.value,
      },
    ],
    { t0: bootT0 }
  );

  /* ---------- clock ---------- */

  const clock = document.querySelector("[data-clock]");
  const clockTime = document.querySelector("[data-clock-time]");
  const hours = document.querySelector("[data-clock-hours]");
  const minutes = document.querySelector("[data-clock-minutes]");

  // His time, not the reader's: the footer already says Ottawa. hourCycle
  // rather than hour12: false, which resolves to h24 in some locales and
  // prints midnight as 24:07.
  const inOttawa = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  function tick() {
    const now = new Date();
    const parts = Object.fromEntries(
      inOttawa.formatToParts(now).map(({ type, value }) => [type, value])
    );
    hours.textContent = parts.hour;
    minutes.textContent = parts.minute;
    clockTime.dateTime = `${parts.hour}:${parts.minute}`;
    clock.hidden = false;
    // The boot log's clock line tells the truth only if it resolves
    // here, once the footer is actually telling this time. Later ticks
    // resolve an already-settled promise, which is a no-op.
    resolveClock?.({ value: `ottawa ${parts.hour}:${parts.minute}` });

    // Land on the minute rather than drifting a second past it, which a fixed
    // 60s interval would do a little more of every hour.
    setTimeout(tick, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
  }

  if (clock) tick();
}

setUp();
