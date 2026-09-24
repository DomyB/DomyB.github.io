// "Posts": every post on the blog, with search and filters.
import { SITE } from "../config.js";
import { postUrl } from "../content.js";
import { state, topicBySlug } from "../store.js";
import { clear, formatDate, h, icon, plural } from "../ui.js";
import { hasAutosave } from "../autosave.js";

export function renderPosts(container) {
  const filters = { q: "", topic: "", status: "all" };
  const published = state.posts.filter((p) => p.published).length;
  const drafts = state.posts.length - published;

  const search = h("input", {
    class: "st-input st-search__input", type: "search", placeholder: "Search your posts", "aria-label": "Search posts",
    oninput: () => { filters.q = search.value.trim().toLowerCase(); draw(); }
  });

  const topicChips = h("div", { class: "st-chips", role: "group", "aria-label": "Filter by subject" },
    [{ slug: "", name: "All subjects" }].concat(state.topics).map((t) => h("button", {
      class: `chip st-chip${t.slug ? ` topic--${t.slug}` : " chip--all"}`,
      type: "button",
      "aria-pressed": t.slug === filters.topic ? "true" : "false",
      onclick: (e) => {
        filters.topic = t.slug;
        topicChips.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"));
        draw();
      }
    }, t.name)));

  const statusSwitch = h("div", { class: "st-segmented", role: "group", "aria-label": "Filter by status" },
    [["all", "All"], ["published", "Published"], ["draft", "Drafts"]].map(([value, label]) => h("button", {
      type: "button",
      "aria-pressed": value === filters.status ? "true" : "false",
      onclick: (e) => {
        filters.status = value;
        statusSwitch.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"));
        draw();
      }
    }, label)));

  const list = h("ul", { class: "st-posts", role: "list" });

  container.append(h("section", { class: "st-page" },
    h("header", { class: "st-page__head" },
      h("div", {},
        h("p", { class: "eyebrow" }, "Your writing"),
        h("h1", { class: "st-page__title" }, "Posts"),
        h("p", { class: "st-page__lede" }, `${plural(published, "published post", "published posts")} · ${plural(drafts, "draft", "drafts")}`)),
      h("a", { class: "st-btn st-btn--primary st-btn--big", href: "#/write/new" }, icon("plus"), "New post")),
    h("div", { class: "st-filters" },
      h("div", { class: "st-search" }, icon("search", 18), search),
      statusSwitch),
    topicChips,
    list));

  function matches(post) {
    if (filters.topic && post.topic !== filters.topic) return false;
    if (filters.status === "published" && !post.published) return false;
    if (filters.status === "draft" && post.published) return false;
    if (filters.q && !`${post.title} ${post.description} ${post.body}`.toLowerCase().includes(filters.q)) return false;
    return true;
  }

  function row(post) {
    const topic = topicBySlug(post.topic);
    const edit = `#/write/${encodeURIComponent(post.path)}`;
    const unsaved = hasAutosave(post.path);
    return h("li", { class: `st-post${topic ? ` topic--${topic.slug}` : ""}` },
      h("p", { class: "st-post__meta" },
        topic ? h("span", { class: "topic-label" }, topic.name) : h("span", { class: "st-muted" }, "No subject"),
        h("span", { "aria-hidden": "true" }, "·"),
        h("span", {}, formatDate(post.date)),
        post.error
          ? h("span", { class: "st-badge st-badge--warn" }, "Needs fixing")
          : h("span", { class: `st-badge ${post.published ? "st-badge--live" : "st-badge--draft"}` }, post.published ? "Published" : "Draft"),
        unsaved ? h("span", { class: "st-badge st-badge--warn" }, "Unsaved changes") : null,
        post.connections.length ? h("span", { class: "st-muted" }, plural(post.connections.length, "connection", "connections")) : null),
      h("h2", { class: "st-post__title" }, h("a", { href: edit }, post.title)),
      post.description ? h("p", { class: "st-post__text" }, post.description) : null,
      post.published ? h("a", { class: "st-post__view", href: SITE + postUrl(post), target: "_blank", rel: "noopener", "aria-label": `View “${post.title}” on the blog` }, icon("external", 18)) : null);
  }

  function draw() {
    clear(list);
    const shown = state.posts.filter(matches);
    if (!state.posts.length) {
      list.append(h("li", { class: "st-empty" },
        h("p", { class: "st-empty__title" }, "No posts yet"),
        h("p", {}, "Your first post is one click away."),
        h("a", { class: "st-btn st-btn--primary", href: "#/write/new" }, icon("plus"), "Write your first post")));
    } else if (!shown.length) {
      list.append(h("li", { class: "st-empty" }, h("p", { class: "st-empty__title" }, "Nothing matches"), h("p", {}, "Try another search or filter.")));
    } else {
      shown.forEach((p) => list.append(row(p)));
    }
  }

  draw();
  return {};
}
