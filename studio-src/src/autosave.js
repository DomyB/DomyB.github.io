// Unsaved writing is backed up in this browser, so nothing is lost if the tab
// closes. Each post has its own backup ("new" for a post never saved).
const PREFIX = "studio-autosave:";

export function hasAutosave(key) {
  try {
    return !!localStorage.getItem(PREFIX + key);
  } catch (e) {
    return false;
  }
}

export function readAutosave(key) {
  try {
    return JSON.parse(localStorage.getItem(PREFIX + key) || "null");
  } catch (e) {
    return null;
  }
}

export function writeAutosave(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    try { // too big with the pictures: keep the text at least
      localStorage.setItem(PREFIX + key, JSON.stringify(Object.assign({}, value, { images: {} })));
      return true;
    } catch (e2) {
      return false;
    }
  }
}

export function dropAutosave(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch (e) {}
}

// Which posts have a backup on this device ("new" for a post never saved).
export function autosaveKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key.slice(PREFIX.length));
    }
  } catch (e) {}
  return keys;
}
