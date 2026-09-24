// A small client for GitHub's REST API, used to read and change the blog's files.
import { API, BRANCH, OWNER, REPO } from "./config.js";

const REPO_PATH = `/repos/${OWNER}/${REPO}`;

export class GitHubError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// Raised when a file was changed on GitHub after the Studio loaded it.
export class ConflictError extends Error {
  constructor(path) {
    super(`“${path}” was changed on GitHub after the Studio loaded it. Reload to get the latest version, then try again.`);
    this.path = path;
  }
}

let token = null;

export function setToken(value) {
  token = value || null;
}

function friendly(status, data) {
  const msg = (data && data.message) || "";
  if (status === 401) return "GitHub didn't accept this access key. Check that you copied all of it and that it hasn't expired, or create a new one.";
  if (status === 403 && /rate limit/i.test(msg)) return "GitHub is limiting requests right now. Wait a minute and try again.";
  if (status === 403) return "Your access key isn't allowed to change the blog. Check that “Contents” is set to “Read and write”.";
  if (status === 404) return "GitHub can't find the blog with this access key. Check that the key has access to the DomyB.github.io repository.";
  if (status === 409 || status === 422) return `GitHub refused the change${msg ? ` (${msg})` : ""}. Reload the Studio and try again.`;
  return `GitHub returned an error (${status}${msg ? `: ${msg}` : ""}).`;
}

export async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
  } catch (e) {
    throw new GitHubError(0, "Can't reach GitHub. Check your internet connection and try again.");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GitHubError(res.status, friendly(res.status, data), data);
  return data;
}

export const github = {
  user: () => api("/user"),
  repo: () => api(REPO_PATH),
  head: async () => (await api(`${REPO_PATH}/git/ref/heads/${BRANCH}`)).object.sha,
  tree: (sha) => api(`${REPO_PATH}/git/trees/${sha}?recursive=1`),
  blob: (sha) => api(`${REPO_PATH}/git/blobs/${sha}`)
};

export function decodeBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Save several file changes as one commit, so the blog rebuilds once.
//   files: [{ path, content }] to write text, [{ path, base64 }] for images,
//          [{ path, delete: true }] to remove a file.
//   known: { head, shas } from when the Studio loaded the files, to refuse to
//          overwrite changes made on GitHub in the meantime.
export async function commitFiles(message, files, known) {
  const head = await github.head();
  if (known && known.head !== head) {
    const latest = await github.tree(head);
    const current = new Map(latest.tree.map((entry) => [entry.path, entry.sha]));
    for (const file of files) {
      if (known.shas.get(file.path) !== current.get(file.path)) throw new ConflictError(file.path);
    }
  }
  const parent = await api(`${REPO_PATH}/git/commits/${head}`);
  const entries = [];
  for (const file of files) {
    if (file.delete) {
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
    } else if (file.base64 != null) {
      const blob = await api(`${REPO_PATH}/git/blobs`, { method: "POST", body: { content: file.base64, encoding: "base64" } });
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    } else {
      entries.push({ path: file.path, mode: "100644", type: "blob", content: file.content });
    }
  }
  const tree = await api(`${REPO_PATH}/git/trees`, { method: "POST", body: { base_tree: parent.tree.sha, tree: entries } });
  const commit = await api(`${REPO_PATH}/git/commits`, { method: "POST", body: { message, tree: tree.sha, parents: [head] } });
  await api(`${REPO_PATH}/git/refs/heads/${BRANCH}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
  return commit.sha;
}

// Has GitHub Pages finished publishing this commit? (Public information, so
// this asks without the access key.) Returns "pending", "success" or "failure".
export async function deploymentState(sha) {
  const deployments = await api(`${REPO_PATH}/deployments?environment=github-pages&per_page=5`, { auth: false });
  const deployment = (deployments || []).find((d) => d.sha === sha);
  if (!deployment) return "pending";
  const statuses = await api(`${REPO_PATH}/deployments/${deployment.id}/statuses?per_page=1`, { auth: false });
  const state = statuses && statuses[0] && statuses[0].state;
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  return "pending";
}
