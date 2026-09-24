// Equations in the editor, written the way the blog expects them:
//   inline:    the demand curve $$Q = a - bP$$ slopes down
//   centered:  $$ on its own lines, with the formula between them
import { Node, mergeAttributes } from "@tiptap/core";

let katex = null;
let loading = null;

// KaTeX (the same library the blog uses) is only loaded once a post has math.
function loadKatex() {
  if (!loading) {
    const base = location.pathname.replace(/[^/]*$/, "");
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${base}app/katex/katex.min.css`;
    document.head.appendChild(css);
    loading = import("katex").then((m) => {
      katex = m.default || m;
      return katex;
    });
  }
  return loading;
}

export function renderLatex(el, latex, display) {
  el.textContent = latex || "(empty equation)";
  el.classList.toggle("st-math--empty", !latex);
  if (!latex) return;
  const draw = () => {
    try {
      katex.render(latex, el, { displayMode: display, throwOnError: false });
    } catch (e) {
      el.textContent = latex;
    }
  };
  if (katex) draw();
  else loadKatex().then(draw, () => {});
}

function mathView(display) {
  return ({ node, editor, getPos }) => {
    const dom = document.createElement(display ? "div" : "span");
    dom.className = `st-math ${display ? "st-math--block" : "st-math--inline"}`;
    dom.setAttribute("contenteditable", "false");
    dom.title = "Double-click to edit the equation";
    let current = node;
    renderLatex(dom, current.attrs.latex, display);
    dom.addEventListener("dblclick", () => {
      if (typeof getPos !== "function") return;
      editor.emit("studio:editMath", { pos: getPos(), node: current });
    });
    return {
      dom,
      update(next) {
        if (next.type !== current.type) return false;
        current = next;
        renderLatex(dom, next.attrs.latex, display);
        return true;
      },
      ignoreMutation: () => true
    };
  };
}

export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "span[data-math-inline]", getAttrs: (el) => ({ latex: el.getAttribute("data-latex") || "" }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-math-inline": "", "data-latex": node.attrs.latex }), node.attrs.latex];
  },

  addNodeView() {
    return mathView(false);
  },

  markdownTokenizer: {
    name: "mathInline",
    level: "inline",
    start: (src) => src.indexOf("$$"),
    tokenize(src) {
      const match = /^\$\$(?!\s*\n)((?:\\.|[^$\\])+?)\$\$/.exec(src);
      if (!match) return undefined;
      return { type: "mathInline", raw: match[0], latex: match[1].trim() };
    }
  },

  parseMarkdown: (token) => ({ type: "mathInline", attrs: { latex: token.latex } }),

  // The blog reads a "|" in a paragraph as a table, even inside an equation,
  // so bars are written the LaTeX way (\vert and \Vert draw the same thing).
  renderMarkdown: (node) => `$$${node.attrs.latex.replace(/\\\|/g, "\\Vert ").replace(/\|/g, "\\vert ")}$$`
});

export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "div[data-math-block]", getAttrs: (el) => ({ latex: el.getAttribute("data-latex") || "" }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-math-block": "", "data-latex": node.attrs.latex }), node.attrs.latex];
  },

  addNodeView() {
    return mathView(true);
  },

  // Only at the start of a line, and only when the $$ … $$ fills whole lines.
  markdownTokenizer: {
    name: "mathBlock",
    level: "block",
    start(src) {
      const match = /(^|\n)\$\$/.exec(src);
      return match ? match.index + match[1].length : -1;
    },
    tokenize(src) {
      const multi = /^\$\$[ \t]*\n([\s\S]+?)\n[ \t]*\$\$[ \t]*(?:\n|$)/.exec(src);
      const single = /^\$\$((?:\\.|[^$\\\n])+?)\$\$[ \t]*(?:\n|$)/.exec(src);
      const match = multi || single;
      if (!match) return undefined;
      return { type: "mathBlock", raw: match[0], latex: match[1].trim() };
    }
  },

  parseMarkdown: (token) => ({ type: "mathBlock", attrs: { latex: token.latex } }),

  renderMarkdown: (node) => `$$\n${node.attrs.latex}\n$$`
});
