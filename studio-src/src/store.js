// The Studio's view of the blog: every post and subject, loaded from GitHub.
import { commitFiles, decodeBase64, github, setToken } from "./github.js";
import { parsePost, parseTopics } from "./content.js";

const TOKEN_KEY = "studio-token";

export const state = {
  user: null,
  head: null,            // the commit the Studio last loaded
  shas: new Map(),       // path -> file version, to detect changes made elsewhere
  posts: [],             // newest first
  topics: [],            // in menu order
  topicPages: new Set(), // existing topics/<slug>.md files
  images: new Set()      // existing files in assets/images/
};

/* ---------- the access key ---------- */

export function savedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    return "";
  }
}

export function rememberToken(token, keep) {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    (keep ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch (e) {
    /* Storage is blocked: the key lasts until the tab is closed. */
  }
}

export function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (e) {}
  setToken(null);
  state.user = null;
}

export async function signIn(token) {
  setToken(token);
  const [user] = await Promise.all([github.user(), github.repo()]);
  state.user = user;
  return user;
}

/* ---------- loading ---------- */

const texts = new Map(); // file version -> text, so reloading only fetches what changed
const listeners = [];

async function readText(sha) {
  if (!texts.has(sha)) {
    const blob = await github.blob(sha);
    texts.set(sha, decodeBase64(blob.content));
  }
  return texts.get(sha);
}

// The text of any file in the blog (as last loaded), or null if there's none.
export function readFile(path) {
  const sha = state.shas.get(path);
  return sha ? readText(sha) : Promise.resolve(null);
}

// Run fn after every (re)load, e.g. to repaint the subject colors.
export function onLoad(fn) {
  listeners.push(fn);
}

// Run async jobs a few at a time (GitHub doesn't like floods of requests).
async function pool(jobs, size) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
  return results;
}

export async function load() {
  const head = await github.head();
  const tree = await github.tree(head);
  const files = tree.tree.filter((e) => e.type === "blob");
  const postFiles = files.filter((e) => /^_posts\/[^/]+\.(md|markdown)$/.test(e.path));
  const topicsFile = files.find((e) => e.path === "_data/topics.yml");
  const [topicsText, ...postTexts] = await pool(
    [() => (topicsFile ? readText(topicsFile.sha) : "")].concat(postFiles.map((e) => () => readText(e.sha))),
    6
  );
  state.head = head;
  state.shas = new Map(files.map((e) => [e.path, e.sha]));
  state.topicPages = new Set(files.filter((e) => /^topics\/[^/]+\.md$/.test(e.path)).map((e) => e.path));
  state.images = new Set(files.filter((e) => e.path.startsWith("assets/images/")).map((e) => e.path));
  state.topics = parseTopics(topicsText);
  state.posts = postFiles
    .map((e, i) => parsePost(e.path, postTexts[i]))
    .sort((a, b) => (b.date + b.slug).localeCompare(a.date + a.slug));
  listeners.forEach((fn) => fn());
}

// Save changes as one commit, then reload so the Studio shows the new state.
export async function save(message, files) {
  const sha = await commitFiles(message, files, { head: state.head, shas: state.shas });
  await load();
  return sha;
}

/* ---------- lookups ---------- */

export function postByPath(path) {
  return state.posts.find((p) => p.path === path) || null;
}

export function postBySlug(slug) {
  return state.posts.find((p) => p.slug === slug || `${p.date}-${p.slug}` === slug) || null;
}

export function topicBySlug(slug) {
  return state.topics.find((t) => t.slug === slug) || null;
}

// A name for a new post that no other post uses (connections refer to posts by it).
export function freeSlug(slug, exceptPath) {
  const taken = (s) => state.posts.some((p) => p.slug === s && p.path !== exceptPath) || state.topics.some((t) => t.slug === s);
  let candidate = slug || "untitled";
  for (let n = 2; taken(candidate); n++) candidate = `${slug}-${n}`;
  return candidate;
}
