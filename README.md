# Domenico Bencivenga: Notes on Economics, AI, Politics & Life

My personal blog about **economics**, **artificial intelligence**, **politics** and **life**.

**Live at → https://domyb.github.io**

It's a [Jekyll](https://jekyllrb.com/) site that GitHub Pages builds automatically. There's nothing to install:
every time a change lands on the `main` branch, the site updates by itself in about a minute.

---

## 🖋️ The Studio: write like in a word processor

**https://domyb.github.io/studio/** is your private writing app for this blog. It has three pages:

- **Posts:** every post and draft, with search and filters. Click one to edit it, or **New post**.
  You write on a page that looks just like the blog, with a toolbar for headings, **bold**, *italic*,
  lists, quotes, links, pictures, tables and equations. **Publish** puts the post on the blog;
  **Save draft** keeps it for later. Unsaved writing is backed up on your device, so closing the tab
  doesn't lose it. Shortcuts: <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>S</kbd> saves, <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> adds a link.
- **Network:** your neural network. Drag from one dot to another to connect a subject or post, drag
  again to disconnect, or click a dot and use the panel. Then press **Save changes**.
- **Subjects:** add, rename, recolor, reorder or delete subjects. A new subject gets its own page
  and a color that's readable in both themes.

Every save is an ordinary change (a *commit*) in this repository, so GitHub keeps every earlier version.
The blog updates about a minute later, and the Studio tells you when it's live.

### First time on a device: create an access key

The Studio signs in with a GitHub access key that can only change this blog.

1. Open **https://github.com/settings/personal-access-tokens/new** (sign in to GitHub if asked).
2. Name it **Blog Studio** and choose an expiration, for example one year. GitHub emails you before it expires.
3. Under **Repository access**, choose **Only select repositories** and pick **DomyB/DomyB.github.io**.
4. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**.
5. Click **Generate token**, copy the key and paste it into the Studio.
   Tick *Remember me* only on your own computer or phone.

If you lose a device, delete the key on GitHub (**Settings → Developer settings → Personal access
tokens → Fine-grained tokens**) and create a new one.

Good to know:

- **Drafts** are saved in this repository with `published: false`. They don't appear on the blog, but the
  repository is public, so anyone browsing it on GitHub could read them.
- **Pictures** are resized to at most 1600 pixels and saved in `assets/images/posts/`.
- A post written by hand with HTML, footnotes or `{:.caption}` opens as **Markdown** text, so nothing
  is lost. The **Markdown** button switches any post between the visual editor and the text.
- If a file changed on GitHub while the Studio was open, the Studio won't overwrite it. It asks you to
  reload first (account menu → **Reload from GitHub**).
- If a post's settings (the lines between `---` at the top) have a typo, the Studio opens the whole file
  and shows where the problem is, so you can fix it without losing anything.

---

## ✍️ Or write a new post directly on GitHub

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

- **`topic`** is the post's main subject: `economics`, `ai`, `life` or `politics` (the list is in `_data/topics.yml`).
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

### Drawing connections with the mouse

The easiest way is the Studio's **Network** page (see above), which saves the connections for you.

Without signing in, you can also open **https://domyb.github.io/network/?edit** (note the `?edit` at the
end). Visitors never see this mode.

1. Drag from one dot to another to connect them. Drag between them again to disconnect.
   Dashed lines are drafts, and they're saved in your browser.
2. Under the network, the page shows the exact line to paste, for example `connections: [ai, life]`.
   It also has a button that opens the right file on GitHub.
3. Paste the line into the file and commit. A minute later the connection is live, and the draft disappears.

Edit mode also warns you about connection names that don't match anything, which usually means a typo.

---

## 📈 The Stocks page

**https://domyb.github.io/stocks/** tracks a list of stocks and funds with live-ish prices, chart
signals, fundamentals and forecasts, and it grades its own forecasts in public as they come due.

- **Overview:** every tracked stock with its price, a 60-day sparkline, the forecast for the horizon
  you pick (a day, a week, a month, three months) with its 80% band and the chance of a gain, the fair
  value gap, and a 0–100 score. Search, filter by sector, sort any column.
- **A stock's page:** a price chart with moving averages, Bollinger bands and the forecast cone, RSI and
  MACD, the forecasts for every horizon, plain-language readings of the chart (trend, momentum,
  overbought/oversold, volume, volatility), a fair value built from three methods, the key ratios, the
  analysts' view, and that stock's own track record.
- **How the forecasts work:** what the model can and can't do, the walk-forward backtest horizon by
  horizon next to the naive baselines it has to beat, calibration by decile, year-by-year results, the
  features the model relies on, and the live track record of every forecast published on the site.

### How it works

The numbers come from `tools/stocks/pipeline.py`, which GitHub Actions runs on a schedule
(`.github/workflows/stocks.yml`): every half hour during European and US trading hours and once more
after the US close. Each run downloads twelve years of daily prices from Yahoo Finance for the tracked
symbols plus about 150 extra US large caps the model learns from, computes the features, retrains the
model (the walk-forward backtest itself is redone once a day, after the close), fetches fundamentals,
writes down today's forecasts in a ledger and grades the ones that have come due. The result is a set
of plain JSON files pushed to the **`stock-data`** branch, which the page reads straight from
`raw.githubusercontent.com`. `main` is never touched, so the blog's history stays clean. A copy of the
output from the last manual run lives in `assets/data/stocks/` as a fallback for the very first load.

The model forecasts *relative* performance (which stocks beat the others, net of their beta to the
market) on top of a conservative market drift, because that is the only part of stock returns with a
measurable, repeatable edge. Survivors only count from the day they joined the S&P 500, so the backtest
isn't flattered by hindsight.
Forecasts are calibrated and their bands sized on the model's own out-of-sample errors. The whole
method, with its results, is explained on the page itself. **None of it is investment advice.**

### Everyday use

- **Add or remove a stock:** edit `_data/stocks.yml` (any Yahoo Finance symbol; Milan listings end in
  `.MI`). The next data run picks it up. Keep the list to liquid, well-known names.
- **Refresh by hand:** open the **Actions** tab → *Stocks data* → **Run workflow**. Tick *Force a new
  backtest* to retrain from scratch.
- **Live prices:** the page refreshes itself every few minutes with the latest run. For second-by-second
  prices during US hours, click **Live prices** on the page and paste a free
  [Finnhub](https://finnhub.io/register) key; it stays in that browser only.
- **The first run:** the scheduled workflow only runs on the `main` branch, so after this lands on
  `main` either wait for the next scheduled time or run it by hand once. GitHub pauses schedules in
  repositories with no activity for 60 days; a commit or a manual run wakes them up.
- **Run it on your computer** (optional): `pip install -r tools/stocks/requirements.txt`, then
  `python tools/stocks/pipeline.py --out build/stocks --limit 10 --years 6` for a quick test.
- **Improve the model:** `tools/stocks/experiments.py` runs the walk-forward backtest for named variants
  (feature packs, learner settings, post-processing) against the baseline, caches prices and features,
  and reports paired daily-IC differences with a tune (to 2020) / confirm (2021 on) split and a
  seed-noise floor, so a change is only adopted when it helps in both periods beyond noise.
  `tools/stocks/build_membership.py` refreshes the S&P 500 entry dates used to keep survivorship bias
  out of the training cross-section.

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
| Subjects: names, descriptions, colors, order and links | the Studio's **Subjects** page, or `_data/topics.yml` |
| The site's other colors and fonts | the top of `assets/css/main.css` |
| The picture shown when a link is shared | `assets/images/social-card.png` (1200 × 630) |

### Adding a new topic

The Studio's **Subjects** page does all of this for you. By hand:

1. Add an entry to `_data/topics.yml`, with a `color` (for the light theme) and a `color_dark`.
2. Copy `topics/life.md` to `topics/<slug>.md` and change `title`, `topic` and `permalink` inside it.

The colors reach every page through `assets/css/topics.css`, which is generated from `_data/topics.yml`.

---

## ✨ What's built in

- **Animated home page chart.** A market price line morphs into a neural network and back, with signal pulses running along it. It reacts to the mouse and to taps, and it pauses when off screen. Visitors who turn off animations see a still picture instead.
- **Light and dark themes.** The site follows the visitor's system setting, and the toggle switches themes with a circular reveal.
- **Smooth page transitions.** Post titles glide from the list into the article in browsers that support it.
- **The Studio:** a private, word-processor-like app at `/studio/` for writing posts and managing the network and subjects.
- **The Network:** an interactive neural network of your subjects and posts at `/network/`, with an edit mode for drawing connections.
- **The Stocks page:** prices, chart signals, fundamentals and honestly backtested forecasts at `/stocks/`, refreshed automatically by GitHub Actions.
- **Topic pages and an archive:** `/economics/`, `/ai/`, `/life/`, `/politics/` and `/archive/`.
- **Feeds, sharing and search:** an RSS feed at `/feed.xml`, a sitemap, and link previews for WhatsApp, LinkedIn and X.
- **Details:** reading time, footnotes, code highlighting and math.
- **Accessible:** keyboard friendly, good contrast in both themes, and topic colors that stay distinguishable for color-blind readers.

## 🗂️ What's where

```
_posts/          your posts (one Markdown file each)
_data/topics.yml the topics: names, descriptions, colors, order
about.md         the About page
index.html       the home page
archive.html     the list of all posts
network.html     the Network page
stocks.html      the Stocks page (drawn by assets/js/stocks.js, styled by assets/css/stocks.css)
_data/stocks.yml the stocks the Stocks page tracks
tools/stocks/    the Python pipeline that builds the Stocks page's data
topics/          the Economics / AI / Life / Politics pages
_layouts/        page templates (post, page, topic…)
_includes/       reusable pieces (header, footer, post list…)
assets/css/      the design (colors, fonts, layout, animations)
assets/js/       the theme switch, the animated chart, the Network and the Stocks page
assets/data/     the Stocks page's fallback data (the live data is on the stock-data branch)
assets/fonts/    the Newsreader typeface
assets/images/   icons, the social card and your images
studio/          the Studio app (studio/app/ is built from studio-src/, don't edit it by hand)
studio-src/      the Studio's source code (see studio-src/README.md)
_config.yml      site settings
```

## ▲ Hosting a copy on Vercel (optional)

GitHub Pages stays the home of the blog, but the repository also carries a `vercel.json`, so the same
site can be served from Vercel too:

1. On [vercel.com/new](https://vercel.com/new), import **DomyB/DomyB.github.io**. Vercel reads
   `vercel.json`: it installs the gems, builds the site with Jekyll and serves the `_site` folder.
   No settings need changing; the first build takes a few minutes because of the Ruby gems.
2. Every push to the production branch redeploys. The Stocks page keeps reading its data from the
   `stock-data` branch on GitHub, so it is just as live on Vercel.
3. To deploy from the command line instead, create a token at **vercel.com/account/tokens** and run
   `npx vercel --prod --token "$VERCEL_TOKEN"` from the repository.

The site's absolute links (feed, sitemap, share previews) use the Vercel address automatically; the
GitHub Pages address stays the canonical one in `_config.yml`.

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
- **The Studio says your access key isn't valid.** The key has probably expired. Create a new one
  (see *First time on a device* above) and sign in again. Your unsaved writing is still on the device.

---

The typeface is [Newsreader](https://github.com/productiontype/Newsreader) by Production Type (SIL Open Font License, see `assets/fonts/OFL.txt`). Equations are rendered by [KaTeX](https://katex.org/). The Studio's editor is built with [Tiptap](https://tiptap.dev/); the licenses of everything it includes are in `studio/app/THIRD-PARTY-LICENSES.txt`.
