/* The Network page: every subject and post on the blog drawn as a living
   neural network. Subjects are the big neurons, posts are the small ones, and
   each line is a connection. Connections come from each post's front matter:

     connections: [ai, welcome-to-my-blog]

   and, for subject-to-subject links, from `connects:` in _data/topics.yml.

   Drag the dots, hover (or tap) to trace connections, click to open.
   Open the page with ?edit at the end of the address to draw new connections
   with the mouse; the page then shows the exact line to paste into each file.

   Colors come from the CSS variables named after each subject (--economics…).

   The same engine powers the Studio's network manager:
     BlogNetwork.mount(stageElement, data, options) -> { update, select, destroy }
   options: editing, panel, storageKey, hash, openOnClick, onToggle, onSelect.
   data may carry a `baseline` (the saved state) to show unsaved changes dashed. */
(function () {
  "use strict";

  function mount(stage, data, options) {
    options = options || {};
    var canvas = stage && stage.querySelector("canvas");
    if (!canvas || !canvas.getContext || !data) return null;
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;

    var root = document.documentElement;
    var card = stage.querySelector(".network__card");
    var editor = options.panel || null;
    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var editing = !!options.editing;
    var openOnClick = options.openOnClick !== false;
    var STORAGE_KEY = options.storageKey || null;
    var NAME_FONT = "italic 600 19px Newsreader, Georgia, serif";
    var cleanups = [], observers = [];

    function listen(target, type, fn) {
      target.addEventListener(type, fn);
      cleanups.push(function () { target.removeEventListener(type, fn); });
    }

    var W = 0, H = 0, dpr = 1;
    var nodes = [];          // subjects and posts
    var lookup = {};         // slug (or file name) -> node
    var edges = [];          // connections currently drawn
    var removed = [];        // edit mode: connections a draft takes away
    var unknown = [];        // connection names that match nothing
    var pulses = [];
    var palette = {};
    var drafts = {};
    var alpha = 1, elapsed = 0, last = 0, rafId = 0, nextPulse = 600;
    var onScreen = true;
    var hover = null, selected = null, drag = null, link = null, press = null;
    var pointer = { x: 0, y: 0 };
    var center = { x: 0, y: 0 };
    var widths = {};         // measured label widths

    /* ---------- small helpers ---------- */

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function parseColor(value) {
      ctx.fillStyle = "#000";
      ctx.fillStyle = value;
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

    function cssVar(name) {
      return getComputedStyle(root).getPropertyValue(name).trim();
    }

    function readPalette() {
      palette = {
        text: parseColor(cssVar("--text") || "#1f1d1a"),
        soft: parseColor(cssVar("--text-soft") || "#45403a"),
        muted: parseColor(cssVar("--muted") || "#6b645b"),
        bg: parseColor(cssVar("--bg") || "#faf7f2"),
        focus: parseColor(cssVar("--focus") || "#4b3fa8"),
        topics: {}
      };
    }

    // Each subject uses the CSS variable with its name (--economics, --ai, --life).
    function topicColor(key) {
      if (!key) return palette.muted;
      if (!palette.topics[key]) {
        var safe = String(key).replace(/[^a-z0-9-]/g, "");
        var value = safe ? cssVar("--" + safe) : "";
        palette.topics[key] = value ? parseColor(value) : palette.muted;
      }
      return palette.topics[key];
    }

    function nodeColor(n) {
      return n.kind === "topic" ? topicColor(n.key) : topicColor(n.topicKey);
    }

    function decode(text) {
      var box = document.createElement("textarea");
      box.innerHTML = text || "";
      return box.value;
    }

    // Accepts [a, b], "a, b" or "a" and returns clean lowercase names.
    function names(value) {
      if (value == null) return [];
      var list = Array.isArray(value) ? value : [value];
      var out = [];
      list.forEach(function (item) {
        if (item == null) return;
        String(item).split(",").forEach(function (part) {
          var name = part.trim().toLowerCase().replace(/\.md$/, "");
          if (name && out.indexOf(name) === -1) out.push(name);
        });
      });
      return out;
    }

    // Same names, in any order.
    function sameList(a, b) {
      return a.length === b.length && a.every(function (v) { return b.indexOf(v) !== -1; });
    }

    /* ---------- the model ---------- */

    function addNode(kind, key, label, raw, list) {
      var node = {
        id: nodes.length, kind: kind, key: String(key).toLowerCase(), label: label || key, raw: raw,
        list: list, base: list.slice(), topicKey: "", baseTopic: "",
        x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, fx: null, fy: null,
        r: 8, degree: 0, seed: Math.random() * Math.PI * 2, nextFire: 0
      };
      nodes.push(node);
      return node;
    }

    function buildModel() {
      nodes = [];
      lookup = {};
      var saved = data.baseline || null, savedTopics = {}, savedPosts = {};
      if (saved) {
        (saved.topics || []).forEach(function (t) { savedTopics[String(t.key).toLowerCase()] = t; });
        (saved.posts || []).forEach(function (p) { savedPosts[String(p.fileKey || p.key).toLowerCase()] = p; });
      }
      (data.topics || []).forEach(function (t) {
        var node = addNode("topic", t.key, t.name, t, names(t.connects));
        if (saved) node.base = names((savedTopics[node.key] || {}).connects);
        lookup[node.key] = node;
      });
      (data.posts || []).forEach(function (p) {
        var node = addNode("post", p.key, p.title, p, names(p.connections));
        node.topicKey = node.baseTopic = names(p.topic)[0] || "";
        if (saved) {
          var was = savedPosts[String(p.fileKey || p.key).toLowerCase()] || {};
          node.base = names(was.connections);
          node.baseTopic = names(was.topic)[0] || "";
        }
        if (!lookup[node.key]) lookup[node.key] = node;
        var fileKey = String(p.fileKey || "").toLowerCase();
        if (fileKey && !lookup[fileKey]) lookup[fileKey] = node;
      });
    }

    function info(n) {
      return n ? { kind: n.kind, key: n.key, label: n.label, topic: n.topicKey, file: (n.raw && n.raw.file) || "" } : null;
    }

    function currentList(n) {
      var draft = drafts[n.kind + ":" + n.key];
      return draft ? draft.slice() : n.list.slice();
    }

    // which = "base" (the saved state) or "current" (with drafts and unsaved changes)
    function collectEdges(which) {
      var withDrafts = which !== "base";
      var list = [], seen = {}, missing = [];
      function add(a, b, kind) {
        if (!a || !b || a === b) return;
        var id = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
        if (seen[id]) {
          if (kind === "main") seen[id].kind = "main";
          return;
        }
        var e = { id: id, a: a, b: b, kind: kind, draft: false, bend: (list.length % 2 ? 1 : -1) * (0.07 + (list.length % 4) * 0.025) };
        seen[id] = e;
        list.push(e);
      }
      nodes.forEach(function (n) {
        var main = n.kind === "post" ? lookup[withDrafts ? n.topicKey : n.baseTopic] : null;
        if (main && main.kind === "topic") add(n, main, "main");
      });
      nodes.forEach(function (n) {
        (withDrafts ? currentList(n) : n.base).forEach(function (name) {
          var other = lookup[name];
          if (!other) { missing.push({ node: n, name: name }); return; }
          var kind = n.kind === "topic" && other.kind === "topic" ? "subject" :
            n.kind === "topic" || other.kind === "topic" ? "topic" : "post";
          add(n, other, kind);
        });
      });
      return { edges: list, missing: missing };
    }

    function refreshEdges() {
      var diffing = editing || !!data.baseline;
      var original = collectEdges("base");
      var current = diffing ? collectEdges("current") : original;
      var had = {}, has = {};
      original.edges.forEach(function (e) { had[e.id] = true; });
      current.edges.forEach(function (e) { has[e.id] = true; e.draft = diffing && !had[e.id]; });
      edges = current.edges;
      removed = diffing ? original.edges.filter(function (e) { return !has[e.id]; }) : [];
      unknown = current.missing;
      pulses = pulses.filter(function (p) { return has[p.edge.id]; });

      nodes.forEach(function (n) { n.degree = 0; });
      edges.forEach(function (e) { e.a.degree++; e.b.degree++; });
      sizeNodes();
    }

    function sizeNodes() {
      var k = W ? clamp(W / 760, 0.72, 1) : 1;
      nodes.forEach(function (n) {
        n.r = n.kind === "topic" ? (24 + Math.min(12, Math.sqrt(n.degree) * 3)) * k
                                 : 6 + Math.min(5, Math.sqrt(n.degree) * 1.4);
      });
    }

    function neighbours(n) {
      var near = {};
      near[n.id] = true;
      edges.forEach(function (e) {
        if (e.a === n) near[e.b.id] = true;
        if (e.b === n) near[e.a.id] = true;
      });
      return near;
    }

    /* ---------- layout & physics ---------- */

    function setAnchors() {
      var topics = nodes.filter(function (n) { return n.kind === "topic"; });
      var rx = W * (W < 600 ? 0.29 : 0.32), ry = H * (W < 600 ? 0.37 : 0.34);
      var cx = W / 2, cy = H / 2 - ry * 0.25 + 4;
      center.x = cx;
      center.y = cy;
      topics.forEach(function (t, i) {
        var angle = ((210 + (i * 360) / topics.length) * Math.PI) / 180;
        t.ax = cx + Math.cos(angle) * rx;
        t.ay = cy + Math.sin(angle) * ry;
      });
    }

    function placeNodes() {
      setAnchors();
      nodes.forEach(placeNode);
    }

    function placeNode(n) {
      if (n.kind === "topic") {
        n.x = n.ax;
        n.y = n.ay;
        return;
      }
      var sx = 0, sy = 0, count = 0;
      edges.forEach(function (e) {
        var other = e.a === n ? e.b : e.b === n ? e.a : null;
        if (other && other.kind === "topic") { sx += other.ax; sy += other.ay; count++; }
      });
      n.x = (count ? sx / count : W / 2) + (Math.random() - 0.5) * 80;
      n.y = (count ? sy / count : H / 2) + (Math.random() - 0.5) * 80;
    }

    function tick() {
      var scale = Math.min(W, H) / 640;
      var i, j, a, b, dx, dy, d, f, min;
      for (i = 0; i < nodes.length; i++) {
        a = nodes[i];
        for (j = i + 1; j < nodes.length; j++) {
          b = nodes[j];
          dx = b.x - a.x;
          dy = b.y - a.y;
          d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var posts = a.kind === "post" && b.kind === "post";
          f = ((posts ? 2600 : 2400) * scale) / (d * d);
          min = a.r + b.r + (posts ? 30 : 24);
          if (d < min) f += (min - d) * 0.06;
          dx /= d;
          dy /= d;
          var lift = posts ? 1.35 : 1;   // labels are wide, so give posts more room vertically
          a.vx -= dx * f * alpha;
          a.vy -= dy * f * alpha * lift;
          b.vx += dx * f * alpha;
          b.vy += dy * f * alpha * lift;
        }
      }
      edges.forEach(function (e) {
        var rest = { main: 105, topic: 150, post: 90, subject: 250 }[e.kind] * scale;
        var ex = e.b.x - e.a.x, ey = e.b.y - e.a.y;
        var len = Math.sqrt(ex * ex + ey * ey) || 0.01;
        var pull = (len - rest) * 0.028 * alpha;
        ex /= len;
        ey /= len;
        e.a.vx += ex * pull;
        e.a.vy += ey * pull;
        e.b.vx -= ex * pull;
        e.b.vy -= ey * pull;
      });
      nodes.forEach(function (n) {
        if (n === drag) {
          n.x = n.fx;
          n.y = n.fy;
          n.vx = n.vy = 0;
          return;
        }
        if (n.kind === "topic") {
          n.vx += (n.ax - n.x) * 0.05;
          n.vy += (n.ay - n.y) * 0.05;
        } else {
          n.vx += (center.x - n.x) * 0.0025 * alpha;
          n.vy += (center.y - n.y) * 0.0025 * alpha;
        }
        if (n.kind === "post") {
          nodes.forEach(function (t) {
            if (t.kind !== "topic") return;
            var half = Math.max(50, measure(t.label, NAME_FONT) / 2 + 8) + n.r;
            var x1 = t.x - half, x2 = t.x + half, y1 = t.y + t.r + 4 - n.r, y2 = t.y + t.r + 50 + n.r;
            if (n.x > x1 && n.x < x2 && n.y > y1 && n.y < y2) {
              var outX = n.x < t.x ? x1 - n.x : x2 - n.x;
              var outY = y2 - n.y;
              if (Math.abs(outX) < Math.abs(outY)) n.vx += outX * 0.2;
              else n.vy += outY * 0.2;
            }
          });
        }
        n.vx *= 0.78;
        n.vy *= 0.78;
        n.x += n.vx;
        n.y += n.vy;
        var pad = n.r + 14;
        n.x = clamp(n.x, pad, W - pad);
        n.y = clamp(n.y, pad, H - pad - (n.kind === "topic" ? 34 : 6));
      });
    }

    function settle(steps) {
      for (var s = 0; s < steps; s++) {
        tick();
        alpha = Math.max(0.02, alpha * 0.985);
      }
    }

    /* ---------- pulses ---------- */

    function spawnPulse(edge, from) {
      if (pulses.length > 30) return;
      pulses.push({
        edge: edge,
        forward: from ? edge.a === from : Math.random() < 0.5,
        t: 0,
        speed: 0.0006 + Math.random() * 0.0004
      });
    }

    function updatePulses(dt) {
      if (elapsed > nextPulse && edges.length) {
        spawnPulse(edges[Math.floor(Math.random() * edges.length)]);
        nextPulse = elapsed + 650 + Math.random() * 700;
      }
      var focus = hover || selected;
      if (focus && elapsed > focus.nextFire) {
        edges.forEach(function (e) { if (e.a === focus || e.b === focus) spawnPulse(e, focus); });
        focus.nextFire = elapsed + 900;
      }
      for (var i = pulses.length - 1; i >= 0; i--) {
        pulses[i].t += pulses[i].speed * dt;
        if (pulses[i].t >= 1) pulses.splice(i, 1);
      }
    }

    /* ---------- drawing ---------- */

    function controlPoint(e) {
      var dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      return { x: (e.a.x + e.b.x) / 2 - dy * e.bend, y: (e.a.y + e.b.y) / 2 + dx * e.bend };
    }

    function pointOn(e, c, t) {
      var u = 1 - t;
      return {
        x: u * u * e.a.x + 2 * u * t * c.x + t * t * e.b.x,
        y: u * u * e.a.y + 2 * u * t * c.y + t * t * e.b.y
      };
    }

    function edgeStroke(e, a) {
      if (e.kind === "post") return rgba(palette.muted, a);
      if (e.kind === "subject") {
        var g = ctx.createLinearGradient(e.a.x, e.a.y, e.b.x, e.b.y);
        g.addColorStop(0, rgba(nodeColor(e.a), a));
        g.addColorStop(1, rgba(nodeColor(e.b), a));
        return g;
      }
      return rgba(nodeColor(e.a.kind === "topic" ? e.a : e.b), a);
    }

    function shorten(text, max) {
      return text.length > max ? text.slice(0, max - 1).trim() + "…" : text;
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      var focus = drag ? null : hover || selected || (link && link.from);
      var near = focus ? neighbours(focus) : null;
      var calm = reduceMotion.matches;

      // Soft fields around each subject.
      nodes.forEach(function (n) {
        if (n.kind !== "topic") return;
        var field = ctx.createRadialGradient(n.x, n.y, n.r * 0.6, n.x, n.y, n.r * 4.5);
        field.addColorStop(0, rgba(nodeColor(n), focus && !near[n.id] ? 0.04 : 0.13));
        field.addColorStop(1, rgba(nodeColor(n), 0));
        ctx.fillStyle = field;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 4.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // Connections a draft would remove (edit mode only).
      ctx.setLineDash([2, 6]);
      removed.forEach(function (e) {
        var c = controlPoint(e);
        ctx.strokeStyle = rgba(palette.muted, 0.55);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.quadraticCurveTo(c.x, c.y, e.b.x, e.b.y);
        ctx.stroke();
      });

      // Connections.
      edges.forEach(function (e) {
        var lit = focus && (e.a === focus || e.b === focus);
        var a = focus ? (lit ? 0.9 : 0.07) : e.kind === "main" ? 0.45 : e.kind === "post" ? 0.55 : 0.4;
        var c = controlPoint(e);
        ctx.setLineDash(e.draft ? [6, 5] : []);
        ctx.strokeStyle = edgeStroke(e, a);
        ctx.lineWidth = lit ? 2.4 : e.kind === "main" ? 1.7 : 1.3;
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.quadraticCurveTo(c.x, c.y, e.b.x, e.b.y);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // Signals travelling along the connections.
      pulses.forEach(function (p) {
        var e = p.edge;
        var lit = !focus || e.a === focus || e.b === focus;
        var target = p.forward ? e.b : e.a;
        var at = pointOn(e, controlPoint(e), p.forward ? p.t : 1 - p.t);
        var col = nodeColor(target);
        ctx.beginPath();
        ctx.arc(at.x, at.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col, lit ? 0.2 : 0.05);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(at.x, at.y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col, lit ? 1 : 0.25);
        ctx.fill();
      });

      // The line being drawn in edit mode.
      if (link) {
        var end = link.to || pointer;
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = rgba(palette.focus, 0.9);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(link.from.x, link.from.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // The neurons themselves (labels are drawn on top, in drawLabels).
      nodes.forEach(function (n) {
        var col = nodeColor(n);
        var dim = focus && !near[n.id];
        var r = n.r;
        if (n.kind === "topic" && !calm) r *= 1 + 0.03 * Math.sin(elapsed * 0.0016 + n.seed);
        if (n === focus || (link && n === link.to)) r += 2;
        ctx.globalAlpha = dim ? 0.22 : 1;

        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2);
        ctx.fillStyle = rgba(palette.bg, 1);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col, 1);
        ctx.fill();
        if (n.kind === "topic" || n === focus || (link && n === link.to)) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 7, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(col, n === focus ? 0.6 : 0.3);
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        ctx.globalAlpha = 1;
      });

      drawLabels(focus, near);
    }

    function measure(text, font) {
      var key = font + "|" + text;
      if (widths[key] == null) {
        ctx.font = font;
        widths[key] = ctx.measureText(text).width;
      }
      return widths[key];
    }

    function writeLabel(text, x, y, font, color, alignment) {
      ctx.font = font;
      ctx.textAlign = alignment;
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = rgba(palette.bg, 0.92);
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }

    // Subjects are always labelled. Posts are labelled on whichever side of the
    // dot has room (the hovered post and its neighbours first); a post with no
    // room shows its title on hover instead, so labels never overlap.
    function drawLabels(focus, near) {
      var taken = [];
      function fits(b) {
        if (b.x1 < 4 || b.x2 > W - 4 || b.y1 < 4 || b.y2 > H - 4) return false;
        for (var i = 0; i < taken.length; i++) {
          var t = taken[i];
          if (b.x1 < t.x2 && b.x2 > t.x1 && b.y1 < t.y2 && b.y2 > t.y1) return false;
        }
        return true;
      }
      nodes.forEach(function (n) {
        taken.push({ x1: n.x - n.r - 3, y1: n.y - n.r - 3, x2: n.x + n.r + 3, y2: n.y + n.r + 3 });
      });

      var countFont = "600 11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
      nodes.forEach(function (n) {
        if (n.kind !== "topic") return;
        var dim = focus && !near[n.id];
        var posts = 0;
        edges.forEach(function (e) {
          if ((e.a === n && e.b.kind === "post") || (e.b === n && e.a.kind === "post")) posts++;
        });
        var count = posts === 1 ? "1 POST" : posts + " POSTS";
        var w = Math.max(measure(n.label, NAME_FONT), measure(count, countFont));
        var top = n.y + n.r + 10;
        taken.push({ x1: n.x - w / 2 - 4, y1: top, x2: n.x + w / 2 + 4, y2: top + 38 });
        ctx.globalAlpha = dim ? 0.3 : 1;
        writeLabel(n.label, n.x, top + 11, NAME_FONT, rgba(palette.text, 1), "center");
        writeLabel(count, n.x, top + 30, countFont, rgba(palette.muted, 1), "center");
        ctx.globalAlpha = 1;
      });

      var postFont = "500 14px Newsreader, Georgia, serif";
      var max = W < 560 ? 24 : 34;
      var posts = nodes.filter(function (n) { return n.kind === "post"; });
      posts.sort(function (a, b) {
        var pa = a === focus ? 2 : near && near[a.id] ? 1 : 0;
        var pb = b === focus ? 2 : near && near[b.id] ? 1 : 0;
        return pb - pa || b.degree - a.degree;
      });
      posts.forEach(function (n) {
        var text = shorten(n.label, n === focus ? 60 : max);
        var w = measure(text, postFont), h = 18;
        var right = { x1: n.x + n.r + 7, y1: n.y - h / 2, x2: n.x + n.r + 7 + w, y2: n.y + h / 2 };
        var left = { x1: n.x - n.r - 7 - w, y1: n.y - h / 2, x2: n.x - n.r - 7, y2: n.y + h / 2 };
        var below = { x1: n.x - w / 2, y1: n.y + n.r + 4, x2: n.x + w / 2, y2: n.y + n.r + 4 + h };
        var above = { x1: n.x - w / 2, y1: n.y - n.r - 4 - h, x2: n.x + w / 2, y2: n.y - n.r - 4 };
        var box = [right, left, below, above].filter(fits)[0] || null;
        if (!box && n === focus) box = right.x2 <= W - 4 ? right : left;
        if (!box) return;
        taken.push(box);
        ctx.globalAlpha = focus && !near[n.id] ? 0.25 : 1;
        var align = box === right ? "left" : box === left ? "right" : "center";
        var x = box === right ? box.x1 : box === left ? box.x2 : n.x;
        writeLabel(text, x, (box.y1 + box.y2) / 2, postFont, rgba(n === focus ? palette.text : palette.soft, 1), align);
        ctx.globalAlpha = 1;
      });
    }

    /* ---------- the info card ---------- */

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    function fillCard(n) {
      card.textContent = "";
      var meta = el("p", "network__card-meta");
      var links = 0;
      edges.forEach(function (e) { if (e.a === n || e.b === n) links++; });
      if (n.kind === "topic") {
        meta.appendChild(el("span", "network__card-kind topic--" + n.key, "Subject"));
        card.appendChild(meta);
        card.appendChild(el("p", "network__card-title", n.label));
        if (n.raw.description) card.appendChild(el("p", "network__card-text", decode(n.raw.description)));
        var go = el("a", "network__card-link", "See all posts →");
        go.href = n.raw.url;
        card.appendChild(go);
      } else {
        var topic = lookup[n.topicKey];
        meta.appendChild(el("span", "network__card-kind topic--" + (topic ? topic.key : ""), topic ? topic.label : "Post"));
        if (n.raw.date) meta.appendChild(el("span", "", " · " + n.raw.date));
        card.appendChild(meta);
        card.appendChild(el("p", "network__card-title", n.label));
        if (n.raw.description) card.appendChild(el("p", "network__card-text", decode(n.raw.description)));
        card.appendChild(el("p", "network__card-count", links === 1 ? "1 connection" : links + " connections"));
        var read = el("a", "network__card-link", "Read the post →");
        read.href = n.raw.url;
        card.appendChild(read);
      }
    }

    function showCard(n, interactive) {
      if (!card || !n) return;
      fillCard(n);
      card.hidden = false;
      card.classList.toggle("is-interactive", !!interactive);
      var cw = card.offsetWidth, ch = card.offsetHeight;
      var x, y;
      if (W - 2 * (n.r + 16) < cw * 1.6) {
        // Narrow stage: put the card above or below the dot so the dot stays tappable.
        x = n.x - cw / 2;
        y = n.y + n.r + 14 + ch <= H - 10 ? n.y + n.r + 14 : n.y - n.r - 14 - ch;
      } else {
        x = n.x + n.r + 16;
        if (x + cw > W - 10) x = n.x - n.r - 16 - cw;
        y = n.y - ch / 2;
      }
      card.style.left = clamp(x, 10, Math.max(10, W - cw - 10)) + "px";
      card.style.top = clamp(y, 10, Math.max(10, H - ch - 10)) + "px";
      requestAnimationFrame(function () { card.classList.add("is-visible"); });
    }

    function hideCard() {
      if (!card) return;
      card.classList.remove("is-visible", "is-interactive");
      card.hidden = true;
    }

    function select(n) {
      selected = n;
      if (n) showCard(n, true);
      else hideCard();
      if (options.onSelect) options.onSelect(info(n));
    }

    /* ---------- edit mode ---------- */

    function loadDrafts() {
      if (!STORAGE_KEY) return {};
      try {
        var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        return saved && typeof saved === "object" ? saved : {};
      } catch (e) {
        return {};
      }
    }

    function saveDrafts() {
      if (!STORAGE_KEY) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
      } catch (e) {
        /* Storage is blocked: drafts last until the page is closed. */
      }
    }

    function nodeForDraft(key) {
      var cut = key.indexOf(":");
      var kind = key.slice(0, cut), name = key.slice(cut + 1);
      var n = lookup[name];
      return n && n.kind === kind ? n : null;
    }

    // Drop drafts that no longer apply, e.g. once the change is published.
    function tidyDrafts() {
      Object.keys(drafts).forEach(function (key) {
        var n = nodeForDraft(key);
        if (!n || !Array.isArray(drafts[key]) || sameList(names(drafts[key]), n.list)) delete drafts[key];
        else drafts[key] = names(drafts[key]);
      });
      saveDrafts();
    }

    function refersTo(list, n) {
      var fileKey = n.raw && n.raw.fileKey ? String(n.raw.fileKey).toLowerCase() : "";
      return list.indexOf(n.key) !== -1 || (fileKey && list.indexOf(fileKey) !== -1);
    }

    function without(list, n) {
      var fileKey = n.raw && n.raw.fileKey ? String(n.raw.fileKey).toLowerCase() : "";
      return list.filter(function (name) { return name !== n.key && name !== fileKey; });
    }

    function setList(n, list) {
      var key = n.kind + ":" + n.key;
      if (sameList(list, n.list)) delete drafts[key];
      else drafts[key] = list;
      saveDrafts();
      refreshEdges();
      renderEditor();
      alpha = Math.max(alpha, 0.4);
      wake();
    }

    function say(message) {
      var status = editor && editor.querySelector(".network-editor__status");
      if (status) status.textContent = message;
    }

    // Connect a and b, or disconnect them if they are already connected.
    function toggleConnection(a, b) {
      if (options.onToggle) {
        options.onToggle(info(a), info(b));
        return;
      }
      var owner = a.kind === "post" ? a : b.kind === "post" ? b : a;
      var other = owner === a ? b : a;
      if (owner.kind === "post" && other.kind === "topic" && owner.topicKey === other.key) {
        say("“" + other.label + "” is the main subject of “" + owner.label + "”. To change it, edit the topic: line in that post.");
        return;
      }
      var mine = currentList(owner), theirs = currentList(other);
      if (refersTo(mine, other)) {
        setList(owner, without(mine, other));
        say("Disconnected “" + owner.label + "” and “" + other.label + "” (draft).");
      } else if (refersTo(theirs, owner)) {
        setList(other, without(theirs, owner));
        say("Disconnected “" + other.label + "” and “" + owner.label + "” (draft).");
      } else {
        mine.push(other.key);
        setList(owner, mine);
        say("Connected “" + owner.label + "” to “" + other.label + "” (draft).");
      }
    }

    function editUrl(file) {
      return "https://github.com/" + data.repo + "/edit/" + (data.branch || "main") + "/" + file;
    }

    function renderEditor() {
      if (!editor) return;
      var list = editor.querySelector(".network-editor__changes");
      var empty = editor.querySelector(".network-editor__empty");
      var discard = editor.querySelector(".network-editor__discard");
      list.textContent = "";
      var keys = Object.keys(drafts);
      empty.hidden = keys.length > 0;
      discard.hidden = keys.length === 0;

      keys.forEach(function (key) {
        var n = nodeForDraft(key);
        if (!n) return;
        var items = drafts[key];
        var isPost = n.kind === "post";
        var file = isPost ? n.raw.file : "_data/topics.yml";
        var line = isPost ? "connections: [" + items.join(", ") + "]" : "  connects: [" + items.join(", ") + "]";

        var item = el("li", "network-editor__change");
        item.appendChild(el("p", "network-editor__what", isPost ? n.label : "Subject: " + n.label));
        var where = el("p", "network-editor__where");
        where.appendChild(document.createTextNode("In "));
        where.appendChild(el("code", "", file));
        where.appendChild(document.createTextNode(
          isPost ? ", replace the connections: line between the --- lines (or add it under topic:) with:"
                 : ", under “- slug: " + n.key + "”, replace the connects: line (or add it) with:"));
        item.appendChild(where);
        var pre = el("pre", "network-editor__line");
        pre.appendChild(el("code", "", line));
        item.appendChild(pre);
        if (!items.length) item.appendChild(el("p", "network-editor__note", "An empty list means no extra connections, so you can also delete the line."));

        var actions = el("p", "network-editor__actions");
        var copy = el("button", "network-editor__button", "Copy line");
        copy.type = "button";
        copy.addEventListener("click", function () {
          var done = function () { copy.textContent = "Copied!"; setTimeout(function () { copy.textContent = "Copy line"; }, 1600); };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(line.trim()).then(done, function () { selectText(pre); });
          } else {
            selectText(pre);
          }
        });
        actions.appendChild(copy);
        var open = el("a", "network-editor__button network-editor__button--link", "Open the file on GitHub ↗");
        open.href = editUrl(file);
        open.target = "_blank";
        open.rel = "noopener";
        actions.appendChild(open);
        item.appendChild(actions);
        list.appendChild(item);
      });

      var warn = editor.querySelector(".network-editor__unknown");
      var warnList = warn.querySelector("ul");
      warnList.textContent = "";
      unknown.forEach(function (u) {
        warnList.appendChild(el("li", "", "“" + u.name + "” in " + (u.node.kind === "post" ? "“" + u.node.label + "”" : "the subject " + u.node.label) + " doesn't match any subject or post."));
      });
      warn.hidden = unknown.length === 0;
    }

    function selectText(node) {
      var range = document.createRange();
      range.selectNodeContents(node);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    /* ---------- pointer ---------- */

    function local(event) {
      var rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function hit(x, y, touch) {
      var best = null, bestD = Infinity;
      nodes.forEach(function (n) {
        var d = Math.hypot(n.x - x, n.y - y);
        var reach = Math.max(n.r + 6, touch ? 22 : 12);
        if (d < reach && d < bestD) { best = n; bestD = d; }
      });
      return best;
    }

    function open(n) {
      if (n && n.raw && n.raw.url) window.location.href = n.raw.url;
    }

    canvas.addEventListener("pointerdown", function (event) {
      var p = local(event);
      pointer = p;
      var n = hit(p.x, p.y, event.pointerType !== "mouse");
      press = { x: p.x, y: p.y, node: n, moved: false, type: event.pointerType };
      if (!n) return;
      if (editing) link = { from: n, to: null };
      else {
        drag = n;
        n.fx = p.x;
        n.fy = p.y;
        alpha = Math.max(alpha, 0.3);
      }
      try { canvas.setPointerCapture(event.pointerId); } catch (e) {}
      wake();
    });

    canvas.addEventListener("pointermove", function (event) {
      var p = local(event);
      pointer = p;
      if (press && Math.abs(p.x - press.x) + Math.abs(p.y - press.y) > 6) press.moved = true;
      if (drag && press && press.moved) {
        stage.classList.add("is-dragging");
        drag.fx = p.x;
        drag.fy = p.y;
        if (reduceMotion.matches) { drag.x = p.x; drag.y = p.y; }
        hideCard();
      } else if (link) {
        var target = hit(p.x, p.y, event.pointerType !== "mouse");
        link.to = target && target !== link.from ? target : null;
        stage.classList.add("is-linking");
      } else if (event.pointerType === "mouse" && !drag) {
        var n = hit(p.x, p.y, false);
        if (n !== hover) {
          hover = n;
          if (n) showCard(n, false);
          else if (selected) showCard(selected, true);
          else hideCard();
        }
        stage.classList.toggle("is-pointing", !!n);
      }
      wake();
    });

    function endPress(event, cancelled) {
      var p = event ? local(event) : pointer;
      var clicked = press && !press.moved && !cancelled ? press.node : null;
      if (drag) {
        if (drag.kind === "topic" && press && press.moved) { drag.ax = drag.x; drag.ay = drag.y; }
        drag.fx = drag.fy = null;
        drag = null;
      }
      if (link) {
        var target = cancelled ? null : hit(p.x, p.y, press && press.type !== "mouse");
        if (target && target !== link.from) toggleConnection(link.from, target);
        link = null;
      }
      stage.classList.remove("is-dragging", "is-linking");
      if (clicked) {
        if (press.type === "mouse" && !editing && openOnClick) open(clicked);
        else if (selected === clicked && !editing && openOnClick) open(clicked);
        else select(clicked);
      } else if (press && !press.node && !cancelled) {
        select(null);
      }
      press = null;
      wake();
    }

    canvas.addEventListener("pointerup", function (event) { endPress(event, false); });
    canvas.addEventListener("pointercancel", function () { endPress(null, true); });
    canvas.addEventListener("pointerleave", function () {
      if (drag || link) return;
      hover = null;
      stage.classList.remove("is-pointing");
      if (selected) showCard(selected, true);
      else hideCard();
      wake();
    });

    listen(document, "keydown", function (event) {
      if (event.key === "Escape" && (selected || link)) {
        link = null;
        select(null);
        wake();
      }
    });

    /* ---------- loop ---------- */

    function frame(now) {
      rafId = 0;
      var dt = last ? Math.min(64, now - last) : 16;
      last = now;
      elapsed += dt;
      tick();
      alpha = Math.max(0.02, alpha * 0.985);
      updatePulses(dt);
      draw();
      schedule();
    }

    function schedule() {
      if (!rafId && onScreen && !document.hidden && !reduceMotion.matches && W) {
        rafId = requestAnimationFrame(frame);
      }
    }

    // Redraw after an interaction (with reduced motion there is no loop to do it).
    function wake() {
      if (reduceMotion.matches) {
        if (!rafId) rafId = requestAnimationFrame(function () { rafId = 0; draw(); });
      } else {
        schedule();
      }
    }

    function pause() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      last = 0;
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var w = Math.round(rect.width), h = Math.round(rect.height);
      if (!w || !h) return;
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (w === W && h === H && ratio === dpr) return;
      var first = !W;
      var sx = W ? w / W : 1, sy = H ? h / H : 1;
      W = w;
      H = h;
      dpr = ratio;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      sizeNodes();
      if (first) {
        placeNodes();
        settle(reduceMotion.matches ? 400 : 60);
      } else {
        setAnchors();
        nodes.forEach(function (n) { n.x *= sx; n.y *= sy; });
        alpha = Math.max(alpha, 0.5);
        if (reduceMotion.matches) settle(200);
      }
      if (selected) showCard(selected, true);
      wake();
    }

    // /network/#some-post highlights that post (the "See it on the network" links).
    function focusFromHash() {
      var key = decodeURIComponent(location.hash.slice(1) || "").toLowerCase();
      var n = key ? lookup[key] : null;
      if (!n) return;
      select(n);
      var rect = stage.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        stage.scrollIntoView({ block: "center", behavior: reduceMotion.matches ? "auto" : "smooth" });
      }
    }

    /* ---------- start ---------- */

    buildModel();
    if (editing) {
      drafts = loadDrafts();
      tidyDrafts();
      stage.classList.add("is-editing");
      if (editor) {
        editor.hidden = false;
        editor.querySelector(".network-editor__discard").addEventListener("click", function () {
          drafts = {};
          saveDrafts();
          refreshEdges();
          renderEditor();
          say("All drafts discarded.");
          wake();
        });
      }
    }
    readPalette();
    refreshEdges();
    renderEditor();

    listen(root, "themechange", function () {
      readPalette();
      wake();
    });

    if (reduceMotion.addEventListener) {
      listen(reduceMotion, "change", function () {
        if (reduceMotion.matches) { pause(); settle(200); }
        wake();
      });
    }

    listen(document, "visibilitychange", function () {
      if (document.hidden) pause();
      else schedule();
    });

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        onScreen = entries[entries.length - 1].isIntersecting;
        if (onScreen) schedule();
        else pause();
      });
      io.observe(canvas);
      observers.push(io);
    }

    if ("ResizeObserver" in window) {
      var ro = new ResizeObserver(resize);
      ro.observe(canvas);
      observers.push(ro);
    } else {
      listen(window, "resize", resize);
    }

    if (options.hash) listen(window, "hashchange", focusFromHash);
    resize();
    if (options.hash) focusFromHash();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { widths = {}; wake(); });
    }

    /* ---------- the public API ---------- */

    return {
      // Redraw with new data (and baseline), keeping every dot where it is.
      update: function (next) {
        var old = {};
        nodes.forEach(function (n) { old[n.kind + ":" + n.key] = n; });
        var before = nodes.filter(function (n) { return n.kind === "topic"; }).map(function (n) { return n.key; }).join(",");
        var chosen = selected ? selected.kind + ":" + selected.key : null;
        data = next || { topics: [], posts: [] };
        buildModel();
        refreshEdges();
        pulses = [];
        hover = null;
        drag = null;
        link = null;
        var after = nodes.filter(function (n) { return n.kind === "topic"; }).map(function (n) { return n.key; }).join(",");
        if (W) {
          setAnchors();
          nodes.forEach(function (n) {
            var was = old[n.kind + ":" + n.key];
            if (!was) { placeNode(n); return; }
            n.x = was.x; n.y = was.y; n.vx = was.vx; n.vy = was.vy; n.seed = was.seed;
            if (n.kind === "topic" && before === after) { n.ax = was.ax; n.ay = was.ay; }
          });
        }
        selected = null;
        nodes.forEach(function (n) { if (n.kind + ":" + n.key === chosen) selected = n; });
        if (selected) showCard(selected, true);
        else hideCard();
        renderEditor();
        alpha = Math.max(alpha, 0.35);
        wake();
      },
      // Select a subject or post by its name (or null to clear).
      select: function (key) {
        select(key ? lookup[String(key).toLowerCase()] || null : null);
        wake();
      },
      destroy: function () {
        pause();
        cleanups.forEach(function (fn) { fn(); });
        observers.forEach(function (o) { o.disconnect(); });
        hideCard();
      }
    };
  }

  window.BlogNetwork = { mount: mount };

  // The blog's Network page mounts itself; ?edit turns on the copy-paste editor.
  var source = document.getElementById("network-data");
  if (source) {
    var pageData = null;
    try {
      pageData = JSON.parse(source.textContent);
    } catch (e) {
      pageData = null;
    }
    var pageEditing = /(^|&)edit(=|&|$)/.test(location.search.slice(1));
    mount(document.querySelector(".network__stage"), pageData, {
      editing: pageEditing,
      panel: pageEditing ? document.querySelector(".network-editor") : null,
      storageKey: pageEditing ? "network-drafts" : null,
      hash: true
    });
  }
})();
