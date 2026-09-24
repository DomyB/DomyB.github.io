// Where the blog lives. The Studio only ever talks to GitHub's API about this
// one repository, and every change it makes is an ordinary commit there.
export const OWNER = "DomyB";
export const REPO = "DomyB.github.io";
export const BRANCH = "main";
export const SITE = "https://domyb.github.io";
export const API = "https://api.github.com";

// Where to create the access key the Studio signs in with.
export const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

// Names a new subject can't use: the blog already has pages at these addresses,
// or its stylesheet uses them for colors (a subject's color is stored as
// --<name>, see assets/css/topics.css), or the Studio does (--st-…).
export const RESERVED_SLUGS = [
  "about", "archive", "network", "studio", "assets", "feed", "sitemap", "robots",
  "topics", "posts", "index", "404", "tag", "tags", "category", "categories", "search",
  "bg", "bg-elev", "bg-sunk", "card-pad", "ease-in-out", "ease-out", "focus", "font-mono",
  "font-sans", "font-serif", "grain-opacity", "green", "gutter", "indigo", "line", "link-accent",
  "muted", "on-topic", "post", "radius", "rule", "rule-strong", "sel", "shadow", "shadow-rgb",
  "terracotta", "text", "text-soft", "topic", "wrap", "wrap-narrow", "all",
  // YAML reads these as true/false/nothing
  "yes", "no", "on", "off", "true", "false", "null", "y", "n"
];
export const RESERVED_PREFIX = "st-";

// Colors offered for new subjects: readable on both themes (at least 4.6:1),
// most distinct from the blog's three original colors first.
export const SWATCHES = [
  { name: "Blue", color: "#2672b7", colorDark: "#4790d8" },
  { name: "Plum", color: "#984f92", colorDark: "#b86db1" },
  { name: "Ochre", color: "#906606", colorDark: "#b5820c" },
  { name: "Rose", color: "#a74a72", colorDark: "#c86890" },
  { name: "Teal", color: "#357a82", colorDark: "#289da9" },
  { name: "Olive", color: "#60792a", colorDark: "#7a9938" },
  { name: "Crimson", color: "#ad4a51", colorDark: "#cf686e" },
  { name: "Violet", color: "#8058ab", colorDark: "#9f76cb" }
];

export const LIGHT_BG = "#faf7f2";
export const DARK_BG = "#16140f";
