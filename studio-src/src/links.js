// How subjects and posts point at each other, the same way the blog reads it:
// a post lists subjects and posts in `connections:`, a subject lists them in
// `connects:` (in _data/topics.yml), and two things are connected when either
// one lists the other. A post's main subject (`topic:`) is always connected.
import { state } from "./store.js";

// The names that point at a post: its slug or its file name (date + slug).
export function postNames(post) {
  const slug = post.slug.toLowerCase();
  return [slug, `${post.date}-${slug}`];
}

// The name to write when connecting to a post: its slug, unless a subject or
// another post uses the same one.
export function postRef(post) {
  const slug = post.slug.toLowerCase();
  const clash = state.topics.some((t) => t.slug === slug) ||
    state.posts.some((p) => p !== post && p.slug.toLowerCase() === slug);
  return clash ? `${post.date}-${slug}` : slug;
}

// What a name in a list points at (subjects win, like on the blog):
// { kind: "topic", topic }, { kind: "post", post } or null when nothing matches.
export function resolveName(name) {
  const topic = state.topics.find((t) => t.slug === name);
  if (topic) return { kind: "topic", topic };
  const post = state.posts.find((p) => postNames(p).includes(name));
  return post ? { kind: "post", post } : null;
}

// Does this list of names point at the subject or post?
export function mentions(list, item) {
  const own = item.kind === "topic" ? [item.topic.slug] : postNames(item.post);
  return list.some((name) => own.includes(name));
}

export function withoutItem(list, item) {
  const own = item.kind === "topic" ? [item.topic.slug] : postNames(item.post);
  return list.filter((name) => !own.includes(name));
}

export function refName(item) {
  return item.kind === "topic" ? item.topic.slug : postRef(item.post);
}

// The same names, in any order.
export function sameNames(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
