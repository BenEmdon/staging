/* Dialga/Palkia comparison page logic.
   Original parts: rendered from the source MIDI note data with a
   plain neutral synth (triangle wave / simple drum hits), labelled
   as such. Our parts: rendered by the real maker renderer
   (window.__liveNotes from music.js) with all other channels muted.
   Nothing autoplays; every render happens on tap and is cached. */
(function () {
  "use strict";
  var DATA = window.COMPARE_DATA;
  var SPB = 60 / DATA.tempo / 4; // seconds per 16th step
  var OUR_CHANS = { B: ["B"], E: ["E"], F: ["F"], EF: ["E", "F"], A: ["A"], C: ["C"], D: ["D"] };
  var cache = new Map();
  var actx = null, current = null, currentBtn = null;
  var liveReady = false;

  function $(sel, el) { return (el || document).querySelector(sel); }
  function freq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  // ---------- playback plumbing ----------
  function ensureCtx() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function stopAll() {
    if (current) { try { current.stop(); } catch (e) {} current = null; }
    if (currentBtn) { currentBtn.classList.remove("playing"); currentBtn = null; }
  }
  function playBuffer(buf, btn) {
    var ctx = ensureCtx();
    stopAll();
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = function () { if (current === src) { current = null; if (currentBtn) currentBtn.classList.remove("playing"); currentBtn = null; } };
    current = src; currentBtn = btn || null;
    if (btn) btn.classList.add("playing");
    src.start();
    var peak = 0, d0 = buf.getChannelData(0);
    for (var i = 0; i < d0.length; i += 7) { var a = Math.abs(d0[i]); if (a > peak) peak = a; }
    window.__compareLast = { peak: peak, dur: buf.duration };
    return peak;
  }

  // ---------- original: neutral synth ----------
  var noiseBuf = null;
  function getNoise(off) {
    if (noiseBuf && noiseBuf.sampleRate === off.sampleRate) return noiseBuf;
    var len = Math.floor(off.sampleRate * 0.5);
    noiseBuf = off.createBuffer(1, len, off.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  function drumHit(off, dest, t0, midi, vol) {
    if (midi === 36) { // kick
      var o = off.createOscillator(), g = off.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(120, t0);
      o.frequency.exponentialRampToValueAtTime(42, t0 + 0.1);
      g.gain.setValueAtTime(0.5 * vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
      o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + 0.16);
    } else { // snare / hat: filtered noise
      var src = off.createBufferSource(); src.buffer = getNoise(off);
      var f = off.createBiquadFilter(), g2 = off.createGain();
      var dur = midi === 42 ? 0.045 : 0.1;
      f.type = midi === 42 ? "highpass" : "bandpass";
      f.frequency.value = midi === 42 ? 6500 : 1800;
      g2.gain.setValueAtTime((midi === 42 ? 0.22 : 0.34) * vol, t0);
      g2.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.connect(f); f.connect(g2); g2.connect(dest);
      src.start(t0); src.stop(t0 + dur + 0.02);
    }
  }
  function scheduleNote(off, dest, n, kind, gain) {
    var t0 = n[0] * SPB, d = Math.max(0.04, n[1] * SPB), midi = n[2], vel = (n[3] || 100) / 127;
    if (kind === "drums") { drumHit(off, dest, t0, midi, vel * gain); return; }
    if (kind === "timpani") {
      var o = off.createOscillator(), g = off.createGain();
      o.type = "sine"; o.frequency.value = freq(midi);
      var dd = Math.min(d, 0.9);
      g.gain.setValueAtTime(0.4 * vel * gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dd);
      o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + dd + 0.02);
      return;
    }
    var osc = off.createOscillator(), flt = off.createBiquadFilter(), gn = off.createGain();
    osc.type = "triangle"; osc.frequency.value = freq(midi);
    flt.type = "lowpass"; flt.frequency.value = 3200;
    var peak = 0.15 * vel * gain;
    var a = Math.min(0.012, d / 3), rel = Math.min(0.05, d / 3);
    gn.gain.setValueAtTime(0, t0);
    gn.gain.linearRampToValueAtTime(peak, t0 + a);
    gn.gain.setValueAtTime(peak, Math.max(t0 + a, t0 + d - rel));
    gn.gain.linearRampToValueAtTime(0, t0 + d + 0.02);
    osc.connect(flt); flt.connect(gn); gn.connect(dest);
    osc.start(t0); osc.stop(t0 + d + 0.05);
  }
  function renderOriginal(parts) { // parts: [{notes, kind, gain}]
    var dur = DATA.steps * SPB + 1.5;
    var off = new OfflineAudioContext(2, Math.ceil(dur * 44100), 44100);
    var master = off.createGain(); master.gain.value = 0.9; master.connect(off.destination);
    parts.forEach(function (p) { p.notes.forEach(function (n) { scheduleNote(off, master, n, p.kind, p.gain); }); });
    return off.startRendering();
  }

  // ---------- ours: the real maker renderer ----------
  function waitLive() {
    if (liveReady) return Promise.resolve();
    return new Promise(function (res, rej) {
      var n = 0;
      var iv = setInterval(function () {
        if (window.__liveNotes) { liveReady = true; clearInterval(iv); res(); }
        else if (++n > 240) { clearInterval(iv); rej(new Error("maker renderer did not load")); }
      }, 250);
    });
  }
  async function renderOurs(chans) { // chans: array of letters, or null = full mix
    var key = "our:" + (chans ? chans.join("+") : "FULL");
    if (cache.has(key)) return cache.get(key);
    await waitLive();
    var p = window.__liveNotes.parseSong(DATA.songText + "\n");
    var song = JSON.parse(JSON.stringify(p));
    if (chans) song.channels.forEach(function (c) { if (chans.indexOf(c.letter) < 0) c.notes = []; });
    var r = await window.__liveNotes.renderSongBest(song, true);
    cache.set(key, r.buffer);
    return r.buffer;
  }
  async function renderOrigRow(row, solo) {
    var key = "orig:" + row.id + (solo ? ":solo" : "");
    if (cache.has(key)) return cache.get(key);
    var gain = solo ? 1.0 : row.fullGain;
    var buf = await renderOriginal([{ notes: row.orig, kind: row.kind, gain: gain }]);
    cache.set(key, buf);
    return buf;
  }
  async function renderOrigFull() {
    if (cache.has("orig:FULL")) return cache.get("orig:FULL");
    var parts = DATA.rows.filter(function (r) { return r.fullGain > 0; })
      .map(function (r) { return { notes: r.orig, kind: r.kind, gain: r.fullGain }; });
    var buf = await renderOriginal(parts);
    cache.set("orig:FULL", buf);
    return buf;
  }

  // ---------- note lanes ----------
  var COLORS = { match: "#4a86c8", dur: "#8a6fc8", missing: "#c8504a", extra: "#c89240", dropped: "rgba(200,80,74,0.72)", shifted: "#c89240", octave: "#8a6fc8" };
  function drawRow(row, canvas) {
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth, H = 96;
    if (!W) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    var gut = 30, x0 = gut, x1 = W - 2;
    var all = row.orig.concat(row.our);
    if (!all.length) return;
    var lo = Math.min.apply(null, all.map(function (n) { return n[2]; })) - 1;
    var hi = Math.max.apply(null, all.map(function (n) { return n[2]; })) + 1;
    function X(step) { return x0 + (step / DATA.steps) * (x1 - x0); }
    function lane(notes, top, statusIdx, isOrig) {
      var lh = 36;
      ctx.strokeStyle = "rgba(140,140,140,0.35)"; ctx.lineWidth = 1;
      ctx.strokeRect(x0, top, x1 - x0, lh);
      ctx.strokeStyle = "rgba(140,140,140,0.18)";
      for (var s = 64; s < DATA.steps; s += 64) { ctx.beginPath(); ctx.moveTo(X(s), top); ctx.lineTo(X(s), top + lh); ctx.stroke(); }
      notes.forEach(function (n) {
        var st = n[statusIdx];
        ctx.fillStyle = COLORS[st] || "#4a86c8";
        var y = top + lh - ((n[2] - lo) / (hi - lo)) * lh;
        var w = Math.max(1.4, (n[1] / DATA.steps) * (x1 - x0));
        ctx.fillRect(X(n[0]), y - 1.6, w, 3.2);
      });
      ctx.fillStyle = "rgba(140,140,140,0.9)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(isOrig ? "orig" : "ours", 2, top + lh / 2 + 3);
    }
    lane(row.orig, 4, 4, true);
    lane(row.our, 52, 3, false);
  }

  // ---------- build the rows ----------
  function countsLine(row) {
    var o = row.countsOrig, u = row.countsOur;
    var parts = [];
    var on = row.orig.length, un = row.our.length;
    parts.push("original " + on + " notes");
    parts.push(un ? "ours " + un + " notes" : "ours: no channel");
    if (o.match) parts.push(o.match + " identical");
    if (o.dur) parts.push(o.dur + " same note, different length");
    if (o.missing) parts.push(o.missing + " with no separate note in ours");
    if (u.extra) parts.push(u.extra + " extra in ours");
    if (o.dropped) parts.push("all of it absent from our version");
    return parts.join(" · ");
  }
  function setStatus(txt) { var el = $("#cmp-status"); if (el) el.textContent = txt; }

  async function handlePlay(btn, maker) {
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = "rendering…";
    setStatus("Rendering " + old.replace(/^▶ /, "") + " (first render can take a while; it is cached after that).");
    try {
      var buf = await maker();
      btn.textContent = old; btn.disabled = false;
      playBuffer(buf, btn);
      setStatus("Playing. Stop button is above the rows.");
    } catch (err) {
      btn.textContent = old; btn.disabled = false;
      setStatus("Render failed: " + (err && err.message ? err.message : err));
    }
  }

  function build() {
    var host = $("#cmp-rows");
    DATA.rows.forEach(function (row) {
      var sec = document.createElement("section");
      sec.className = "cmp-row"; sec.id = "row-" + row.id;
      var h = document.createElement("h3");
      h.textContent = row.title;
      if (row.open) { var tag = document.createElement("span"); tag.className = "cmp-tag"; tag.textContent = "open question"; h.appendChild(tag); }
      sec.appendChild(h);
      var names = document.createElement("p"); names.className = "cmp-names";
      names.innerHTML = "";
      var b1 = document.createElement("b"); b1.textContent = "Original: "; names.appendChild(b1);
      names.appendChild(document.createTextNode(row.origName.replace(/^Original: /, "") + "  ·  "));
      var b2 = document.createElement("b"); b2.textContent = "Ours: "; names.appendChild(b2);
      names.appendChild(document.createTextNode(row.ourName.replace(/^Ours: /, "")));
      sec.appendChild(names);
      var cv = document.createElement("canvas"); cv.className = "cmp-canvas"; sec.appendChild(cv);
      var counts = document.createElement("p"); counts.className = "cmp-counts"; counts.textContent = countsLine(row); sec.appendChild(counts);
      var blurb = document.createElement("p"); blurb.className = "cmp-blurb"; blurb.textContent = row.blurb; sec.appendChild(blurb);
      var btns = document.createElement("div"); btns.className = "cmp-btns";
      var bOrig = document.createElement("button"); bOrig.type = "button"; bOrig.textContent = "▶ original part (plain synth)";
      bOrig.addEventListener("click", function () { handlePlay(bOrig, function () { return renderOrigRow(row, true); }); });
      btns.appendChild(bOrig);
      if (row.our.length) {
        var bOur = document.createElement("button"); bOur.type = "button"; bOur.textContent = "▶ our channel (real maker sound)";
        bOur.className = "cmp-our-btn";
        bOur.addEventListener("click", function () { handlePlay(bOur, function () { return renderOurs(OUR_CHANS[row.id]); }); });
        btns.appendChild(bOur);
      }
      sec.appendChild(btns);
      host.appendChild(sec);
      row._canvas = cv;
    });
    // A/B buttons
    var abOur = $("#cmp-ab-our"), abOrig = $("#cmp-ab-orig");
    abOur.addEventListener("click", function () { handlePlay(abOur, function () { return renderOurs(null); }); });
    abOrig.addEventListener("click", function () { handlePlay(abOrig, function () { return renderOrigFull(); }); });
    var stop = $("#cmp-stop");
    stop.addEventListener("click", function () { stopAll(); setStatus("Stopped."); });
    var drawAll = function () { DATA.rows.forEach(function (r) { drawRow(r, r._canvas); }); };
    drawAll();
    setTimeout(drawAll, 1600); // once the boot cover has settled and layout is final
    var rto = null;
    window.addEventListener("resize", function () { clearTimeout(rto); rto = setTimeout(drawAll, 200); });
    waitLive().then(function () { setStatus("Maker renderer ready. Nothing plays until you tap a play button."); })
      .catch(function () { setStatus("The maker renderer did not load; the original-side buttons still work."); });
    // test hook: same code path as the buttons
    window.__comparePlay = async function (kind, id) {
      stopAll();
      var buf;
      if (kind === "ourfull") buf = await renderOurs(null);
      else if (kind === "origfull") buf = await renderOrigFull();
      else {
        var row = DATA.rows.find(function (r) { return r.id === id; });
        buf = kind === "our" ? await renderOurs(OUR_CHANS[id]) : await renderOrigRow(row, true);
      }
      return playBuffer(buf, null);
    };
    window.__compareStop = stopAll;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
