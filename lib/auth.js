// @ts-check
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const BASE = "https://dev-null.sh";
const NAMESPACE = "devnull-commit";
// With images the payload carries their SHA-256s, under its own namespace.
const IMAGE_NAMESPACE = "devnull-commit-images";
const USER_AGENT = "herdr-devnull/0.1 (+https://dev-null.sh)";
const KEY_TYPES = /^(ssh-ed25519|ssh-rsa) /;

const keyId = (line) => line.trim().split(/\s+/).slice(0, 2).join(" ");

const tempDirs = new Set();

/** Removes signing scratch directories a killed process left behind. */
export const cleanup = () => {
  for (const directory of tempDirs) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Nothing else to do at exit.
    }
  }
  tempDirs.clear();
};

const agentKeys = async () => {
  try {
    const { stdout } = await run("ssh-add", ["-L"], { timeout: 5000 });
    return stdout.split("\n").filter((line) => KEY_TYPES.test(line));
  } catch {
    return [];
  }
};

const fileKeys = () => {
  const directory = join(homedir(), ".ssh");
  if (!existsSync(directory)) return [];
  const keys = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".pub")) continue;
    const privatePath = join(directory, entry.slice(0, -4));
    if (!existsSync(privatePath)) continue;
    try {
      const line = readFileSync(join(directory, entry), "utf8").split("\n")[0];
      if (KEY_TYPES.test(line)) keys.push({ line, privatePath });
    } catch {
      // An unreadable key is not a candidate.
    }
  }
  return keys;
};

let resolved = null;

/**
 * The SSH key /dev/null knows the user by: one of the keys on their GitHub
 * account, picked the way the `devnull commit` script picks it.
 */
export async function signingKey() {
  if (resolved) return resolved;

  const agent = await agentKeys();
  const files = fileKeys();
  const candidates = [...new Set([...agent, ...files.map((file) => file.line)].map(keyId))];
  if (!candidates.length) throw new Error("no Ed25519 or RSA SSH key in your agent or ~/.ssh");

  let response;
  try {
    response = await fetch(`${BASE}/api/cli/key-lookups`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "text/plain; charset=utf-8", "user-agent": USER_AGENT },
      body: `${candidates.join("\n")}\n`,
    });
  } catch {
    throw new Error("/dev/null did not answer the key lookup");
  }
  if (!response.ok) throw new Error(`could not look up your key (${response.status})`);

  const answer = keyId((await response.text()).split("\n")[0]);
  const inAgent = agent.some((line) => keyId(line) === answer);
  const file = files.find((candidate) => keyId(candidate.line) === answer);
  if (!inAgent && !file) throw new Error("none of your SSH keys is on a /dev/null account");

  resolved = { key: answer, inAgent, privatePath: file?.privatePath ?? null };
  return resolved;
}

/**
 * Null when ssh-keygen can read the key without a passphrase, otherwise why it
 * cannot: "passphrase", or what ssh-keygen said.
 */
const keyProblem = async (/** @type {string} */ path) => {
  try {
    await run("ssh-keygen", ["-y", "-P", "", "-f", path], { timeout: 5000 });
    return null;
  } catch (error) {
    const stderr = String((error && typeof error === "object" && "stderr" in error ? error.stderr : "") ?? "").trim();
    if (/passphrase/i.test(stderr)) return "passphrase";
    return stderr.split("\n")[0] || "ssh-keygen could not read this key";
  }
};

/** @param {string} payload @param {{name: string, type: string, bytes: Buffer}[]} images */
const multipart = (payload, images) => {
  const form = new FormData();
  form.append("payload", new Blob([payload], { type: "text/plain; charset=utf-8" }), "commit");
  for (const image of images) {
    const name = image.name.replace(/["\\\r\n]/g, "") || "image";
    form.append("images[]", new Blob([new Uint8Array(image.bytes)], { type: image.type }), name);
  }
  return form;
};

/**
 * Commits, or replies, as your /dev/null account: the payload is signed locally
 * with `ssh-keygen -Y sign`, exactly like `curl -fsSL https://dev-null.sh/commit`.
 * With images, the payload gains a line of their SHA-256s, comma separated in
 * the order they are uploaded, and the signature moves to the images namespace.
 * @param {{body: string, replyTo?: string|null, images?: {name: string, type: string, bytes: Buffer}[]}} commit
 */
export async function postCommit({ body, replyTo = null, images = [] }) {
  const key = await signingKey();
  const directory = mkdtempSync(join(tmpdir(), "herdr-devnull-"));
  tempDirs.add(directory);
  const payloadPath = join(directory, "commit");

  try {
    const fields = [String(Math.floor(Date.now() / 1000)), randomBytes(16).toString("hex"), replyTo ?? ""];
    if (images.length) {
      fields.push(images.map((image) => createHash("sha256").update(image.bytes).digest("hex")).join(","));
    }
    fields.push(body);
    const payload = fields.join("\n");
    writeFileSync(payloadPath, payload, { mode: 0o600 });

    let signing = key.privatePath;
    if (key.inAgent || !signing) {
      signing = join(directory, "key.pub");
      writeFileSync(signing, `${key.key}\n`, { mode: 0o600 });
    } else {
      const problem = await keyProblem(signing);
      if (problem) {
        throw new Error(problem === "passphrase" ? `this key needs a passphrase: run \`ssh-add ${signing}\` first` : problem);
      }
    }

    try {
      // ssh-keygen prompts on /dev/tty, never on stdin: the spawn stdio stays out of it.
      await run("ssh-keygen", ["-Y", "sign", "-n", images.length ? IMAGE_NAMESPACE : NAMESPACE, "-f", signing, payloadPath], {
        timeout: 180000,
      });
    } catch (error) {
      const detail = String(error.stderr ?? "").trim();
      throw new Error(detail ? `signing failed: ${detail}` : "signing failed");
    }

    const signature = readFileSync(`${payloadPath}.sig`, "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("-----"))
      .join("");
    if (!/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error("ssh-keygen produced an unexpected signature");

    const response = await fetch(`${BASE}/api/cli/commits`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(images.length ? 180000 : 30000),
      headers: {
        "user-agent": USER_AGENT,
        "x-ssh-signature": signature,
        ...(images.length ? {} : { "content-type": "text/plain; charset=utf-8" }),
      },
      // fetch writes the multipart boundary; the payload rides along as a file.
      body: images.length ? multipart(payload, images) : payload,
    });

    const answer = (await response.text()).trim().split("\n")[0] ?? "";
    if (!response.ok) throw new Error(answer || `/dev/null answered ${response.status}`);
    return answer;
  } finally {
    tempDirs.delete(directory);
    rmSync(directory, { recursive: true, force: true });
  }
}
