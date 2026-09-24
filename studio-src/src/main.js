// The Studio: signs in with a GitHub access key, loads the blog's posts and
// subjects, and shows one page at a time (see router.js for the addresses).
import { autosaveKeys, dropAutosave } from "./autosave.js";
import { OWNER, REPO } from "./config.js";
import { GitHubError } from "./github.js";
import { markShown, onRoute, parseRoute, shownHash } from "./router.js";
import { forgetToken, load, onLoad, rememberToken, savedToken, signIn, state } from "./store.js";
import { clear, confirmDialog, h, icon, plural, toast } from "./ui.js";
import { renderNetwork } from "./views/network.js";
import { renderPosts } from "./views/posts.js";
import { renderSignIn } from "./views/signin.js";
import { renderSubjects } from "./views/subjects.js";

const main = document.getElementById("st-main");
const top = document.querySelector(".st-top");
const account = document.querySelector(".st-account");

// "Skip to content" moves the focus without touching the address (which
// holds the Studio's current page).
document.querySelector(".skip-link").addEventListener("click", (e) => {
  e.preventDefault();
  main.focus();
});
const TITLES = { posts: "Posts", write: "Write", network: "Network", subjects: "Subjects" };

let current = null; // the page on screen: { dirty(), leaveMessage, destroy() }
let ticket = 0;
let started = false;

/* ---------- subject colors ---------- */

// The blog's topics.css only changes when the site rebuilds, so the Studio
// paints each subject's color from what it just loaded (same rules).
const colorStyle = document.createElement("style");
document.head.appendChild(colorStyle);

function paintSubjects() {
  const topics = state.topics.filter((t) => /^[a-z0-9-]+$/.test(t.slug));
  const hex = (value, fallback) => (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value) ? value : fallback);
  const light = topics.map((t) => `--${t.slug}: ${hex(t.color, "#6b645b")};`).join(" ");
  const dark = topics.map((t) => `--${t.slug}: ${hex(t.colorDark, hex(t.color, "#a59c8e"))};`).join(" ");
  const n = topics.length;
  const stops = topics.map((t, i) => `var(--${t.slug}) ${Math.floor((i * 100) / n)}% ${Math.floor(((i + 1) * 100) / n)}%`).join(", ");
  colorStyle.textContent = [
    `:root { ${light} }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }`,
    `:root[data-theme="dark"] { ${dark} }`,
    ...topics.map((t) => `.topic--${t.slug} { --topic: var(--${t.slug}); --sel: var(--${t.slug}); }`),
    n ? `.chip--all::before, .chip--all:hover::before, .chip--all[aria-pressed="true"]::before { background: conic-gradient(${stops}); }` : ""
  ].join("\n");
}
onLoad(paintSubjects);

/* ---------- pages ---------- */

function setTabs(view) {
  const tab = view === "write" ? "posts" : view;
  document.querySelectorAll(".st-tab").forEach((link) => {
    if (link.dataset.view === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function problem(title, message, retry) {
  return h("section", { class: "st-page" },
    h("div", { class: "st-empty" },
      h("p", { class: "st-empty__title" }, title),
      h("p", {}, message),
      retry ? h("button", { class: "st-btn st-btn--primary", type: "button", onclick: retry }, "Try again") : null));
}

function loading(text) {
  return h("p", { class: "st-loading" }, h("span", { class: "st-spinner", "aria-hidden": "true" }), text);
}

function leave() {
  if (current && current.destroy) current.destroy();
  current = null;
}

async function draw() {
  if (!state.user) return; // signed out: the sign-in screen stays
  const hash = location.hash;
  const { view, arg } = parseRoute(hash);
  if (!TITLES[view]) {
    history.replaceState(history.state, "", "#/posts");
    return draw();
  }
  const mine = ++ticket;
  leave();
  markShown(hash);
  setTabs(view);
  document.title = `${TITLES[view]} · Studio`;
  clear(main);
  window.scrollTo(0, 0);

  let render = { posts: renderPosts, network: renderNetwork, subjects: renderSubjects }[view];
  if (view === "write") {
    main.append(loading("Opening the editor…"));
    try {
      render = (await import("./views/write.js")).renderWrite; // the editor is loaded only when needed
    } catch (e) {
      if (mine === ticket) clear(main).append(problem("The editor couldn't load", "Check your internet connection, then try again.", draw));
      return;
    }
    if (mine !== ticket) return; // another page was opened in the meantime
    clear(main);
  }
  try {
    current = render(main, arg) || {};
  } catch (e) {
    console.error(e);
    current = {};
    clear(main).append(problem("Something went wrong", `This page couldn't be shown (${e.message}). Try reloading the Studio.`));
  }
  if (!main.contains(document.activeElement)) main.focus({ preventScroll: true });
}

async function canLeave() {
  if (!current || !current.dirty || !current.dirty()) return true;
  return confirmDialog({
    title: "Leave without saving?",
    message: current.leaveMessage || "You have changes that aren't saved yet.",
    confirm: "Leave",
    cancel: "Stay"
  });
}

// Every history entry gets a number, so a Back or Forward can be undone when
// the person decides to stay on a page with unsaved changes.
let position = 0;
let leavingTo = null; // where to go without asking again (the answer was "Leave")

function entryIndex() {
  const st = history.state;
  return st && typeof st.idx === "number" ? st.idx : null;
}

function stamp(idx) {
  history.replaceState(Object.assign({}, history.state, { idx }), "");
}

async function onHashChange() {
  const target = location.hash;
  if (target === shownHash()) return; // (also our own step back while asking)
  if (target && !target.startsWith("#/")) {
    // An in-page link (like "Skip to content"), not a page of the Studio.
    history.replaceState(history.state, "", shownHash());
    const spot = document.getElementById(decodeURIComponent(target.slice(1)));
    if (spot) spot.focus();
    return;
  }
  let idx = entryIndex();
  if (idx === null) { // a new entry: a link or a typed address
    idx = position + 1;
    stamp(idx);
  }
  const allowed = leavingTo === target;
  leavingTo = null;
  if (!allowed && current && current.dirty && current.dirty()) {
    const back = position - idx;
    history.go(back); // return to the page on screen while asking
    if (!(await canLeave())) return;
    leavingTo = target;
    history.go(-back);
    return;
  }
  position = idx;
  draw();
}

// In-page links ask before moving, so history stays as it was.
document.addEventListener("click", async (e) => {
  const link = e.target.closest && e.target.closest('a[href^="#/"]');
  if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const target = link.getAttribute("href");
  if (target === shownHash() || !current || !current.dirty || !current.dirty()) return;
  e.preventDefault();
  if (await canLeave()) {
    leavingTo = target;
    location.hash = target;
  }
}, true);

/* ---------- account ---------- */

const menu = h("div", { class: "st-menu", id: "st-account-menu", hidden: true });
account.after(menu);
account.setAttribute("aria-controls", "st-account-menu");

function toggleMenu(open) {
  menu.hidden = !open;
  account.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    const first = menu.querySelector("a, button");
    if (first) first.focus();
  }
}

account.addEventListener("click", () => toggleMenu(menu.hidden));
document.addEventListener("click", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !account.contains(e.target)) toggleMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menu.hidden) {
    toggleMenu(false);
    account.focus();
  }
});
menu.addEventListener("focusout", (e) => {
  if (!menu.hidden && e.relatedTarget && !menu.contains(e.relatedTarget) && e.relatedTarget !== account) toggleMenu(false);
});

function drawAccount() {
  const user = state.user;
  clear(account);
  if (!user) return;
  const avatar = h("img", { class: "st-account__avatar", src: `${user.avatar_url}${user.avatar_url.includes("?") ? "&" : "?"}s=64`, alt: "", width: 28, height: 28 });
  avatar.addEventListener("error", () => avatar.remove());
  account.append(avatar, h("span", { class: "st-account__name" }, user.login), icon("down", 16));
  account.setAttribute("aria-label", `Account: ${user.login}`);
  clear(menu).append(
    h("p", { class: "st-menu__who" }, "Signed in as ", h("strong", {}, user.login)),
    h("a", { class: "st-menu__item", href: `https://github.com/${OWNER}/${REPO}`, target: "_blank", rel: "noopener" }, icon("external", 18), "The blog's files on GitHub"),
    h("button", { class: "st-menu__item", type: "button", onclick: reload }, icon("undo", 18), "Reload from GitHub"),
    h("button", { class: "st-menu__item", type: "button", onclick: signOut }, icon("signout", 18), "Sign out"));
}

async function reload() {
  toggleMenu(false);
  if (!(await canLeave())) return;
  leave();
  const note = toast("Getting the latest version from GitHub…", { busy: true, timeout: 0 });
  try {
    await load();
    note.update("Up to date.", { kind: "success", timeout: 2500 });
  } catch (e) {
    note.update(e.message, { kind: "error" });
  }
  draw();
}

async function signOut() {
  toggleMenu(false);
  if (!(await canLeave())) return;
  leave(); // (a post being written is backed up here)
  const backups = autosaveKeys();
  if (backups.length && !(await confirmDialog({
    title: "Sign out?",
    message: `Unsaved changes to ${plural(backups.length, "post are", "posts are")} kept on this device. Signing out deletes them.`,
    confirm: "Delete them and sign out",
    cancel: "Cancel",
    danger: true
  }))) {
    draw();
    return;
  }
  backups.forEach(dropAutosave);
  forgetToken();
  state.posts = [];
  state.topics = [];
  showSignIn("");
}

/* ---------- start ---------- */

function showSignIn(error) {
  leave();
  top.hidden = true;
  document.title = "Sign in · Studio";
  clear(main);
  renderSignIn(main, {
    error,
    onSignIn: async (token, keep) => {
      await signIn(token);
      rememberToken(token, keep);
      await load();
      startApp();
    }
  });
}

function startApp() {
  top.hidden = false;
  drawAccount();
  if (!started) {
    started = true;
    onRoute(draw);
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("beforeunload", (e) => {
      if (current && current.dirty && current.dirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }
  if (!TITLES[parseRoute(location.hash).view]) history.replaceState(history.state, "", "#/posts");
  position = entryIndex() === null ? 0 : entryIndex();
  stamp(position);
  draw();
}

function keyProblem(e) {
  if (!(e instanceof GitHubError)) return false;
  const limited = e.status === 403 && e.detail && /rate limit/i.test(e.detail.message || "");
  return e.status === 401 || e.status === 404 || (e.status === 403 && !limited);
}

async function boot() {
  const token = savedToken();
  if (!token) {
    showSignIn("");
    return;
  }
  clear(main).append(loading("Loading your blog…"));
  try {
    await signIn(token);
    await load();
    startApp();
  } catch (e) {
    if (keyProblem(e)) {
      forgetToken();
      showSignIn(e.message);
    } else {
      clear(main).append(problem("Couldn't load your blog", e.message, boot));
    }
  }
}

boot();
