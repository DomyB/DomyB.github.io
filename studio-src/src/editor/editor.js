// The visual ("Word-like") editor. It reads and writes the same Markdown the
// blog uses, so posts written here look exactly like the rest of the site.
import { Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Paragraph from "@tiptap/extension-paragraph";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { MathBlock, MathInline } from "./math.js";

// Text that only looks like Markdown must stay text on the blog: a line that
// starts with "- ", "1. " or "# " would become a list or a heading, and the
// blog reads any "|" as a table. Code and equations are left as they are.
function protectLine(line) {
  const parts = line.replace(/^[ \t]+/, "").split(/(`+[^`]*?`+|\$\$[\s\S]*?\$\$)/);
  const text = parts.map((part, i) => (i % 2 ? part : part.replace(/\|/g, "\\|"))).join("");
  return text
    .replace(/^(#{1,6})(?=[ \t]|$)/, "\\$1")
    .replace(/^([-+])(?=[ \t]|$)/, "\\$1")
    .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, "$1\\$2")
    .replace(/^(=+|-+)[ \t]*$/, "\\$1");
}

export function protectParagraph(markdown) {
  return markdown === "&nbsp;" ? markdown : markdown.split("\n").map(protectLine).join("\n");
}

const StudioParagraph = Paragraph.extend({
  renderMarkdown(node, helpers, context) {
    return protectParagraph(this.parent(node, helpers, context));
  }
});

// The big first letter of a post. The blog draws it with CSS (::first-letter),
// but in the editor that breaks typing in Safari: every key pressed after the
// first letter replaces it. So here the letter gets a <span> of its own, which
// every browser edits normally. It takes the same characters as the blog's:
// the letter plus any punctuation touching it, like “H or L'.
const PUNCT = "[\\p{Ps}\\p{Pe}\\p{Pi}\\p{Pf}\\p{Po}]";
const FIRST_LETTER = new RegExp(`^(?:${PUNCT}*[\\p{L}\\p{N}]${PUNCT}*|\\S)`, "u");

// Where the big letter is: [from, to], or null when the post doesn't start
// with a paragraph of text.
function dropCapRange(doc) {
  const paragraph = doc.firstChild;
  const text = paragraph && paragraph.type.name === "paragraph" ? paragraph.firstChild : null;
  const letter = text && text.isText ? FIRST_LETTER.exec(text.text) : null;
  return letter ? [1, 1 + letter[0].length] : null;
}

const DropCap = Extension.create({
  name: "dropCap",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("dropCap"),
      props: {
        decorations(state) {
          const range = dropCapRange(state.doc);
          return range ? DecorationSet.create(state.doc, [Decoration.inline(...range, { class: "st-dropcap" })]) : null;
        }
      }
    })];
  },
  // Safari's arrow keys don't step over a floating letter, so do it here.
  addKeyboardShortcuts() {
    const step = (direction, extend) => ({ editor }) => {
      const { state, view } = editor;
      const range = dropCapRange(state.doc);
      const { anchor, head, empty } = state.selection;
      if (!range || view.dom.classList.contains("st-no-dropcap") || (!extend && !empty)) return false;
      const target = direction < 0 ? (head === range[1] ? range[0] : null) : (head === range[0] ? range[1] : null);
      if (target === null) return false;
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, extend ? anchor : target, target)).scrollIntoView());
      return true;
    };
    return {
      ArrowLeft: step(-1, false),
      ArrowRight: step(1, false),
      "Shift-ArrowLeft": step(-1, true),
      "Shift-ArrowRight": step(1, true)
    };
  }
});

// resolveImage: turns an image address into something the browser can show
// right now (new pictures aren't on the blog until the post is saved).
export function createEditor(element, markdown, { onChange, resolveImage }) {
  const StudioImage = Image.extend({
    addNodeView() {
      return ({ node }) => {
        const img = document.createElement("img");
        const apply = (n) => {
          img.src = resolveImage(n.attrs.src || "");
          img.alt = n.attrs.alt || "";
          if (n.attrs.title) img.title = n.attrs.title;
        };
        apply(node);
        return {
          dom: img,
          update(next) {
            if (next.type.name !== "image") return false;
            apply(next);
            return true;
          }
        };
      };
    }
  });

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        paragraph: false,
        underline: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" }
      }),
      StudioParagraph,
      StudioImage.configure({ inline: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: "Start writing… (type ## for a heading, - for a list)" }),
      CharacterCount,
      MathInline,
      MathBlock,
      DropCap,
      Markdown
    ],
    content: markdown,
    contentType: "markdown",
    editorProps: {
      attributes: {
        // "no-dropcap" switches off the blog's own big first letter here;
        // DropCap draws it instead.
        class: "prose post-content no-dropcap st-editor__content",
        "aria-label": "Post text",
        "aria-multiline": "true",
        role: "textbox"
      }
    },
    onUpdate: ({ editor }) => onChange(editor)
  });

  return editor;
}

export function wordCount(editor) {
  return editor.storage.characterCount ? editor.storage.characterCount.words() : 0;
}
