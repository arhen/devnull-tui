// @ts-check
// A device key for /dev/null's own API: the same PKCE approval the mobile app
// does, so stars, deletes and follows can be signed from this pane.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

const BASE = "https://dev-null.sh";
const NAMESPACE = "devnull-api";
const USER_AGENT = "herdr-devnull/0.1 (+https://dev-null.sh)";
const REDIRECT_URI = "devnull://device";
const DEVICE_NAME = "Herdr";

const stateRoot = () =>
  process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.HOME ?? ".", ".cache", "herdr-devnull");

const directory = () => {
  const dir = stateRoot();
  mkdirSync(dir, { recursive: true });
  return dir;
};

const keyPath = () => join(directory(), "device");
const pendingPath = () => join(directory(), "device-pending.json");

/** @param {Buffer} buffer */
const base64url = (buffer) =>
  buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** @param {unknown} error */
const stderrOf = (error) =>
  String((error && typeof error === "object" && "stderr" in error ? error.stderr : "") ?? "").trim();

export const hasDevice = () => existsSync(`${keyPath()}.pub`);

/** @returns {Promise<string>} */
export const fingerprint = async () => {
  try {
    const { stdout } = await run("ssh-keygen", ["-lf", `${keyPath()}.pub`, "-E", "sha256"]);
    return /SHA256:[A-Za-z0-9+/]{43}/.exec(stdout)?.[0] ?? "";
  } catch {
    return "";
  }
};

const ensureKey = async () => {
  if (!hasDevice()) {
    try {
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "devnull-herdr", "-f", keyPath()]);
    } catch (error) {
      throw new Error(`could not make a device key: ${stderrOf(error) || "ssh-keygen failed"}`);
    }
  }
  const fingerprintValue = await fingerprint();
  if (!fingerprintValue) throw new Error("could not read the device key fingerprint");
  return fingerprintValue;
};

/**
 * The page where the user approves this pane as a device. It redirects to
 * devnull://device?code=…, which no app has to open: the code is pasted back.
 */
export const authorizationUrl = async () => {
  const fingerprintValue = await ensureKey();
  const verifier = base64url(randomBytes(32)).slice(0, 64);
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(12));

  writeFileSync(pendingPath(), JSON.stringify({ verifier, state, at: Date.now() }), { mode: 0o600 });

  const query = new URLSearchParams({
    fingerprint: fingerprintValue,
    device_name: DEVICE_NAME,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    redirect_uri: REDIRECT_URI,
  });

  return `${BASE}/mobile-authorization?${query.toString()}`;
};

/**
 * Signs one request the way the app does: the payload is the timestamp, the
 * nonce, the method, the path with its query, and the raw body.
 */
const signedHeaders = async (
  /** @type {string} */ method,
  /** @type {string} */ path,
  /** @type {string} */ body,
) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const payload = `${timestamp}\n${nonce}\n${method.toUpperCase()}\n${path}\n${body}`;

  const scratch = join(tmpdir(), `devnull-sign-${nonce}`);
  writeFileSync(scratch, payload, { mode: 0o600 });

  try {
    await run("ssh-keygen", ["-Y", "sign", "-n", NAMESPACE, "-f", keyPath(), scratch], { timeout: 60000 });
    const signature = readFileSync(`${scratch}.sig`, "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("-----"))
      .join("");
    return {
      "X-Devnull-Timestamp": timestamp,
      "X-Devnull-Nonce": nonce,
      "X-SSH-Signature": signature,
    };
  } catch (error) {
    throw new Error(`could not sign the request: ${stderrOf(error) || "ssh-keygen failed"}`);
  } finally {
    rmSync(scratch, { force: true });
    rmSync(`${scratch}.sig`, { force: true });
  }
};

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} payload
 */
const call = async (method, path, payload = null) => {
  if (!hasDevice()) throw new Error("no device yet");
  const body = payload === null ? "" : JSON.stringify(payload);
  const headers = await signedHeaders(method, path, body);

  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body } : {}),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const code = parsed?.code;
    const message = parsed?.message ?? `dev/null answered ${response.status}`;
    if (code === "device_not_approved") throw new Error("this device is no longer approved");
    throw new Error(message);
  }

  return parsed;
};

/** @param {string} input a `devnull://` URL, with `?code=…`, or the code itself */
export const redeem = async (input) => {
  const trimmed = input.trim();
  let code = trimmed;
  const match = /[?&]code=([A-Za-z0-9]+)/.exec(trimmed);
  if (match) code = match[1];
  if (!/^[A-Za-z0-9]{16,255}$/.test(code)) throw new Error("that is not an approval code");

  if (!existsSync(pendingPath())) throw new Error("start the approval again");
  const pending = JSON.parse(readFileSync(pendingPath(), "utf8"));

  const user = await call("POST", "/api/v1/devices", { code, code_verifier: pending.verifier });
  rmSync(pendingPath(), { force: true });
  writeFileSync(join(directory(), "device-user.json"), JSON.stringify({ user, at: Date.now() }), { mode: 0o600 });
  return user;
};

export const me = async () => call("GET", "/api/v1/me");

/** @param {string} commitId */
export const star = async (commitId) => call("POST", `/api/v1/commits/${commitId}/star`);

/** @param {string} commitId */
export const unstar = async (commitId) => call("DELETE", `/api/v1/commits/${commitId}/star`);

/** @param {string} commitId */
export const remove = async (commitId) => call("DELETE", `/api/v1/commits/${commitId}`);

/** @param {string} username */
export const follow = async (username) => call("POST", `/api/v1/users/${encodeURIComponent(username)}/follow`);

/** @param {string} username */
export const unfollow = async (username) => call("DELETE", `/api/v1/users/${encodeURIComponent(username)}/follow`);
