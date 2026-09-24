// After a save, keep an eye on GitHub Pages and say when the change is live.
import { OWNER, REPO, SITE } from "./config.js";
import { deploymentState } from "./github.js";
import { toast } from "./ui.js";

export function trackPublish(sha, { saved = "Saved.", live = "Your change is live.", url = "/" } = {}) {
  const note = toast(`${saved} Your blog updates in about a minute…`, { busy: true, timeout: 0 });
  let tries = 0;

  async function check() {
    tries++;
    let state = "pending";
    try {
      state = await deploymentState(sha);
    } catch (e) {
      state = tries > 3 ? "unknown" : "pending"; // offline or rate-limited
    }
    if (state === "success") {
      note.update(live, { kind: "success", action: { label: "View", href: SITE + url }, timeout: 15000 });
    } else if (state === "failure") {
      note.update("GitHub couldn't rebuild the blog. Open the Actions page to see what went wrong.", {
        kind: "error",
        action: { label: "Open", href: `https://github.com/${OWNER}/${REPO}/actions` }
      });
    } else if (state === "unknown" || tries >= 14) {
      note.update(`${saved} It should appear on the blog within a few minutes.`, { kind: "info", timeout: 10000 });
    } else {
      setTimeout(check, 10000);
    }
  }

  setTimeout(check, 15000);
}
