/* The animated chart at the top of the home page.

   A market price line (economics) morphs into a neural network (AI) and back,
   with signal pulses (life) running along it. Points shy away from the pointer,
   and moving or tapping sends new pulses. The animation pauses when it is off
   screen and shows a single still frame when the visitor prefers reduced motion.
   Colors come from the CSS variables --economics, --ai and --life. */
(function () {
  "use strict";

  var canvas = document.querySelector(".hero__canvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var hero = canvas.closest(".hero") || canvas.parentNode;
  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Timeline (ms): the first line draws itself in, then the loop repeats forever.
  var INTRO = 1700;
  var PHASES = [
    { name: "chart", dur: 3000 },
    { name: "toNet", dur: 2300 },
    { name: "net", dur: 3600 },
    { name: "toChart", dur: 2300 }
  ];
  var CYCLE = PHASES.reduce(function (sum, p) { return sum + p.dur; }, 0);
  var MAX_PULSES = 70;

  var W = 0, H = 0, dpr = 1;
  var padX = 0, bandTop = 0, bandH = 0;
  var nodes = [];          // {x, y, cx, cy, nx, ny, seed}
  var layers = [];         // node indexes per network layer, left to right
  var layerOf = [];        // layer index of each node
  var edges = [];          // [a, b] pairs between neighbouring layers
  var pulses = [];         // {a, b, t, v, hops}
  var colors = {};
  var pointer = { x: 0, y: 0, active: false, lastSpawn: 0 };
  var elapsed = 0, last = 0, rafId = 0;
  var morph = 0, phaseKey = "", nextAutoPulse = 0;
  var onScreen = true;

  /* ---------- helpers ---------- */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function parseColor(value, fallback) {
    ctx.fillStyle = fallback;
    if (value) ctx.fillStyle = value;
    var c = ctx.fillStyle;
    if (c.charAt(0) === "#") {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    var parts = c.match(/[\d.]+/g) || [0, 0, 0];
    return [+parts[0], +parts[1], +parts[2]];
  }

  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + clamp(a, 0, 1).toFixed(3) + ")";
  }

  function mixColor(c1, c2, t) {
    return [
      Math.round(lerp(c1[0], c2[0], t)),
      Math.round(lerp(c1[1], c2[1], t)),
      Math.round(lerp(c1[2], c2[2], t))
    ];
  }

  function readColors() {
    var s = getComputedStyle(root);
    colors = {
      economics: parseColor(s.getPropertyValue("--economics").trim(), "#0c7b60"),
      ai: parseColor(s.getPropertyValue("--ai").trim(), "#4b3fa8"),
      life: parseColor(s.getPropertyValue("--life").trim(), "#a4461f"),
      muted: parseColor(s.getPropertyValue("--muted").trim(), "#6b645b"),
      rule: parseColor(s.getPropertyValue("--rule-strong").trim(), "#cfc5b5"),
      bg: parseColor(s.getPropertyValue("--bg").trim(), "#faf7f2")
    };
  }

  /* ---------- building the scene ---------- */

  // A random walk that tends to drift upward, scaled to 0..1.
  function randomWalk(n) {
    var ys = [], v = 0, y = 0;
    var drift = 0.05 + Math.random() * 0.08;
    for (var i = 0; i < n; i++) {
      v = v * 0.55 + (Math.random() - 0.5) * 1.1 + drift;
      y += v;
      ys.push(y);
    }
    var min = Math.min.apply(null, ys), max = Math.max.apply(null, ys);
    var span = max - min || 1;
    return ys.map(function (value) { return (value - min) / span; });
  }

  function setChartTargets() {
    var ys = randomWalk(nodes.length);
    var step = (W - 2 * padX) / (nodes.length - 1);
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].cx = padX + i * step;
      nodes[i].cy = bandTop + (1 - ys[i]) * bandH;
    }
  }

  function buildLayers(n) {
    var count = W < 560 ? 4 : W < 960 ? 5 : 6;
    var weights = {
      4: [0.8, 1.2, 1.2, 0.8],
      5: [0.7, 1.1, 1.4, 1.1, 0.7],
      6: [0.6, 1, 1.3, 1.3, 1, 0.6]
    }[count];
    var total = weights.reduce(function (s, w) { return s + w; }, 0);
    var sizes = weights.map(function (w) { return Math.max(2, Math.floor((w / total) * n)); });
    var used = sizes.reduce(function (s, v) { return s + v; }, 0);
    var widestFirst = weights.map(function (w, i) { return i; })
      .sort(function (a, b) { return weights[b] - weights[a]; });
    for (var k = 0; used < n; k++) {
      sizes[widestFirst[k % count]]++;
      used++;
    }
    while (used > n) {
      var biggest = sizes.indexOf(Math.max.apply(null, sizes));
      sizes[biggest]--;
      used--;
    }

    layers = [];
    layerOf = [];
    var index = 0;
    for (var l = 0; l < count; l++) {
      var members = [];
      for (var j = 0; j < sizes[l]; j++) {
        members.push(index);
        layerOf[index] = l;
        index++;
      }
      layers.push(members);
    }

    edges = [];
    for (var a = 0; a < layers.length - 1; a++) {
      for (var p = 0; p < layers[a].length; p++) {
        for (var q = 0; q < layers[a + 1].length; q++) {
          edges.push([layers[a][p], layers[a + 1][q]]);
        }
      }
    }
  }

  // Network positions. Within each layer, the point that sits highest on the
  // chart takes the top slot, so the morph untangles instead of crossing over.
  function setNetTargets() {
    var biggest = Math.max.apply(null, layers.map(function (l) { return l.length; }));
    var gap = Math.min(40, (H * 0.6) / Math.max(1, biggest - 1));
    var centerY = bandTop + bandH * 0.5;
    var colStep = (W - 2 * padX) / (layers.length - 1);
    layers.forEach(function (members, l) {
      var sorted = members.slice().sort(function (a, b) { return nodes[a].cy - nodes[b].cy; });
      sorted.forEach(function (id, k) {
        nodes[id].nx = padX + l * colStep;
        nodes[id].ny = centerY + (k - (sorted.length - 1) / 2) * gap;
      });
    });
  }

  function build() {
    padX = clamp(W * 0.06, 20, 90);
    bandTop = H * 0.12;
    bandH = H * 0.56;
    var n = clamp(Math.round(W / 27), 22, 54);
    nodes = [];
    for (var i = 0; i < n; i++) {
      nodes.push({ x: 0, y: 0, cx: 0, cy: 0, nx: 0, ny: 0, seed: Math.random() * Math.PI * 2 });
    }
    buildLayers(n);
    setChartTargets();
    setNetTargets();
    nodes.forEach(function (node) {
      node.x = lerp(node.cx, node.nx, morph);
      node.y = lerp(node.cy, node.ny, morph);
    });
    pulses = [];
  }

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.round(rect.width), h = Math.round(rect.height);
    if (!w || !h) return false;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (w === W && h === H && ratio === dpr) return true;
    W = w;
    H = h;
    dpr = ratio;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    build();
    return true;
  }

  /* ---------- pulses ---------- */

  function spawnPulse(from, hops) {
    if (pulses.length >= MAX_PULSES || from == null) return;
    var to;
    if (morph < 0.5) {
      if (from + 1 >= nodes.length) return;   // reached the end of the line
      to = from + 1;
    } else {
      var l = layerOf[from];
      var next = layers[l + 1] || layers[l - 1];
      to = next[Math.floor(Math.random() * next.length)];
      if (!layers[l + 1]) hops = 0;
    }
    var a = nodes[from], b = nodes[to];
    var dist = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y));
    var speed = morph < 0.5 ? 0.55 : 0.6; // px per ms
    pulses.push({ a: from, b: to, t: 0, v: speed / dist, hops: hops });
  }

  function nearestNode(x, y, maxDist) {
    var best = null, bestD = maxDist * maxDist;
    for (var i = 0; i < nodes.length; i++) {
      var dx = nodes[i].x - x, dy = nodes[i].y - y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function spawnNear(x, y, count) {
    var id = nearestNode(x, y, 110);
    if (id == null) return;
    var hops = morph < 0.5 ? 12 : layers.length - 1 - layerOf[id];
    for (var i = 0; i < count; i++) spawnPulse(id, hops);
  }

  function updatePulses(dt) {
    for (var i = pulses.length - 1; i >= 0; i--) {
      var p = pulses[i];
      p.t += p.v * dt;
      if (p.t >= 1) {
        pulses.splice(i, 1);
        if (p.hops > 0) {
          spawnPulse(p.b, p.hops - 1);
          if (morph >= 0.5 && Math.random() < 0.3) spawnPulse(p.b, p.hops - 1);
        }
      }
    }
  }

  /* ---------- timeline ---------- */

  function advanceTimeline() {
    if (elapsed < INTRO) {
      morph = 0;
      return;
    }
    var t = (elapsed - INTRO) % CYCLE;
    var cycle = Math.floor((elapsed - INTRO) / CYCLE);
    var phase = PHASES[0], start = 0;
    for (var i = 0; i < PHASES.length; i++) {
      if (t < start + PHASES[i].dur) { phase = PHASES[i]; break; }
      start += PHASES[i].dur;
    }
    var p = (t - start) / phase.dur;
    morph = phase.name === "chart" ? 0 : phase.name === "toNet" ? easeInOut(p) :
      phase.name === "net" ? 1 : 1 - easeInOut(p);

    var key = cycle + ":" + phase.name;
    if (key !== phaseKey) {
      phaseKey = key;
      if (phase.name === "chart") spawnPulse(0, nodes.length);        // a price tick runs along the line
      if (phase.name === "toNet") setNetTargets();                    // untangle from the current chart
      if (phase.name === "toChart") setChartTargets();                // a brand-new market every time
      nextAutoPulse = elapsed + 300;
    }
    if (phase.name === "net" && elapsed >= nextAutoPulse) {
      var first = layers[0];
      spawnPulse(first[Math.floor(Math.random() * first.length)], layers.length - 1);
      nextAutoPulse = elapsed + 380;
    }
  }

  /* ---------- physics ---------- */

  function updateNodes(dt, snap) {
    var radius = clamp(W * 0.09, 70, 130);
    var ease = snap ? 1 : 1 - Math.exp(-dt / 90);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var tx = lerp(node.cx, node.nx, morph);
      var ty = lerp(node.cy, node.ny, morph);

      // The chart ripples gently; the network drifts like it's thinking.
      tx += Math.cos(elapsed * 0.0009 + node.seed) * 3 * morph;
      ty += Math.sin(elapsed * 0.0011 + node.seed) * 3 * morph +
        Math.sin(elapsed * 0.002 - i * 0.45) * 1.6 * (1 - morph);

      if (pointer.active && !snap) {
        var dx = tx - pointer.x, dy = ty - pointer.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < radius) {
          var push = (1 - d / radius);
          push = push * push * radius * 0.5;
          tx += (dx / (d || 1)) * push;
          ty += (dy / (d || 1)) * push;
        }
      }

      node.x += (tx - node.x) * ease;
      node.y += (ty - node.y) * ease;
    }
  }

  /* ---------- drawing ---------- */

  function tracePath() {
    ctx.moveTo(nodes[0].x, nodes[0].y);
    for (var i = 1; i < nodes.length - 1; i++) {
      var mx = (nodes[i].x + nodes[i + 1].x) / 2;
      var my = (nodes[i].y + nodes[i + 1].y) / 2;
      ctx.quadraticCurveTo(nodes[i].x, nodes[i].y, mx, my);
    }
    var end = nodes[nodes.length - 1];
    ctx.lineTo(end.x, end.y);
  }

  // Height of the chart line at x (used by the crosshair and the drawing pen).
  function lineYAt(x) {
    for (var i = 0; i < nodes.length - 1; i++) {
      var a = nodes[i], b = nodes[i + 1];
      if (x >= a.x && x <= b.x) {
        return lerp(a.y, b.y, (x - a.x) / ((b.x - a.x) || 1));
      }
    }
    return null;
  }

  function draw(introProgress, keep) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!keep) ctx.clearRect(0, 0, W, H);

    var chartA = 1 - morph;
    var netA = morph;
    var drawnTo = W;

    // Chart paper: faint dashed gridlines that fade out as the network appears.
    if (chartA > 0.02) {
      ctx.save();
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(colors.rule, 0.9 * chartA);
      ctx.beginPath();
      for (var g = 0; g <= 4; g++) {
        var gy = Math.round(bandTop + (bandH * g) / 4) + 0.5;
        ctx.moveTo(padX, gy);
        ctx.lineTo(W - padX, gy);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    if (introProgress < 1) {
      drawnTo = padX + (W - 2 * padX) * easeOut(introProgress);
      ctx.beginPath();
      ctx.rect(0, 0, drawnTo, H);
      ctx.clip();
    }

    // Network connections, brighter near the pointer.
    if (netA > 0.02) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(colors.ai, 0.16 * netA);
      ctx.beginPath();
      for (var e = 0; e < edges.length; e++) {
        var ea = nodes[edges[e][0]], eb = nodes[edges[e][1]];
        ctx.moveTo(ea.x, ea.y);
        ctx.lineTo(eb.x, eb.y);
      }
      ctx.stroke();

      if (pointer.active) {
        var reach = clamp(W * 0.12, 90, 170);
        ctx.lineWidth = 1.4;
        for (var h = 0; h < edges.length; h++) {
          var ha = nodes[edges[h][0]], hb = nodes[edges[h][1]];
          var mx = (ha.x + hb.x) / 2 - pointer.x, my = (ha.y + hb.y) / 2 - pointer.y;
          var md = Math.sqrt(mx * mx + my * my);
          if (md < reach) {
            ctx.strokeStyle = rgba(colors.ai, 0.42 * (1 - md / reach) * netA);
            ctx.beginPath();
            ctx.moveTo(ha.x, ha.y);
            ctx.lineTo(hb.x, hb.y);
            ctx.stroke();
          }
        }
      }
    }

    // The price line, with a soft wash underneath.
    if (chartA > 0.02) {
      var wash = ctx.createLinearGradient(0, bandTop, 0, bandTop + bandH + H * 0.2);
      wash.addColorStop(0, rgba(colors.economics, 0.16 * chartA));
      wash.addColorStop(1, rgba(colors.economics, 0));
      ctx.beginPath();
      tracePath();
      ctx.lineTo(nodes[nodes.length - 1].x, H);
      ctx.lineTo(nodes[0].x, H);
      ctx.closePath();
      ctx.fillStyle = wash;
      ctx.fill();

      ctx.beginPath();
      tracePath();
      ctx.lineWidth = 2.25;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = rgba(colors.economics, chartA);
      ctx.stroke();
    }

    // The points themselves: data points that become neurons.
    var nodeColor = mixColor(colors.economics, colors.ai, morph);
    var baseR = 1.7 + 2.3 * morph;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var r = baseR;
      if (pointer.active) {
        var pd = Math.hypot(node.x - pointer.x, node.y - pointer.y);
        if (pd < 120) r += 2 * (1 - pd / 120);
      }
      if (morph > 0.05) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2);
        ctx.fillStyle = rgba(colors.ai, 0.12 * morph);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(nodeColor, 0.55 + 0.45 * morph);
      ctx.fill();
    }
    ctx.restore();

    // The pen that draws the first line in.
    if (introProgress < 1) {
      var penY = lineYAt(drawnTo);
      if (penY != null) {
        ctx.beginPath();
        ctx.arc(drawnTo, penY, 4, 0, Math.PI * 2);
        ctx.fillStyle = rgba(colors.economics, 1);
        ctx.fill();
      }
    }

    // A "live price" beacon at the end of the line.
    if (chartA > 0.05 && introProgress >= 1) {
      var end = nodes[nodes.length - 1];
      var beat = (elapsed % 1800) / 1800;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 4 + beat * 10, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(colors.economics, (1 - beat) * 0.6 * chartA);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = rgba(colors.economics, chartA);
      ctx.fill();
    }

    // Crosshair: hovering reads the chart like a trading screen.
    if (pointer.active && chartA > 0.05 && introProgress >= 1) {
      var cy = lineYAt(pointer.x);
      if (cy != null) {
        ctx.save();
        ctx.setLineDash([3, 5]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(colors.muted, 0.55 * chartA);
        ctx.beginPath();
        ctx.moveTo(Math.round(pointer.x) + 0.5, bandTop - 8);
        ctx.lineTo(Math.round(pointer.x) + 0.5, bandTop + bandH + 8);
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(pointer.x, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = rgba(colors.economics, chartA);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(colors.bg, chartA);
        ctx.stroke();
      }
    }

    // Signal pulses with short glowing trails.
    for (var k = 0; k < pulses.length; k++) {
      var p = pulses[k];
      var a = nodes[p.a], b = nodes[p.b];
      var t0 = Math.max(0, p.t - 0.4);
      var hx = lerp(a.x, b.x, p.t), hy = lerp(a.y, b.y, p.t);
      var sx = lerp(a.x, b.x, t0), sy = lerp(a.y, b.y, t0);
      var trail = ctx.createLinearGradient(sx, sy, hx, hy);
      trail.addColorStop(0, rgba(colors.life, 0));
      trail.addColorStop(1, rgba(colors.life, 0.9));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = trail;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.fillStyle = rgba(colors.life, 0.18);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hx, hy, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = rgba(colors.life, 1);
      ctx.fill();
    }
  }

  /* ---------- loop ---------- */

  function frame(now) {
    rafId = 0;
    var dt = last ? Math.min(64, now - last) : 16;
    last = now;
    elapsed += dt;
    advanceTimeline();
    updateNodes(dt, false);
    updatePulses(dt);
    draw(Math.min(1, elapsed / INTRO));
    schedule();
  }

  function schedule() {
    if (!rafId && onScreen && !document.hidden && !reduceMotion.matches && W) {
      rafId = requestAnimationFrame(frame);
    }
  }

  function pause() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    last = 0;
  }

  // With reduced motion: one calm picture, the network in the background and
  // the price line in front of it.
  function drawStill() {
    pointer.active = false;
    pulses = [];
    morph = 1;
    updateNodes(0, true);
    ctx.globalAlpha = 0.55;
    draw(1);
    ctx.globalAlpha = 1;
    morph = 0;
    updateNodes(0, true);
    draw(1, true);
  }

  function refresh() {
    if (!resize()) return;
    if (reduceMotion.matches) drawStill();
    else schedule();
  }

  /* ---------- events ---------- */

  function toLocal(event) {
    var rect = canvas.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
  }

  hero.addEventListener("pointermove", function (event) {
    if (reduceMotion.matches) return;
    toLocal(event);
    pointer.active = true;
    var now = performance.now();
    if (now - pointer.lastSpawn > 160) {
      pointer.lastSpawn = now;
      spawnNear(pointer.x, pointer.y, 1);
    }
  }, { passive: true });

  hero.addEventListener("pointerdown", function (event) {
    if (reduceMotion.matches) return;
    toLocal(event);
    pointer.active = true;
    spawnNear(pointer.x, pointer.y, 3);
  }, { passive: true });

  hero.addEventListener("pointerleave", function () { pointer.active = false; });
  hero.addEventListener("pointercancel", function () { pointer.active = false; });
  hero.addEventListener("pointerup", function (event) {
    if (event.pointerType !== "mouse") pointer.active = false;
  });

  root.addEventListener("themechange", function () {
    readColors();
    if (reduceMotion.matches) drawStill();
  });

  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener("change", function () {
      if (reduceMotion.matches) { pause(); drawStill(); } else { schedule(); }
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) pause();
    else schedule();
  });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[entries.length - 1].isIntersecting;
      if (onScreen) schedule();
      else pause();
    }).observe(canvas);
  }

  if ("ResizeObserver" in window) {
    new ResizeObserver(refresh).observe(canvas);
  } else {
    window.addEventListener("resize", refresh);
  }

  readColors();
  refresh();
})();
