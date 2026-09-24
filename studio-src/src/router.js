// The Studio's pages live after the # in the address:
//   #/posts   #/write/new   #/write/<post file>   #/network   #/subjects
// main.js draws them; views call go() to move on and rename() when the page
// they show gets a new address (a new post's first save).

let draw = () => {};
let shown = "";

export function parseRoute(hash) {
  const match = /^#\/([a-z]+)(?:\/(.+))?$/.exec(hash || "");
  let arg = null;
  if (match && match[2]) {
    try {
      arg = decodeURIComponent(match[2]);
    } catch (e) {
      arg = match[2];
    }
  }
  return { view: match ? match[1] : "", arg };
}

export function onRoute(fn) {
  draw = fn;
}

// The address of the page on screen.
export function shownHash() {
  return shown;
}

export function markShown(hash) {
  shown = hash;
}

// Go to a page. `replace` swaps the current history entry instead of adding one.
export function go(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(history.state, "", hash);
    draw();
  } else if (location.hash === hash) {
    draw();
  } else {
    location.hash = hash; // main.js draws it on "hashchange"
  }
}

// Same page, new address (nothing is redrawn).
export function rename(hash) {
  history.replaceState(history.state, "", hash);
  shown = hash;
}
