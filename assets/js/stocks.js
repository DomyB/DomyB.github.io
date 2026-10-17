/* The Stocks page.
   Loads the data produced by tools/stocks/pipeline.py (from the stock-data
   branch, or the copy in assets/data/stocks/ as a fallback), and draws the
   overview table, each stock's detail page and the methodology page. Charts
   are plain canvas, in the blog's colors, and follow the theme switch.
   Real-time prices stream from Yahoo Finance's public WebSocket while the
   page is open; no key is needed and nothing is sent anywhere else. */
(function () {
  "use strict";

  var app = document.getElementById("stocks");
  if (!app) return;
  var root = document.documentElement;
  var view = document.getElementById("stocks-view");
  var statusEl = app.querySelector(".stocks__status");
  var tabs = Array.prototype.slice.call(app.querySelectorAll(".stocks__tab"));
  var REPO = app.getAttribute("data-repo") || "";
  var BRANCH = app.getAttribute("data-branch") || "stock-data";
  var LOCAL = app.getAttribute("data-local") || "/assets/data/stocks/";
  var RAW = REPO ? "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/" : null;
  var HORIZON_NAMES = { 1: "1 day", 5: "1 week", 21: "1 month", 63: "3 months" };
  var HORIZON_SHORT = { 1: "1d", 5: "1w", 21: "1m", 63: "3m" };
  var REFRESH_MS = 5 * 60 * 1000;

  var state = {
    summary: null, base: null, generatedAt: null,
    tickers: {}, loading: {},
    horizon: 21, sort: { key: "overall", dir: -1 }, query: "", sector: "",
    range: 252, overlays: { sma: true, bb: false, cone: true },
    route: { view: "overview" }, prevRoute: null
  };
  var DETAIL_TABS = { overview: "Overview", signals: "Chart signals", fundamentals: "Fundamentals", record: "Track record", about: "About" };
  var charts = [];      // { canvas, draw, ro } for everything that must redraw on resize / theme change
  var refreshTimer = null;

  /* ---------- tiny DOM helper ---------- */

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v; // only ever used with static strings
        else if (k === "style") node.style.cssText = v;
        else if (k.indexOf("on") === 0) node.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function append(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ---------- formatting ---------- */

  var fmtCache = {};
  function moneyFmt(currency, digits) {
    var key = currency + ":" + digits;
    if (!fmtCache[key]) {
      try {
        fmtCache[key] = new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD",
          minimumFractionDigits: digits, maximumFractionDigits: digits });
      } catch (e) {
        fmtCache[key] = { format: function (v) { return (currency || "") + " " + v.toFixed(digits); } };
      }
    }
    return fmtCache[key];
  }

  function money(v, currency, digits) {
    if (v == null || !isFinite(v)) return "–";
    return moneyFmt(currency, digits != null ? digits : Math.abs(v) >= 10 ? 2 : Math.abs(v) >= 1 ? 3 : 4).format(v);
  }

  function compact(v, currency) {
    if (v == null || !isFinite(v)) return "–";
    var abs = Math.abs(v), unit = "", n = v;
    if (abs >= 1e12) { n = v / 1e12; unit = "T"; } else if (abs >= 1e9) { n = v / 1e9; unit = "B"; } else if (abs >= 1e6) { n = v / 1e6; unit = "M"; } else if (abs >= 1e3) { n = v / 1e3; unit = "K"; }
    var s = n.toFixed(abs >= 1e3 && Math.abs(n) < 10 ? 2 : abs >= 1e3 ? 1 : 0) + unit;
    if (!currency) return s;
    var sym = moneyFmt(currency, 0).format(0).replace(/[\d.,\s]/g, "");
    return sym + s;
  }

  function pct(v, digits, signed) {
    if (v == null || !isFinite(v)) return "–";
    var d = digits == null ? 1 : digits;
    var s = (Math.abs(v) * 100).toFixed(d) + "%";
    if (signed === false) return s;
    return (v > 0 ? "+" : v < 0 ? "−" : "") + s;
  }

  function num(v, digits) {
    if (v == null || !isFinite(v)) return "–";
    return Number(v).toFixed(digits == null ? 2 : digits);
  }

  function dirOf(v, eps) {
    if (v == null || !isFinite(v)) return "flat";
    var e = eps == null ? 0.0005 : eps;
    return v > e ? "up" : v < -e ? "down" : "flat";
  }

  function delta(v, digits, eps) {
    // Flat means "rounds to zero at the shown precision", so the glyph always agrees with the number
    var d = digits == null ? 1 : digits;
    var e = eps == null ? 0.5 * Math.pow(10, -d - 2) : eps;
    var dir = dirOf(v, e);
    return el("span", { class: "delta delta--" + dir, text: v == null ? "–" : (dir === "flat" ? "0." + Array(d + 1).join("0") + "%" : pct(Math.abs(v), d, false)) });
  }

  function deltaMoney(v, currency) {
    var d = dirOf(v, 0.000001);
    return el("span", { class: "delta delta--" + d, text: v == null ? "–" : money(Math.abs(v), currency, 2) });
  }

  function dateLong(iso) {
    if (!iso) return "–";
    var d = new Date(iso.length > 10 ? iso : iso + "T12:00:00Z");
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function timeAgo(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    var m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 36) return h + (h === 1 ? " hour ago" : " hours ago");
    return Math.round(h / 24) + " days ago";
  }

  function stance(s) {
    var label = s ? s.charAt(0).toUpperCase() + s.slice(1) : "–";
    return el("span", { class: "chip chip--" + (s || "neutral").replace(/\s+/g, "-"), text: label });
  }

  function meter(value, cls) {
    var v = value == null ? 0 : Math.max(0, Math.min(100, value));
    return el("div", { class: "meter " + (cls || ""), role: "img", "aria-label": value == null ? "no score" : Math.round(v) + " out of 100" },
      el("div", { class: "meter__fill", style: "width:" + v + "%" }));
  }

  function scoreClass(v) {
    if (v == null) return "meter--flat";
    return v >= 62 ? "meter--up" : v <= 38 ? "meter--down" : "";
  }

  function bandBar(f, scale) {
    // A horizontal band around zero: p10–p90 light, p25–p75 darker, dot at the expected value
    var lim = scale || Math.max(0.02, Math.abs(f.p10), Math.abs(f.p90), Math.abs(f.ret)) * 1.1;
    var x = function (v) { return (50 + 50 * Math.max(-1, Math.min(1, v / lim))) + "%"; };
    var bar = el("div", { class: "band", role: "img", "aria-label": "Range " + pct(f.p10) + " to " + pct(f.p90) });
    bar.appendChild(el("div", { class: "band__fill", style: "left:" + x(f.p10) + ";right:" + (100 - parseFloat(x(f.p90))) + "%" }));
    bar.appendChild(el("div", { class: "band__core", style: "left:" + x(f.p25) + ";right:" + (100 - parseFloat(x(f.p75))) + "%" }));
    bar.appendChild(el("div", { class: "band__zero", style: "left:" + x(0) }));
    bar.appendChild(el("div", { class: "band__dot", style: "left:" + x(f.ret) }));
    return bar;
  }

  /* ---------- colors & canvas ---------- */

  function cssVar(name, fallback) {
    var v = getComputedStyle(root).getPropertyValue(name).trim();
    return v || fallback;
  }

  function palette() {
    return {
      text: cssVar("--text", "#1f1d1a"), soft: cssVar("--text-soft", "#45403a"), muted: cssVar("--muted", "#6b645b"),
      rule: cssVar("--rule", "#e2dace"), ruleStrong: cssVar("--rule-strong", "#cfc5b5"),
      bg: cssVar("--bg", "#faf7f2"), card: cssVar("--bg-elev", "#f2ece2"),
      up: cssVar("--green", "#0c7b60"), down: cssVar("--terracotta", "#a4461f"), model: cssVar("--indigo", "#4b3fa8"),
      sans: cssVar("--font-sans", "system-ui, sans-serif")
    };
  }

  function withAlpha(color, a) {
    var m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    var n = parseInt(m[1], 16);
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  function sizeCanvas(canvas) {
    var rect = canvas.getBoundingClientRect();
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(10, rect.width), h = Math.max(10, rect.height);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function registerChart(canvas, draw) {
    var entry = { canvas: canvas, draw: draw, ro: null };
    if ("ResizeObserver" in window) {
      entry.ro = new ResizeObserver(function () { if (canvas.isConnected) draw(); });
      entry.ro.observe(canvas);
    } else {
      requestAnimationFrame(draw);
    }
    charts.push(entry);
    return entry;
  }

  function dropCharts() {
    charts.forEach(function (c) { if (c.ro) c.ro.disconnect(); });
    charts = [];
  }

  root.addEventListener("themechange", function () { charts.forEach(function (c) { c.draw(); }); });

  function niceTicks(min, max, count) {
    var span = max - min || 1;
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = span / count / step;
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    var ticks = [];
    for (var v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v / step) * step);
    return ticks;
  }

  function sparkline(canvas, values, upGood) {
    registerChart(canvas, function () {
      var s = sizeCanvas(canvas), ctx = s.ctx, p = palette();
      var vals = values.filter(function (v) { return v != null; });
      if (vals.length < 2) return;
      var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
      var span = max - min || 1;
      var color = upGood ? (vals[vals.length - 1] >= vals[0] ? p.up : p.down) : p.muted;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.strokeStyle = color;
      ctx.beginPath();
      vals.forEach(function (v, i) {
        var x = 1 + (s.w - 2) * i / (vals.length - 1), y = s.h - 2 - (s.h - 4) * (v - min) / span;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 0.12;
      ctx.lineTo(s.w - 1, s.h); ctx.lineTo(1, s.h); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
      ctx.globalAlpha = 1;
      var lx = s.w - 1, ly = s.h - 2 - (s.h - 4) * (vals[vals.length - 1] - min) / span;
      ctx.fillStyle = p.bg; ctx.beginPath(); ctx.arc(lx - 1, ly, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx - 1, ly, 2.2, 0, Math.PI * 2); ctx.fill();
    });
  }

  /* ---------- data ---------- */

  function fetchJson(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(r.status + " " + url);
      return r.json();
    });
  }

  function loadSummary() {
    var sources = [];
    if (RAW) sources.push(RAW);
    sources.push(LOCAL);
    return Promise.all(sources.map(function (base) {
      return fetchJson(base + "summary.json").then(function (s) { return { base: base, summary: s }; }, function () { return null; });
    })).then(function (results) {
      var best = null;
      results.forEach(function (r) {
        if (r && r.summary && r.summary.tickers && (!best || r.summary.generatedAt > best.summary.generatedAt)) best = r;
      });
      if (!best) throw new Error("No data could be loaded.");
      return best;
    });
  }

  function loadTicker(symbol) {
    if (state.tickers[symbol]) return Promise.resolve(state.tickers[symbol]);
    if (!state.loading[symbol]) {
      state.loading[symbol] = fetchJson(state.base + "tickers/" + encodeURIComponent(symbol) + ".json").then(function (t) {
        state.tickers[symbol] = t;
        delete state.loading[symbol];
        return t;
      }, function (err) { delete state.loading[symbol]; throw err; });
    }
    return state.loading[symbol];
  }

  function tickerBySymbol(symbol) {
    var list = state.summary ? state.summary.tickers : [];
    for (var i = 0; i < list.length; i++) if (list[i].symbol === symbol) return list[i];
    return null;
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      if (document.hidden) { scheduleRefresh(); return; }
      loadSummary().then(function (best) {
        if (best.summary.generatedAt !== state.generatedAt) {
          state.summary = best.summary; state.base = best.base; state.generatedAt = best.summary.generatedAt;
          state.tickers = {};
          render();
        } else {
          renderStatus();
        }
      }).catch(function () {}).then(scheduleRefresh);
    }, REFRESH_MS);
  }

  /* ---------- router ---------- */

  function parseHash() {
    var h = (location.hash || "#/").replace(/^#\/?/, "");
    if (!h) return { view: "overview" };
    if (h === "method") return { view: "method" };
    var parts = h.split("/");
    var tab = (parts[1] || "overview").toLowerCase();
    if (!DETAIL_TABS[tab]) tab = "overview";
    return { view: "detail", symbol: decodeURIComponent(parts[0]).toUpperCase(), tab: tab };
  }

  function render() {
    dropCharts();
    state.prevRoute = state.route;
    state.route = parseHash();
    tabs.forEach(function (t) {
      var current = t.getAttribute("data-view") === state.route.view;
      if (current) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    renderStatus();
    clear(view);
    if (!state.summary) return;
    if (state.route.view === "method") renderMethod();
    else if (state.route.view === "detail") renderDetail(state.route.symbol);
    else renderOverview();
    var prev = state.prevRoute || {};
    var sameDetail = state.route.view === "detail" && prev.view === "detail" && prev.symbol === state.route.symbol;
    if (state.route.view !== "overview" && !sameDetail) window.scrollTo({ top: app.offsetTop - 60, behavior: "auto" });
  }

  function renderStatus() {
    clear(statusEl);
    if (!state.summary) return;
    var s = state.summary;
    var open = s.session && (s.session.us === "open" || s.session.milan === "open");
    statusEl.appendChild(document.createTextNode("Data from " + timeAgo(s.generatedAt)));
    if (open) statusEl.appendChild(el("span", { class: "chip", text: "Market open" }));
    statusEl.title = "Generated " + new Date(s.generatedAt).toLocaleString();
  }

  /* ---------- overview ---------- */

  var SORTS = {
    name: function (t) { return t.name.toLowerCase(); },
    price: function (t) { return liveChange(t); },
    forecast: function (t) { var f = t.forecasts[state.horizon]; return f ? f.ret : -Infinity; },
    pup: function (t) { var f = t.forecasts[state.horizon]; return f ? f.pUp : -Infinity; },
    fv: function (t) { return t.fairValue ? t.fairValue.marginOfSafety : -Infinity; },
    overall: function (t) { return t.scores.overall == null ? -Infinity : t.scores.overall; },
    technical: function (t) { return t.scores.technical == null ? -Infinity : t.scores.technical; },
    fundamental: function (t) { return t.scores.fundamental == null ? -Infinity : t.scores.fundamental; }
  };

  function liveChange(t) {
    var q = stream.quotes[t.symbol];
    return q && q.changePercent != null ? q.changePercent / 100 : t.changePct;
  }

  function livePrice(t) {
    var q = stream.quotes[t.symbol];
    return q && q.price > 0 ? q.price : t.price;
  }

  function glanceLink(t) {
    return el("a", { href: "#/" + encodeURIComponent(t.symbol), text: t.name, onclick: function (e) { e.preventDefault(); go(t.symbol); } });
  }

  function glanceCard(title, items, emptyText) {
    var card = el("div", { class: "card", dataset: { glance: title } }, el("p", { class: "card__title", text: title }));
    if (items.length) card.appendChild(el("ul", { class: "glance__list" }, items));
    else card.appendChild(el("p", { class: "glance__empty", text: emptyText }));
    return card;
  }

  function moversCard(s) {
    var rows = s.tickers.filter(function (t) { return liveChange(t) != null; }).sort(function (a, b) { return Math.abs(liveChange(b)) - Math.abs(liveChange(a)); }).slice(0, 5);
    var anyLive = rows.some(function (t) { return stream.quotes[t.symbol]; });
    return glanceCard(anyLive ? "Biggest moves right now" : "Biggest moves, last session", rows.map(function (t) {
      return el("li", {}, glanceLink(t), delta(liveChange(t), 1), el("small", { text: t.symbol + " · " + money(livePrice(t), t.currency) }));
    }), "No prices yet.");
  }

  function forecastsCard(s) {
    var h = state.horizon;
    var rows = s.tickers.filter(function (t) { return t.forecasts[h]; }).sort(function (a, b) { return b.forecasts[h].relRet - a.forecasts[h].relRet; }).slice(0, 5);
    return glanceCard("Model's favourites, " + HORIZON_NAMES[h], rows.map(function (t) {
      var f = t.forecasts[h];
      return el("li", {}, glanceLink(t), delta(f.ret, 1), el("small", { text: Math.round(f.pUp * 100) + "% chance of a gain · " + pct(f.relRet, 1) + " vs the others" }));
    }), "No forecasts yet.");
  }

  function valueCard(s) {
    var rows = s.tickers.filter(function (t) { return t.fairValue && t.fairValue.marginOfSafety > 0.005; }).sort(function (a, b) { return b.fairValue.marginOfSafety - a.fairValue.marginOfSafety; }).slice(0, 5);
    return glanceCard("Furthest below fair value", rows.map(function (t) {
      return el("li", {}, glanceLink(t), delta(t.fairValue.marginOfSafety, 0), el("small", { text: "fair value " + money(t.fairValue.value, t.currency) + " vs " + money(livePrice(t), t.currency) }));
    }), "Nothing trades below its estimated fair value right now.");
  }

  function renderOverview() {
    document.title = "Stocks";
    var s = state.summary;
    view.appendChild(marketStrip(s));

    var glance = el("div", { class: "glance" });
    view.appendChild(glance);
    function drawGlance() {
      clear(glance);
      glance.appendChild(moversCard(s));
      glance.appendChild(forecastsCard(s));
      glance.appendChild(valueCard(s));
    }
    drawGlance();
    glanceRedraw = drawGlance;

    var sectors = {};
    s.tickers.forEach(function (t) { if (t.sector && t.type !== "ETF") sectors[t.sector] = true; });
    var search = el("input", { type: "search", placeholder: "Search by name or symbol", value: state.query, "aria-label": "Search stocks",
      oninput: function (e) { state.query = e.target.value; drawTable(); } });
    var seg = el("div", { class: "seg", role: "group", "aria-label": "Forecast horizon" },
      [1, 5, 21, 63].map(function (h) {
        return el("button", { type: "button", "aria-pressed": state.horizon === h ? "true" : "false", text: HORIZON_SHORT[h],
          onclick: function () { state.horizon = h; drawTable(); drawGlance(); seg.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", b.textContent === HORIZON_SHORT[h] ? "true" : "false"); }); } });
      }));
    var count = el("span", { class: "stocks-filters__count" });
    view.appendChild(el("div", { class: "stocks-filters" }, search, el("label", {}, "Forecast horizon ", seg), count));

    var chips = el("ul", { class: "chips", role: "group", "aria-label": "Sector" });
    function chip(value, label) {
      return el("li", {}, el("button", { type: "button", text: label, "aria-pressed": state.sector === value ? "true" : "false", onclick: function () {
        state.sector = value;
        chips.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
        this.setAttribute("aria-pressed", "true");
        drawTable();
      } }));
    }
    chips.appendChild(chip("", "All"));
    Object.keys(sectors).sort().forEach(function (k) { chips.appendChild(chip(k, k)); });
    chips.appendChild(chip("ETF", "Funds"));
    view.appendChild(chips);

    var wrap = el("div", { class: "stocks-table-wrap" });
    view.appendChild(wrap);

    function drawTable() {
      dropCharts();
      clear(wrap);
      var q = state.query.trim().toLowerCase();
      var rows = s.tickers.filter(function (t) {
        if (state.sector === "ETF" && t.type !== "ETF") return false;
        if (state.sector && state.sector !== "ETF" && t.sector !== state.sector) return false;
        if (!q) return true;
        return t.symbol.toLowerCase().indexOf(q) >= 0 || t.name.toLowerCase().indexOf(q) >= 0 || (t.sector || "").toLowerCase().indexOf(q) >= 0;
      });
      var key = SORTS[state.sort.key] || SORTS.overall;
      rows.sort(function (a, b) {
        var va = key(a), vb = key(b);
        if (va === vb) return a.symbol < b.symbol ? -1 : 1;
        if (typeof va === "string") return va < vb ? state.sort.dir : -state.sort.dir;
        return (va < vb ? -1 : 1) * state.sort.dir;
      });
      count.textContent = rows.length + " of " + s.tickers.length;

      function th(label, sortKey, cls) {
        var attrs = { scope: "col", class: cls || "" };
        if (sortKey && state.sort.key === sortKey) attrs["aria-sort"] = state.sort.dir < 0 ? "descending" : "ascending";
        var cell = el("th", attrs);
        if (!sortKey) { cell.textContent = label; return cell; }
        cell.appendChild(el("button", { type: "button", text: label, onclick: function () {
          if (state.sort.key === sortKey) state.sort.dir = -state.sort.dir; else state.sort = { key: sortKey, dir: sortKey === "name" ? 1 : -1 };
          drawTable();
        } }));
        return cell;
      }

      var table = el("table", { class: "stocks-table" },
        el("thead", {}, el("tr", {},
          th("Company", "name"), th("Price", "price"), th("60 days", null, "hide-xs"),
          th("Forecast, " + HORIZON_NAMES[state.horizon], "forecast"),
          th("Fair value", "fv", "hide-sm"), th("Score", "overall", "hide-xs"))),
        el("tbody", {}, rows.map(tableRow)));
      wrap.appendChild(table);
      if (!rows.length) wrap.appendChild(el("p", { class: "record-empty", style: "padding:1.25rem", text: "Nothing matches." }));
    }

    function tableRow(t) {
      var f = t.forecasts[state.horizon];
      var fvCell = el("td", { class: "fv hide-sm" });
      if (t.fairValue) {
        fvCell.appendChild(delta(t.fairValue.marginOfSafety, 0, 0.005));
        fvCell.appendChild(el("small", { text: money(t.fairValue.value, t.currency) }));
      } else {
        fvCell.appendChild(el("span", { class: "muted", text: t.type === "ETF" ? "fund" : "–" }));
      }
      var spark = el("canvas", { class: "spark", role: "img", "aria-label": "Last 60 closes" });
      var fcCell = el("td", { class: "fc-cell" });
      if (f) {
        fcCell.appendChild(el("div", { class: "fc-cell__main" }, delta(f.ret, 1), el("small", { text: Math.round(f.pUp * 100) + "% up · " + pct(f.p10, 0) + " to " + pct(f.p90, 0) })));
        fcCell.appendChild(bandBar(f, bandScale()));
      } else fcCell.textContent = "–";
      var priceCell = el("td", { class: "price", dataset: { price: t.symbol } });
      fillPriceCell(priceCell, t);
      var row = el("tr", { dataset: { symbol: t.symbol }, tabindex: "-1" },
        el("td", {}, el("div", { class: "name" },
          el("a", { href: "#/" + encodeURIComponent(t.symbol), text: t.name, onclick: function (e) { e.preventDefault(); go(t.symbol); } }),
          el("small", {}, el("b", { text: t.symbol }), t.sector ? " · " + t.sector : t.type === "ETF" ? " · Fund" : ""))),
        priceCell,
        el("td", { class: "hide-xs" }, spark),
        fcCell,
        fvCell,
        el("td", { class: "score-cell hide-xs" },
          el("div", { class: "score-cell__row" }, el("b", { text: t.scores.overall == null ? "–" : Math.round(t.scores.overall) }), meter(t.scores.overall, scoreClass(t.scores.overall))),
          el("small", {}, "Chart " + (t.scores.technical == null ? "–" : Math.round(t.scores.technical)) + " · Fundamentals " + (t.scores.fundamental == null ? "–" : Math.round(t.scores.fundamental))),
          t.scores.outlook ? el("div", { class: "score-cell__outlook" }, stance(t.scores.outlook)) : null));
      row.addEventListener("click", function (e) { if (e.target.closest("a")) return; go(t.symbol); });
      sparkline(spark, t.spark, true);
      return row;
    }

    function bandScale() {
      var m = 0.02;
      s.tickers.forEach(function (t) { var f = t.forecasts[state.horizon]; if (f) m = Math.max(m, Math.abs(f.p10), Math.abs(f.p90)); });
      return m * 1.05;
    }

    drawTable();
  }

  var glanceRedraw = null;

  function sessionLabel(q) {
    if (!q) return "";
    return q.marketHours === 0 ? "pre-market" : q.marketHours === 2 ? "after hours" : q.marketHours === 3 ? "extended hours" : "";
  }

  function tickTime(q) {
    return new Date(q.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function fillPriceCell(cell, t) {
    clear(cell);
    var q = stream.quotes[t.symbol];
    var price = livePrice(t);
    var change = liveChange(t);
    cell.appendChild(el("span", { class: "price-tick" + (q && q.flash ? " is-" + q.flash : ""), text: money(price, t.currency) }));
    cell.appendChild(el("small", {}, delta(change, 2, 0.00005)));
    cell.title = q ? "Live from Yahoo Finance" + (sessionLabel(q) ? ", " + sessionLabel(q) : "") + ", " + tickTime(q) : "From the last data run";
  }

  function go(symbol) {
    location.hash = "#/" + encodeURIComponent(symbol);
  }

  function marketStrip(s) {
    var m = s.market || {};
    var tiles = [];
    function tile(label, value, note) {
      tiles.push(el("div", { class: "stat" }, el("p", { class: "stat__label", text: label }), el("p", { class: "stat__value" }, value), note ? el("p", { class: "stat__note" }, note) : null));
    }
    tile("S&P 500, past month", delta(m.sp500Ret1m, 1), "Year to date " + pct(m.sp500Ytd, 1));
    tile("VIX", el("span", { text: m.vix == null ? "–" : num(m.vix, 1) }), m.vixChange5d == null ? null : el("span", {}, "5 days: ", delta(m.vixChange5d, 0)));
    tile("US 10-year yield", el("span", { text: m.tnx == null ? "–" : num(m.tnx, 2) + "%" }), "Treasury rate");
    tile("Above 200-day average", el("span", { text: Math.round((m.breadthAbove200 || 0) * 100) + "%" }), "of tracked stocks");
    tile("Model leans up, 1 month", el("span", { text: Math.round((m.breadthUp1m || 0) * 100) + "%" }), "of tracked stocks");
    tile("Data as of", el("span", { text: dateLong(s.asOf) }), "Updated " + timeAgo(s.generatedAt));
    return el("div", { class: "mkt-strip" }, tiles);
  }

  /* ---------- detail ---------- */

  function renderDetail(symbol) {
    var t = tickerBySymbol(symbol);
    if (!t) {
      view.appendChild(el("div", { class: "stocks__error" }, el("p", { class: "stocks__error-title", text: "No such stock here." }),
        el("p", {}, el("a", { href: "#/", text: "Back to the overview" }))));
      return;
    }
    document.title = t.name + " · Stocks";
    var box = el("div", { class: "detail" });
    view.appendChild(box);
    box.appendChild(el("a", { class: "detail__back", href: "#/", text: "← All stocks" }));
    box.appendChild(detailHead(t));
    box.appendChild(verdictCard(t));
    var tabsEl = detailTabs(t, null);
    box.appendChild(tabsEl);
    var body = el("div", { class: "detail__body" }, el("div", { class: "stocks__loading" }, el("p", { class: "stocks__loading-title", text: "Loading " + t.symbol + "…" })));
    box.appendChild(body);
    loadTicker(symbol).then(function (d) {
      if (state.route.view !== "detail" || state.route.symbol !== symbol) return;
      var fresh = detailTabs(t, d);
      tabsEl.parentNode.replaceChild(fresh, tabsEl);
      clear(body);
      detailBody(body, t, d);
    }).catch(function (err) {
      clear(body);
      body.appendChild(el("div", { class: "stocks__error" }, el("p", { class: "stocks__error-title", text: "Couldn't load the details." }),
        el("p", { class: "small", text: String(err.message || err) })));
    });
  }

  function detailHead(t) {
    var q = stream.quotes[t.symbol];
    var price = livePrice(t);
    var change = q && q.change != null ? q.change : t.change;
    var changePct = liveChange(t);
    var note = t.live ? "During today's session, as of the last data run" : "Close of " + dateLong(t.asOf);
    if (q) note = "Live from Yahoo Finance" + (sessionLabel(q) ? ", " + sessionLabel(q) : "") + ", " + tickTime(q);
    var head = el("div", { class: "detail__head", dataset: { head: t.symbol } },
      el("div", {},
        el("h2", { class: "detail__title" }, t.name, el("small", { text: t.symbol })),
        el("p", { class: "detail__meta", text: [t.sector, t.industry, t.exchange].filter(Boolean).join(" · ") || (t.type === "ETF" ? "Exchange-traded fund" : "") })),
      el("div", { class: "detail__price" },
        el("p", { class: "detail__price-value" }, el("span", { class: "price-tick" + (q && q.flash ? " is-" + q.flash : ""), text: money(price, t.currency) }), el("small", { text: t.currency })),
        el("p", { class: "detail__price-change" }, deltaMoney(change, t.currency), " ", delta(changePct, 2, 0.00005)),
        el("p", { class: "detail__price-note" }, note, q ? el("span", { class: "chip chip--live", text: "Live" }) : null)));
    return head;
  }

  function forecastRank(t, h) {
    var list = state.summary.tickers.filter(function (x) { return x.forecasts[h]; });
    if (!list.length || !t.forecasts[h]) return null;
    var mine = t.forecasts[h];
    var better = list.filter(function (x) { var f = x.forecasts[h]; return f.relRet > mine.relRet || (f.relRet === mine.relRet && f.conviction > mine.conviction); }).length;
    return { rank: better + 1, n: list.length };
  }

  function scoreStance(v) {
    return v == null ? "neutral" : v >= 62 ? "bullish" : v <= 38 ? "bearish" : "neutral";
  }

  function verdictCard(t) {
    var sc = t.scores || {};
    var out = sc.outlook || "neutral";
    var word = out === "positive" ? "leans positive" : out === "negative" ? "leans negative" : "is mixed";
    var lead = el("p", { class: "verdict-card__lead" }, "Overall score ", el("b", { text: sc.overall == null ? "–" : Math.round(sc.overall) }), " of 100: the evidence on " + t.name + " " + word + ".");
    var cols = [];
    var f = t.forecasts[21];
    if (f) {
      var rk = forecastRank(t, 21);
      cols.push(el("div", { class: "verdict-card__col" }, el("h3", { text: "Model, next month" }),
        el("p", {}, "Expects ", delta(f.ret, 1), " with a ", el("b", { text: Math.round(f.pUp * 100) + "%" }), " chance of a gain", rk ? [": ranked ", el("b", { text: rk.rank + " of " + rk.n }), " tracked stocks for the month ahead."] : "."),
        stance(scoreStance(sc.model))));
    }
    var st = t.stances || {};
    var keys = ["trend", "momentum", "oscillators", "volume"].filter(function (k) { return st[k]; });
    var chartText = keys.length ? keys.map(function (k) { return k + " " + st[k]; }).join(", ") + "." : "No readings yet.";
    chartText = chartText.charAt(0).toUpperCase() + chartText.slice(1);
    cols.push(el("div", { class: "verdict-card__col" }, el("h3", { text: "Chart" }), el("p", { text: chartText }), stance(scoreStance(sc.technical))));
    if (t.type !== "ETF") {
      var fv = t.fairValue, v = t.view12m;
      var fundText = fv
        ? el("p", {}, "Fair value ", el("b", { text: money(fv.value, t.currency) }), ", " + pct(Math.abs(fv.marginOfSafety), 0, false) + (fv.marginOfSafety >= 0 ? " above" : " below") + " the price", v ? [". Twelve-month view ", delta(v.expectedReturn12m, 0), " including the dividend."] : ".")
        : el("p", { text: "Not enough data for a fair value." });
      cols.push(el("div", { class: "verdict-card__col" }, el("h3", { text: "Fundamentals" }), fundText, stance(fv ? fv.label : "neutral")));
    } else {
      cols.push(el("div", { class: "verdict-card__col" }, el("h3", { text: "Fundamentals" }), el("p", { text: "A fund has no fundamentals of its own; its score is the model and the chart." })));
    }
    return el("div", { class: "verdict-card" }, lead, cols);
  }

  function detailTabs(t, d) {
    var ul = el("ul", { class: "detail__tabs" });
    Object.keys(DETAIL_TABS).forEach(function (k) {
      if (k === "fundamentals" && t.type === "ETF") return;
      var extra = null;
      if (k === "record" && d && d.ledger) {
        var n = d.ledger.resolved.length;
        extra = el("small", { text: n ? n + " graded" : d.ledger.pending.length + " pending" });
      }
      ul.appendChild(el("li", {}, el("a", { href: "#/" + encodeURIComponent(t.symbol) + (k === "overview" ? "" : "/" + k), "aria-current": (state.route.tab || "overview") === k ? "page" : null, text: DETAIL_TABS[k] }, extra)));
    });
    return ul;
  }

  function detailBody(body, t, d) {
    var tab = state.route.tab || "overview";
    if (tab === "fundamentals" && t.type === "ETF") tab = "overview";
    if (tab === "overview") {
      body.appendChild(summaryTiles(t, d));
      body.appendChild(priceChartCard(t, d));
      body.appendChild(el("h2", { class: "section-title", text: "Forecasts" }));
      body.appendChild(forecastGrid(t, d));
      body.appendChild(el("h2", { class: "section-title", text: "Scores" }));
      body.appendChild(scoreGrid(t, d));
    } else if (tab === "signals") {
      body.appendChild(el("h2", { class: "section-title", text: "What the chart says" }));
      var parts = d.technical && d.technical.parts;
      if (parts) {
        body.appendChild(el("div", { class: "card", style: "margin-bottom:.75rem" },
          el("p", { class: "card__title", text: "Chart score " + (t.scores.technical == null ? "–" : Math.round(t.scores.technical)) + " of 100" }),
          partsList(parts, TECH_PARTS),
          el("p", { class: "small muted", style: "margin:.6rem 0 0", text: "Trend 30%, momentum 30%, oscillators 15%, volume 15%, volatility 10%. The readings below are what the score is made of." })));
      }
      body.appendChild(readingsSection(t, d));
    } else if (tab === "fundamentals") {
      body.appendChild(el("h2", { class: "section-title", text: "Fundamentals" }));
      body.appendChild(fundamentalsSection(t, d));
    } else if (tab === "record") {
      body.appendChild(el("h2", { class: "section-title", text: "Track record for " + t.symbol }));
      body.appendChild(el("p", { class: "small muted", style: "margin:0 0 .75rem", text: "Every forecast is written down when it is made and graded against the real price when its horizon passes. Nothing here can be adjusted in hindsight." }));
      body.appendChild(ledgerSection(t, d));
    } else if (tab === "about") {
      body.appendChild(el("h2", { class: "section-title", text: "About " + t.name }));
      body.appendChild(aboutSection(t, d));
    }
  }

  function summaryTiles(t, d) {
    var st = d.stats || {};
    var q = stream.quotes[t.symbol];
    var tiles = el("div", { class: "detail__summary" });
    function tile(label, value, note, noteAttrs) {
      tiles.appendChild(el("div", { class: "stat" }, el("p", { class: "stat__label", text: label }), el("p", { class: "stat__value" }, value), note ? el("p", Object.assign({ class: "stat__note" }, noteAttrs || {}), note) : null));
    }
    var lo = q && q.dayLow > 0 ? q.dayLow : d.dayLow, hi = q && q.dayHigh > 0 ? q.dayHigh : d.dayHigh;
    tile("Open", money(q && q.open > 0 ? q.open : d.open, t.currency), "Day " + money(lo, t.currency) + " – " + money(hi, t.currency), { dataset: { range: t.symbol } });
    tile("Volume", el("span", { dataset: { volume: t.symbol }, text: compact(q && q.dayVolume > 0 ? q.dayVolume : d.volume) }), "Average " + compact(st.avgVolume20));
    if (t.marketCap) tile("Market cap", compact(t.marketCap, t.currency), st.beta63 != null ? "Beta " + num(st.beta63, 2) : null);
    tile("1 month", delta(st.ret1m, 1), "This year " + pct(st.ytd, 1));
    tile("1 year", delta(st.ret1y, 1), "Worst drop " + pct(st.maxDrawdown1y, 0));
    tile("Volatility", (st.vol21 == null ? "–" : Math.round(st.vol21 * 100) + "%"), "annualised, last month");
    if (st.high52 && st.low52) {
      var pos = Math.max(0, Math.min(1, (livePrice(t) - st.low52) / (st.high52 - st.low52)));
      tiles.appendChild(el("div", { class: "range52" }, el("span", { text: money(st.low52, t.currency) }),
        el("div", { class: "range52__bar", role: "img", "aria-label": "52-week range, " + Math.round(pos * 100) + "% of the way from low to high" }, el("div", { class: "range52__dot", style: "left:" + (pos * 100) + "%" })),
        el("span", { text: money(st.high52, t.currency) }), el("span", { class: "muted", text: "52-week range" })));
    }
    return tiles;
  }

  function kvRow(label, value, sub) {
    return el("tr", {}, el("th", { scope: "row", text: label }), el("td", {}, value == null || value === "" ? "–" : value, sub ? el("small", { text: sub }) : null));
  }

  function aboutSection(t, d) {
    var info = (d.fundamentals && d.fundamentals.info) || {};
    var cols = el("div", { class: "two-col" });
    cols.appendChild(el("div", { class: "card" }, el("p", { class: "card__title", text: t.type === "ETF" ? "The fund" : "The company" }),
      el("div", { class: "desc" },
        d.description ? el("p", { text: d.description + (d.description.length >= 600 ? "…" : "") }) : el("p", { class: "muted", text: "No description is available." }),
        d.website ? el("p", {}, el("a", { href: d.website, rel: "noopener", text: d.website.replace(/^https?:\/\//, "") })) : null)));
    cols.appendChild(el("div", { class: "card" }, el("p", { class: "card__title", text: "Listing and data" }), el("table", { class: "kv" }, el("tbody", {},
      kvRow("Symbol", t.symbol), kvRow("Exchange", t.exchange), kvRow("Currency", t.currency),
      kvRow("Sector", t.sector, t.industry), kvRow("Country", d.country),
      kvRow("Prices as of", dateLong(d.asOf), t.live ? "a session in progress at the time of the run" : "close"),
      kvRow("Last data run", d.generatedAt ? new Date(d.generatedAt).toLocaleString() : "–"),
      kvRow("Fundamentals fetched", info.fetchedAt ? dateLong(info.fetchedAt.slice(0, 10)) : "–", info.stale ? "Yahoo didn't answer on the last run; showing the previous values" : null),
      kvRow("Real-time prices", stream.quotes[t.symbol] ? "Streaming from Yahoo Finance" : stream.status === "off" ? "Not available in this browser" : "Stream connected; ticks arrive while the market trades")))));
    return cols;
  }

  /* ---------- the price chart ---------- */

  function priceChartCard(t, d) {
    var card = el("div", { class: "card chart-card" });
    var p = palette();
    var legend = el("ul", { class: "chart-card__legend" },
      el("li", {}, el("i", { style: "--legend:" + p.text }), "Close"),
      el("li", { class: "lg-sma50" }, el("i", { style: "--legend:" + p.model }), "50-day"),
      el("li", { class: "lg-sma200" }, el("i", { style: "--legend:" + p.down }), "200-day"),
      el("li", { class: "lg-bb" }, el("i", { class: "is-area", style: "--legend:" + p.muted }), "Bollinger"),
      el("li", { class: "lg-cone" }, el("i", { class: "is-area", style: "--legend:" + p.model }), "Forecast, 50% and 80% bands"));
    var ranges = el("div", { class: "seg", role: "group", "aria-label": "Range" },
      [[63, "3m"], [126, "6m"], [252, "1y"], [504, "2y"]].map(function (r) {
        return el("button", { type: "button", text: r[1], "aria-pressed": state.range === r[0] ? "true" : "false", onclick: function () {
          state.range = r[0]; ranges.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", b.textContent === r[1] ? "true" : "false"); }); chart.draw();
        } });
      }));
    var toggles = el("div", { class: "seg", role: "group", "aria-label": "Overlays" },
      [["sma", "Averages"], ["bb", "Bollinger"], ["cone", "Forecast"]].map(function (o) {
        return el("button", { type: "button", text: o[1], "aria-pressed": state.overlays[o[0]] ? "true" : "false", onclick: function (e) {
          state.overlays[o[0]] = !state.overlays[o[0]]; e.currentTarget.setAttribute("aria-pressed", state.overlays[o[0]] ? "true" : "false"); chart.draw();
        } });
      }));
    card.appendChild(el("div", { class: "chart-card__bar" }, legend, el("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap" }, ranges, toggles)));
    var holder = el("div", { class: "chart chart--price" });
    var canvas = el("canvas", { tabindex: "0", role: "img", "aria-label": "Price chart for " + t.name + " with moving averages and the forecast range. Use the left and right arrow keys to read values." });
    var tip = el("div", { class: "chart__tip", hidden: true });
    holder.appendChild(canvas); holder.appendChild(tip);
    card.appendChild(holder);
    var chart = priceChart(canvas, tip, t, d);

    // RSI and MACD below
    var sub = el("div", { class: "chart-card__sub" });
    var rsiLast = lastDefined(d.indicators.rsi14);
    var macdLast = lastDefined(d.indicators.macdHist);
    var rsiH = el("h3", {}, "RSI 14", el("span", { text: rsiLast == null ? "" : num(rsiLast, 0) }));
    var macdH = el("h3", {}, "MACD 12 · 26 · 9", el("span", { text: macdLast == null ? "" : (macdLast > 0 ? "+" : "") + num(macdLast, 2) }));
    var rsiC = el("canvas", { role: "img", "aria-label": "RSI, last value " + num(rsiLast, 0) });
    var macdC = el("canvas", { role: "img", "aria-label": "MACD histogram" });
    sub.appendChild(el("div", {}, rsiH, el("div", { class: "chart chart--rsi" }, rsiC)));
    sub.appendChild(el("div", {}, macdH, el("div", { class: "chart chart--macd" }, macdC)));
    card.appendChild(sub);
    rsiChart(rsiC, d);
    macdChart(macdC, d);
    return card;
  }

  function lastDefined(arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }

  function priceChart(canvas, tip, t, d) {
    var h = d.history, ind = d.indicators;
    var cursor = null; // index into the visible window
    var geom = null;

    function visible() {
      var n = h.close.length;
      var start = Math.max(0, n - state.range);
      return { start: start, n: n - start };
    }

    function conePath() {
      // Interpolate the forecast quantiles between horizons (in sqrt-time, as uncertainty grows)
      var fcs = d.forecasts || {};
      var hs = [1, 5, 21, 63].filter(function (x) { return fcs[x]; });
      if (!hs.length) return null;
      var last = h.close[h.close.length - 1];
      var keys = ["p10", "p25", "ret", "p75", "p90"];
      var pts = { 0: { p10: 0, p25: 0, ret: 0, p75: 0, p90: 0 } };
      hs.forEach(function (x) { pts[x] = fcs[x]; });
      var xs = [0].concat(hs);
      var maxH = hs[hs.length - 1];
      var path = [];
      for (var step = 0; step <= maxH; step++) {
        var i = 0; while (i < xs.length - 1 && xs[i + 1] < step) i++;
        var a = xs[i], b = xs[Math.min(i + 1, xs.length - 1)];
        var w = b === a ? 0 : (Math.sqrt(step) - Math.sqrt(a)) / (Math.sqrt(b) - Math.sqrt(a));
        var row = { step: step };
        keys.forEach(function (k) { row[k] = last * (1 + pts[a][k] + (pts[b][k] - pts[a][k]) * w); });
        path.push(row);
      }
      return { path: path, maxH: maxH, horizons: hs };
    }

    function draw() {
      var s = sizeCanvas(canvas), ctx = s.ctx, p = palette();
      var vis = visible();
      var cone = state.overlays.cone ? conePath() : null;
      var future = cone ? cone.maxH : 0;
      var padL = 8, padR = 62, padT = 14, padB = 26;
      var volH = Math.round((s.h - padT - padB) * 0.16);
      var plotH = s.h - padT - padB - volH - 6;
      var W = s.w - padL - padR;
      var slots = vis.n + future + (future ? 2 : 1);
      var dx = W / slots;
      var xAt = function (i) { return padL + (i + 0.5) * dx; };

      // Y range over visible closes, averages, bands and the cone
      var lo = Infinity, hi = -Infinity;
      for (var i = vis.start; i < vis.start + vis.n; i++) {
        var vals = [h.low[i], h.high[i]];
        if (state.overlays.sma) vals.push(ind.sma50[i], ind.sma200[i]);
        if (state.overlays.bb) vals.push(ind.bbUpper[i], ind.bbLower[i]);
        vals.forEach(function (v) { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } });
      }
      if (cone) cone.path.forEach(function (r) { if (r.p10 < lo) lo = r.p10; if (r.p90 > hi) hi = r.p90; });
      if (!isFinite(lo) || !isFinite(hi)) return;
      var pad = (hi - lo) * 0.06 || 1;
      lo -= pad; hi += pad;
      var yAt = function (v) { return padT + plotH - (v - lo) / (hi - lo) * plotH; };
      geom = { xAt: xAt, yAt: yAt, dx: dx, vis: vis, padL: padL, W: W, top: padT, bottom: padT + plotH };

      // Grid and y labels
      ctx.font = "500 11px " + p.sans;
      ctx.fillStyle = p.muted;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.strokeStyle = p.rule; ctx.lineWidth = 1;
      niceTicks(lo, hi, 5).forEach(function (v) {
        var y = Math.round(yAt(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
        ctx.fillText(money(v, t.currency).replace(/\.00$/, ""), padL + W + 8, y);
      });
      // X labels: month boundaries
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      var lastMonth = null, labelEvery = vis.n > 300 ? 3 : vis.n > 150 ? 2 : 1, count = 0;
      for (i = vis.start; i < vis.start + vis.n; i++) {
        var m = h.dates[i].slice(0, 7);
        if (m !== lastMonth) {
          lastMonth = m;
          if (count++ % labelEvery === 0) {
            var dt = new Date(h.dates[i] + "T12:00:00Z");
            var label = dt.toLocaleDateString(undefined, { month: "short" }) + (dt.getUTCMonth() === 0 || vis.n > 300 ? " " + String(dt.getUTCFullYear()).slice(2) : "");
            ctx.fillStyle = p.muted;
            ctx.fillText(label, xAt(i - vis.start), s.h - padB + 8);
          }
        }
      }

      // Volume
      var vmax = 0;
      for (i = vis.start; i < vis.start + vis.n; i++) if (h.volume[i] > vmax) vmax = h.volume[i];
      var volTop = padT + plotH + 6;
      for (i = vis.start; i < vis.start + vis.n; i++) {
        if (!h.volume[i]) continue;
        var bh = (h.volume[i] / vmax) * volH;
        ctx.fillStyle = withAlpha(h.close[i] >= (h.open[i] || h.close[i]) ? p.up : p.down, 0.35);
        ctx.fillRect(xAt(i - vis.start) - Math.max(0.5, dx * 0.35), volTop + volH - bh, Math.max(1, dx * 0.7), bh);
      }

      // Bollinger band
      if (state.overlays.bb) {
        ctx.beginPath();
        var started = false;
        for (i = vis.start; i < vis.start + vis.n; i++) { if (ind.bbUpper[i] == null) continue; var x = xAt(i - vis.start), y = yAt(ind.bbUpper[i]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
        for (i = vis.start + vis.n - 1; i >= vis.start; i--) { if (ind.bbLower[i] == null) continue; ctx.lineTo(xAt(i - vis.start), yAt(ind.bbLower[i])); }
        ctx.closePath();
        ctx.fillStyle = withAlpha(p.muted, 0.1); ctx.fill();
      }

      // Forecast cone
      if (cone) {
        var x0 = xAt(vis.n - 1);
        var bandFill = function (loKey, hiKey, alpha) {
          ctx.beginPath();
          cone.path.forEach(function (r, k) { var x = x0 + k * dx, y = yAt(r[hiKey]); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
          for (var k = cone.path.length - 1; k >= 0; k--) ctx.lineTo(x0 + k * dx, yAt(cone.path[k][loKey]));
          ctx.closePath();
          ctx.fillStyle = withAlpha(p.model, alpha); ctx.fill();
        };
        bandFill("p10", "p90", 0.1);
        bandFill("p25", "p75", 0.14);
        ctx.beginPath();
        cone.path.forEach(function (r, k) { var x = x0 + k * dx, y = yAt(r.ret); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.strokeStyle = p.model; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
        // "now" divider and horizon markers
        ctx.strokeStyle = p.ruleStrong; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, padT); ctx.lineTo(Math.round(x0) + 0.5, padT + plotH); ctx.stroke();
        ctx.fillStyle = p.muted; ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = "500 10px " + p.sans;
        cone.horizons.forEach(function (hz) {
          var x = x0 + hz * dx;
          if (hz >= 5 || cone.horizons.length < 3) ctx.fillText(HORIZON_SHORT[hz], x, s.h - padB + 8);
          var r = cone.path[hz];
          ctx.fillStyle = p.bg; ctx.beginPath(); ctx.arc(x, yAt(r.ret), 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = p.model; ctx.beginPath(); ctx.arc(x, yAt(r.ret), 2.3, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = p.muted;
        });
      }

      // Averages
      function line(arr, color, width) {
        ctx.beginPath(); var on = false;
        for (var j = vis.start; j < vis.start + vis.n; j++) {
          if (arr[j] == null) { on = false; continue; }
          var x = xAt(j - vis.start), y = yAt(arr[j]);
          if (!on) { ctx.moveTo(x, y); on = true; } else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
      }
      if (state.overlays.sma) { line(ind.sma50, p.model, 1.4); line(ind.sma200, p.down, 1.4); }
      line(h.close, p.text, 2);

      // Last price marker and label
      var lastIdx = vis.start + vis.n - 1, ly = yAt(h.close[lastIdx]), lx = xAt(vis.n - 1);
      ctx.fillStyle = p.bg; ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = p.text; ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = "600 11px " + p.sans; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      var labelText = money(h.close[lastIdx], t.currency);
      var tw = ctx.measureText(labelText).width + 10;
      ctx.fillStyle = p.text;
      roundRect(ctx, padL + W + 4, ly - 9, tw, 18, 4); ctx.fill();
      ctx.fillStyle = p.bg; ctx.fillText(labelText, padL + W + 9, ly);

      // Crosshair
      if (cursor != null) {
        var ci = vis.start + cursor;
        var cx = Math.round(xAt(cursor)) + 0.5;
        ctx.strokeStyle = p.ruleStrong; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, volTop + volH); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = p.bg; ctx.beginPath(); ctx.arc(xAt(cursor), yAt(h.close[ci]), 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.text; ctx.beginPath(); ctx.arc(xAt(cursor), yAt(h.close[ci]), 3.2, 0, Math.PI * 2); ctx.fill();
        showTip(ci, cx);
      } else {
        tip.hidden = true;
      }
    }

    function showTip(i, cx) {
      clear(tip);
      var p = palette();
      tip.appendChild(el("div", { class: "chart__tip-date", text: dateLong(h.dates[i]) }));
      var rows = [["Close", money(h.close[i], t.currency), p.text], ["Open", money(h.open[i], t.currency)], ["High", money(h.high[i], t.currency)], ["Low", money(h.low[i], t.currency)], ["Volume", compact(h.volume[i])]];
      if (state.overlays.sma) { rows.push(["50-day", money(ind.sma50[i], t.currency), p.model]); rows.push(["200-day", money(ind.sma200[i], t.currency), p.down]); }
      if (i > 0 && h.close[i - 1]) rows.push(["Change", pct(h.close[i] / h.close[i - 1] - 1, 2)]);
      rows.forEach(function (r) {
        tip.appendChild(el("div", { class: "chart__tip-row" }, el("span", {}, r[2] ? el("i", { style: "--legend:" + r[2] }) : null, r[0]), el("b", { text: r[1] })));
      });
      tip.hidden = false;
      var rect = canvas.getBoundingClientRect();
      var left = cx + 14, tw = tip.offsetWidth;
      if (left + tw > rect.width - 8) left = cx - tw - 14;
      tip.style.left = Math.max(4, left) + "px";
    }

    function setCursorFromX(px) {
      if (!geom) return;
      var i = Math.round((px - geom.padL) / geom.dx - 0.5);
      if (i < 0 || i >= geom.vis.n) { if (cursor != null) { cursor = null; draw(); } return; }
      if (i !== cursor) { cursor = i; draw(); }
    }

    canvas.addEventListener("pointermove", function (e) { var r = canvas.getBoundingClientRect(); setCursorFromX(e.clientX - r.left); });
    canvas.addEventListener("pointerleave", function () { cursor = null; draw(); });
    canvas.addEventListener("keydown", function (e) {
      if (!geom) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        var n = geom.vis.n;
        cursor = cursor == null ? n - 1 : Math.max(0, Math.min(n - 1, cursor + (e.key === "ArrowLeft" ? -1 : 1)));
        draw();
      } else if (e.key === "Escape") { cursor = null; draw(); }
    });
    canvas.addEventListener("blur", function () { cursor = null; draw(); });
    return registerChart(canvas, draw);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  function smallSeries(canvas, drawFn) {
    return registerChart(canvas, function () {
      var s = sizeCanvas(canvas), p = palette();
      drawFn(s.ctx, s.w, s.h, p);
    });
  }

  function rsiChart(canvas, d) {
    smallSeries(canvas, function (ctx, w, h, p) {
      var n = d.history.close.length, start = Math.max(0, n - state.range), arr = d.indicators.rsi14;
      var padR = 30, W = w - padR, dx = W / (n - start);
      var y = function (v) { return 4 + (h - 8) * (1 - v / 100); };
      ctx.font = "500 10px " + p.sans; ctx.fillStyle = p.muted; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      [30, 50, 70].forEach(function (lvl) {
        ctx.strokeStyle = p.rule; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Math.round(y(lvl)) + 0.5); ctx.lineTo(W, Math.round(y(lvl)) + 0.5); ctx.stroke();
        ctx.fillText(String(lvl), W + 6, y(lvl));
      });
      ctx.fillStyle = withAlpha(p.muted, 0.08); ctx.fillRect(0, y(70), W, y(30) - y(70));
      ctx.beginPath(); var on = false;
      for (var i = start; i < n; i++) { if (arr[i] == null) { on = false; continue; } var x = (i - start + 0.5) * dx; if (!on) { ctx.moveTo(x, y(arr[i])); on = true; } else ctx.lineTo(x, y(arr[i])); }
      ctx.strokeStyle = p.model; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.stroke();
    });
    // Re-draw with the main chart's range
    canvas.dataset.follow = "range";
  }

  function macdChart(canvas, d) {
    smallSeries(canvas, function (ctx, w, h, p) {
      var n = d.history.close.length, start = Math.max(0, n - state.range), ind = d.indicators;
      var padR = 30, W = w - padR, dx = W / (n - start);
      var lo = 0, hi = 0;
      for (var i = start; i < n; i++) [ind.macd[i], ind.macdSignal[i], ind.macdHist[i]].forEach(function (v) { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } });
      var span = (hi - lo) || 1; lo -= span * 0.05; hi += span * 0.05;
      var y = function (v) { return 4 + (h - 8) * (1 - (v - lo) / (hi - lo)); };
      ctx.strokeStyle = p.rule; ctx.beginPath(); ctx.moveTo(0, Math.round(y(0)) + 0.5); ctx.lineTo(W, Math.round(y(0)) + 0.5); ctx.stroke();
      for (i = start; i < n; i++) {
        var v = ind.macdHist[i]; if (v == null) continue;
        ctx.fillStyle = withAlpha(v >= 0 ? p.up : p.down, 0.55);
        var x = (i - start + 0.5) * dx, top = Math.min(y(0), y(v));
        ctx.fillRect(x - Math.max(0.5, dx * 0.35), top, Math.max(1, dx * 0.7), Math.abs(y(v) - y(0)));
      }
      function line(arr, color) {
        ctx.beginPath(); var on = false;
        for (var j = start; j < n; j++) { if (arr[j] == null) { on = false; continue; } var x = (j - start + 0.5) * dx; if (!on) { ctx.moveTo(x, y(arr[j])); on = true; } else ctx.lineTo(x, y(arr[j])); }
        ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
      }
      line(ind.macd, p.model); line(ind.macdSignal, p.muted);
      ctx.font = "500 10px " + p.sans; ctx.fillStyle = p.muted; ctx.textBaseline = "middle";
      ctx.fillText("0", W + 6, y(0));
    });
  }

  /* ---------- forecasts, scores, readings ---------- */

  function forecastGrid(t, d) {
    var grid = el("div", { class: "fc-grid" });
    var anchor = d.price;
    [1, 5, 21, 63].forEach(function (h) {
      var f = d.forecasts[h];
      if (!f) return;
      var dir = dirOf(f.ret, 0.0005);
      grid.appendChild(el("div", { class: "card fc-card" },
        el("p", { class: "fc-card__h", text: HORIZON_NAMES[h] }),
        el("p", { class: "fc-card__ret delta delta--" + dir, text: pct(Math.abs(f.ret), 1, false) }),
        el("p", { class: "fc-card__target" }, "to ", el("b", { text: money(anchor * (1 + f.ret), t.currency) }), " · 80% band ", money(anchor * (1 + f.p10), t.currency), " – ", money(anchor * (1 + f.p90), t.currency)),
        bandBar(f),
        el("div", { class: "fc-card__prob" }, el("span", {}, "Chance of a gain ", el("b", { text: Math.round(f.pUp * 100) + "%" })), el("span", {}, "Range ", el("b", { text: pct(f.p10, 0) + " to " + pct(f.p90, 0) }))),
        el("p", { class: "fc-card__rel" }, "Versus the other tracked stocks: ", delta(f.relRet, 1, 0.0005))));
    });
    if (d.view12m) {
      var v = d.view12m, dirV = dirOf(v.expectedReturn12m, 0.005);
      grid.appendChild(el("div", { class: "card fc-card fc-card--fund" },
        el("p", { class: "fc-card__h", text: "12 months · fundamentals" }),
        el("p", { class: "fc-card__ret delta delta--" + dirV, text: pct(Math.abs(v.expectedReturn12m), 0, false) }),
        el("p", { class: "fc-card__target" }, "if half the gap to fair value closes, plus a ", pct(v.dividendYield, 1, false), " dividend"),
        el("p", { class: "fc-card__rel" }, stance(v.label), " Not from the backtested model: a valuation view, graded in the track record as it comes due.")));
    }
    var note = el("p", { class: "small muted", style: "margin:.75rem 0 0" },
      "Expected moves are from the close of " + dateLong(d.asOf) + " (" + money(anchor, t.currency) + "). The bands come from the model's own out-of-sample errors, so about 80% of outcomes should land inside them. ",
      el("a", { href: "#/method", text: "How the forecasts work and how accurate they've been." }));
    return el("div", {}, grid, note);
  }

  var TECH_PARTS = { trend: "Trend", momentum: "Momentum", oscillators: "Oscillators", volume: "Volume", volatility: "Volatility" };

  function partsList(parts, labels) {
    if (!parts) return null;
    var ul = el("ul", { class: "parts" });
    Object.keys(labels).forEach(function (k) {
      if (parts[k] == null) return;
      ul.appendChild(el("li", {}, el("span", { text: labels[k] }), meter(parts[k], scoreClass(parts[k])), el("b", { text: Math.round(parts[k]) })));
    });
    return ul;
  }

  function scoreGrid(t, d) {
    var sc = t.scores;
    var grid = el("div", { class: "scores-grid" });
    function card(label, value, blurb, partsList) {
      var c = el("div", { class: "card score-card" },
        el("p", { class: "card__title", text: label }),
        el("div", { class: "score-card__row" }, el("b", { text: value == null ? "–" : Math.round(value) }), el("span", { text: "out of 100" })),
        meter(value, scoreClass(value)),
        el("p", { text: blurb }));
      if (partsList) c.appendChild(partsList);
      return c;
    }
    grid.appendChild(card("Overall", sc.overall, "Model 45%, fundamentals 35%, chart 20%. Above 62 reads positive, below 38 negative."));
    grid.appendChild(card("Model", sc.model, "How strongly the forecasts lean, across horizons, relative to the other tracked stocks."));
    grid.appendChild(card("Chart", sc.technical, "Trend, momentum, oscillators, volume and volatility, weighed as below.",
      partsList(d.technical && d.technical.parts, TECH_PARTS)));
    if (t.type !== "ETF") {
      grid.appendChild(card("Fundamentals", sc.fundamental, "Valuation 35%, quality 25%, growth 20%, safety 10%, analyst sentiment 10%.",
        partsList(d.fundamentals && d.fundamentals.score && d.fundamentals.score.parts, { valuation: "Valuation", quality: "Quality", growth: "Growth", safety: "Safety", sentiment: "Sentiment" })));
    }
    return grid;
  }

  function readingsSection(t, d) {
    var groups = { trend: "Trend", momentum: "Momentum", oscillators: "Overbought or oversold", volume: "Volume", volatility: "Volatility" };
    var readings = (d.technical && d.technical.readings) || [];
    var cols = el("div", { class: "two-col" });
    Object.keys(groups).forEach(function (g) {
      var items = readings.filter(function (r) { return r.group === g; });
      if (!items.length) return;
      cols.appendChild(el("div", { class: "card" }, el("p", { class: "card__title", text: groups[g] }),
        el("ul", { class: "readings" }, items.map(function (r) {
          return el("li", {}, el("span", { class: "readings__name", text: r.name }), stance(r.stance), el("span", { class: "readings__value", text: r.value }), el("span", { class: "readings__detail", text: r.detail }));
        }))));
    });
    return cols;
  }

  function fundamentalsSection(t, d) {
    var f = d.fundamentals || {}, info = f.info || {}, fv = f.fairValue || {}, det = (f.score && f.score.details) || {};
    var cols = el("div", { class: "two-col" });
    var cur = t.currency;
    function row(label, value, sub) {
      return el("tr", {}, el("th", { scope: "row", text: label }), el("td", {}, value, sub ? el("small", { text: sub }) : null));
    }
    function x(v, digits) { return v == null ? "–" : num(v, digits == null ? 1 : digits) + "×"; }
    var peers = (f.peers && f.peers.medians) || {};

    // Fair value card
    var fvCard = el("div", { class: "card" }, el("p", { class: "card__title", text: "Fair value" }));
    var methodKeys = Object.keys(fv.methods || {});
    if (fv.value) {
      fvCard.appendChild(el("div", { class: "fv-hero" }, el("b", { text: money(fv.value, cur) }), delta(fv.marginOfSafety, 0, 0.005), el("span", { class: "muted small", text: "vs " + money(d.price, cur) }), d.view12m ? stance(d.view12m.label) : null));
    } else {
      fvCard.appendChild(el("p", { class: "record-empty", text: fv.note || "Not enough data to estimate a fair value." }));
    }
    if (methodKeys.length) {
      var ul = el("ul", { class: "fv-methods" });
      var weights = { earnings: 0.4, dcf: 0.35, book: 0.35, analysts: 0.25 };
      var total = 0; methodKeys.forEach(function (k) { if (!fv.methods[k].dropped) total += weights[k] || 0; });
      methodKeys.forEach(function (k) {
        var m = fv.methods[k], extra = "";
        if (k === "earnings") extra = "Forward EPS " + money(fv.inputs.forwardEps, cur) + " × " + num(m.justifiedPE, 1) + " (peers pay " + (m.peerPE ? num(m.peerPE, 1) : "–") + ", growth justifies " + num(m.growthPE, 1) + ")";
        if (k === "dcf") extra = "Free cash flow growing " + pct(m.growth5y, 0, false) + " a year for five years, fading to " + pct(m.terminalGrowth, 1, false) + ", discounted at " + pct(m.discountRate, 1, false);
        if (k === "book") extra = "Book value " + money(fv.inputs.bookValue, cur) + " per share × peers' price-to-book " + num(m.peerPB, 2);
        if (k === "analysts") extra = m.analysts + " analysts' mean 12-month target";
        var use = m.dropped === "implausible" ? "not used: too far from the price to be real" : m.dropped === "outlier" ? "not used: too far from the other methods" : fv.value && total ? "weight " + Math.round((weights[k] || 0) / total * 100) + "%" : "";
        ul.appendChild(el("li", { class: m.dropped ? "is-dropped" : "" }, el("span", { style: "grid-column:1", text: m.label + (use ? " · " + use : "") }), el("b", { text: money(m.value, cur) }), el("span", { text: extra })));
      });
      fvCard.appendChild(ul);
    }
    cols.appendChild(fvCard);

    cols.appendChild(el("div", { class: "card" }, el("p", { class: "card__title", text: "Valuation" }), el("table", { class: "kv" }, el("tbody", {},
      row("Price / earnings", x(info.trailingPE), peers.trailingPE ? "sector median " + x(peers.trailingPE) : null),
      row("Forward P/E", x(info.forwardPE), peers.forwardPE ? "sector median " + x(peers.forwardPE) : null),
      row("PEG", x(det.peg, 2), "P/E per point of growth"),
      row("Price / book", x(info.priceToBook, 2), peers.priceToBook ? "sector median " + x(peers.priceToBook, 2) : null),
      row("EV / EBITDA", x(info.enterpriseToEbitda), peers.enterpriseToEbitda ? "sector median " + x(peers.enterpriseToEbitda) : null),
      row("Price / sales", x(info.priceToSalesTrailing12Months)),
      row("Dividend yield", d.view12m ? pct(d.view12m.dividendYield, 2, false) : "–"),
      row("Market cap", compact(info.marketCap, cur), info.enterpriseValue ? "enterprise value " + compact(info.enterpriseValue, cur) : null)))));

    cols.appendChild(el("div", { class: "card" }, el("p", { class: "card__title", text: "Quality & growth" }), el("table", { class: "kv" }, el("tbody", {},
      row("Revenue growth", delta(info.revenueGrowth, 1), "latest quarter, year on year"),
      row("Earnings growth", delta(info.earningsGrowth, 1), "latest quarter, year on year"),
      row("Gross margin", pct(info.grossMargins, 1, false)),
      row("Operating margin", pct(info.operatingMargins, 1, false)),
      row("Net margin", pct(info.profitMargins, 1, false)),
      row("Free cash flow", compact(info.freeCashflow, cur), det.fcfMargin != null ? pct(det.fcfMargin, 1, false) + " of revenue" : null),
      row("Return on equity", pct(info.returnOnEquity, 1, false)),
      row("Debt / equity", info.debtToEquity == null ? "–" : num(info.debtToEquity / 100, 2) + "×", info.totalDebt != null ? "debt " + compact(info.totalDebt, cur) + ", cash " + compact(info.totalCash, cur) : null),
      row("Current ratio", x(info.currentRatio, 2)),
      row("Beta", num(info.beta, 2), "sensitivity to the market")))));

    var rec = info.recommendationKey ? info.recommendationKey.replace(/_/g, " ") : null;
    cols.appendChild(el("div", { class: "card" }, el("p", { class: "card__title", text: "Analysts & positioning" }), el("table", { class: "kv" }, el("tbody", {},
      row("Consensus", rec ? rec.charAt(0).toUpperCase() + rec.slice(1) : "–", info.recommendationMean != null ? num(info.recommendationMean, 1) + " on a 1 (strong buy) to 5 (sell) scale, " + (info.numberOfAnalystOpinions || 0) + " analysts" : null),
      row("Mean target", money(info.targetMeanPrice, cur), det.analystUpside != null ? pct(det.analystUpside, 0) + " from here" : null),
      row("Target range", info.targetLowPrice ? money(info.targetLowPrice, cur) + " – " + money(info.targetHighPrice, cur) : "–"),
      row("Short interest", pct(info.shortPercentOfFloat, 1, false), "of the float sold short"),
      row("Held by institutions", pct(info.heldPercentInstitutions, 0, false)),
      row("Held by insiders", pct(info.heldPercentInsiders, 1, false)),
      row("Fundamentals fetched", info.fetchedAt ? dateLong(info.fetchedAt.slice(0, 10)) : "–", info.stale ? "Yahoo didn't answer on the last run; showing the previous values" : null)))));
    return cols;
  }

  function ledgerSection(t, d) {
    var L = d.ledger || { resolved: [], pending: [] };
    var box = el("div", {});
    if (!L.resolved.length) {
      var soonest = L.pending.length ? Math.min.apply(null, L.pending.map(function (e) { return e.h; })) : null;
      box.appendChild(el("p", { class: "record-empty" }, "No graded forecasts for " + t.symbol + " yet. ",
        L.pending.length ? "The first of the " + L.pending.length + " pending ones comes due in " + soonest + " trading day" + (soonest === 1 ? "" : "s") + "." : ""));
      return box;
    }
    var byH = {};
    L.resolved.forEach(function (e) { (byH[e.h] = byH[e.h] || []).push(e); });
    var sum = el("table", { class: "record-table" }, el("thead", {}, el("tr", {}, el("th", { text: "Horizon" }), el("th", { text: "Graded" }), el("th", { text: "Direction right" }), el("th", { text: "Beat the others" }), el("th", { text: "Inside 80% band" }))),
      el("tbody", {}, [1, 5, 21, 63].filter(function (h) { return byH[h]; }).map(function (h) {
        var es = byH[h], rel = es.filter(function (e) { return e.relHit != null; });
        return el("tr", {}, el("td", { text: HORIZON_NAMES[h] }), el("td", { text: es.length }),
          el("td", { text: pct(es.filter(function (e) { return e.hit; }).length / es.length, 0, false) }),
          el("td", { text: rel.length ? pct(rel.filter(function (e) { return e.relHit; }).length / rel.length, 0, false) : "–" }),
          el("td", { text: pct(es.filter(function (e) { return e.inBand; }).length / es.length, 0, false) }));
      })));
    box.appendChild(el("div", { class: "card" }, el("p", { class: "card__title", text: "Graded forecasts" }), sum));
    var recent = L.resolved.slice(-12).reverse();
    box.appendChild(el("div", { class: "card", style: "margin-top:.75rem" }, el("p", { class: "card__title", text: "Most recent" }),
      el("table", { class: "record-table" }, el("thead", {}, el("tr", {}, el("th", { text: "Made" }), el("th", { text: "Horizon" }), el("th", { text: "Forecast" }), el("th", { text: "Actual" }), el("th", { text: "Right?" }), el("th", { text: "In band?" }))),
        el("tbody", {}, recent.map(function (e) {
          return el("tr", {}, el("td", { text: dateLong(e.date) }), el("td", { text: HORIZON_SHORT[e.h] }), el("td", {}, delta(e.ret, 1, 0.0005)), el("td", {}, delta(e.real, 1, 0.0005)),
            el("td", { class: e.hit ? "yes" : "no", text: e.hit ? "✓" : "✗" }), el("td", { class: e.inBand ? "yes" : "no", text: e.inBand ? "✓" : "✗" }));
        })))));
    return box;
  }

  /* ---------- methodology ---------- */

  function renderMethod() {
    document.title = "How the forecasts work · Stocks";
    var s = state.summary, bt = s.backtest || {}, m = s.model || {};
    var btRecent = s.backtestRecent && Object.keys(s.backtestRecent).length ? s.backtestRecent : null;
    var box = el("div", { class: "method" });
    view.appendChild(box);
    var contentsList = el("ol", {});
    box.appendChild(el("nav", { class: "contents", "aria-label": "On this page" }, el("strong", { text: "On this page" }), contentsList));
    var sectionN = 0;
    function section(text) {
      var h = el("h2", { id: "method-" + (++sectionN), text: text });
      contentsList.appendChild(el("li", {}, el("a", { href: "#/method", text: text, onclick: function (e) { e.preventDefault(); h.scrollIntoView({ behavior: "smooth", block: "start" }); } })));
      return h;
    }
    var hs = [1, 5, 21, 63].filter(function (h) { return bt[h]; });
    var tOf = function (r) { return r.ic_daily_t_nw != null ? r.ic_daily_t_nw : r.ic_daily_t; };
    var head = btRecent || bt;
    var bestH = hs.slice().sort(function (a, b) { return (tOf(head[b] || bt[b]) || 0) - (tOf(head[a] || bt[a]) || 0); })[0];

    box.appendChild(section("What the model can and can't do"));
    box.appendChild(el("p", { text: "Nobody can reliably say whether the market goes up or down next month, and a model that pretends to just adds noise. What is mildly predictable is which stocks will do better or worse than the others: the well-documented momentum, short-term reversal and low-volatility effects. So every forecast here has two parts: a market drift, which is simply the historical average return (halved, to stay conservative), and a relative forecast, which is learned and says how much better or worse than the average tracked stock this one should do." }));
    box.appendChild(el("p", { text: "The learned part is an average of two models trained on " + (m.universeSize || "a few hundred") + " stocks at once: a gradient-boosted tree ensemble, which finds interactions such as \"oversold and in an uptrend\", and a ridge regression, which is linear and hard to overfit. They see " + (m.features || 80) + " features computed only from past prices and volumes: returns over many windows, moving-average gaps, RSI, MACD, Bollinger position, volatility, volume flows, each stock's rank among the others, and the market's own state (S&P 500 trend, VIX, 10-year yield). What they learn to predict is each stock's rank among all the others over the next period, after taking out each stock's share of the market's move (half its beta, half one-for-one), so the ranking rewards stock picking rather than a bet on high- or low-beta names, and is more robust than predicting the size of the move. The one-week and one-month forecasts are then blended with their neighbouring horizons' forecasts (15% from each side), which reduced noise in the backtest. Fundamentals are deliberately kept out of the learned model because only today's values are available, and training on them would be cheating." }));
    box.appendChild(el("p", { text: "Forecasts are calibrated against the backtest: if only a third of a predicted relative move materialised on average in the past, today's forecast is scaled by a third. The 80% bands are the model's own out-of-sample errors (conformal prediction), so they are as wide as they need to be. Two honesty rules shape the backtest: a stock only enters the cross-section from the day it joined the S&P 500 (today's survivors can't teach the model what future winners looked like before anyone could have picked them), and European listings see the US market's context with a one-day lag, because their session closes first." }));

    if (hs.length) {
      var b = (btRecent && btRecent[bestH]) || bt[bestH];
      var span = dateLong(b.from).slice(-4) + "–" + dateLong(b.to).slice(-4);
      var strong = tOf(b) >= 2;
      var verdict = strong
        ? "Over " + span + (btRecent ? " (the recent years only, which is the stricter test)" : "") + ", out of sample, the model's ranking of stocks was positively related to what happened next on " + pct(b.ic_positive_share, 0, false) + " of days at the " + HORIZON_NAMES[bestH] + " horizon (t-statistic " + num(tOf(b), 1) + ", so very unlikely to be luck). Picking the fifth of stocks it liked most against the fifth it liked least would have earned " + pct(b.long_short_annualised, 0) + " a year before costs. That is a real but small edge: the kind a professional desk is pleased with, and one a retail trader would struggle to capture after fees. "
        : "Over " + span + ", out of sample, the model's ranking of stocks was only weakly related to what happened next (best horizon " + HORIZON_NAMES[bestH] + ", t-statistic " + num(tOf(b), 1) + ", which could be luck). The calibration therefore scales the relative forecasts down to almost nothing, and what remains is mostly the market drift with honest, wide bands. ";
      verdict += "The absolute direction (will the price go up?) is right " + pct(b.hit_rate, 0, false) + " of the time, the same as always saying \"up\" (" + pct(b.up_rate, 0, false) + "), because the model does not try to time the market. Horizons where the t-statistic is below 2 should be read as \"no reliable edge\".";
      box.appendChild(el("div", { class: "verdict" }, el("p", {}, el("strong", { text: "The honest summary. " }), verdict)));
    }

    function bestRule(r) {
      var best = null;
      Object.keys(r.baselines || {}).forEach(function (k) { var v = r.baselines[k]; if (!best || v.rel_hit_rate > best.rel_hit_rate) best = v; });
      return best;
    }
    function backtestTable(src, caption) {
      var hz = hs.filter(function (h) { return src[h]; });
      return el("div", { class: "card wide" }, caption ? el("p", { class: "card__title", text: caption }) : null, el("table", { class: "record-table" },
        el("thead", {}, el("tr", {}, el("th", { text: "Horizon" }), el("th", { text: "Beat the others" }), el("th", { text: "best naive rule" }), el("th", { text: "Rank skill (IC)" }), el("th", { text: "t-stat" }), el("th", { text: "Raw-return IC" }), el("th", { text: "Days IC > 0" }), el("th", { text: "Long–short / yr" }), el("th", { text: "Up direction" }), el("th", { text: "always up" }), el("th", { text: "Inside 80% band" }), el("th", { text: "Forecasts" }))),
        el("tbody", {}, hz.map(function (h) {
          var r = src[h], rule = bestRule(r);
          return el("tr", {}, el("td", { text: HORIZON_NAMES[h] }),
            el("td", { class: r.rel_hit_rate > (rule ? rule.rel_hit_rate : 0.505) ? "good" : "", text: pct(r.rel_hit_rate, 1, false) }), el("td", { class: "muted", text: rule ? pct(rule.rel_hit_rate, 1, false) : "50.0%" }),
            el("td", { text: num(r.ic_daily_mean, 3) }), el("td", { class: tOf(r) >= 2 ? "good" : "", text: num(tOf(r), 1) }),
            el("td", { text: r.ic_raw_daily_mean == null ? "–" : num(r.ic_raw_daily_mean, 3) }),
            el("td", { text: pct(r.ic_positive_share, 0, false) }), el("td", {}, delta(r.long_short_annualised, 0)),
            el("td", { text: pct(r.hit_rate, 1, false) }), el("td", { class: "muted", text: pct(r.up_rate, 1, false) }),
            el("td", { text: pct(r.coverage80_out_of_time, 0, false) }), el("td", { text: compact(r.n) }));
        }))));
    }
    box.appendChild(section("The backtest, horizon by horizon"));
    box.appendChild(el("p", { text: "Walk-forward: the model that forecasts a six-month period was trained only on data that ended before it, with a gap of one horizon so no training target overlaps the test. The \"best naive rule\" column is what the strongest of four fixed rules (bet on low volatility, on small dollar volume, on past-year momentum, or against last week's move) would have scored, so the model has to beat a real competitor, not a coin flip." }));
    if (btRecent) {
      box.appendChild(backtestTable(btRecent, "Since " + dateLong(s.recentFrom || "2021-01-01") + " (the recent years: the stricter test)"));
      box.appendChild(el("div", { style: "height:.75rem" }));
      box.appendChild(backtestTable(bt, "Whole test period, " + dateLong(bt[hs[0]].from).slice(-4) + "–" + dateLong(bt[hs[0]].to).slice(-4)));
    } else {
      box.appendChild(backtestTable(bt));
    }
    box.appendChild(el("p", { class: "small muted" }, el("strong", { text: "Beat the others: " }), "how often the sign of the relative forecast was right. ", el("strong", { text: "IC: " }), "the rank correlation between forecasts and outcomes within each day, averaged; its t-statistic (Newey-West) accounts for overlapping horizons. ", el("strong", { text: "Raw-return IC: " }), "the same correlation against plain forward returns instead of volatility-scaled ones, which is what you'd actually earn. ", el("strong", { text: "Long–short: " }), "the top fifth minus the bottom fifth by forecast, annualised, before costs. ", el("strong", { text: "Inside 80% band: " }), "measured on the last 30% of the test period with bands set on the first 70%."));

    // The two learners and the naive rules, per horizon
    var compRows = hs.filter(function (h) { return bt[h].components; });
    if (compRows.length) {
      box.appendChild(el("h3", { text: "What carries the skill" }));
      box.appendChild(el("p", { text: "Daily IC of each learner alone and of the four naive rules, over the whole test period. The ensemble should beat both of its parts, and the model should beat every rule." }));
      box.appendChild(el("div", { class: "card wide" }, el("table", { class: "record-table" },
        el("thead", {}, el("tr", {}, el("th", { text: "Horizon" }), el("th", { text: "Boosted trees" }), el("th", { text: "Ridge" }), el("th", { text: "Ensemble" }), el("th", { text: "Low volatility" }), el("th", { text: "Small dollar volume" }), el("th", { text: "Momentum" }), el("th", { text: "Reversal" }))),
        el("tbody", {}, compRows.map(function (h) {
          var r = bt[h], c = r.components || {}, bl = r.baselines || {};
          var f = function (v) { return v == null ? "–" : num(v, 3); };
          return el("tr", {}, el("td", { text: HORIZON_NAMES[h] }),
            el("td", { text: f(c.gbm && c.gbm.ic_daily_mean) }), el("td", { text: f(c.ridge && c.ridge.ic_daily_mean) }), el("td", { class: "good", text: f(c.ensemble && c.ensemble.ic_daily_mean) }),
            el("td", { text: f(bl.f_negvol && bl.f_negvol.ic) }), el("td", { text: f(bl.f_negsize && bl.f_negsize.ic) }), el("td", { text: f(bl.f_mom && bl.f_mom.ic) }), el("td", { text: f(bl.f_rev && bl.f_rev.ic) }));
        })))));
    }

    if (hs.length) {
      box.appendChild(section("Does a stronger forecast mean a bigger move?"));
      box.appendChild(el("p", { text: "Forecasts sorted into ten equal buckets, from most bearish to most bullish relative to the other stocks, against the average relative return that actually followed. A well-calibrated model draws a rising staircase; the bars should climb from left to right and roughly match the dots." }));
      var decSeg = el("div", { class: "seg", role: "group", "aria-label": "Horizon" });
      var decHolder = el("div", { class: "chart chart--bars" });
      var decCanvas = el("canvas", { role: "img", "aria-label": "Calibration by decile" });
      decHolder.appendChild(decCanvas);
      var decH = hs.indexOf(21) >= 0 ? 21 : hs[0];
      hs.forEach(function (h) {
        decSeg.appendChild(el("button", { type: "button", text: HORIZON_SHORT[h], "aria-pressed": h === decH ? "true" : "false", onclick: function (e) {
          decH = h; decSeg.querySelectorAll("button").forEach(function (btn) { btn.setAttribute("aria-pressed", btn === e.currentTarget ? "true" : "false"); }); decChart.draw();
        } }));
      });
      var decCard = el("div", { class: "card wide" }, el("div", { class: "chart-card__bar" }, el("ul", { class: "chart-card__legend" },
        el("li", {}, el("i", { class: "is-area", style: "--legend:" + palette().model }), "Realised relative return"), el("li", {}, el("i", { style: "--legend:" + palette().text }), "Forecast")), decSeg), decHolder);
      box.appendChild(decCard);
      var decChart = decileChart(decCanvas, function () { return bt[decH].deciles; });

      box.appendChild(section("Year by year"));
      box.appendChild(el("p", { text: "One lucky year can hide a bad model, so here is each year's relative hit rate and rank skill at each horizon." }));
      var years = {};
      hs.forEach(function (h) { (bt[h].by_year || []).forEach(function (y) { years[y.year] = years[y.year] || {}; years[y.year][h] = y; }); });
      box.appendChild(el("div", { class: "card wide" }, el("table", { class: "record-table" },
        el("thead", {}, el("tr", {}, el("th", { text: "Year" }), hs.map(function (h) { return [el("th", { text: HORIZON_SHORT[h] + " hit" }), el("th", { text: HORIZON_SHORT[h] + " IC" })]; }))),
        el("tbody", {}, Object.keys(years).sort().map(function (yr) {
          return el("tr", {}, el("td", { text: yr }), hs.map(function (h) {
            var y = years[yr][h];
            return [el("td", { class: y && y.rel_hit > 0.505 ? "good" : y && y.rel_hit < 0.495 ? "bad" : "", text: y ? pct(y.rel_hit, 1, false) : "–" }), el("td", { text: y ? num(y.ic, 3) : "–" })];
          }));
        })))));
    }

    if (s.importance && s.importance.length) {
      box.appendChild(section("What the model pays attention to"));
      box.appendChild(el("p", { text: "Permutation importance for the one-month model on recent data: how much worse the forecasts get when each feature is scrambled, as a share of the total." }));
      var names = { ret1: "Yesterday's return", ret5: "5-day return", ret10: "10-day return", ret21: "1-month return", ret63: "3-month return", ret126: "6-month return", ret252: "1-year return", mom12_1: "12-1 momentum", vol10: "10-day volatility", vol21: "1-month volatility", vol63: "3-month volatility", vol_ratio: "Volatility ratio", dvol63: "Downside volatility", skew63: "Return skew", atr_pct: "Average true range", sma20_gap: "Gap to 20-day average", sma50_gap: "Gap to 50-day average", sma200_gap: "Gap to 200-day average", sma50_200: "50 vs 200-day average", slope20: "20-day slope", slope63: "63-day slope", macd: "MACD", macd_hist: "MACD histogram", macd_hist_chg: "MACD histogram change", rsi14: "RSI 14", rsi2: "RSI 2", stoch_k: "Stochastic", bb_pctb: "Bollinger position", bb_width: "Bollinger width", pos52: "52-week position", dd252: "Drawdown from 52-week high", days_since_high: "Days since 52-week high", vol_rel20: "Volume vs 20-day", vol_rel5_63: "Volume 5 vs 63-day", dollar_vol: "Dollar volume", obv_slope: "On-balance volume", updown_vol: "Up-day volume share", intraday: "Intraday move", gap: "Opening gap", range_pct: "Day range", close_pos: "Close within range", streak: "Up/down streak", max_r21: "Best day in a month", min_r21: "Worst day in a month", mkt_ret1: "S&P 500 1-day", mkt_ret5: "S&P 500 5-day", mkt_ret21: "S&P 500 1-month", mkt_ret63: "S&P 500 3-month", mkt_vol21: "S&P 500 volatility", mkt_sma200_gap: "S&P 500 vs 200-day", mkt_rsi14: "S&P 500 RSI", mkt_dd252: "S&P 500 drawdown", vix: "VIX", vix_chg5: "VIX 5-day change", vix_rel63: "VIX vs 3-month average", tnx: "10-year yield", tnx_chg21: "Yield 1-month change", rs21: "Relative strength 1m", rs63: "Relative strength 3m", beta63: "Beta", corr63: "Correlation to market" };
      var max = s.importance[0].share || 1;
      box.appendChild(el("div", { class: "card" }, el("ul", { class: "imp" }, s.importance.map(function (f) {
        var label = names[f.feature] || (f.feature.indexOf("rank_") === 0 ? "Rank: " + (names[f.feature.slice(5)] || f.feature.slice(5)) : f.feature);
        return el("li", {}, el("span", { text: label }), el("div", { class: "meter" }, el("div", { class: "meter__fill", style: "width:" + (f.share / max * 100) + "%" })), el("b", { text: pct(f.share, 0, false) }));
      }))));
    }

    box.appendChild(section("The live track record"));
    var L = s.ledger || {}, lh = L.horizons || {};
    var graded = Object.keys(lh).reduce(function (n, k) { return n + (lh[k].n || 0); }, 0);
    if (!graded) {
      box.appendChild(el("p", { text: "Every forecast shown on this site is written down when it is made and graded when its horizon passes, from " + (L.since ? dateLong(L.since) : "today") + ". " + (L.pending || 0) + " forecasts are pending; the first one-day forecasts are graded after the next close, the three-month ones in about a quarter. The table will appear here as results come in, and each stock's page shows its own." }));
    } else {
      box.appendChild(el("p", { text: "Forecasts published on this site since " + dateLong(L.since) + ", graded after the fact. Unlike the backtest, nothing here can have been tuned in hindsight. " + (L.pending || 0) + " forecasts are still pending." }));
      box.appendChild(el("div", { class: "card wide" }, el("table", { class: "record-table" },
        el("thead", {}, el("tr", {}, el("th", { text: "Horizon" }), el("th", { text: "Graded" }), el("th", { text: "Up direction" }), el("th", { text: "always up" }), el("th", { text: "Beat the others" }), el("th", { text: "Inside 80% band" }), el("th", { text: "Rank skill" }))),
        el("tbody", {}, [1, 5, 21, 63].filter(function (h) { return lh[h] && lh[h].n; }).map(function (h) {
          var r = lh[h];
          return el("tr", {}, el("td", { text: HORIZON_NAMES[h] }), el("td", { text: r.n }), el("td", { text: pct(r.hit_rate, 0, false) }), el("td", { class: "muted", text: pct(r.up_rate, 0, false) }),
            el("td", { text: r.rel_hit_rate == null ? "–" : pct(r.rel_hit_rate, 0, false) }), el("td", { text: pct(r.coverage80, 0, false) }), el("td", { text: r.ic_pooled == null ? "–" : num(r.ic_pooled, 3) }));
        })))));
    }

    box.appendChild(section("Fundamentals and the scores"));
    box.appendChild(el("p", { text: "Fundamentals move slowly, so they say little about next week but are the only thing that says anything about next year. Three classic methods are blended into a fair value: earnings power (next year's expected earnings times a justified price/earnings ratio, half from what the market pays the company's sector peers here and half from its own expected growth), a ten-year discounted cash flow (free cash flow growing at the recent revenue growth rate, fading to 2.5%, discounted at a rate that rises with the stock's beta, plus net cash), and the analysts' mean target when at least four cover the stock. Banks and insurers use book value instead of cash flow. The methods are blended geometrically, so one generous estimate can't dominate, and a method that lands more than five times away from the price is set aside as a data error or a method that doesn't apply to that company (each stock's page shows which, and why). The 12-month view assumes half of the gap to fair value closes within a year, plus the dividend; it is not backtested, which is why it sits apart from the model's forecasts and why the track record grades it separately." }));
    box.appendChild(el("p", { text: "The fundamental score (0–100) weighs valuation 35%, quality 25% (margins, return on equity, cash conversion), growth 20%, safety 10% (debt, liquidity, beta) and analyst sentiment 10%. The chart score weighs trend 30%, momentum 30%, oscillators 15%, volume 15% and volatility 10%. The overall score is 45% model, 35% fundamentals and 20% chart; funds have no fundamentals, so theirs is model and chart only. None of it is advice: the scores summarise evidence, they don't know your situation." }));

    box.appendChild(section("Data and refresh"));
    box.appendChild(el("p", { text: "Prices and company data come from Yahoo Finance and are refreshed automatically during US and European trading hours and after each close (the time of the last run is at the top of the page). The model is retrained every day after the US close on " + (m.universeSize || "about 200") + " stocks; the latest model was trained through " + dateLong(m.trainedThrough) + ". The whole thing runs on GitHub Actions and publishes plain JSON files that this page reads; the code is in the blog's repository under tools/stocks." }));
    box.appendChild(el("p", { text: "Prices on the page update in real time while you have it open: the browser subscribes to Yahoo Finance's public price stream for the tracked symbols, with no key and no server in between, and the indicator in the top corner says whether the stream is connected. The forecasts, scores and fundamentals change only when a data run completes." }));
    box.appendChild(el("p", {}, el("a", { href: "#/", text: "← Back to the overview" })));
  }

  function decileChart(canvas, getDeciles) {
    return registerChart(canvas, function () {
      var s = sizeCanvas(canvas), ctx = s.ctx, p = palette();
      var dec = getDeciles() || [];
      if (!dec.length) return;
      var padL = 44, padR = 10, padT = 10, padB = 28, W = s.w - padL - padR, H = s.h - padT - padB;
      var vals = [];
      dec.forEach(function (d) { vals.push(d.pred, d.real); });
      var lo = Math.min(0, Math.min.apply(null, vals)), hi = Math.max(0, Math.max.apply(null, vals));
      var span = (hi - lo) || 0.01; lo -= span * 0.1; hi += span * 0.1;
      var y = function (v) { return padT + H - (v - lo) / (hi - lo) * H; };
      var slot = W / dec.length, bw = Math.min(24, slot * 0.55);
      ctx.font = "500 11px " + p.sans; ctx.fillStyle = p.muted; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      niceTicks(lo, hi, 5).forEach(function (v) {
        var yy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = v === 0 ? p.ruleStrong : p.rule; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + W, yy); ctx.stroke();
        ctx.fillText(pct(v, 1), padL - 6, yy);
      });
      dec.forEach(function (d, i) {
        var x = padL + slot * (i + 0.5);
        var top = Math.min(y(0), y(d.real)), hgt = Math.abs(y(d.real) - y(0));
        ctx.fillStyle = withAlpha(p.model, 0.55);
        roundRect(ctx, x - bw / 2, top, bw, Math.max(hgt, 1), 3); ctx.fill();
        ctx.fillStyle = p.bg; ctx.beginPath(); ctx.arc(x, y(d.pred), 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.text; ctx.beginPath(); ctx.arc(x, y(d.pred), 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.muted; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(i === 0 ? "bearish" : i === dec.length - 1 ? "bullish" : String(i + 1), x, padT + H + 8);
      });
    });
  }

  /* ---------- real-time prices (Yahoo Finance stream, no key) ---------- */

  var feedEl = app.querySelector(".stocks__feed");
  var STREAM_URL = "wss://streamer.finance.yahoo.com/?version=2";
  var stream = { ws: null, quotes: {}, status: "paused", retries: 0, retryTimer: null, heartbeat: null, dirty: {}, flushTimer: null,
    lastTick: 0, lastGlance: 0, supported: typeof WebSocket === "function" && typeof atob === "function" };

  // Yahoo's PricingData protobuf: the fields we read, and which varints are zig-zag signed
  var PB_NAMES = { 1: "id", 2: "price", 3: "time", 4: "currency", 5: "exchange", 6: "quoteType", 7: "marketHours", 8: "changePercent",
    9: "dayVolume", 10: "dayHigh", 11: "dayLow", 12: "change", 13: "shortName", 15: "open", 16: "previousClose", 27: "priceHint", 33: "marketCap" };
  var PB_SIGNED = { 3: 1, 9: 1, 14: 1, 19: 1, 20: 1, 21: 1, 22: 1, 24: 1, 26: 1, 27: 1, 28: 1, 29: 1 };
  var utf8 = typeof TextDecoder === "function" ? new TextDecoder() : null;

  function decodePricing(b64) {
    var bin = atob(b64), n = bin.length, buf = new Uint8Array(n);
    for (var i = 0; i < n; i++) buf[i] = bin.charCodeAt(i);
    var dv = new DataView(buf.buffer), p = 0, out = {};
    function varint() { var r = 0, m = 1, b; do { b = buf[p++]; r += (b & 127) * m; m *= 128; } while (b >= 128 && p < n); return r; }
    while (p < n) {
      var key = varint(), field = Math.floor(key / 8), wt = key % 8, val;
      if (wt === 0) { val = varint(); if (PB_SIGNED[field]) val = val % 2 ? -(val + 1) / 2 : val / 2; }
      else if (wt === 1) { val = dv.getFloat64(p, true); p += 8; }
      else if (wt === 5) { val = dv.getFloat32(p, true); p += 4; }
      else if (wt === 2) {
        var len = varint(), bytes = buf.subarray(p, p + len);
        val = !PB_NAMES[field] ? null : utf8 ? utf8.decode(bytes) : String.fromCharCode.apply(null, bytes);
        p += len;
      } else return out; // an unknown wire type: keep what we have
      if (PB_NAMES[field]) out[PB_NAMES[field]] = val;
    }
    return out;
  }

  function setFeed(status, text) {
    stream.status = status;
    if (!feedEl) return;
    feedEl.className = "stocks__feed" + (status === "live" ? " is-live" : status === "connecting" ? " is-connecting" : status === "off" ? " is-off" : "");
    feedEl.textContent = text || "";
  }

  function streamSymbols() {
    return state.summary ? state.summary.tickers.map(function (t) { return t.symbol; }) : [];
  }

  function streamConnect() {
    if (!stream.supported) { setFeed("off", "Live prices need a newer browser"); return; }
    if (!state.summary || stream.ws || document.hidden) return;
    var symbols = streamSymbols();
    if (!symbols.length) return;
    setFeed("connecting", stream.retries ? "Reconnecting live prices…" : "Connecting live prices…");
    var ws;
    try { ws = new WebSocket(STREAM_URL); } catch (e) { setFeed("off", "Live prices unavailable"); return; }
    stream.ws = ws;
    var openedAt = 0;
    function subscribe() { if (ws.readyState === 1) ws.send(JSON.stringify({ subscribe: symbols })); }
    ws.onopen = function () {
      if (stream.ws !== ws) return;
      openedAt = Date.now();
      subscribe();
      setFeed("idle", "Live feed on · waiting for trades");
      if (stream.heartbeat) clearInterval(stream.heartbeat);
      stream.heartbeat = setInterval(subscribe, 15000); // Yahoo drops silent subscriptions; yfinance does the same
    };
    ws.onmessage = function (ev) {
      var msg, q;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.type !== "pricing" || !msg.message) return;
      try { q = decodePricing(msg.message); } catch (e) { return; }
      if (q.id && q.price > 0) onTick(q);
    };
    ws.onclose = function () {
      if (stream.ws !== ws) return;
      stream.ws = null;
      if (stream.heartbeat) { clearInterval(stream.heartbeat); stream.heartbeat = null; }
      if (document.hidden) { setFeed("paused"); return; }
      if (openedAt && Date.now() - openedAt > 30000) stream.retries = 0; // a long-lived connection that dropped is not a failure
      stream.retries++;
      if (stream.retries > 8) { setFeed("off", "Live prices unavailable"); return; }
      setFeed("connecting", "Reconnecting live prices…");
      stream.retryTimer = setTimeout(streamConnect, Math.min(60000, 1000 * Math.pow(2, stream.retries)));
    };
    ws.onerror = function () { /* the close event that follows handles the retry */ };
  }

  function streamStop(status) {
    if (stream.retryTimer) { clearTimeout(stream.retryTimer); stream.retryTimer = null; }
    if (stream.heartbeat) { clearInterval(stream.heartbeat); stream.heartbeat = null; }
    var ws = stream.ws;
    stream.ws = null;
    if (ws) { try { ws.close(); } catch (e) { /* already gone */ } }
    setFeed(status || "paused");
  }

  function onTick(q) {
    var prev = stream.quotes[q.id];
    q.flash = prev && prev.price !== q.price ? (q.price > prev.price ? "up" : "down") : null;
    if (!(q.time > 0)) q.time = Date.now();
    if (prev) ["changePercent", "change", "dayHigh", "dayLow", "dayVolume", "open", "previousClose", "marketHours"].forEach(function (k) {
      if (q[k] == null && prev[k] != null) q[k] = prev[k]; // a sparse tick keeps the last full one's fields
    });
    stream.quotes[q.id] = q;
    stream.dirty[q.id] = true;
    stream.lastTick = Date.now();
    if (!stream.flushTimer) stream.flushTimer = setTimeout(flushTicks, 200);
  }

  function flushTicks() {
    stream.flushTimer = null;
    var syms = Object.keys(stream.dirty);
    stream.dirty = {};
    syms.forEach(applyQuote);
    setFeed("live", "Live · " + new Date(stream.lastTick).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
    if (state.route.view === "overview" && glanceRedraw && Date.now() - stream.lastGlance > 3000) { stream.lastGlance = Date.now(); glanceRedraw(); }
    setTimeout(function () {
      syms.forEach(function (s) { if (stream.quotes[s]) stream.quotes[s].flash = null; });
      Array.prototype.forEach.call(view.querySelectorAll(".price-tick.is-up, .price-tick.is-down"), function (n) { n.classList.remove("is-up", "is-down"); });
    }, 700);
  }

  function applyQuote(sym) {
    var t = tickerBySymbol(sym), q = stream.quotes[sym];
    if (!t || !q) return;
    var cell = view.querySelector('[data-price="' + sym + '"]');
    if (cell) fillPriceCell(cell, t);
    var head = view.querySelector('[data-head="' + sym + '"]');
    if (head) head.parentNode.replaceChild(detailHead(t), head);
    var range = view.querySelector('[data-range="' + sym + '"]');
    if (range && q.dayLow > 0 && q.dayHigh > 0) range.textContent = "Day " + money(q.dayLow, t.currency) + " – " + money(q.dayHigh, t.currency);
    var vol = view.querySelector('[data-volume="' + sym + '"]');
    if (vol && q.dayVolume > 0) vol.textContent = compact(q.dayVolume);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) streamStop("paused");
    else { stream.retries = 0; streamConnect(); }
  });
  window.addEventListener("pagehide", function () { streamStop("paused"); });

  /* ---------- boot ---------- */

  window.addEventListener("hashchange", render);

  loadSummary().then(function (best) {
    state.summary = best.summary; state.base = best.base; state.generatedAt = best.summary.generatedAt;
    render();
    scheduleRefresh();
    streamConnect();
  }).catch(function (err) {
    clear(view);
    view.appendChild(el("div", { class: "stocks__error" }, el("p", { class: "stocks__error-title", text: "The market data isn't available right now." }),
      el("p", { text: "The first data run may not have happened yet, or the connection failed. " + String(err.message || err) })));
  });
})();
