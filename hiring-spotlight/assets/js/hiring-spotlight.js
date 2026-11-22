/*
  Experiment: hiring spotlight.

  A strip of three small pixel scenes inside the hiring block: the
  meadow tower, the canal locks, a skyline. They sit dim and quiet at
  rest. As the block nears the page's focus line on scroll, or the
  pointer comes near it, or it takes keyboard focus, the scenes light
  in stepped stages: shade bands step in, details arrive, lamps and
  windows switch on. While they are lit, the rest of the page steps
  back: body-level colour tokens swap to muted values in two discrete
  steps, and the block re-declares its own full-strength values, so
  the eye lands on the posting. Leaving the zone steps everything
  back down.

  The pixel rule holds: every scene is a fixed grid of cells, cells
  only ever swap whole palette shades in place on the site's 75ms
  step, and the page step-back is a class swap, never a transition
  or a fade. Reduced motion gets the end state in one cut, scenes
  and step-back alike.
*/
(() => {
  const block = document.querySelector("[data-hiring]");
  const strip = document.querySelector("[data-spotlight]");
  if (!block || !strip) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

  const W = 52;
  const H = 26;

  /* ---------- palette slots ---------- */

  const SKY0 = 0, SKY1 = 1, SKY2 = 2, CLOUD = 3, CSHADE = 4, HAZE = 5;
  const STONE0 = 6, STONE1 = 7, STONE2 = 8;
  const GRASS0 = 9, GRASS1 = 10, GRASS2 = 11, GRASS3 = 12;
  const CANOPY = 13, CANOPYD = 14, WOOD = 15;
  const WATER0 = 16, WATER1 = 17, WATER2 = 18;
  const LAMP = 19, EMBER = 20, WINA = 21, WINB = 22;
  const STAR = 23, FLOWER = 24, WINDARK = 25;
  const SLOTS = 26;

  // How far each stage mixes a slot's full colour toward the theme's
  // haze anchor. Stage 2 is the scene at full strength; stage 3 keeps
  // full strength and switches the lights on (the specials below).
  const MIX = [0.66, 0.45, 0, 0];
  const MUTE = { light: [147, 165, 189], dark: [16, 26, 44] };

  // Slots whose stage colours are not a plain mix: lamps stay dark
  // until the last stage, windows warm up in two steps, stars and
  // flowers hide inside their ground until the scene is properly lit.
  // A null entry falls through to the mix.
  const SPECIALS = {
    [LAMP]: {
      light: ["#212b3d", "#212b3d", "#212b3d", "#e07b12"],
      dark: ["#0a0f18", "#0a0f18", "#0a0f18", "#ff9e2c"],
    },
    [EMBER]: {
      light: [null, null, null, "#b45f06"],
      dark: [null, null, null, "#8a4a16"],
    },
    [WINA]: {
      light: ["#121826", "#121826", "#d9a441", "#f2cf6b"],
      dark: ["#02040a", "#02040a", "#b97f26", "#ffd08a"],
    },
    [WINB]: {
      light: ["#121826", "#121826", "#121826", "#e8b84b"],
      dark: ["#02040a", "#02040a", "#02040a", "#ffb84d"],
    },
    [STAR]: {
      light: [null, null, "#dfeef6", "#dfeef6"],
      dark: [null, null, "#7f97bd", "#cfe0f7"],
    },
    [FLOWER]: {
      light: ["#5da24e", "#5da24e", null, null],
      dark: ["#2c5741", "#2c5741", null, null],
    },
  };

  // The full-strength slot colours live in components.css as --spot-*
  // custom properties (light-dark pairs, so the theme machinery owns
  // them). A canvas cannot paint with an unresolved light-dark() pair,
  // so the colours are read off a hidden probe's computed background,
  // the route the wake experiment proved.
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;inline-size:0;block-size:0;overflow:hidden;visibility:hidden;pointer-events:none";
  const probeCells = [];
  for (let i = 0; i < SLOTS; i += 1) {
    const cell = document.createElement("span");
    cell.style.background = `var(--spot-${i})`;
    probe.append(cell);
    probeCells.push(cell);
  }
  strip.append(probe);

  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return systemDark.matches;
  };

  function readFull() {
    return probeCells.map((cell) => {
      const rgb = getComputedStyle(cell).backgroundColor.match(/\d+/g);
      return rgb ? rgb.slice(0, 3).map(Number) : [0, 0, 0];
    });
  }

  // One resolved palette per stage, rebuilt when the theme moves.
  let stagePalettes = [];
  function buildPalettes() {
    const full = readFull();
    const dark = isDark();
    const mute = dark ? MUTE.dark : MUTE.light;
    stagePalettes = [0, 1, 2, 3].map((stage) => {
      const t = MIX[stage];
      return full.map((colour, slot) => {
        const special = SPECIALS[slot];
        if (special) {
          const pinned = special[dark ? "dark" : "light"][stage];
          if (pinned) return pinned;
        }
        const [r, g, b] = colour.map((c, i) =>
          Math.round(c + (mute[i] - c) * t)
        );
        return `rgb(${r}, ${g}, ${b})`;
      });
    });
  }

  /* ---------- the scenes as data ---------- */

  // Mulberry32, one seed per scene: the strip a visitor gets is the
  // strip that was critiqued, not a fresh roll per load.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function builder(seed) {
    const grid = new Uint8Array(W * H);
    const rnd = mulberry32(seed);
    const set = (x, y, s) => {
      if (x >= 0 && x < W && y >= 0 && y < H) grid[y * W + x] = s;
    };
    const rect = (x, y, w, h, s) => {
      for (let j = y; j < y + h; j += 1)
        for (let i = x; i < x + w; i += 1) set(i, j, s);
    };
    return { grid, rnd, set, rect };
  }

  // The meadow tower, shrunk to a keepsake of the home scene: hazed
  // ridge, the tower with its lamp, the copse at the field's edge.
  function buildTower() {
    const { grid, rnd, set, rect } = builder(1103);
    rect(0, 0, W, 5, SKY0);
    rect(0, 5, W, 5, SKY1);
    rect(0, 10, W, 6, SKY2);
    rect(33, 3, 9, 1, CLOUD);
    rect(34, 4, 7, 1, CSHADE);
    for (let x = 0; x < W; x += 1) {
      const top = x < 16 ? 14 : x < 32 ? 13 : 14;
      for (let y = top; y <= 16; y += 1) set(x, y, HAZE);
    }
    rect(7, 13, 7, 4, STONE1); // tower base
    rect(9, 5, 3, 8, STONE0); // shaft
    rect(9, 6, 3, 1, STONE2); // band rows
    rect(9, 11, 3, 1, STONE2);
    set(9, 8, EMBER);
    set(10, 8, LAMP);
    set(11, 8, EMBER);
    rect(8, 3, 5, 2, STONE0); // crown
    set(8, 4, STONE2);
    set(12, 4, STONE2);
    set(10, 1, STONE0); // antenna
    set(10, 2, STONE0);
    rect(0, 17, W, 2, GRASS2);
    rect(0, 19, W, 4, GRASS1);
    rect(0, 23, W, 3, GRASS0);
    for (let i = 0; i < 70; i += 1)
      set((rnd() * W) | 0, 17 + ((rnd() * 6) | 0), GRASS3);
    for (let i = 0; i < 40; i += 1)
      set((rnd() * W) | 0, 20 + ((rnd() * 6) | 0), GRASS0);
    for (let i = 0; i < 10; i += 1)
      set((rnd() * W) | 0, 18 + ((rnd() * 6) | 0), FLOWER);
    rect(45, 14, 2, 7, WOOD); // the copse: trunk, root flare, canopy
    set(44, 20, WOOD);
    set(47, 20, WOOD);
    rect(43, 8, 6, 2, CANOPYD);
    rect(41, 10, 10, 3, CANOPY);
    rect(42, 13, 8, 1, CANOPY);
    rect(43, 14, 6, 1, CANOPYD);
    return grid;
  }

  // The Rideau locks: stone banks, two gate pairs meeting in shallow
  // chevrons, a boat waiting in the upper pool, lamps on the banks.
  function buildLocks() {
    const { grid, rnd, set, rect } = builder(2309);
    rect(0, 0, W, 3, SKY0);
    rect(0, 3, W, 3, SKY1);
    rect(0, 8, W, 1, CANOPYD); // treeline
    for (let x = 0; x < W; x += 1) {
      const h = 1 + ((rnd() * 3) | 0);
      for (let y = 8 - h; y < 8; y += 1)
        set(x, y, rnd() < 0.3 ? CANOPY : CANOPYD);
    }
    rect(9, 10, 34, 4, WATER0); // the channel, banded by depth
    rect(9, 14, 34, 6, WATER1);
    rect(9, 20, 34, 6, WATER2);
    for (let i = 0; i < 26; i += 1)
      set(10 + ((rnd() * 32) | 0), 15 + ((rnd() * 10) | 0), WATER0);
    rect(0, 9, 9, 17, STONE1); // banks
    rect(43, 9, 9, 17, STONE1);
    rect(0, 9, 9, 1, STONE2);
    rect(43, 9, 9, 1, STONE2);
    for (let i = 0; i < 22; i += 1) {
      set((rnd() * 9) | 0, 11 + ((rnd() * 14) | 0), STONE0);
      set(43 + ((rnd() * 9) | 0), 11 + ((rnd() * 14) | 0), STONE0);
    }
    rect(23, 8, 7, 1, WOOD); // the boat: hull and cabin
    rect(22, 9, 9, 1, STONE0);
    rect(25, 6, 3, 2, STONE2);
    set(26, 6, WINDARK);
    const gate = (y0) => {
      for (let i = 0; i <= 15; i += 1) {
        const dy = Math.round((i * 3) / 15);
        set(10 + i, y0 + dy, WOOD);
        set(10 + i, y0 + dy + 1, WOOD);
        set(41 - i, y0 + dy, WOOD);
        set(41 - i, y0 + dy + 1, WOOD);
      }
    };
    gate(11);
    gate(19);
    rect(9, 10, 1, 6, STONE0); // gate posts
    rect(42, 10, 1, 6, STONE0);
    rect(9, 18, 1, 6, STONE0);
    rect(42, 18, 1, 6, STONE0);
    set(4, 6, LAMP); // bank lamps
    rect(4, 7, 1, 3, STONE0);
    set(47, 6, LAMP);
    rect(47, 7, 1, 3, STONE0);
    return grid;
  }

  // A small skyline: six towers of varied heights, a stepped crown,
  // an antenna whose tip joins the lamps at full light, and a window
  // grid that warms up in two waves.
  function buildSkyline() {
    const { grid, rnd, set, rect } = builder(3701);
    rect(0, 0, W, 7, SKY0);
    rect(0, 7, W, 6, SKY1);
    rect(0, 13, W, 7, SKY2);
    for (let i = 0; i < 16; i += 1)
      set((rnd() * W) | 0, 1 + ((rnd() * 9) | 0), STAR);
    rect(44, 2, 4, 1, CLOUD); // the moon
    rect(43, 3, 5, 2, CLOUD);
    set(47, 3, CSHADE);
    set(47, 4, CSHADE);
    const blocks = [
      [0, 9, 10, STONE0],
      [9, 7, 14, STONE1],
      [16, 10, 7, STONE0],
      [26, 6, 12, STONE1],
      [32, 9, 9, STONE0],
      [41, 11, 13, STONE1],
    ];
    for (const [x, w, top, s] of blocks) rect(x, top, w, 24 - top, s);
    rect(19, 5, 4, 2, STONE0); // stepped crown
    set(20, 4, STONE0);
    set(21, 3, STONE0); // antenna, its tip an ember until stage 3
    set(21, 2, STONE0);
    set(21, 1, EMBER);
    for (const [x, w, top] of blocks) {
      for (let wx = x + 1; wx < x + w - 1; wx += 2) {
        for (let wy = top + 2; wy < 23; wy += 3) {
          const r = rnd();
          set(wx, wy, r < 0.3 ? WINA : r < 0.55 ? WINB : WINDARK);
        }
      }
    }
    rect(0, 24, W, 2, STONE0); // the street
    return grid;
  }

  const scenes = [
    { name: "tower", grid: buildTower() },
    { name: "locks", grid: buildLocks() },
    { name: "skyline", grid: buildSkyline() },
  ];
  for (const scene of scenes) {
    scene.canvas = strip.querySelector(
      `[data-spot-scene="${scene.name}"]`
    );
    scene.ctx = scene.canvas ? scene.canvas.getContext("2d") : null;
  }

  function paint(stage) {
    const palette = stagePalettes[stage];
    if (!palette) return;
    for (const scene of scenes) {
      if (!scene.ctx) continue;
      const { ctx, grid } = scene;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          ctx.fillStyle = palette[grid[y * W + x]];
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }

  /* ---------- the stage engine ---------- */

  // The rest of the page steps back on tokens, in classes on body.
  // Level 1 at stage 2, level 2 at stage 3; the block itself
  // re-declares full strength in components.css.
  function applyDim(stage) {
    const level = stage >= 3 ? 2 : stage === 2 ? 1 : 0;
    document.body.classList.toggle("spotlight-1", level === 1);
    document.body.classList.toggle("spotlight-2", level === 2);
  }

  let stage = 0;
  let target = 0;
  let timer = 0;

  function step() {
    if (stage === target) {
      clearInterval(timer);
      timer = 0;
      return;
    }
    stage += Math.sign(target - stage);
    paint(stage);
    applyDim(stage);
    if (stage === target) {
      clearInterval(timer);
      timer = 0;
    }
  }

  function setTarget(next) {
    target = Math.max(0, Math.min(3, next));
    if (reduced.matches) {
      stage = target;
      paint(stage);
      applyDim(stage);
      return;
    }
    if (stage === target) return;
    if (!timer) {
      step();
      if (stage !== target) timer = setInterval(step, 75);
    }
  }

  /* ---------- triggers ---------- */

  // Three holds, one per signal; the target is the strongest hold, so
  // the triggers never fight and nothing drains while any holds.
  let scrollStage = 0;
  let pointerStage = 0;
  let focusStage = 0;
  const retarget = () =>
    setTarget(Math.max(scrollStage, pointerStage, focusStage));

  // Scroll: three bands around the focus line the section highlight
  // uses. The line itself is the strongest hold; a wider band above
  // it is the middle one; plain visibility is the weakest.
  const bands = { line: false, near: false, visible: false };
  const weighScroll = () => {
    scrollStage = bands.line ? 3 : bands.near ? 2 : bands.visible ? 1 : 0;
    retarget();
  };
  const observeBand = (key, rootMargin) => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) bands[key] = entry.isIntersecting;
        weighScroll();
      },
      { rootMargin }
    );
    io.observe(block);
  };
  observeBand("visible", "0px");
  observeBand("near", "-20% 0px -55% 0px");
  observeBand("line", "-33.333% 0px -66.667% 0px");

  // Pointer: within about 96px of the block the scenes wake; right
  // at the block they reach full light. Touch is left to the scroll
  // trigger, as with the reveal experiment.
  window.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const r = block.getBoundingClientRect();
    const dx =
      event.clientX < r.left
        ? r.left - event.clientX
        : event.clientX > r.right
          ? event.clientX - r.right
          : 0;
    const dy =
      event.clientY < r.top
        ? r.top - event.clientY
        : event.clientY > r.bottom
          ? event.clientY - r.bottom
          : 0;
    const d = Math.hypot(dx, dy);
    const next = d <= 96 ? (d <= 24 ? 3 : 2) : 0;
    if (next !== pointerStage) {
      pointerStage = next;
      retarget();
    }
  });
  document.documentElement.addEventListener("pointerleave", () => {
    if (pointerStage !== 0) {
      pointerStage = 0;
      retarget();
    }
  });

  // Keyboard focus on the block holds full light while it lasts.
  block.addEventListener("focusin", () => {
    focusStage = 3;
    retarget();
  });
  block.addEventListener("focusout", () => {
    focusStage = 0;
    retarget();
  });

  /* ---------- theme ---------- */

  buildPalettes();
  paint(0);
  new MutationObserver(() => {
    buildPalettes();
    paint(stage);
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  systemDark.addEventListener("change", () => {
    buildPalettes();
    paint(stage);
  });
})();
