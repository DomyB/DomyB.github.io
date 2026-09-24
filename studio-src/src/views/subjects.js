// "Subjects": the big neurons of the network. Add, rename, recolor, reorder
// and delete them. Every change is saved as one commit.
import { DARK_BG, LIGHT_BG, RESERVED_PREFIX, RESERVED_SLUGS, SITE, SWATCHES } from "../config.js";
import { distance, hexToRgb, subjectColors } from "../colors.js";
import { retitlePage, serializePost, serializeTopics, slugify, topicPage } from "../content.js";
import { mentions, sameNames, withoutItem } from "../links.js";
import { trackPublish } from "../publish.js";
import { readFile, save, state } from "../store.js";
import { clear, h, icon, openDialog, plural, toast } from "../ui.js";

const SIMILAR = 10; // below this, two colors are easy to mix up

const topicItem = (topic) => ({ kind: "topic", topic });
const address = (slug) => `${SITE.replace("https://", "")}/${slug}/`;

function linkedTopics(topic) {
  return state.topics.filter((o) => o !== topic &&
    (mentions(topic.connects, topicItem(o)) || mentions(o.connects, topicItem(topic))));
}

// The first ready-made color that doesn't look like one already in use.
function freeSwatch() {
  const used = state.topics.filter((t) => hexToRgb(t.color));
  return SWATCHES.find((s) => used.every((t) => distance(s.color, t.color) >= SIMILAR &&
    (!hexToRgb(t.colorDark) || distance(s.colorDark, t.colorDark) >= SIMILAR))) ||
    SWATCHES[state.topics.length % SWATCHES.length];
}

function slugProblem(slug) {
  if (!slug) return "Choose an address for the subject.";
  if (RESERVED_SLUGS.includes(slug) || slug.startsWith(RESERVED_PREFIX)) return `“${slug}” is already used by the blog. Choose another address.`;
  if (/^\d{4}$/.test(slug)) return "The address can't be a year (those are used by posts).";
  if (state.topics.some((t) => t.slug === slug)) return `There's already a subject at /${slug}/.`;
  if (state.posts.some((p) => p.slug.toLowerCase() === slug)) return `A post already uses the name “${slug}”. Choose another address so connections stay clear.`;
  const taken = Array.from(state.shas.keys()).some((path) => path === `${slug}.md` || path === `${slug}.html` || path.startsWith(`${slug}/`));
  if (taken) return `The blog already has a page or folder called “${slug}”. Choose another address.`;
  return "";
}

export function renderSubjects(container) {
  let order = state.topics.map((t) => t.slug);
  let busy = false;

  const list = h("ol", { class: "st-subjects", role: "list" });
  const discardBtn = h("button", { class: "st-btn", type: "button", onclick: () => { order = state.topics.map((t) => t.slug); draw(); } }, "Discard");
  const saveBtn = h("button", { class: "st-btn st-btn--primary", type: "button", onclick: saveOrder }, icon("check", 18), "Save order");
  const bar = h("div", { class: "st-savebar", hidden: true, role: "region", "aria-label": "Unsaved changes" },
    h("span", { class: "st-savebar__dot", "aria-hidden": "true" }),
    h("span", { class: "st-savebar__text" }, "New order not saved yet"),
    h("div", { class: "st-savebar__actions" }, discardBtn, saveBtn));

  container.append(h("section", { class: "st-page" },
    h("header", { class: "st-page__head" },
      h("div", {},
        h("p", { class: "eyebrow" }, "Your blog"),
        h("h1", { class: "st-page__title" }, "Subjects"),
        h("p", { class: "st-page__lede" }, "The big neurons of your network. Every post has a main subject, and each subject has its own color and page. They appear on the blog in this order.")),
      h("button", { class: "st-btn st-btn--primary st-btn--big", type: "button", onclick: () => editSubject(null) }, icon("plus"), "New subject")),
    list,
    bar));

  const ordered = () => order.map((slug) => state.topics.find((t) => t.slug === slug)).filter(Boolean)
    .concat(state.topics.filter((t) => !order.includes(t.slug)));

  function orderChanged() {
    return ordered().some((t, i) => state.topics[i] !== t);
  }

  function draw() {
    const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    clear(list);
    const topics = ordered();
    if (!topics.length) {
      list.append(h("li", { class: "st-empty" },
        h("p", { class: "st-empty__title" }, "No subjects yet"),
        h("p", {}, "Add one to give your posts a home."),
        h("button", { class: "st-btn st-btn--primary", type: "button", onclick: () => editSubject(null) }, icon("plus"), "Add a subject")));
    }
    topics.forEach((t, i) => {
      const posts = state.posts.filter((p) => p.topic === t.slug);
      const live = posts.filter((p) => p.published).length;
      const drafts = posts.length - live;
      const links = linkedTopics(t);
      const move = (dir) => {
        const j = i + dir;
        [topics[i], topics[j]] = [topics[j], topics[i]];
        order = topics.map((x) => x.slug);
        draw();
      };
      list.append(h("li", { class: `st-subject topic--${t.slug}` },
        h("span", { class: "st-subject__swatch", "aria-hidden": "true" }),
        h("div", { class: "st-subject__body" },
          h("h2", { class: "st-subject__name" }, t.name),
          h("p", { class: "st-subject__address" },
            h("a", { href: `${SITE}/${t.slug}/`, target: "_blank", rel: "noopener" }, address(t.slug), h("span", { "aria-hidden": "true" }, " ↗"))),
          t.description ? h("p", { class: "st-subject__text" }, t.description) : null,
          h("p", { class: "st-subject__meta" },
            [plural(live, "post", "posts"), drafts ? plural(drafts, "draft", "drafts") : null,
              links.length ? `linked to ${links.map((o) => o.name).join(", ")}` : null].filter(Boolean).join(" · "))),
        h("div", { class: "st-subject__actions" },
          h("button", { class: "st-btn st-btn--small", type: "button", dataset: { focus: `edit:${t.slug}` }, onclick: () => editSubject(t) }, icon("pen", 16), "Edit"),
          h("button", {
            class: "st-iconbtn", type: "button", "aria-label": `Move ${t.name} up`, disabled: i === 0 || busy,
            dataset: { focus: `up:${t.slug}` }, onclick: () => move(-1)
          }, icon("up")),
          h("button", {
            class: "st-iconbtn", type: "button", "aria-label": `Move ${t.name} down`, disabled: i === topics.length - 1 || busy,
            dataset: { focus: `down:${t.slug}` }, onclick: () => move(1)
          }, icon("down")),
          h("button", {
            class: "st-iconbtn st-iconbtn--danger", type: "button", "aria-label": `Delete ${t.name}`, disabled: busy,
            dataset: { focus: `delete:${t.slug}` }, onclick: () => removeSubject(t)
          }, icon("trash")))));
    });
    bar.hidden = !orderChanged();
    discardBtn.disabled = saveBtn.disabled = busy;
    if (focusKey) {
      const [what, slug] = focusKey.split(":");
      const again = [focusKey, `${what === "up" ? "down" : "up"}:${slug}`, `edit:${slug}`]
        .map((key) => Array.from(list.querySelectorAll("[data-focus]")).find((el) => el.dataset.focus === key && !el.disabled))
        .find(Boolean);
      if (again) again.focus();
    }
  }

  async function commit(message, files, url, saved) {
    busy = true;
    draw();
    try {
      const sha = await save(message, files);
      order = state.topics.map((t) => t.slug);
      trackPublish(sha, { saved, live: "Your blog is up to date.", url });
      return true;
    } catch (e) {
      toast(e.message, { kind: "error", timeout: 0 });
      return false;
    } finally {
      busy = false;
      draw();
    }
  }

  function saveOrder() {
    if (busy) return;
    commit("Reorder subjects", [{ path: "_data/topics.yml", content: serializeTopics(ordered()) }], "/", "New order saved.");
  }

  /* ---------- add / edit ---------- */

  async function editSubject(topic) {
    if (busy) return;
    const isNew = !topic;
    const others = state.topics.filter((t) => t !== topic);
    const start = topic && hexToRgb(topic.color)
      ? { color: topic.color, colorDark: hexToRgb(topic.colorDark) ? topic.colorDark : subjectColors(topic.color).colorDark }
      : topic ? subjectColors("#6b645b") : freeSwatch();
    const startIndex = SWATCHES.findIndex((s) => s.color === start.color && s.colorDark === start.colorDark);

    const result = await openDialog(isNew ? "New subject" : `Edit “${topic.name}”`, (close) => {
      let colors = { color: start.color, colorDark: start.colorDark };
      let slugTouched = !isNew;

      const name = h("input", {
        class: "st-input", id: "st-sub-name", type: "text", maxlength: 40, required: true, autofocus: true,
        value: topic ? topic.name : "", placeholder: "For example: Politics",
        oninput: () => {
          if (!slugTouched) slug.value = slugify(name.value);
          paint();
        }
      });
      const slug = h("input", {
        class: "st-input st-input--mono", id: "st-sub-slug", type: "text", maxlength: 40, spellcheck: "false",
        value: topic ? topic.slug : "", disabled: !isNew, "aria-describedby": "st-sub-slug-help",
        oninput: () => { slugTouched = true; },
        onchange: () => { slug.value = slugify(slug.value); }
      });
      const description = h("textarea", {
        class: "st-input", id: "st-sub-text", rows: 2, maxlength: 200,
        placeholder: "One sentence about it, shown on the home page and the subject's page."
      }, topic ? topic.description : "");

      const picker = h("input", {
        class: "st-colorpick", type: "color", value: start.color, "aria-label": "Custom color",
        oninput: () => {
          custom.checked = true;
          colors = subjectColors(picker.value);
          paint();
        }
      });
      const custom = h("input", {
        type: "radio", name: "st-color", value: "custom", checked: startIndex < 0,
        onchange: () => { colors = subjectColors(picker.value); paint(); }
      });
      const swatches = SWATCHES.map((s, i) => {
        const radio = h("input", {
          type: "radio", name: "st-color", value: String(i), checked: i === startIndex,
          onchange: () => { colors = { color: s.color, colorDark: s.colorDark }; paint(); }
        });
        const label = h("label", { class: "st-swatch", title: s.name }, radio,
          h("span", { class: "st-swatch__dot", "aria-hidden": "true" }), h("span", { class: "visually-hidden" }, s.name));
        label.style.setProperty("--sw", s.color);
        label.style.setProperty("--sw-dark", s.colorDark);
        return label;
      });

      const panes = [["Light theme", LIGHT_BG, "#1f1d1a", "light"], ["Dark theme", DARK_BG, "#ece6dc", "dark"]].map(([caption, bg, ink, mode]) => {
        const title = h("span", { class: "st-preview__title" });
        const chip = h("span", { class: "st-preview__chip" });
        const label = h("span", { class: "st-preview__label" });
        const pane = h("div", { class: "st-preview__pane" }, h("span", { class: "st-preview__caption" }, caption), title, h("span", { class: "st-preview__row" }, chip, label));
        pane.style.background = bg;
        pane.style.color = ink;
        return { mode, bg, pane, title, chip, label };
      });
      const similar = h("p", { class: "st-warn", hidden: true });
      const adjusted = h("p", { class: "st-hint", hidden: true }, "Adjusted slightly so text in this color stays easy to read in both themes.");

      const linkBoxes = others.map((o) => {
        const box = h("input", { type: "checkbox", value: o.slug, checked: !!topic && linkedTopics(topic).includes(o) });
        return h("label", { class: `st-check st-check--pill topic--${o.slug}` }, box, h("span", { class: "st-conn__dot", "aria-hidden": "true" }), h("span", {}, o.name));
      });

      const error = h("p", { class: "st-form-error", role: "alert" });

      function paint() {
        const text = name.value.trim() || "Subject";
        panes.forEach((p) => {
          const c = p.mode === "light" ? colors.color : colors.colorDark;
          p.title.textContent = text;
          p.title.style.color = c;
          p.chip.textContent = text;
          p.chip.style.background = c;
          p.chip.style.color = p.bg;
          p.label.textContent = text.toUpperCase();
          p.label.style.setProperty("--dot", c);
        });
        const near = others.filter((o) => hexToRgb(o.color) && (distance(o.color, colors.color) < SIMILAR ||
          (hexToRgb(o.colorDark) && distance(o.colorDark, colors.colorDark) < SIMILAR)));
        similar.hidden = !near.length;
        similar.textContent = near.length ? `This color looks a lot like ${near.map((o) => o.name).join(" and ")}. Pick another one so readers can tell them apart.` : "";
        adjusted.hidden = !custom.checked || colors.color.toLowerCase() === picker.value.toLowerCase();
      }

      function submit(e) {
        e.preventDefault();
        const cleanName = name.value.trim().replace(/\s+/g, " ");
        const cleanSlug = isNew ? slugify(slug.value || cleanName) : topic.slug;
        const nameProblem = !cleanName ? "Give the subject a name."
          : others.some((o) => o.name.toLowerCase() === cleanName.toLowerCase()) ? `There's already a subject called ${cleanName}.` : "";
        const problem = nameProblem || (isNew ? slugProblem(cleanSlug) : "");
        if (problem) {
          error.textContent = problem;
          (nameProblem ? name : slug).focus();
          return;
        }
        close({
          name: cleanName,
          slug: cleanSlug,
          description: description.value.trim().replace(/\s+/g, " "),
          colors,
          links: linkBoxes.map((l) => l.querySelector("input")).filter((b) => b.checked).map((b) => b.value)
        });
      }

      const form = h("form", { class: "st-dialog__body st-subform", onsubmit: submit, novalidate: true },
        h("div", { class: "st-field" },
          h("label", { class: "st-field__label", for: "st-sub-name" }, "Name"), name),
        h("div", { class: "st-field" },
          h("label", { class: "st-field__label", for: "st-sub-slug" }, "Address"),
          h("div", { class: "st-affix" }, h("span", { class: "st-affix__text" }, `${SITE.replace("https://", "")}/`), slug, h("span", { class: "st-affix__text" }, "/")),
          h("p", { class: "st-hint", id: "st-sub-slug-help" }, isNew
            ? "The subject's page, and the short name posts use for it. Lowercase letters, numbers and dashes."
            : "The address can't change after a subject is created, so links to it keep working.")),
        h("div", { class: "st-field" },
          h("label", { class: "st-field__label", for: "st-sub-text" }, "Description"), description),
        h("fieldset", { class: "st-field st-colors" },
          h("legend", { class: "st-field__label" }, "Color"),
          h("div", { class: "st-swatches" }, swatches,
            h("label", { class: "st-swatch st-swatch--custom", title: "Custom color" }, custom,
              h("span", { class: "st-swatch__dot", "aria-hidden": "true" }), h("span", { class: "st-swatch__text" }, "Custom")),
            picker),
          h("div", { class: "st-preview" }, panes.map((p) => p.pane)),
          adjusted,
          similar),
        others.length ? h("fieldset", { class: "st-field" },
          h("legend", { class: "st-field__label" }, "Linked subjects"),
          h("p", { class: "st-hint" }, "Linked subjects are joined by a line on the network."),
          h("div", { class: "st-pills" }, linkBoxes)) : null,
        error,
        h("div", { class: "st-dialog__actions" },
          h("button", { class: "st-btn", type: "button", onclick: () => close(undefined) }, "Cancel"),
          h("button", { class: "st-btn st-btn--primary", type: "submit" }, isNew ? "Add subject" : "Save changes")));
      paint();
      return form;
    }, { wide: true });

    if (!result) return;
    await saveSubject(topic, result);
  }

  async function saveSubject(topic, result) {
    const isNew = !topic;
    const current = ordered();
    const next = current.map((t) => Object.assign({}, t, { connects: t.connects.slice() }));
    let mine;
    if (isNew) {
      mine = { slug: result.slug, name: result.name, description: result.description, color: result.colors.color, colorDark: result.colors.colorDark, connects: result.links.slice(), extra: {} };
      next.push(mine);
    } else {
      mine = next[current.indexOf(topic)];
      Object.assign(mine, { name: result.name, description: result.description, color: result.colors.color, colorDark: result.colors.colorDark });
      // Linked subjects: add the new links, and remove unticked ones from both sides.
      next.forEach((o) => {
        if (o === mine) return;
        const wanted = result.links.includes(o.slug);
        const was = mentions(mine.connects, topicItem(o)) || mentions(o.connects, topicItem(mine));
        if (wanted && !was) mine.connects.push(o.slug);
        if (!wanted && was) {
          mine.connects = withoutItem(mine.connects, topicItem(o));
          o.connects = withoutItem(o.connects, topicItem(mine));
        }
      });
    }

    const files = [{ path: "_data/topics.yml", content: serializeTopics(next) }];
    const page = `topics/${mine.slug}.md`;
    try {
      if (!state.topicPages.has(page)) {
        files.push({ path: page, content: topicPage(mine) });
      } else if (!isNew && result.name !== topic.name) {
        const source = await readFile(page);
        if (source != null) files.push({ path: page, content: retitlePage(source, result.name) });
      }
    } catch (e) {
      toast(e.message, { kind: "error", timeout: 0 });
      return;
    }
    const unchanged = !isNew && files.length === 1 && serializeTopics(next) === serializeTopics(current);
    if (unchanged) {
      toast("Nothing changed.", { kind: "info" });
      return;
    }
    await commit(isNew ? `Add subject “${mine.name}”` : `Update subject “${mine.name}”`, files, `/${mine.slug}/`,
      isNew ? `${mine.name} added.` : `${mine.name} updated.`);
  }

  /* ---------- delete ---------- */

  async function removeSubject(topic) {
    if (busy) return;
    const item = topicItem(topic);
    const own = state.posts.filter((p) => p.topic === topic.slug);
    const mentioning = state.posts.filter((p) => p.topic !== topic.slug && mentions(p.connections, item));
    const broken = own.concat(mentioning).filter((p) => p.error);
    if (broken.length) {
      toast(`First fix the settings of ${broken.map((p) => `“${p.title}”`).join(", ")}: open it in the editor and save it once.`, { kind: "error", timeout: 12000 });
      return;
    }
    const others = state.topics.filter((t) => t !== topic);

    const answer = await openDialog(`Delete “${topic.name}”?`, (close) => {
      const move = h("select", { class: "st-input", id: "st-sub-move" },
        others.map((o) => h("option", { value: o.slug }, o.name)).concat(h("option", { value: "" }, "No subject")));
      return h("form", { class: "st-dialog__body", onsubmit: (e) => { e.preventDefault(); close({ moveTo: own.length ? move.value : "" }); } },
        own.length
          ? h("div", { class: "st-field" },
            h("p", {}, `${plural(own.length, "post has", "posts have")} ${topic.name} as main subject. Choose a new main subject for ${own.length === 1 ? "it" : "them"}:`),
            h("label", { class: "st-field__label", for: "st-sub-move" }, "Move to"),
            move)
          : null,
        h("p", {}, `The page ${address(topic.slug)} will be removed, and so will every connection to ${topic.name}. (GitHub keeps a copy in the blog's history.)`),
        h("div", { class: "st-dialog__actions" },
          h("button", { class: "st-btn", type: "button", onclick: () => close(undefined) }, "Cancel"),
          h("button", { class: "st-btn st-btn--danger", type: "submit" }, icon("trash", 18), "Delete subject")));
    });
    if (!answer) return;

    const next = ordered().filter((t) => t !== topic).map((t) => Object.assign({}, t, { connects: withoutItem(t.connects, item) }));
    const files = [{ path: "_data/topics.yml", content: serializeTopics(next) }];
    if (state.topicPages.has(`topics/${topic.slug}.md`)) files.push({ path: `topics/${topic.slug}.md`, delete: true });
    own.concat(mentioning).forEach((p) => {
      const main = p.topic === topic.slug ? answer.moveTo : p.topic;
      const connections = withoutItem(p.connections, item).filter((c) => c !== main);
      if (main === p.topic && sameNames(connections, p.connections)) return;
      files.push({ path: p.path, content: serializePost(Object.assign({}, p, { topic: main, connections })) });
    });
    await commit(`Delete subject “${topic.name}”`, files, "/", `${topic.name} deleted.`);
  }

  draw();

  return {
    dirty: () => orderChanged() && !busy,
    leaveMessage: "The new order of your subjects hasn't been saved. If you leave now, it will be lost."
  };
}
