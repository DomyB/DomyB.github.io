// "Network": the blog's neural network. Drag between dots to connect subjects
// and posts, or use the panel beside it (which also works with a keyboard).
// Changes collect here until "Save changes" writes them in one commit.
import { BRANCH, OWNER, REPO } from "../config.js";
import { serializePost, serializeTopics } from "../content.js";
import { mentions, postNames, refName, resolveName, sameNames, withoutItem } from "../links.js";
import { trackPublish } from "../publish.js";
import { save, state } from "../store.js";
import { clear, combobox, formatDate, h, icon, plural, toast } from "../ui.js";

export function renderNetwork(container) {
  if (!window.BlogNetwork) {
    container.append(h("section", { class: "st-page" },
      h("div", { class: "st-empty" },
        h("p", { class: "st-empty__title" }, "The network couldn't start"),
        h("p", {}, "Reload the page to try again."))));
    return {};
  }

  let work = fresh();
  let showDrafts = false;
  let chosen = null; // { kind: "topic", id: slug } or { kind: "post", id: path }
  let saving = false;
  let alive = true; // false once the page is left (a save can still be finishing)
  const undoStack = [];

  /* ---------- the working copy ---------- */

  function fresh() {
    return {
      topics: new Map(state.topics.map((t) => [t.slug, t.connects.slice()])),
      posts: new Map(state.posts.map((p) => [p.path, { topic: p.topic, connections: p.connections.slice() }]))
    };
  }

  function copy(w) {
    return {
      topics: new Map(Array.from(w.topics, ([k, v]) => [k, v.slice()])),
      posts: new Map(Array.from(w.posts, ([k, v]) => [k, { topic: v.topic, connections: v.connections.slice() }]))
    };
  }

  function remember() {
    undoStack.push(copy(work));
    if (undoStack.length > 60) undoStack.shift();
  }

  const topicItem = (topic) => ({ kind: "topic", topic });
  const postItem = (post) => ({ kind: "post", post });
  const itemName = (item) => (item.kind === "topic" ? item.topic.name : item.post.title);
  const listOf = (item) => (item.kind === "topic" ? work.topics.get(item.topic.slug) : work.posts.get(item.post.path).connections);
  const mainOf = (post) => work.posts.get(post.path).topic;

  function setList(item, list) {
    if (item.kind === "topic") work.topics.set(item.topic.slug, list);
    else work.posts.get(item.post.path).connections = list;
  }

  function linked(a, b) {
    return mentions(listOf(a), b) || mentions(listOf(b), a);
  }

  function connect(a, b) {
    // Like the blog: a connection is written into the post (so it shows at the
    // end of it), or into the first subject when both are subjects.
    const owner = a.kind === "post" ? a : b.kind === "post" ? b : a;
    const other = owner === a ? b : a;
    setList(owner, listOf(owner).concat(refName(other)));
  }

  function disconnect(a, b) {
    setList(a, withoutItem(listOf(a), b));
    setList(b, withoutItem(listOf(b), a));
  }

  function sameItem(a, b) {
    return a.kind === b.kind && (a.kind === "topic" ? a.topic === b.topic : a.post === b.post);
  }

  // Everything connected to an item (its main subject aside).
  function neighbours(item) {
    const out = [];
    const add = (other) => {
      if (!sameItem(other, item) && !out.some((o) => sameItem(o, other))) out.push(other);
    };
    listOf(item).forEach((name) => {
      const target = resolveName(name);
      if (target) add(target);
    });
    state.topics.forEach((t) => { if (mentions(work.topics.get(t.slug), item)) add(topicItem(t)); });
    state.posts.forEach((p) => { if (mentions(work.posts.get(p.path).connections, item)) add(postItem(p)); });
    return out.filter((o) => !(item.kind === "post" && o.kind === "topic" && mainOf(item.post) === o.topic.slug) &&
      !(item.kind === "topic" && o.kind === "post" && mainOf(o.post) === item.topic.slug));
  }

  // Names in a list that match no subject or post.
  function unknownNames() {
    const out = [];
    state.topics.forEach((t) => work.topics.get(t.slug).forEach((name) => {
      if (!resolveName(name)) out.push({ item: topicItem(t), name });
    }));
    state.posts.forEach((p) => work.posts.get(p.path).connections.forEach((name) => {
      if (!resolveName(name)) out.push({ item: postItem(p), name });
    }));
    return out;
  }

  // A post's connections as they'll be saved: its main subject is always connected, so it isn't listed.
  const effective = (list, topic) => list.filter((name) => name !== topic);

  function changedPosts() {
    return state.posts.filter((p) => {
      const w = work.posts.get(p.path);
      return w.topic !== p.topic || !sameNames(effective(w.connections, w.topic), effective(p.connections, p.topic));
    });
  }

  function topicsChanged() {
    return state.topics.some((t) => !sameNames(work.topics.get(t.slug), t.connects));
  }

  function changeCount() {
    return changedPosts().length + (topicsChanged() ? 1 : 0);
  }

  /* ---------- the drawing ---------- */

  const shownPosts = () => state.posts.filter((p) => p.published || showDrafts);

  function networkData() {
    const posts = shownPosts();
    return {
      repo: `${OWNER}/${REPO}`,
      branch: BRANCH,
      topics: state.topics.map((t) => ({
        key: t.slug, name: t.name, description: t.description, url: "#/subjects", connects: work.topics.get(t.slug)
      })),
      posts: posts.map((p) => {
        const w = work.posts.get(p.path);
        return {
          key: p.slug, fileKey: `${p.date}-${p.slug}`, file: p.path,
          title: p.error ? `${p.title} (needs fixing)` : p.published ? p.title : `${p.title} (draft)`,
          url: `#/write/${encodeURIComponent(p.path)}`, date: formatDate(p.date),
          topic: w.topic, connections: w.connections, description: p.description
        };
      }),
      baseline: {
        topics: state.topics.map((t) => ({ key: t.slug, connects: t.connects })),
        posts: posts.map((p) => ({ key: p.slug, fileKey: `${p.date}-${p.slug}`, topic: p.topic, connections: p.connections }))
      }
    };
  }

  // A dot the network reports -> the subject or post it stands for.
  function fromInfo(info) {
    if (!info) return null;
    if (info.kind === "topic") {
      const topic = state.topics.find((t) => t.slug === info.key);
      return topic ? topicItem(topic) : null;
    }
    // The file tells posts with the same name apart.
    const post = shownPosts().find((p) => (info.file ? p.path === info.file : p.slug.toLowerCase() === info.key));
    return post ? postItem(post) : null;
  }

  function engineKey(item) {
    return item.kind === "topic" ? item.topic.slug : postNames(item.post)[1];
  }

  function chosenItem() {
    if (!chosen) return null;
    if (chosen.kind === "topic") {
      const topic = state.topics.find((t) => t.slug === chosen.id);
      return topic ? topicItem(topic) : null;
    }
    const post = state.posts.find((p) => p.path === chosen.id);
    return post ? postItem(post) : null;
  }

  /* ---------- the page ---------- */

  const status = h("p", { class: "st-net__status", role: "status", "aria-live": "polite" });
  const canvas = h("canvas", {
    role: "img",
    "aria-label": "The network of subjects and posts. Drag from one dot to another to connect or disconnect them. The panel lists the same connections."
  });
  const stage = h("div", { class: "network__stage st-net__stage" }, canvas);
  const panel = h("aside", { class: "st-net__panel", "aria-label": "Connections" });
  const draftsToggle = h("input", {
    type: "checkbox",
    onchange: () => {
      showDrafts = draftsToggle.checked;
      net.update(networkData());
      drawPanel();
    }
  });

  const counter = h("span", { class: "st-savebar__text" });
  const undoBtn = h("button", { class: "st-btn st-btn--ghost", type: "button", onclick: undo }, icon("undo", 18), "Undo");
  const discardBtn = h("button", { class: "st-btn", type: "button", onclick: discard }, "Discard");
  const saveBtn = h("button", { class: "st-btn st-btn--primary", type: "button", onclick: saveAll }, icon("check", 18), "Save changes");
  const bar = h("div", { class: "st-savebar", hidden: true, role: "region", "aria-label": "Unsaved changes" },
    h("span", { class: "st-savebar__dot", "aria-hidden": "true" }), counter,
    h("div", { class: "st-savebar__actions" }, undoBtn, discardBtn, saveBtn));

  container.append(h("section", { class: "st-page st-page--wide st-net" },
    h("header", { class: "st-page__head" },
      h("div", {},
        h("p", { class: "eyebrow" }, "Your blog"),
        h("h1", { class: "st-page__title" }, "Network"),
        h("p", { class: "st-page__lede" }, "Connect your subjects and posts. Drag from one dot to another to connect them, and drag again to disconnect. Click a dot to see its connections."))),
    h("div", { class: "network__bar st-net__bar" },
      h("ul", { class: "network__legend", role: "list" },
        state.topics.map((t) => h("li", { class: `network__legend-item topic--${t.slug}` }, t.name)),
        h("li", { class: "network__legend-item network__legend-item--post" }, "Post"),
        h("li", { class: "network__legend-item st-legend--new" }, "Not saved yet")),
      h("label", { class: "st-check st-check--inline" }, draftsToggle, h("span", {}, "Show drafts"))),
    h("div", { class: "st-net__grid" },
      h("div", { class: "st-net__main" }, stage, status),
      panel),
    bar));

  const net = window.BlogNetwork.mount(stage, networkData(), {
    editing: true,
    openOnClick: false,
    onToggle: (a, b) => toggle(fromInfo(a), fromInfo(b)),
    onSelect: (info) => {
      const item = fromInfo(info);
      chosen = item ? { kind: item.kind, id: item.kind === "topic" ? item.topic.slug : item.post.path } : null;
      drawPanel();
    }
  });

  /* ---------- changes ---------- */

  function say(message) {
    status.textContent = message;
  }

  function changed() {
    net.update(networkData());
    drawPanel();
    drawBar();
  }

  function blockedBy(...items) {
    if (saving) {
      say("Saving… one moment, then try again.");
      return true;
    }
    const broken = items.find((i) => i.kind === "post" && i.post.error);
    if (broken) say(`“${broken.post.title}” has a formatting problem in its settings. Open it in the editor and save it once to fix it, then connect it.`);
    return !!broken;
  }

  function toggle(a, b) {
    if (!a || !b || sameItem(a, b) || blockedBy(a, b)) return;
    const post = [a, b].find((i) => i.kind === "post");
    const topic = [a, b].find((i) => i.kind === "topic");
    if (post && topic && mainOf(post.post) === topic.topic.slug) {
      say(`${topic.topic.name} is the main subject of “${post.post.title}”, so they're always connected. To change it, pick another main subject in the panel.`);
      choose(post);
      return;
    }
    remember();
    if (linked(a, b)) {
      disconnect(a, b);
      say(`Disconnected “${itemName(a)}” and “${itemName(b)}”.`);
    } else {
      connect(a, b);
      say(`Connected “${itemName(a)}” and “${itemName(b)}”.`);
    }
    changed();
  }

  function setMain(post, slug) {
    if (blockedBy(postItem(post))) return;
    remember();
    work.posts.get(post.path).topic = slug; // (the old connections stay; the main subject is left out when saving)
    const topic = state.topics.find((t) => t.slug === slug);
    say(topic ? `“${post.title}” now belongs to ${topic.name}.` : `“${post.title}” has no main subject now.`);
    changed();
  }

  function removeName(item, name) {
    if (blockedBy(item)) return;
    remember();
    setList(item, listOf(item).filter((n) => n !== name));
    say(`Removed “${name}”.`);
    changed();
  }

  function undo() {
    if (!undoStack.length || saving) return;
    work = undoStack.pop();
    say("Undone.");
    changed();
  }

  function discard() {
    if (saving) return;
    remember();
    work = fresh();
    say("All changes discarded. (Undo brings them back.)");
    changed();
  }

  async function saveAll() {
    if (saving) return;
    const posts = changedPosts();
    const files = posts.map((p) => {
      const w = work.posts.get(p.path);
      return { path: p.path, content: serializePost(Object.assign({}, p, { topic: w.topic, connections: effective(w.connections, w.topic) })) };
    });
    if (topicsChanged()) {
      files.push({ path: "_data/topics.yml", content: serializeTopics(state.topics.map((t) => Object.assign({}, t, { connects: work.topics.get(t.slug) }))) });
    }
    if (!files.length) return;
    const onlyDrafts = !topicsChanged() && posts.every((p) => !p.published);
    const message = files.length === 1 && posts.length === 1 ? `Update connections of “${posts[0].title}”` : "Update connections";
    saving = true;
    drawBar();
    try {
      const sha = await save(message, files);
      if (alive) {
        work = fresh();
        undoStack.length = 0;
        say("");
        net.update(networkData());
        drawPanel();
      }
      if (onlyDrafts) toast("Connections saved. They'll show on the blog when the drafts are published.", { kind: "success" });
      else trackPublish(sha, { saved: "Connections saved.", live: "The network on your blog is up to date.", url: "/network/" });
    } catch (e) {
      toast(e.message, { kind: "error", timeout: 0 });
    } finally {
      saving = false;
      if (alive) drawBar();
    }
  }

  function drawBar() {
    const n = changeCount();
    bar.hidden = n === 0 && !saving;
    counter.textContent = saving ? "Saving…" : `${plural(n, "file", "files")} to update · not saved yet`;
    undoBtn.disabled = saving || !undoStack.length;
    discardBtn.disabled = saving;
    saveBtn.disabled = saving;
  }

  /* ---------- the panel ---------- */

  function choose(item) {
    if (item && item.kind === "post" && !item.post.published && !showDrafts) {
      showDrafts = true;
      draftsToggle.checked = true;
      net.update(networkData());
    }
    if (item) net.select(engineKey(item)); // the network calls onSelect, which redraws the panel
    else net.select(null);
  }

  function itemButton(item, extra) {
    return h("button", {
      class: "st-conn__label st-linkbtn", type: "button",
      dataset: { focus: `go:${engineKey(item)}${extra || ""}` },
      onclick: () => choose(item)
    }, itemName(item));
  }

  function kindLabel(item) {
    if (item.kind === "topic") return "Subject";
    return item.post.published ? "Post" : "Draft";
  }

  function connectionList(item) {
    const list = neighbours(item);
    if (!list.length) return h("p", { class: "st-hint" }, "No other connections yet.");
    return h("ul", { class: "st-conns", role: "list" }, list.map((other) => {
      const slug = other.kind === "topic" ? other.topic.slug : mainOf(other.post);
      return h("li", { class: `st-conn${slug ? ` topic--${slug}` : ""}` },
        h("span", { class: "st-conn__dot", "aria-hidden": "true" }),
        itemButton(other, ":list"),
        h("span", { class: "st-conn__kind" }, kindLabel(other)),
        h("button", {
          class: "st-iconbtn st-iconbtn--small", type: "button", "aria-label": `Disconnect ${itemName(other)}`,
          dataset: { focus: `cut:${engineKey(other)}` },
          onclick: () => {
            if (blockedBy(item, other)) return;
            remember();
            disconnect(item, other);
            say(`Disconnected “${itemName(item)}” and “${itemName(other)}”.`);
            changed();
          }
        }, icon("close", 16)));
    }));
  }

  function addBox(item) {
    const others = () => {
      const taken = neighbours(item);
      return state.topics.map(topicItem).concat(state.posts.filter((p) => !p.error).map(postItem))
        .filter((o) => !sameItem(o, item) && !taken.some((t) => sameItem(t, o)) &&
          !(item.kind === "post" && o.kind === "topic" && mainOf(item.post) === o.topic.slug) &&
          !(item.kind === "topic" && o.kind === "post" && mainOf(o.post) === item.topic.slug));
    };
    const box = combobox({
      label: "Add a connection",
      placeholder: "Type a subject or post…",
      empty: "Everything is connected already",
      focusKey: "add",
      choices: (query) => others()
        .map((o) => (o.kind === "topic"
          ? { key: `topic|${o.topic.slug}`, label: o.topic.name, kind: "Subject", topic: o.topic.slug, item: o }
          : { key: `post|${o.post.path}`, label: o.post.title, kind: o.post.published ? "Post" : "Draft", topic: mainOf(o.post), item: o }))
        .filter((c) => !query || c.label.toLowerCase().includes(query))
        .slice(0, 12),
      onPick: (choice) => {
        if (blockedBy(item, choice.item)) return;
        remember();
        connect(item, choice.item);
        say(`Connected “${itemName(item)}” and “${itemName(choice.item)}”.`);
        changed();
      }
    });
    box.input.id = "st-net-add";
    return h("div", { class: "st-settings__group" },
      h("label", { class: "st-field__label", for: "st-net-add" }, "Add a connection"),
      box.element);
  }

  function unknownSection(list) {
    if (!list.length) return null;
    return h("div", { class: "st-settings__group st-net__unknown" },
      h("p", { class: "st-field__label" }, "Connections that don't match anything"),
      h("p", { class: "st-hint" }, "Probably a typo, or something that was renamed or deleted."),
      h("ul", { class: "st-conns", role: "list" }, list.map((u) => h("li", { class: "st-conn st-conn--unknown" },
        h("span", { class: "st-conn__dot", "aria-hidden": "true" }),
        h("span", { class: "st-conn__label" }, `“${u.name}”`, h("span", { class: "st-conn__where" }, ` in ${itemName(u.item)}`)),
        h("button", {
          class: "st-btn st-btn--small", type: "button", dataset: { focus: `drop:${u.name}` },
          onclick: () => removeName(u.item, u.name)
        }, "Remove")))));
  }

  function overview() {
    const degree = (item) => neighbours(item).length;
    return [
      h("h2", { class: "st-net__title" }, "Subjects and posts"),
      h("p", { class: "st-hint" }, "Pick one to see and change its connections."),
      h("div", { class: "st-settings__group" },
        h("p", { class: "st-field__label" }, "Subjects"),
        state.topics.length
          ? h("ul", { class: "st-conns", role: "list" }, state.topics.map((t) => h("li", { class: `st-conn topic--${t.slug}` },
            h("span", { class: "st-conn__dot", "aria-hidden": "true" }),
            itemButton(topicItem(t)),
            h("span", { class: "st-conn__kind" }, plural(degree(topicItem(t)) + state.posts.filter((p) => mainOf(p) === t.slug).length, "link", "links")))))
          : h("p", { class: "st-hint" }, "No subjects yet. ", h("a", { class: "st-link", href: "#/subjects" }, "Add one"))),
      h("div", { class: "st-settings__group" },
        h("p", { class: "st-field__label" }, "Posts"),
        state.posts.length
          ? h("ul", { class: "st-conns", role: "list" }, state.posts.map((p) => {
            const main = mainOf(p);
            return h("li", { class: `st-conn${main ? ` topic--${main}` : ""}` },
              h("span", { class: "st-conn__dot", "aria-hidden": "true" }),
              itemButton(postItem(p)),
              h("span", { class: "st-conn__kind" }, p.published ? plural(degree(postItem(p)) + (main ? 1 : 0), "link", "links") : "Draft"));
          }))
          : h("p", { class: "st-hint" }, "No posts yet.")),
      unknownSection(unknownNames())
    ];
  }

  function postDetails(item) {
    const post = item.post;
    const main = h("select", {
      class: "st-input", id: "st-net-main", dataset: { focus: "main" },
      onchange: () => setMain(post, main.value)
    }, [h("option", { value: "" }, "No subject")].concat(state.topics.map((t) => h("option", { value: t.slug, selected: t.slug === mainOf(post) }, t.name))));
    const mine = unknownNames().filter((u) => sameItem(u.item, item));
    return [
      h("button", { class: "st-btn st-btn--ghost st-btn--small st-net__back", type: "button", dataset: { focus: "back" }, onclick: () => choose(null) }, icon("back", 16), "All subjects and posts"),
      h("p", { class: "eyebrow st-net__eyebrow" }, post.published ? `Post · ${formatDate(post.date)}` : "Draft · not on your blog yet"),
      h("h2", { class: "st-net__title" }, post.title),
      h("a", { class: "st-btn st-btn--small", href: `#/write/${encodeURIComponent(post.path)}` }, icon("pen", 16), "Open in the editor"),
      h("div", { class: "st-settings__group" },
        h("label", { class: "st-field__label", for: "st-net-main" }, "Main subject"),
        main),
      h("div", { class: "st-settings__group" },
        h("p", { class: "st-field__label" }, "Connected to"),
        connectionList(item)),
      addBox(item),
      unknownSection(mine)
    ];
  }

  function topicDetails(item) {
    const topic = item.topic;
    const own = state.posts.filter((p) => mainOf(p) === topic.slug);
    const mine = unknownNames().filter((u) => sameItem(u.item, item));
    return [
      h("button", { class: "st-btn st-btn--ghost st-btn--small st-net__back", type: "button", dataset: { focus: "back" }, onclick: () => choose(null) }, icon("back", 16), "All subjects and posts"),
      h("p", { class: `eyebrow st-net__eyebrow topic--${topic.slug}` }, h("span", { class: "st-net__swatch", "aria-hidden": "true" }), "Subject"),
      h("h2", { class: "st-net__title" }, topic.name),
      topic.description ? h("p", { class: "st-net__text" }, topic.description) : null,
      h("div", { class: "st-settings__group" },
        h("p", { class: "st-field__label" }, own.length ? `Main subject of ${plural(own.length, "post", "posts")}` : "Main subject of no posts yet"),
        own.length ? h("ul", { class: "st-conns", role: "list" }, own.map((p) => h("li", { class: `st-conn topic--${topic.slug}` },
          h("span", { class: "st-conn__dot", "aria-hidden": "true" }),
          itemButton(postItem(p), ":own"),
          h("span", { class: "st-conn__kind" }, p.published ? "Post" : "Draft")))) : null),
      h("div", { class: "st-settings__group" },
        h("p", { class: "st-field__label" }, "Also connected to"),
        connectionList(item)),
      addBox(item),
      unknownSection(mine),
      h("a", { class: "st-hint st-link", href: "#/subjects" }, "Edit subjects, their names and colors")
    ];
  }

  function drawPanel() {
    const focusKey = panel.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    const item = chosenItem();
    if (chosen && !item) chosen = null;
    clear(panel).append(...(item ? (item.kind === "post" ? postDetails(item) : topicDetails(item)) : overview()).filter(Boolean));
    if (focusKey) {
      const again = Array.from(panel.querySelectorAll("[data-focus]")).find((el) => el.dataset.focus === focusKey) ||
        panel.querySelector('[data-focus="add"]') || panel.querySelector("[data-focus]");
      if (again) again.focus();
    }
  }

  function onKey(e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing && undoStack.length) {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (changeCount()) saveAll();
    }
  }
  document.addEventListener("keydown", onKey);

  drawPanel();
  drawBar();

  return {
    dirty: () => changeCount() > 0 && !saving,
    leaveMessage: "Your connection changes haven't been saved. If you leave now, they'll be lost.",
    destroy() {
      alive = false;
      document.removeEventListener("keydown", onKey);
      if (net) net.destroy();
    }
  };
}
