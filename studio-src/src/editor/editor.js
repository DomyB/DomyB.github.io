// The visual ("Word-like") editor. It reads and writes the same Markdown the
// blog uses, so posts written here look exactly like the rest of the site.
import { Editor } from "@tiptap/core";
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

  return new Editor({
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
      Markdown
    ],
    content: markdown,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "prose post-content st-editor__content",
        "aria-label": "Post text",
        "aria-multiline": "true",
        role: "textbox"
      }
    },
    onUpdate: ({ editor }) => onChange(editor)
  });
}

export function wordCount(editor) {
  return editor.storage.characterCount ? editor.storage.characterCount.words() : 0;
}
