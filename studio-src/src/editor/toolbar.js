// The formatting toolbar above the page, like a word processor's.
import { h, icon, openDialog } from "../ui.js";
import { renderLatex } from "./math.js";

const STYLES = [
  { value: "p", label: "Normal text" },
  { value: "2", label: "Heading" },
  { value: "3", label: "Subheading" },
  { value: "4", label: "Small heading" }
];

function button(name, label, run, shortcut) {
  return h("button", {
    class: "st-tool",
    type: "button",
    "aria-label": label,
    title: shortcut ? `${label} (${shortcut})` : label,
    dataset: { tool: name },
    onmousedown: (e) => e.preventDefault(), // keep the text selection
    onclick: run
  }, icon(name));
}

// Ask for a link address.
export function askLink(current) {
  return openDialog("Link", (close) => {
    const input = h("input", { class: "st-input", type: "url", value: current || "", placeholder: "https://…", autofocus: true, "aria-label": "Link address" });
    const submit = (e) => {
      e.preventDefault();
      close({ href: input.value.trim() });
    };
    return h("form", { class: "st-dialog__body", onsubmit: submit },
      h("label", { class: "st-field" }, h("span", { class: "st-field__label" }, "Address"), input),
      h("p", { class: "st-hint" }, "Tip: to link to another post, use its address on your blog, like /2026/09/welcome-to-my-blog/"),
      h("div", { class: "st-dialog__actions" },
        current ? h("button", { class: "st-btn st-btn--danger", type: "button", onclick: () => close({ href: "" }) }, "Remove link") : null,
        h("button", { class: "st-btn", type: "button", onclick: () => close(undefined) }, "Cancel"),
        h("button", { class: "st-btn st-btn--primary", type: "submit" }, "Apply")));
  });
}

// Write or edit an equation, with a live preview.
export function askMath(latex, display) {
  return openDialog("Equation", (close) => {
    const preview = h("div", { class: "st-math-preview" });
    const input = h("textarea", {
      class: "st-input st-input--mono", rows: 3, autofocus: true, "aria-label": "Equation in LaTeX",
      placeholder: "P^* = \\frac{a - c}{b + d}",
      oninput: () => renderLatex(preview, input.value.trim(), block.checked)
    }, latex || "");
    const block = h("input", { type: "checkbox", checked: display, onchange: () => renderLatex(preview, input.value.trim(), block.checked) });
    renderLatex(preview, latex || "", display);
    return h("form", { class: "st-dialog__body", onsubmit: (e) => { e.preventDefault(); close({ latex: input.value.trim(), display: block.checked }); } },
      h("label", { class: "st-field" }, h("span", { class: "st-field__label" }, "Equation (LaTeX)"), input),
      h("label", { class: "st-check" }, block, h("span", {}, "Show it centered on its own line")),
      h("div", { class: "st-field" }, h("span", { class: "st-field__label" }, "Preview"), preview),
      h("p", { class: "st-hint" }, "Examples: x^2, \\frac{a}{b}, \\sqrt{x}, \\alpha, \\sum_{i=1}^{n} x_i"),
      h("div", { class: "st-dialog__actions" },
        h("button", { class: "st-btn", type: "button", onclick: () => close(undefined) }, "Cancel"),
        h("button", { class: "st-btn st-btn--primary", type: "submit" }, latex ? "Update" : "Insert")));
  }, { wide: true });
}

export async function insertOrEditMath(editor, existing) {
  const node = existing && existing.node;
  const result = await askMath(node ? node.attrs.latex : "", node ? node.type.name === "mathBlock" : false);
  if (!result || !result.latex) return;
  const type = result.display ? "mathBlock" : "mathInline";
  const chain = editor.chain().focus();
  if (existing) chain.deleteRange({ from: existing.pos, to: existing.pos + node.nodeSize });
  chain.insertContent({ type, attrs: { latex: result.latex } }).run();
}

export function createToolbar(editor, { onImage }) {
  const run = (fn) => () => fn(editor.chain().focus()).run();

  const style = h("select", {
    class: "st-tool st-tool--select",
    "aria-label": "Text style",
    onchange: () => {
      const chain = editor.chain().focus();
      if (style.value === "p") chain.setParagraph().run();
      else chain.setHeading({ level: Number(style.value) }).run();
    }
  }, STYLES.map((s) => h("option", { value: s.value }, s.label)));

  const tableTools = h("div", { class: "st-toolbar__group st-toolbar__group--table", hidden: true },
    h("button", { class: "st-tool st-tool--text", type: "button", onclick: run((c) => c.addRowAfter()) }, "+ Row"),
    h("button", { class: "st-tool st-tool--text", type: "button", onclick: run((c) => c.addColumnAfter()) }, "+ Column"),
    h("button", { class: "st-tool st-tool--text", type: "button", onclick: run((c) => c.deleteRow()) }, "− Row"),
    h("button", { class: "st-tool st-tool--text", type: "button", onclick: run((c) => c.deleteColumn()) }, "− Column"),
    h("button", { class: "st-tool st-tool--text", type: "button", onclick: run((c) => c.deleteTable()) }, "Delete table"));

  const bar = h("div", { class: "st-toolbar", role: "toolbar", "aria-label": "Formatting" },
    h("div", { class: "st-toolbar__group" },
      button("undo", "Undo", run((c) => c.undo()), "Ctrl+Z"),
      button("redo", "Redo", run((c) => c.redo()), "Ctrl+Shift+Z")),
    h("div", { class: "st-toolbar__group" }, style),
    h("div", { class: "st-toolbar__group" },
      button("bold", "Bold", run((c) => c.toggleBold()), "Ctrl+B"),
      button("italic", "Italic", run((c) => c.toggleItalic()), "Ctrl+I"),
      button("strike", "Strikethrough", run((c) => c.toggleStrike())),
      button("code", "Code", run((c) => c.toggleCode())),
      button("link", "Link", async () => {
        const result = await askLink(editor.getAttributes("link").href);
        if (!result) return;
        const chain = editor.chain().focus().extendMarkRange("link");
        if (result.href) chain.setLink({ href: result.href }).run();
        else chain.unsetLink().run();
      }, "Ctrl+K")),
    h("div", { class: "st-toolbar__group" },
      button("bullets", "Bulleted list", run((c) => c.toggleBulletList())),
      button("numbers", "Numbered list", run((c) => c.toggleOrderedList())),
      button("quote", "Quote", run((c) => c.toggleBlockquote())),
      button("codeblock", "Code block", run((c) => c.toggleCodeBlock())),
      button("divider", "Divider", run((c) => c.setHorizontalRule()))),
    h("div", { class: "st-toolbar__group" },
      button("image", "Picture", onImage),
      button("table", "Table", run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))),
      button("sigma", "Equation", () => insertOrEditMath(editor, null))),
    tableTools);

  editor.on("studio:editMath", (existing) => insertOrEditMath(editor, existing));
  editor.on("create", update);

  function update() {
    if (textMode) return;
    const active = {
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      strike: editor.isActive("strike"),
      code: editor.isActive("code"),
      link: editor.isActive("link"),
      bullets: editor.isActive("bulletList"),
      numbers: editor.isActive("orderedList"),
      quote: editor.isActive("blockquote"),
      codeblock: editor.isActive("codeBlock")
    };
    bar.querySelectorAll("[data-tool]").forEach((btn) => {
      const on = active[btn.dataset.tool];
      if (on != null) btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    bar.querySelector('[data-tool="undo"]').disabled = !editor.can().undo();
    bar.querySelector('[data-tool="redo"]').disabled = !editor.can().redo();
    const level = [2, 3, 4].find((l) => editor.isActive("heading", { level: l }));
    style.value = level ? String(level) : "p";
    tableTools.hidden = !editor.isActive("table");
  }

  let textMode = false;

  editor.on("selectionUpdate", update);
  editor.on("transaction", update);
  update();

  return {
    element: bar,
    // In Markdown mode the formatting buttons have nothing to act on.
    setMode(on) {
      textMode = on;
      bar.hidden = on;
      bar.querySelectorAll(".st-toolbar__group .st-tool").forEach((tool) => { tool.disabled = on; });
      if (!on) update();
    }
  };
}
