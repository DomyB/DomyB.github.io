# Domenico Bencivenga: Notes on Economics, AI & Life

My personal blog about **economics**, **artificial intelligence** and **life**.

**Live at → https://domyb.github.io**

It's a [Jekyll](https://jekyllrb.com/) site that GitHub Pages builds automatically. There's nothing to install:
every time a change lands on the `main` branch, the site updates by itself in about a minute.

---

## ✍️ Write a new post (right here in the browser)

1. Open the **`_posts`** folder in this repository and click **Add file → Create new file**.
2. Name the file `YEAR-MONTH-DAY-short-title.md`, for example:
   `2026-10-01-why-inflation-matters.md`
   (lowercase words, separated by hyphens, no spaces).
3. Paste the template below, write your post, and click **Commit changes**.

That's it. After about a minute the post is on the home page, on its topic page and on the Network.
To watch it publish, open the **Actions** tab and look for *pages build and deployment*.

**To fix or update a post later:** open it in `_posts`, click the ✏️ pencil icon, edit, and commit again.

> 💡 **Tip:** for longer posts, press the <kbd>.</kbd> key on this repository's page. That opens a full
> editor in the browser (github.dev) with a Markdown preview. Save your changes there with *Commit & Push*.

### Post template

```markdown
---
title: "Why inflation matters more than you think"
topic: economics
connections: [ai, welcome-to-my-blog]
description: "One sentence that appears on the home page and when the link is shared."
---

Your first paragraph goes here. It starts with a big decorative first letter.

## A section heading

More text...
```

- **`topic`** is the post's main subject: `economics`, `ai` or `life`.
- **`connections`** is optional. It lists other subjects and posts this post relates to, and those links appear on the Network page (see below) and at the end of the post.
- **`description`** is optional but recommended.
- The **date** comes from the file name.

Optional extras for the front matter (the part between the `---` lines):

| Line | What it does |
|------|--------------|
| `math: true` | Turns on equations for this post (see below) |
| `image: /assets/images/my-chart.png` | Uses your own picture when the link is shared |
| `dropcap: false` | Turns off the big first letter |
| `published: false` | Hides the post without deleting it |

---

## 🕸️ The Network page

**https://domyb.github.io/network/** draws the whole blog as a living neural network:

- the **big neurons** are your subjects;
- the **small ones** are your posts;
- every **line** is a connection.

Visitors can drag the dots, hover or tap them to light up their connections, and click to open a post.

### Connecting things

Every post is automatically connected to its main `topic`. To connect it to more things, add a
`connections:` line to its front matter. Use subject names or other posts' names: a post's name is its
file name without the date, so `2026-09-24-welcome-to-my-blog.md` is `welcome-to-my-blog`.

```yaml
connections: [ai, life, welcome-to-my-blog]
```

- Connections work both ways. If post A lists post B, both posts show the link.
- To connect two **subjects** to each other, add `connects:` under a subject in `_data/topics.yml`:

  ```yaml
  - slug: economics
    name: Economics
    description: Markets, policy, and the ideas behind how economies work.
    connects: [ai]
  ```

### Drawing connections with the mouse (edit mode)

Open **https://domyb.github.io/network/?edit** (note the `?edit` at the end). Visitors never see this mode.

1. Drag from one dot to another to connect them. Drag between them again to disconnect.
   Dashed lines are drafts, and they're saved in your browser.
2. Under the network, the page shows the exact line to paste, for example `connections: [ai, life]`.
   It also has a button that opens the right file on GitHub.
3. Paste the line into the file and commit. A minute later the connection is live, and the draft disappears.

Edit mode also warns you about connection names that don't match anything, which usually means a typo.

---

## 🧾 Formatting cheat sheet

```markdown
## Section heading
### Smaller heading

**bold**, *italic*, [a link](https://example.com)

- a bullet list
- another item

1. a numbered list
2. second item

> A quote, shown in large italics.

A sentence with a footnote.[^1]

[^1]: The footnote text, shown at the bottom of the post.

| Year | Growth |
|------|-------:|
| 2025 | 1.8%   |
```

For code, wrap it in three backticks and name the language: ` ```python `.

### Images

1. Open the `assets/images/` folder and click **Add file → Upload files**.
2. In your post, write:

```markdown
![What the picture shows](/assets/images/my-chart.png)
*A caption under the picture*{:.caption}
```

### Math (for economics)

Add `math: true` to the post's front matter, then:

- **In a sentence:** `the demand curve $$Q_d = a - bP$$ slopes down`
- **A centered equation:** put it on its own lines, with an empty line before and after:

  ```markdown

  $$
  P^* = \frac{a - c}{b + d}
  $$

  ```

A single `$` is just a dollar sign, so "$5" is fine.
If an equation contains `{{` or `{%`, wrap it in `{% raw %}` … `{% endraw %}`.

---

## 🎨 Make it yours

| To change… | Edit this file |
|------------|----------------|
| Your bio on the About page | `about.md` (there's a note inside showing where) |
| Blog name, tagline and intro line | `_config.yml` |
| The big headline on the home page | `index.html` (the `<h1>` line) |
| Topic names, descriptions and subject-to-subject links | `_data/topics.yml` |
| Colors and fonts | the top of `assets/css/main.css` |
| The picture shown when a link is shared | `assets/images/social-card.png` (1200 × 630) |

### Adding a new topic

1. Add an entry to `_data/topics.yml`.
2. Copy `topics/life.md` to `topics/<slug>.md` and change `title`, `topic` and `permalink` inside it.
3. *(Optional)* Give it its own color. In `assets/css/main.css`:
   - add `--<slug>: #hexcolor;` to both color blocks (light and dark);
   - add a `.topic--<slug> { --topic: var(--<slug>); --sel: var(--<slug>); }` line.

---

## ✨ What's built in

- **Animated home page chart.** A market price line morphs into a neural network and back, with signal pulses running along it. It reacts to the mouse and to taps, and it pauses when off screen. Visitors who turn off animations see a still picture instead.
- **Light and dark themes.** The site follows the visitor's system setting, and the toggle switches themes with a circular reveal.
- **Smooth page transitions.** Post titles glide from the list into the article in browsers that support it.
- **The Network:** an interactive neural network of your subjects and posts at `/network/`, with an edit mode for drawing connections.
- **Topic pages and an archive:** `/economics/`, `/ai/`, `/life/` and `/archive/`.
- **Feeds, sharing and search:** an RSS feed at `/feed.xml`, a sitemap, and link previews for WhatsApp, LinkedIn and X.
- **Details:** reading time, footnotes, code highlighting and math.
- **Accessible:** keyboard friendly, good contrast in both themes, and topic colors that stay distinguishable for color-blind readers.

## 🗂️ What's where

```
_posts/          your posts (one Markdown file each)
_data/topics.yml the topics: names, descriptions, order
about.md         the About page
index.html       the home page
archive.html     the list of all posts
network.html     the Network page
topics/          the Economics / AI / Life pages
_layouts/        page templates (post, page, topic…)
_includes/       reusable pieces (header, footer, post list…)
assets/css/      the design (colors, fonts, layout, animations)
assets/js/       the theme switch, the animated chart and the Network
assets/fonts/    the Newsreader typeface
assets/images/   icons, the social card and your images
_config.yml      site settings
```

## 💻 Preview on your own computer (optional)

You don't need this to publish. If you want to see changes before pushing them, install Ruby and then run:

```bash
bundle install
bundle exec jekyll serve
```

Then open http://localhost:4000. The `Gemfile` pins the same versions GitHub Pages uses.

## 🛟 Troubleshooting

- **A new post doesn't show up.**
  - Open the **Actions** tab. A red ✗ usually means a typo in the front matter, such as a missing quote or a missing `---` line. GitHub also emails you when a build fails.
  - Check that the file name looks like `2026-10-01-my-title.md`.
- **A change doesn't appear yet.** GitHub Pages can take a few minutes; try a hard refresh (Ctrl/Cmd + Shift + R).

---

The typeface is [Newsreader](https://github.com/productiontype/Newsreader) by Production Type (SIL Open Font License, see `assets/fonts/OFL.txt`). Equations are rendered by [KaTeX](https://katex.org/).
