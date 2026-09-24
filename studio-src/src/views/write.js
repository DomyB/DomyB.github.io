// "Write": the Word-like editor for one post, with its settings beside it.
import { dropAutosave, readAutosave, writeAutosave } from "../autosave.js";
import { SITE } from "../config.js";
import {
  advancedFeatures, escapeLiquid, parsePost, postPath, postUrl, serializePost, serializeTopics, slugify, tidyMarkdown, unescapeLiquid
} from "../content.js";
import { createEditor, wordCount } from "../editor/editor.js";
import { createToolbar } from "../editor/toolbar.js";
import { postNames, postRef, resolveName } from "../links.js";
import { trackPublish } from "../publish.js";
import { go, rename } from "../router.js";
import { freeSlug, postByPath, save, state } from "../store.js";
import { clear, combobox, confirmDialog, formatDate, h, icon, openDialog, plural, timeAgo, toast, today } from "../ui.js";

const MAX_IMAGE_SIDE = 1600;

// Pictures uploaded in this visit: the blog shows them only after it
// rebuilds, so until then the editor keeps showing the local copy.
const uploaded = new Map(); // "/assets/images/posts/…" -> local blob: address

// Shrink big photos and turn them into base64 for uploading.
function prepareImage(file) {
  return new Promise((resolve, reject) => {
    const keep = file.type === "image/gif" || (file.type === "image/png" && file.size < 600 * 1024);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const finish = (blob, ext) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ blob, ext, base64: String(reader.result).split(",")[1] });
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      };
      if (keep && scale === 1) {
        finish(file, file.type === "image/gif" ? "gif" : "png");
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // photos with transparency get a white background
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? finish(blob, "jpg") : reject(new Error("Couldn't read that picture."))), "image/jpeg", 0.85);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file doesn't look like a picture."));
    };
    img.src = url;
  });
}

// A post whose settings (the part between the --- lines) can't be read is
// edited as the whole file, exactly as it is, so nothing gets lost.
function renderFile(container, post) {
  const name = post.path.split("/").pop();
  let dirty = false;
  let saving = false;
  let alive = true;
  const grow = () => {
    text.style.height = "auto";
    text.style.height = `${text.scrollHeight}px`;
  };
  const text = h("textarea", {
    class: "st-source", spellcheck: "false", "aria-label": `The file ${name}`,
    oninput: () => { dirty = true; grow(); showStatus(); }
  }, post.source);
  const status = h("span", { class: "st-status", role: "status" });
  const saveBtn = h("button", { class: "st-btn st-btn--primary", type: "button", onclick: saveFile }, icon("check", 18), "Save file");

  function showStatus() {
    clear(status).append(h("span", { class: "st-status__note" }, saving ? "Saving…" : dirty ? "Unsaved changes" : "Needs fixing"));
    status.classList.toggle("is-dirty", dirty && !saving);
  }

  async function saveFile() {
    if (saving) return;
    const problem = parsePost(post.path, text.value).error;
    if (problem && !(await confirmDialog({
      title: "Still not quite right",
      message: `The settings still can't be read (${problem.split("\n")[0]}). Save anyway?`,
      confirm: "Save anyway"
    }))) return;
    saving = true;
    saveBtn.disabled = true;
    showStatus();
    try {
      const sha = await save(`Fix the settings of ${name}`, [{ path: post.path, content: text.value }]);
      dirty = false;
      trackPublish(sha, { saved: "File saved.", live: "Your blog is up to date." });
      if (alive) go(`#/write/${encodeURIComponent(post.path)}`, { replace: true }); // opens normally once fixed
    } catch (e) {
      toast(e.message, { kind: "error", timeout: 0 });
    } finally {
      saving = false;
      saveBtn.disabled = false;
      if (alive) showStatus();
    }
  }

  container.append(h("section", { class: "st-write", "aria-labelledby": "st-write-title" },
    h("h1", { class: "visually-hidden", id: "st-write-title" }, `Fix ${name}`),
    h("div", { class: "st-write__bar" },
      h("a", { class: "st-btn st-btn--ghost", href: "#/posts" }, icon("back", 18), h("span", { class: "st-hide-small" }, "Posts")),
      status,
      h("div", { class: "st-write__actions" }, saveBtn)),
    h("div", { class: "st-write__grid st-write__grid--single" },
      h("div", { class: "st-desk" },
        h("div", { class: "st-paper st-paper--file" },
          h("div", { class: "st-notice st-notice--warn" },
            icon("sparkle", 18),
            h("div", {},
              h("p", {}, `The settings at the top of ${name} (between the --- lines) have a formatting problem, so the Studio shows the whole file here, exactly as it is. A common cause is a title with a colon in it: put the title in quotes. Fix it and save; the post then opens in the editor again.`),
              h("pre", { class: "st-error" }, post.error))),
          text)))));
  showStatus();
  requestAnimationFrame(grow);
  text.focus();
  return {
    dirty: () => dirty && !saving,
    leaveMessage: "Your changes to this file aren't saved yet. If you leave now, they'll be lost.",
    destroy() { alive = false; }
  };
}

export function renderWrite(container, arg) {
  let original = !arg || arg === "new" ? null : postByPath(arg);
  if (arg && arg !== "new" && !original) {
    container.append(h("section", { class: "st-page" },
      h("div", { class: "st-empty" },
        h("p", { class: "st-empty__title" }, "Post not found"),
        h("p", {}, "It may have been renamed or deleted."),
        h("a", { class: "st-btn", href: "#/posts" }, icon("back"), "Back to posts"))));
    return {};
  }
  if (original && original.error) return renderFile(container, original);

  let wasPublished = !!(original && original.published);
  let key = original ? original.path : "new"; // where unsaved changes are backed up
  const post = {
    title: original ? original.title : "",
    description: original ? original.description : "",
    topic: original ? original.topic : (state.topics[0] ? state.topics[0].slug : ""),
    connections: original ? original.connections.filter((c) => c !== original.topic) : [],
    date: original ? original.date : today(),
    slug: original ? original.slug : "",
    dropcap: original ? original.dropcap : true,
    math: original ? original.math : false,
    body: original ? original.body : ""
  };
  let slugTouched = !!original;
  let dirty = false;
  let bodyDirty = false;
  let saving = false;
  let textMode = false;
  let savedAt = null;
  let timer = null;
  let revision = 0; // counts edits, to notice typing while a save is on its way
  let alive = true; // false once the page is left (a save can still be finishing)
  const pending = new Map(); // "/assets/images/posts/…" -> { base64, url, saved }

  /* ---------- the page ---------- */

  const grow = (el) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const title = h("textarea", {
    class: "st-paper__title", rows: 1, placeholder: "Title", "aria-label": "Title", maxlength: 200,
    oninput: () => {
      post.title = title.value.replace(/\s*\n\s*/g, " ");
      if (!slugTouched) {
        post.slug = slugify(post.title);
        slugInput.value = post.slug;
        showAddress();
      }
      grow(title);
      changed();
    },
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); lede.focus(); } }
  }, post.title);

  const lede = h("textarea", {
    class: "st-paper__lede", rows: 1, maxlength: 300, "aria-label": "Summary",
    placeholder: "Add a one-sentence summary. It's shown on the home page and when the link is shared.",
    oninput: () => {
      post.description = lede.value.replace(/\s*\n\s*/g, " ");
      grow(lede);
      changed();
    },
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); if (!textMode) editor.commands.focus("start"); else source.focus(); } }
  }, post.description);

  const editorHost = h("div", { class: "st-editor" });
  const source = h("textarea", {
    class: "st-source", hidden: true, spellcheck: "true", "aria-label": "Post text in Markdown",
    oninput: () => { bodyDirty = true; grow(source); changed(); }
  });
  const advanced = advancedFeatures(post.body);
  const notice = h("p", { class: "st-notice", hidden: !advanced.length },
    icon("markdown", 18),
    h("span", {}, `This post uses ${advanced.join(", ")}, so it opens as Markdown text to keep everything exactly as written.`));
  const editor = createEditor(editorHost, advanced.length ? "" : unescapeLiquid(post.body), {
    onChange: () => {
      bodyDirty = true;
      changed();
    },
    resolveImage: (src) => (pending.has(src) ? pending.get(src).url : uploaded.get(src) || src)
  });

  const toolbar = createToolbar(editor, { onImage: pickImage });
  const modeBtn = h("button", {
    class: "st-btn st-btn--ghost st-mode", type: "button", "aria-pressed": "false", onclick: () => toggleMode()
  }, icon("markdown", 18), h("span", { class: "st-hide-small" }, "Markdown"));
  const paper = h("article", { class: "st-paper" },
    title, lede, h("div", { class: "st-paper__rule", "aria-hidden": "true" }), notice, editorHost, source);
  const counter = h("p", { class: "st-paper__count" });

  /* ---------- settings ---------- */

  const status = h("span", { class: "st-status", role: "status" });
  const subject = h("select", {
    class: "st-input", id: "st-subject",
    onchange: () => {
      post.topic = subject.value;
      paint();
      drawConnections();
      changed();
    }
  }, [h("option", { value: "" }, "No subject")].concat(state.topics.map((t) => h("option", { value: t.slug, selected: t.slug === post.topic }, t.name))));

  const connList = h("ul", { class: "st-conns", role: "list", "aria-labelledby": "st-conn-label" });
  const conn = combobox({
    label: "Add a connection",
    placeholder: "Add a subject or post…",
    empty: "Everything is connected already",
    choices: suggestions,
    onPick: (choice) => {
      post.connections.push(choice.key);
      drawConnections();
      changed();
    }
  });

  const date = h("input", {
    class: "st-input", id: "st-date", type: "date", value: post.date, "aria-describedby": "st-date-help",
    onchange: () => { post.date = date.value || today(); showAddress(); changed(); }
  });
  const dateHelp = h("p", { class: "st-hint", id: "st-date-help" });
  const slugInput = h("input", {
    class: "st-input st-input--mono", id: "st-slug", type: "text", value: post.slug, spellcheck: "false",
    oninput: () => { slugTouched = true; post.slug = slugify(slugInput.value); showAddress(); changed(); },
    onchange: () => { slugInput.value = post.slug; }
  });
  const address = h("p", { class: "st-address" });
  const dropcap = h("input", { type: "checkbox", checked: post.dropcap, onchange: () => { post.dropcap = dropcap.checked; paint(); changed(); } });
  const math = h("input", { type: "checkbox", checked: post.math, onchange: () => { post.math = math.checked; changed(); } });

  let publishBtn = null;
  let draftBtn = null;
  const actions = h("div", { class: "st-write__actions" });
  const danger = h("div", { class: "st-settings__group st-settings__danger" });

  const settings = h("aside", { class: "st-settings", "aria-label": "Post settings" },
    h("div", { class: "st-settings__group" },
      h("label", { class: "st-field__label", for: "st-subject" }, "Main subject"),
      subject,
      h("a", { class: "st-hint st-link", href: "#/subjects" }, "Manage subjects")),
    h("div", { class: "st-settings__group" },
      h("span", { class: "st-field__label", id: "st-conn-label" }, "Connections"),
      h("p", { class: "st-hint" }, "Other subjects and posts this post relates to. They show up on the network and at the end of the post."),
      connList,
      conn.element),
    h("div", { class: "st-settings__group" },
      h("span", { class: "st-field__label" }, "Options"),
      h("label", { class: "st-check" }, dropcap, h("span", {}, "Big first letter")),
      h("label", { class: "st-check" }, math, h("span", {}, "Equations (switched on automatically when you add one)"))),
    h("details", { class: "st-more" },
      h("summary", {}, h("span", { class: "st-field__label" }, "Date and web address")),
      h("div", { class: "st-more__body" },
        h("div", { class: "st-settings__group" },
          h("label", { class: "st-field__label", for: "st-date" }, "Date"),
          date,
          dateHelp),
        h("div", { class: "st-settings__group" },
          h("label", { class: "st-field__label", for: "st-slug" }, "Web address"),
          slugInput,
          address))),
    danger);

  const bar = h("div", { class: "st-write__bar" },
    h("a", { class: "st-btn st-btn--ghost", href: "#/posts" }, icon("back", 18), h("span", { class: "st-hide-small" }, "Posts")),
    status,
    modeBtn,
    actions);

  const banner = h("div", { class: "st-banner", hidden: true });

  const heading = h("h1", { class: "visually-hidden", id: "st-write-title" }, original ? `Edit “${original.title}”` : "New post");

  container.append(h("section", { class: "st-write", "aria-labelledby": "st-write-title" },
    heading,
    bar,
    banner,
    h("div", { class: "st-write__grid" },
      h("div", { class: "st-desk" }, toolbar.element, paper, counter),
      settings)));

  /* ---------- behaviour ---------- */

  function paint() {
    paper.className = `st-paper${post.topic ? ` topic--${post.topic}` : ""}`;
    editor.view.dom.classList.toggle("no-dropcap", !post.dropcap);
  }

  // The parts that depend on whether the post is new, a draft or published.
  function drawChrome() {
    publishBtn = h("button", { class: "st-btn st-btn--primary", type: "button", onclick: () => persist("publish") },
      icon(wasPublished ? "check" : "upload", 18), wasPublished ? "Update" : "Publish");
    draftBtn = wasPublished ? null : h("button", { class: "st-btn", type: "button", onclick: () => persist("draft") }, "Save draft");
    const view = wasPublished ? h("a", { class: "st-btn st-btn--ghost", href: SITE + postUrl(original), target: "_blank", rel: "noopener" },
      icon("external", 18), h("span", { class: "st-hide-small" }, "View")) : null;
    clear(actions).append(...[view, draftBtn, publishBtn].filter(Boolean));

    date.disabled = wasPublished;
    slugInput.disabled = wasPublished;
    dateHelp.textContent = wasPublished
      ? "Published posts keep their date and address, so links to them never break."
      : "The post's date. It's also part of its address.";

    clear(danger);
    if (original) {
      if (wasPublished) danger.append(h("button", { class: "st-btn st-btn--ghost", type: "button", onclick: unpublish }, "Unpublish (back to draft)"));
      danger.append(h("button", { class: "st-btn st-btn--ghost st-btn--danger-text", type: "button", onclick: remove }, icon("trash", 18), "Delete post"));
    }
    danger.hidden = !original;
    heading.textContent = original ? `Edit “${original.title}”` : "New post";
    showStatus();
  }

  function showAddress() {
    const [y, m] = (post.date || today()).split("-");
    address.textContent = `${SITE.replace("https://", "")}/${y}/${m}/${post.slug || "…"}/`;
  }

  function currentBody() {
    if (textMode) return source.value;
    return bodyDirty ? escapeLiquid(tidyMarkdown(editor.getMarkdown())) : post.body;
  }

  function count() {
    const words = textMode ? source.value.split(/\s+/).filter(Boolean).length : wordCount(editor);
    counter.textContent = `${plural(words, "word", "words")} · ${Math.max(1, Math.round(words / 200))} min read`;
  }

  function showStatus() {
    const where = !original ? "New post" : wasPublished ? `Published · ${formatDate(original.date)}` : "Draft · not on your blog yet";
    const note = saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved";
    const backedUp = dirty && !saving && savedAt ? ` · backed up on this device ${timeAgo(savedAt)}` : "";
    if (status.dataset.text === where + note + backedUp) return; // no need to announce it again
    status.dataset.text = where + note + backedUp;
    clear(status).append(...[
      h("span", { class: "st-status__where" }, `${where} — `),
      h("span", { class: "st-status__note" }, note),
      backedUp ? h("span", { class: "st-status__where" }, backedUp) : null
    ].filter(Boolean));
    status.classList.toggle("is-dirty", dirty && !saving);
  }

  function changed() {
    dirty = true;
    revision++;
    count();
    showStatus();
    clearTimeout(timer);
    timer = setTimeout(backup, 700);
  }

  function backup() {
    if (!dirty) return;
    const images = {};
    pending.forEach((img, path) => { if (!img.saved) images[path] = img.base64; });
    writeAutosave(key, {
      ts: Date.now(),
      base: original ? state.shas.get(original.path) || null : null,
      post: Object.assign({}, post, { body: currentBody() }),
      textMode,
      images
    });
    savedAt = Date.now();
    showStatus();
  }

  function drawConnections() {
    clear(connList);
    const shown = post.connections.filter((name) => name !== post.topic); // the main subject is always connected
    shown.forEach((name) => {
      const target = resolveName(name);
      const topic = target && target.kind === "topic" ? target.topic : null;
      const other = target && target.kind === "post" ? target.post : null;
      const label = topic ? topic.name : other ? other.title : name;
      const color = topic ? topic.slug : other ? other.topic : "";
      connList.append(h("li", { class: `st-conn${color ? ` topic--${color}` : ""}${target ? "" : " st-conn--unknown"}` },
        h("span", { class: "st-conn__dot", "aria-hidden": "true" }),
        h("span", { class: "st-conn__label" }, label),
        h("span", { class: "st-conn__kind" }, topic ? "Subject" : other ? (other.published ? "Post" : "Draft") : "Not found"),
        h("button", {
          class: "st-iconbtn st-iconbtn--small", type: "button", "aria-label": `Remove connection to ${label}`,
          onclick: () => { post.connections = post.connections.filter((c) => c !== name); drawConnections(); changed(); conn.input.focus(); }
        }, icon("close", 16))));
    });
    if (!shown.length) connList.append(h("li", { class: "st-hint" }, "No connections yet."));
  }

  function suggestions(query) {
    const has = (names) => names.some((n) => post.connections.includes(n));
    return state.topics
      .filter((t) => t.slug !== post.topic && !has([t.slug]))
      .map((t) => ({ key: t.slug, label: t.name, kind: "Subject", topic: t.slug }))
      .concat(state.posts
        .filter((p) => (!original || p.path !== original.path) && !p.error && !has(postNames(p)))
        .map((p) => ({ key: postRef(p), label: p.title, kind: p.published ? "Post" : "Draft", topic: p.topic })))
      .filter((c) => !query || c.label.toLowerCase().includes(query) || c.key.includes(query))
      .slice(0, 12);
  }

  function applyMode() {
    editorHost.hidden = textMode;
    source.hidden = !textMode;
    toolbar.setMode(textMode);
    modeBtn.setAttribute("aria-pressed", textMode ? "true" : "false");
    modeBtn.title = textMode ? "Back to the visual editor" : "Edit the post as Markdown text";
    if (textMode) grow(source);
    count();
  }

  function toggleMode() {
    if (!textMode) {
      source.value = currentBody();
      textMode = true;
    } else {
      const found = advancedFeatures(source.value);
      if (found.length) {
        toast(`This post uses ${found.join(", ")}, which the visual editor can't show. Keep editing it as text.`, { kind: "info", timeout: 9000 });
        return;
      }
      editor.commands.setContent(unescapeLiquid(source.value), { contentType: "markdown", emitUpdate: false });
      textMode = false;
      bodyDirty = true;
    }
    applyMode();
  }

  function pickImage() {
    const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/gif,image/webp" });
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
        toast("Please choose a JPG, PNG, GIF or WebP picture.", { kind: "error" });
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        toast("That picture is over 20 MB. Please choose a smaller one.", { kind: "error" });
        return;
      }
      try {
        const img = await prepareImage(file);
        const base = slugify(post.slug || post.title) || "post";
        const path = `/assets/images/posts/${base}-${Date.now().toString(36)}.${img.ext}`;
        pending.set(path, { base64: img.base64, url: URL.createObjectURL(img.blob), saved: false });
        const alt = await askAlt();
        editor.chain().focus().setImage({ src: path, alt: alt || "" }).run();
      } catch (e) {
        toast(e.message, { kind: "error" });
      }
    });
    input.click();
  }

  function askAlt() {
    return openDialog("Describe the picture", (close) => {
      const input = h("input", { class: "st-input", type: "text", autofocus: true, placeholder: "For example: A chart of inflation since 2015", "aria-label": "Picture description" });
      return h("form", { class: "st-dialog__body", onsubmit: (e) => { e.preventDefault(); close(input.value.trim()); } },
        h("p", {}, "A short description helps people who use screen readers, and search engines. You can leave it empty."),
        input,
        h("div", { class: "st-dialog__actions" },
          h("button", { class: "st-btn", type: "button", onclick: () => close("") }, "Skip"),
          h("button", { class: "st-btn st-btn--primary", type: "submit" }, "Add picture")));
    });
  }

  // Other posts (and subjects) that point at a post that's being renamed or deleted.
  function referenceFixes(oldPost, newSlug) {
    const names = postNames(oldPost);
    const swap = (list) => {
      const out = [];
      list.forEach((c) => {
        const next = names.includes(c) ? newSlug : c;
        if (next && !out.includes(next)) out.push(next);
      });
      return out;
    };
    const files = [];
    state.posts.forEach((p) => {
      if (p.path === oldPost.path || p.error || !p.connections.some((c) => names.includes(c))) return;
      files.push({ path: p.path, content: serializePost(Object.assign({}, p, { connections: swap(p.connections) })) });
    });
    if (state.topics.some((t) => t.connects.some((c) => names.includes(c)))) {
      const topics = state.topics.map((t) => Object.assign({}, t, { connects: swap(t.connects) }));
      files.push({ path: "_data/topics.yml", content: serializeTopics(topics) });
    }
    return files;
  }

  async function persist(mode, message) {
    if (saving) return;
    const cleanTitle = post.title.trim();
    if (!cleanTitle) {
      toast("Give your post a title first.", { kind: "error" });
      title.focus();
      return;
    }
    const before = wasPublished;
    const rev = revision;
    const body = currentBody();
    let path = original ? original.path : null;
    if (!before) {
      const wanted = slugify(post.slug) || slugify(cleanTitle) || "post";
      const slug = original && original.slug === wanted ? wanted : freeSlug(wanted, original && original.path);
      path = postPath(post.date || today(), slug);
    }
    const slug = path.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, "").replace(/\.(md|markdown)$/, "");
    const next = {
      path,
      fm: original ? original.fm : {},
      title: cleanTitle,
      description: post.description.trim(),
      topic: post.topic,
      connections: post.connections.filter((c) => c !== post.topic),
      body,
      math: post.math || /\$\$/.test(body),
      dropcap: post.dropcap,
      published: mode === "publish"
    };
    const files = [{ path, content: serializePost(next) }];
    if (original && original.path !== path) {
      files.push({ path: original.path, delete: true });
      files.push(...referenceFixes(original, slug));
    }
    const uploads = [];
    pending.forEach((img, src) => {
      if (!img.saved && body.includes(src)) {
        files.push({ path: src.replace(/^\//, ""), base64: img.base64 });
        uploads.push(img);
      }
    });

    const verb = message || (mode === "publish" ? (before ? "Update" : "Publish") : "Save draft");
    saving = true;
    [publishBtn, draftBtn].forEach((b) => b && (b.disabled = true));
    showStatus();
    try {
      const sha = await save(`${verb} “${cleanTitle}”`, files);
      uploads.forEach((img) => { img.saved = true; });
      pending.forEach((img, src) => { if (img.saved) uploaded.set(src, img.url); });
      const oldKey = key;
      original = postByPath(path);
      wasPublished = !!(original && original.published);
      key = path;
      if (revision !== rev) {
        // Writing went on while saving: keep the newer changes backed up, under the post's address.
        if (alive) {
          backup();
        } else {
          const later = readAutosave(oldKey);
          if (later) writeAutosave(key, Object.assign({}, later, { base: state.shas.get(path) || null }));
        }
        if (oldKey !== key) dropAutosave(oldKey);
      } else {
        dropAutosave(oldKey);
        dropAutosave(key);
        dirty = false;
        post.body = body;
        if (!textMode) bodyDirty = false;
        post.title = cleanTitle;
        post.math = next.math;
      }
      if (revision === rev || !slugTouched) {
        post.slug = slug;
        post.date = path.slice(7, 17);
      }
      slugTouched = true;
      if (alive) {
        math.checked = post.math;
        slugInput.value = post.slug;
        date.value = post.date;
        rename(`#/write/${encodeURIComponent(path)}`);
      }
      if (mode === "publish") {
        trackPublish(sha, {
          saved: before ? "Post updated." : "Post published.",
          live: `“${cleanTitle}” is live on your blog.`,
          url: postUrl({ date: post.date, slug })
        });
      } else {
        toast(before ? "The post is a draft again and no longer on your blog." : "Draft saved. It's kept with your blog but not shown until you publish it.", { kind: "success" });
      }
    } catch (e) {
      toast(e.message, { kind: "error", timeout: 0 });
    } finally {
      saving = false;
      if (alive) {
        drawChrome();
        showAddress();
      }
    }
  }

  async function unpublish() {
    const ok = await confirmDialog({
      title: "Unpublish this post?",
      message: "It will disappear from your blog but stay here as a draft, so you can publish it again later.",
      confirm: "Unpublish"
    });
    if (ok) persist("draft", "Unpublish");
  }

  async function remove() {
    const ok = await confirmDialog({
      title: "Delete this post?",
      message: `“${original.title}” will be removed${wasPublished ? " from your blog" : ""}. Connections to it are removed too. (GitHub keeps a copy in the blog's history.)`,
      confirm: "Delete post",
      danger: true
    });
    if (!ok) return;
    try {
      const files = [{ path: original.path, delete: true }].concat(referenceFixes(original, null));
      const sha = await save(`Delete “${original.title}”`, files);
      dropAutosave(key);
      dirty = false;
      if (wasPublished) trackPublish(sha, { saved: "Post deleted.", live: "The post is gone from your blog." });
      else toast("Draft deleted.", { kind: "success" });
      if (alive) go("#/posts");
    } catch (e) {
      toast(e.message, { kind: "error", timeout: 0 });
    }
  }

  function offerRestore(saved) {
    const changedSince = original && saved.base && saved.base !== state.shas.get(original.path);
    clear(banner).append(
      icon("sparkle", 18),
      h("span", {}, changedSince
        ? `You have unsaved changes from ${timeAgo(saved.ts)}, but the post has changed on GitHub since then.`
        : `You have unsaved changes from ${timeAgo(saved.ts)}.`),
      h("button", { class: "st-btn st-btn--small st-btn--primary", type: "button", onclick: () => restore(saved) }, "Restore them"),
      h("button", { class: "st-btn st-btn--small", type: "button", onclick: () => { dropAutosave(key); banner.hidden = true; } }, "Discard"));
    banner.hidden = false;
  }

  function restore(saved) {
    Object.assign(post, saved.post);
    Object.entries(saved.images || {}).forEach(([path, base64]) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const type = /\.png$/.test(path) ? "image/png" : /\.gif$/.test(path) ? "image/gif" : "image/jpeg";
      pending.set(path, { base64, url: URL.createObjectURL(new Blob([bytes], { type })), saved: false });
    });
    title.value = post.title;
    lede.value = post.description;
    subject.value = post.topic;
    if (!wasPublished) {
      date.value = post.date;
      slugInput.value = post.slug;
    } else {
      post.date = original.date;
      post.slug = original.slug;
    }
    dropcap.checked = post.dropcap;
    math.checked = post.math;
    slugTouched = true;
    textMode = !!saved.textMode || advancedFeatures(post.body).length > 0;
    if (textMode) source.value = post.body;
    else editor.commands.setContent(unescapeLiquid(post.body), { contentType: "markdown", emitUpdate: false });
    bodyDirty = true;
    banner.hidden = true;
    [title, lede].forEach(grow);
    paint();
    drawConnections();
    showAddress();
    applyMode();
    changed();
  }

  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      persist(wasPublished ? "publish" : "draft");
    } else if (mod && e.key.toLowerCase() === "k" && !textMode && editorHost.contains(document.activeElement)) {
      e.preventDefault();
      toolbar.element.querySelector('[data-tool="link"]').click();
    }
  }
  document.addEventListener("keydown", onKey);

  /* ---------- start ---------- */

  if (advanced.length) {
    textMode = true;
    source.value = post.body;
  }
  paint();
  drawChrome();
  drawConnections();
  showAddress();
  applyMode();
  requestAnimationFrame(() => [title, lede].forEach(grow));
  const saved = readAutosave(key);
  if (saved && saved.post) offerRestore(saved);
  if (!original) title.focus();

  return {
    dirty: () => dirty && !saving,
    leaveMessage: "Your latest changes aren't saved to your blog yet. They're backed up on this device, so you can restore them the next time you open this post.",
    destroy() {
      alive = false;
      clearTimeout(timer);
      if (dirty) backup();
      document.removeEventListener("keydown", onKey);
      editor.destroy();
      pending.forEach((img, src) => { if (uploaded.get(src) !== img.url) URL.revokeObjectURL(img.url); });
    }
  };
}
