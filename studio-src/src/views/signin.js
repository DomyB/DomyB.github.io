// The sign-in screen: the Studio signs in with a GitHub access key that can
// only change the blog's repository.
import { OWNER, REPO, TOKEN_URL } from "../config.js";
import { h } from "../ui.js";

export function renderSignIn(container, { error, onSignIn }) {
  const input = h("input", {
    id: "st-token", class: "st-input st-input--mono", type: "password", autocomplete: "off",
    spellcheck: "false", placeholder: "github_pat_…", required: true, "aria-describedby": "st-token-help"
  });
  const keep = h("input", { type: "checkbox", checked: true });
  const status = h("p", { class: "st-form-error", role: "alert" }, error || "");
  const submit = h("button", { class: "st-btn st-btn--primary st-btn--wide", type: "submit" }, "Sign in");

  const form = h("form", {
    class: "st-signin__form",
    onsubmit: async (event) => {
      event.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      submit.disabled = true;
      submit.textContent = "Checking the key…";
      status.textContent = "";
      try {
        await onSignIn(token, keep.checked);
      } catch (e) {
        status.textContent = e.message;
        submit.disabled = false;
        submit.textContent = "Sign in";
        input.focus();
      }
    }
  },
    h("label", { class: "st-field", for: "st-token" }, h("span", { class: "st-field__label" }, "Your access key")),
    input,
    h("label", { class: "st-check" }, keep, h("span", {}, "Remember me on this device (only on your own computer or phone)")),
    status,
    submit);

  container.append(h("section", { class: "st-signin" },
    h("div", { class: "st-signin__intro" },
      h("p", { class: "eyebrow" }, "Blog Studio"),
      h("h1", { class: "st-signin__title" }, "Write, publish and ", h("em", {}, "connect"), "."),
      h("p", { class: "st-signin__lede" },
        "The Studio edits your blog directly on GitHub. To let it in, create an access key that can only change your blog, then paste it below. You only do this once per device.")),
    h("div", { class: "st-signin__card" },
      h("ol", { class: "st-steps", id: "st-token-help" },
        h("li", {}, h("a", { href: TOKEN_URL, target: "_blank", rel: "noopener" }, "Open GitHub's “new access key” page ↗"), " (sign in to GitHub if it asks)."),
        h("li", {}, "Name it ", h("strong", {}, "Blog Studio"), " and choose an expiration, for example one year."),
        h("li", {}, "Under ", h("strong", {}, "Repository access"), ", choose ", h("strong", {}, "Only select repositories"), " and pick ", h("strong", {}, `${OWNER}/${REPO}`), "."),
        h("li", {}, "Under ", h("strong", {}, "Permissions"), ", open ", h("strong", {}, "Repository permissions"), " and set ", h("strong", {}, "Contents"), " to ", h("strong", {}, "Read and write"), "."),
        h("li", {}, "Click ", h("strong", {}, "Generate token"), ", copy the key and paste it here.")),
      form,
      h("p", { class: "st-hint" },
        "The key stays in this browser and can only change your blog, nothing else on your GitHub account. You can delete it on GitHub at any time."))));

  input.focus();
  return {};
}
