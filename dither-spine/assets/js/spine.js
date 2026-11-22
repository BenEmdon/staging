// EXPERIMENT (reimagined 2026-11-22): reactive dither spine.
// Fixed grid, discrete steps only. Scroll decides past/current/future.
// Pointer position and speed decide a halo of extra lit cells near the
// pointer's height. No cell moves; classes snap on/off on 75ms ticks.
const COLS = 5, ROWS = 4, TICK = 75, STRIP = 48;
const BAYER = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

function makeCells(parent, n) {
  const out = [];
  for (let i = 0; i < n; i++) { const s = document.createElement("span"); s.className = "spine-cell"; parent.append(s); out.push(s); }
  return out;
}

function init() {
  const rail = document.querySelector("[data-spine-rail]");
  const stripEl = document.querySelector("[data-spine-strip]");
  const sections = [...document.querySelectorAll(".section")];
  if (!sections.length) return;
  const segs = [];
  if (rail) {
    for (const btn of rail.querySelectorAll("[data-spine-seg]")) {
      const grid = btn.querySelector("[data-spine-cells]");
      const sec = sections.find(s => s.querySelector("[id]")?.id === btn.dataset.target);
      if (sec) segs.push({ btn, cells: makeCells(grid, COLS * ROWS), sec });
      btn.addEventListener("click", () => {
        const t = document.getElementById(btn.dataset.target);
        if (t) { history.pushState(null, "", "#" + btn.dataset.target); t.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" }); }
      });
    }
  }
  // Day block: Ottawa day fraction in Bayer order, 16 cells.
  const dayGrid = rail?.querySelector("[data-spine-day-cells]");
  if (dayGrid) {
    const cells = makeCells(dayGrid, 16);
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Toronto" }));
    const frac = (now.getHours() * 60 + now.getMinutes()) / 1440;
    const lit = Math.round(frac * 16);
    cells.forEach((c, i) => { if (BAYER[i] < lit) c.classList.add("is-on"); });
    const lbl = rail.querySelector("[data-spine-day-label]");
    if (lbl) lbl.textContent = Math.round(frac * 100) + "% day";
  }
  // Strip cells
  let stripCells = [];
  if (stripEl) { for (let i = 0; i < STRIP; i++) { const s = document.createElement("span"); s.className = "spine-strip__cell"; stripEl.append(s); stripCells.push(s); } }

  let current = -1, timer = 0, halo = -1, haloWide = false;
  function paint(seg, state, rows = ROWS, haloOn = false) {
    seg.cells.forEach((c, i) => {
      c.classList.remove("is-on", "is-dither", "is-halo");
      if (state === "past" && BAYER[i % 16] < 8) c.classList.add("is-dither");
      if (state === "future" && haloOn && BAYER[i % 16] < 12) c.classList.add("is-halo");
      if (state === "past" && haloOn && BAYER[i % 16] >= 8 && BAYER[i % 16] < 12) c.classList.add("is-halo");
      if (state === "current" && Math.floor(i / COLS) < rows) c.classList.add("is-on");
    });
    if (state === "current") seg.btn.setAttribute("aria-current", "true"); else seg.btn.removeAttribute("aria-current");
  }
  function render() { segs.forEach((s, i) => paint(s, i < current ? "past" : i > current ? "future" : "current", ROWS, i === halo || (haloWide && Math.abs(i - halo) === 1))); }
  function setCurrent(n) {
    if (n === current || n < 0) return; current = n; clearInterval(timer);
    segs.forEach((s, i) => { if (i !== n) paint(s, i < n ? "past" : "future", ROWS, i === halo); });
    const seg = segs[n]; if (!seg) return;
    if (reduced.matches) { paint(seg, "current"); return; }
    let rows = 0; paint(seg, "current", rows);
    timer = setInterval(() => { rows++; paint(seg, "current", rows); if (rows >= ROWS) clearInterval(timer); }, TICK);
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { const idx = sections.indexOf(e.target); if (idx >= 0) setCurrent(segs.findIndex(s => s.sec === e.target) >= 0 ? segs.findIndex(s => s.sec === e.target) : idx); }
  }, { rootMargin: "-50% 0px -50% 0px" });
  sections.forEach(s => io.observe(s));
  setCurrent(0);

  // Pointer halo: quantise pointer Y to the nearest segment, speed widens it.
  let lastY = null, lastT = 0;
  window.addEventListener("pointermove", (e) => {
    if (reduced.matches || e.pointerType === "touch" || !segs.length) return;
    const now = performance.now(); let speed = 0;
    if (lastY !== null && lastT) speed = Math.abs(e.clientY - lastY) / Math.max(now - lastT, 1);
    lastY = e.clientY; lastT = now;
    let best = 0, bd = Infinity;
    segs.forEach((s, i) => { const r = s.btn.getBoundingClientRect(); const d = Math.abs(e.clientY - (r.top + r.height / 2)); if (d < bd) { bd = d; best = i; } });
    const nh = bd < 260 ? best : -1; const nw = speed > 0.8;
    if (nh !== halo || nw !== haloWide) { halo = nh; haloWide = nw; render(); }
  }, { passive: true });
  window.addEventListener("pointerleave", () => { halo = -1; render(); });

  function paintStrip() {
    const max = document.documentElement.scrollHeight - innerHeight;
    const frac = max > 0 ? Math.min(1, scrollY / max) : 0;
    const lit = Math.round(frac * STRIP);
    stripCells.forEach((c, i) => { c.classList.toggle("is-on", i < lit); c.classList.toggle("is-dither", i === lit); });
  }
  window.addEventListener("scroll", paintStrip, { passive: true }); paintStrip();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
