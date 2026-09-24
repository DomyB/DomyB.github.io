// Reading and writing the blog's files: posts (Markdown with front matter),
// the subjects list (_data/topics.yml) and each subject's page.
import yaml from "js-yaml";

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SLUG_LIKE = /^[a-z0-9][a-z0-9-]*$/;
const POST_KEYS = ["title", "topic", "connections", "description", "image", "math", "dropcap", "published"];
const TOPIC_KEYS = ["slug", "name", "description", "color", "color_dark", "connects"];

// Accepts [a, b], "a, b" or "a" and returns clean lowercase names.
export function names(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  list.forEach((item) => {
    if (item == null) return;
    String(item).split(",").forEach((part) => {
      const name = part.trim().toLowerCase().replace(/\.md$/, "");
      if (name && !out.includes(name)) out.push(name);
    });
  });
  return out;
}

export function slugify(text) {
  return String(text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

export function titleize(slug) {
  return String(slug).split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

function quote(value) {
  return JSON.stringify(String(value)); // a JSON string is also a valid YAML string
}

function listValue(items) {
  return "[" + items.map((i) => (SLUG_LIKE.test(i) ? i : quote(i))).join(", ") + "]";
}

// Plain text when YAML can't misread it, otherwise quoted.
function text(value) {
  const s = String(value);
  const plain = /^[A-Za-z0-9À-ÿ][A-Za-z0-9À-ÿ ,.'’()&!?-]*$/.test(s) && !/\s$/.test(s) &&
    !/^(true|false|yes|no|on|off|null|~)$/i.test(s) && !/^[-+.\d]/.test(s);
  return plain ? s : quote(s);
}

function dumpExtra(key, value) {
  return yaml.dump({ [key]: value }, { schema: yaml.CORE_SCHEMA, lineWidth: -1, flowLevel: 1 }).trimEnd();
}

/* ---------- posts ---------- */

// "_posts/2026-09-24-welcome-to-my-blog.md" -> a post object.
export function parsePost(path, source) {
  const file = path.split("/").pop();
  const match = file.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.(md|markdown)$/);
  const date = match ? match[1] : "";
  const slug = match ? match[2] : file.replace(/\.[^.]+$/, "");
  let fm = {};
  let body = source;
  let error = null;
  const front = source.match(FRONT_MATTER);
  if (front) {
    try {
      fm = yaml.load(front[1], { schema: yaml.CORE_SCHEMA }) || {};
    } catch (e) {
      error = e.message;
    }
    if (typeof fm !== "object" || Array.isArray(fm)) fm = {};
    body = source.slice(front[0].length).replace(/^\s*\n/, "");
  }
  return {
    path,
    date,
    slug,
    fm,
    body,
    error,
    title: fm.title != null ? String(fm.title) : titleize(slug),
    topic: names(fm.topic)[0] || "",
    connections: names(fm.connections),
    description: fm.description != null ? String(fm.description) : "",
    published: fm.published !== false,
    math: fm.math === true,
    dropcap: fm.dropcap !== false
  };
}

export function postPath(date, slug) {
  return `_posts/${date}-${slug}.md`;
}

// The post's address on the blog (matches `permalink: /:year/:month/:title/`).
export function postUrl(post) {
  const [year, month] = post.date.split("-");
  return `/${year}/${month}/${post.slug}/`;
}

export function serializePost(post) {
  const fm = Object.assign({}, post.fm);
  const put = (key, value) => {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) delete fm[key];
    else fm[key] = value;
  };
  fm.title = post.title;
  put("topic", post.topic);
  put("connections", post.connections);
  put("description", post.description);
  put("math", post.math ? true : null);
  put("dropcap", post.dropcap === false ? false : null);
  put("published", post.published === false ? false : null);
  const keys = POST_KEYS.filter((k) => k in fm).concat(Object.keys(fm).filter((k) => !POST_KEYS.includes(k)));
  const lines = keys.map((key) => {
    const value = fm[key];
    if (key === "title" || key === "description") return `${key}: ${quote(value)}`;
    if (key === "topic" && typeof value === "string") return `topic: ${SLUG_LIKE.test(value) ? value : quote(value)}`;
    if (key === "connections" && Array.isArray(value)) return `connections: ${listValue(value)}`;
    if (typeof value === "boolean") return `${key}: ${value}`;
    return dumpExtra(key, value);
  });
  const body = String(post.body || "").replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

// The editor writes & and < in text as &amp; and &lt;. Put them back where
// Markdown reads them the same way, so the files stay easy to read. (&gt; stays:
// a > at the start of a line would turn into a quote. Inline code is left
// alone, since there the escapes are what was typed.)
function plainEntities(line) {
  return line.split(/(`+[^`]*?`+)/).map((part, i) => (i % 2 ? part : part
    .replace(/&amp;(?![a-zA-Z0-9#]+;)/g, "&")
    .replace(/&lt;(?![a-zA-Z/!?])/g, "<"))).join("");
}

// Empty paragraphs in the editor become runs of blank lines in Markdown; the
// blog ignores them, so keep at most one. Code blocks are left as they are.
export function tidyMarkdown(md) {
  const out = [];
  let fence = null;
  let blank = 0;
  String(md).split("\n").forEach((line) => {
    const mark = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      out.push(line);
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !line.trim().slice(mark[1].length).trim()) fence = null;
      return;
    }
    if (mark) fence = mark[1];
    if (!line.trim()) {
      blank++;
      if (blank > 1) return;
    } else {
      blank = 0;
    }
    out.push(mark ? line : plainEntities(line));
  });
  return out.join("\n").replace(/^\n+/, "");
}

// Things the visual editor can't keep exactly as written. Posts using them are
// edited as plain text instead, so nothing is ever lost.
export function advancedFeatures(body) {
  const found = [];
  if (/\{%|\{\{/.test(body)) found.push("Liquid tags");
  if (/\[\^[^\]]+\]/.test(body)) found.push("footnotes");
  if (/\{:[^}]*\}/.test(body)) found.push("custom attributes like {:.caption}");
  const prose = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, "");
  // (<br> in tables and &nbsp; for blank lines are written by the editor itself.)
  if (/<\/?[a-zA-Z][\w-]*(\s[^>]*)?>|<!--/.test(prose.replace(/<br\s*\/?>/gi, ""))) found.push("HTML");
  const entities = prose.replace(/^&nbsp;$/gm, "").match(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi) || [];
  if (entities.some((e) => !/^&(amp|lt|gt|quot);$/i.test(e))) found.push("HTML entities like &eacute;");
  return found;
}

/* ---------- subjects ---------- */

export function parseTopics(source) {
  let list;
  try {
    list = yaml.load(source, { schema: yaml.CORE_SCHEMA }) || [];
  } catch (e) {
    throw new Error(`The subjects file (_data/topics.yml) has a formatting error: ${e.message}`);
  }
  if (!Array.isArray(list)) list = [];
  return list.filter((t) => t && t.slug).map((t) => {
    const extra = {};
    Object.keys(t).forEach((k) => { if (!TOPIC_KEYS.includes(k)) extra[k] = t[k]; });
    return {
      slug: String(t.slug).toLowerCase(),
      name: t.name != null ? String(t.name) : titleize(String(t.slug)),
      description: t.description != null ? String(t.description) : "",
      color: t.color ? String(t.color) : "",
      colorDark: t.color_dark ? String(t.color_dark) : "",
      connects: names(t.connects),
      extra
    };
  });
}

const TOPICS_HEADER = `# The subjects of the blog, in menu order. The Studio (/studio/) edits this
# file for you, but you can also change it by hand:
#
# - slug: the short name used in posts (\`topic: economics\`) and in the address
# - name: how the subject is shown on the site
# - description: the one-liner shown on the home page and the subject's page
# - color / color_dark: the subject's color in the light and dark themes
# - connects: (optional) other subjects or posts it links to on the Network
#
# Every subject also needs a page: topics/<slug>.md (copy topics/life.md).
`;

export function serializeTopics(topics) {
  const blocks = topics.map((t) => {
    const lines = [`- slug: ${t.slug}`, `  name: ${text(t.name)}`];
    if (t.description) lines.push(`  description: ${text(t.description)}`);
    if (t.color) lines.push(`  color: ${quote(t.color)}`);
    if (t.colorDark) lines.push(`  color_dark: ${quote(t.colorDark)}`);
    if (t.connects && t.connects.length) lines.push(`  connects: ${listValue(t.connects)}`);
    Object.keys(t.extra || {}).forEach((k) => {
      dumpExtra(k, t.extra[k]).split("\n").forEach((line) => lines.push(`  ${line}`));
    });
    return lines.join("\n");
  });
  return `${TOPICS_HEADER}\n${blocks.join("\n\n")}\n`;
}

// The page that lists a subject's posts, at /<slug>/.
export function topicPage(topic) {
  return `---\nlayout: topic\ntitle: ${text(topic.name)}\ntopic: ${topic.slug}\npermalink: /${topic.slug}/\n---\n`;
}

// Change the `title:` line of a page, keeping the rest of the file as it is.
export function retitlePage(source, title) {
  const line = `title: ${text(title)}`;
  const front = source.match(FRONT_MATTER);
  if (!front) return `---\n${line}\n---\n${source}`;
  const lines = front[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^title\s*:/.test(l));
  if (at >= 0) lines[at] = line;
  else lines.unshift(line);
  return `---\n${lines.join("\n")}\n---\n${source.slice(front[0].length)}`;
}
