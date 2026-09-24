// Small DOM helpers: element builder, icons, toasts and dialogs.

// h("button", { class: "x", onclick: fn, "aria-label": "…" }, "text", childNode…)
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  Object.entries(props || {}).forEach(([key, value]) => {
    if (value == null || value === false) return;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked" || key === "selected" || key === "disabled" || key === "hidden") el[key] = !!value;
    else el.setAttribute(key, value === true ? "" : value);
  });
  append(el, children);
  return el;
}

function append(el, children) {
  children.flat(Infinity).forEach((child) => {
    if (child == null || child === false) return;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  });
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/* ---------- icons (24×24, drawn with lines) ---------- */

const ICONS = {
  bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
  italic: "M11 5h7M6 19h7M14.5 5l-5 14",
  strike: "M5 12h14M16.5 7.5A4 3.2 0 0 0 12 5c-2.7 0-4.5 1.3-4.5 3.2M7.5 16.5A4.4 3.3 0 0 0 12 19c2.8 0 4.6-1.4 4.6-3.3",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  link: "M10 14a4.5 4.5 0 0 0 6.4 0l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2",
  bullets: "M10 6h10M10 12h10M10 18h10M5 6h.01M5 12h.01M5 18h.01",
  numbers: "M10 6h10M10 12h10M10 18h10M4 5h1.5v4M4 9h3M4 14.5c.5-.8 2.8-.9 2.8.6 0 1.2-2.8 1.7-2.8 3.4h3",
  quote: "M7 7h4v5c0 2.5-1.5 4-4 5M14 7h4v5c0 2.5-1.5 4-4 5",
  codeblock: "M4 5h16v14H4zM9 10l-2 2 2 2M15 10l2 2-2 2",
  divider: "M4 12h16M8 7h8M8 17h8",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01",
  table: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  sigma: "M17 5H7l6 7-6 7h10",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  back: "M15 5l-7 7 7 7",
  check: "M5 12l4.5 4.5L19 7",
  close: "M6 6l12 12M18 6L6 18",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  eye: "M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  pen: "M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3",
  network: "M6 6h.01M18 6h.01M12 18h.01M6 6l6 12M18 6l-6 12M6 6h12",
  palette: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  signout: "M15 17l5-5-5-5M20 12H9M11 20H5V4h6",
  text: "M5 6h14M12 6v13M9 19h6",
  markdown: "M3 6h18v12H3zM6 15V9l3 3 3-3v6M16 9v6M14 13l2 2 2-2",
  upload: "M12 16V4M7 9l5-5 5 5M4 16v4h16v-4",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"
};

export function icon(name, size = 20) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "st-icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] || ICONS.sparkle);
  svg.appendChild(path);
  return svg;
}

/* ---------- toasts ---------- */

export function toast(message, { kind = "info", action = null, timeout = 5000, busy = false } = {}) {
  const box = document.querySelector(".st-toasts");
  const item = h("div", { class: `st-toast st-toast--${kind}` },
    busy ? h("span", { class: "st-spinner", "aria-hidden": "true" }) : null,
    h("span", { class: "st-toast__text" }, message));
  if (action) {
    item.appendChild(action.href
      ? h("a", { class: "st-toast__action", href: action.href, target: "_blank", rel: "noopener" }, action.label)
      : h("button", { class: "st-toast__action", type: "button", onclick: action.onClick }, action.label));
  }
  const close = h("button", { class: "st-toast__close", type: "button", "aria-label": "Dismiss", onclick: () => dismiss() }, icon("close", 16));
  item.appendChild(close);
  box.appendChild(item);
  requestAnimationFrame(() => item.classList.add("is-in"));
  let timer = timeout ? setTimeout(dismiss, timeout) : null;
  function dismiss() {
    clearTimeout(timer);
    item.classList.remove("is-in");
    setTimeout(() => item.remove(), 250);
  }
  return {
    dismiss,
    update(text, opts = {}) {
      item.querySelector(".st-toast__text").textContent = text;
      if (opts.kind) item.className = `st-toast st-toast--${opts.kind} is-in`;
      const spinner = item.querySelector(".st-spinner");
      if (spinner && !opts.busy) spinner.remove();
      if (opts.action) {
        item.insertBefore(opts.action.href
          ? h("a", { class: "st-toast__action", href: opts.action.href, target: "_blank", rel: "noopener" }, opts.action.label)
          : h("button", { class: "st-toast__action", type: "button", onclick: opts.action.onClick }, opts.action.label), close);
      }
      if (opts.timeout) {
        clearTimeout(timer);
        timer = setTimeout(dismiss, opts.timeout);
      }
    }
  };
}

/* ---------- dialogs ---------- */

// Opens a modal <dialog>. `build(close)` returns its content; resolves with
// whatever close() is called with (undefined when dismissed).
export function openDialog(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: `st-dialog${wide ? " st-dialog--wide" : ""}`, "aria-labelledby": "st-dialog-title" });
    let result;
    const close = (value) => {
      result = value;
      dialog.close();
    };
    dialog.append(
      h("div", { class: "st-dialog__head" },
        h("h2", { id: "st-dialog-title", class: "st-dialog__title" }, title),
        h("button", { class: "st-iconbtn", type: "button", "aria-label": "Close", onclick: () => close(undefined) }, icon("close"))),
      build(close)
    );
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    const first = dialog.querySelector("[autofocus], input, textarea, select");
    if (first) first.focus();
  });
}

export function confirmDialog({ title, message, confirm = "Confirm", cancel = "Cancel", danger = false }) {
  return openDialog(title, (close) => h("div", { class: "st-dialog__body" },
    h("p", {}, message),
    h("div", { class: "st-dialog__actions" },
      h("button", { class: "st-btn", type: "button", onclick: () => close(false) }, cancel),
      h("button", { class: `st-btn ${danger ? "st-btn--danger" : "st-btn--primary"}`, type: "button", autofocus: true, onclick: () => close(true) }, confirm))
  )).then((ok) => ok === true);
}

/* ---------- a text box with suggestions ---------- */

// Type to filter, ↑/↓ to move, Enter to pick, Escape to close.
//   choices(query) -> [{ key, label, kind, topic }]   onPick(choice)
let comboCount = 0;
export function combobox({ label, placeholder, empty, choices, onPick, focusKey }) {
  const id = `st-combo-${++comboCount}`;
  let active = -1;
  const input = h("input", {
    class: "st-input", type: "text", placeholder, autocomplete: "off", spellcheck: "false",
    role: "combobox", "aria-expanded": "false", "aria-controls": `${id}-list`, "aria-autocomplete": "list",
    "aria-label": label, dataset: focusKey ? { focus: focusKey } : undefined
  });
  const list = h("ul", { class: "st-options", id: `${id}-list`, role: "listbox", "aria-label": "Suggestions", hidden: true });

  function close() {
    list.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function open() {
    const query = input.value.trim().toLowerCase();
    const found = choices(query);
    clear(list);
    active = -1;
    input.removeAttribute("aria-activedescendant");
    found.forEach((c, i) => list.append(h("li", {
      id: `${id}-${i}`, class: `st-option${c.topic ? ` topic--${c.topic}` : ""}`, role: "option", "aria-selected": "false",
      onmousedown: (e) => {
        e.preventDefault(); // keep the focus in the box
        input.value = "";
        onPick(c);
        if (input.isConnected) open();
      }
    }, h("span", { class: "st-conn__dot", "aria-hidden": "true" }), h("span", { class: "st-conn__label" }, c.label), h("span", { class: "st-conn__kind" }, c.kind))));
    if (!found.length) list.append(h("li", { class: "st-option st-option--empty" }, query ? "Nothing matches" : empty));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    list.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", open);
  input.addEventListener("focus", open);
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("keydown", (e) => {
    const items = list.querySelectorAll("[role=option]");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) open();
      if (!items.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((item, i) => item.setAttribute("aria-selected", i === active ? "true" : "false"));
      input.setAttribute("aria-activedescendant", items[active].id);
      items[active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active >= 0 ? active : 0];
      if (item && !list.hidden) item.dispatchEvent(new Event("mousedown"));
    } else if (e.key === "Escape" && !list.hidden) {
      e.stopPropagation();
      close();
    }
  });

  return { element: h("div", { class: "st-combo" }, input, list), input };
}

/* ---------- formatting ---------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return y ? `${MONTHS[m - 1]} ${d}, ${y}` : "";
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "a minute ago";
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 5400) return "an hour ago";
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  return new Date(ts).toLocaleDateString();
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
