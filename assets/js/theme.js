/* Light/dark theme switch.
   A tiny script in _includes/head.html applies the saved choice before the page
   paints; this file wires up the button and the circular "reveal" animation. */
(function () {
  "use strict";

  var root = document.documentElement;
  var button = document.querySelector(".theme-toggle");
  var systemDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var themeMetas = Array.prototype.slice.call(document.querySelectorAll('meta[name="theme-color"]'));
  var metaDefaults = themeMetas.map(function (meta) { return meta.getAttribute("content"); });

  function currentTheme() {
    var chosen = root.getAttribute("data-theme");
    if (chosen === "light" || chosen === "dark") return chosen;
    return systemDark && systemDark.matches ? "dark" : "light";
  }

  function syncUi() {
    var theme = currentTheme();
    if (button) button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");

    // Keep the browser's toolbar color in step with a manually chosen theme.
    var chosen = root.hasAttribute("data-theme");
    var bg = getComputedStyle(root).getPropertyValue("--bg").trim();
    themeMetas.forEach(function (meta, i) {
      meta.setAttribute("content", chosen && bg ? bg : metaDefaults[i]);
    });

    root.dispatchEvent(new CustomEvent("themechange", { detail: { theme: theme } }));
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch (e) {
      /* Storage is blocked: the choice still applies until the page is left. */
    }
    syncUi();
  }

  function toggle() {
    var next = currentTheme() === "dark" ? "light" : "dark";
    var animate = typeof document.startViewTransition === "function" &&
      !(reduceMotion && reduceMotion.matches);

    if (!animate) {
      applyTheme(next);
      return;
    }

    // Grow a circle of the new theme out of the button.
    var rect = button.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    root.classList.add("theme-switching");
    var transition = document.startViewTransition(function () {
      applyTheme(next);
    });

    transition.ready.then(function () {
      root.animate(
        {
          clipPath: [
            "circle(0px at " + x + "px " + y + "px)",
            "circle(" + radius + "px at " + x + "px " + y + "px)"
          ]
        },
        {
          duration: 650,
          easing: "cubic-bezier(0.65, 0, 0.35, 1)",
          pseudoElement: "::view-transition-new(root)"
        }
      );
    }).catch(function () {});

    function done() {
      root.classList.remove("theme-switching");
    }
    transition.finished.then(done, done);
  }

  if (button) {
    button.hidden = false;
    button.addEventListener("click", toggle);
  }

  if (systemDark) {
    var onSystemChange = function () {
      if (!root.hasAttribute("data-theme")) syncUi();
    };
    if (systemDark.addEventListener) systemDark.addEventListener("change", onSystemChange);
    else if (systemDark.addListener) systemDark.addListener(onSystemChange);
  }

  syncUi();
})();
