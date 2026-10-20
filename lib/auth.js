// @ts-check
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const BASE = "https://dev-null.sh";
const NAMESPACE = "devnull-commit";
const USER_AGENT = "herdr-devnull/0.1 (+https://dev-null.sh)";
const KEY_TYPES = /^(ssh-ed25519|ssh-rsa) /;

const keyId = (line) => line.trim().split(/\s+/).slice(0, 2).join(" ");

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

  const response = await fetch(`${BASE}/api/cli/key-lookups`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8", "user-agent": USER_AGENT },
    body: `${candidates.join("\n")}\n`,
  });
  if (!response.ok) throw new Error(`could not look up your key (${response.status})`);

  const answer = keyId((await response.text()).split("\n")[0]);
  const inAgent = agent.some((line) => keyId(line) === answer);
  const file = files.find((candidate) => keyId(candidate.line) === answer);
  if (!inAgent && !file) throw new Error("none of your SSH keys is on a /dev/null account");

  resolved = { key: answer, inAgent, privatePath: file?.privatePath ?? null };
  return resolved;
}

/**
 * Commits, or replies, as your /dev/null account: the payload is signed locally
 * with `ssh-keygen -Y sign`, exactly like `curl -fsSL https://dev-null.sh/commit`.
 */
export async function postCommit({ body, replyTo = null }) {
  const key = await signingKey();
  const directory = mkdtempSync(join(tmpdir(), "herdr-devnull-"));
  const payloadPath = join(directory, "commit");

  try {
    const payload = `${Math.floor(Date.now() / 1000)}\n${randomBytes(16).toString("hex")}\n${replyTo ?? ""}\n${body}`;
    writeFileSync(payloadPath, payload, { mode: 0o600 });

    let signing = key.privatePath;
    if (key.inAgent || !signing) {
      signing = join(directory, "key.pub");
      writeFileSync(signing, `${key.key}\n`, { mode: 0o600 });
    }

    try {
      // ssh-keygen prompts on /dev/tty, never on stdin: the spawn stdio stays out of it.
      await run("ssh-keygen", ["-Y", "sign", "-n", NAMESPACE, "-f", signing, payloadPath], {
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
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "user-agent": USER_AGENT,
        "x-ssh-signature": signature,
      },
      body: payload,
    });

    const answer = (await response.text()).trim();
    if (!response.ok) throw new Error(answer || `/dev/null answered ${response.status}`);
    return answer;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
