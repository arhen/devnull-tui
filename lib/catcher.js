// @ts-check
// The approval page sends the code to devnull://device?code=…, and a desktop
// with no handler for that scheme drops it: Chrome shows nothing at all. So the
// pane registers one for the few minutes the approval takes — an AppleScript
// applet on macOS, a .desktop scheme handler on Linux — which appends the URL
// it is handed to a file the pane polls, and then removes it again.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const SCHEME = "devnull";
const BUNDLE_ID = "dev.devnull.herdr.catcher";
const APP_NAME = "DevnullHerdr";
const DESKTOP_NAME = "devnull-herdr.desktop";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const stateRoot = () =>
  process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.HOME ?? ".", ".cache", "herdr-devnull");

const codePath = () => join(stateRoot(), "device-code.txt");
const scriptPath = () => join(stateRoot(), "catch-code.sh");
const appPath = () => join(homedir(), "Applications", `${APP_NAME}.app`);
const desktopPath = () => join(homedir(), ".local", "share", "applications", DESKTOP_NAME);
const mimeappsPath = () => join(homedir(), ".config", "mimeapps.list");

// Both are Herdr's platforms. The override is for tests that cannot switch OS.
const platform = () => process.env.DEVNULL_CATCHER_PLATFORM || process.platform;

/** Platform support: both are Herdr's platforms. */
export const supported = () => platform() === "darwin" || platform() === "linux";

const attempt = async (/** @type {string} */ command, /** @type {string[]} */ args) => {
  try {
    return await run(command, args, { timeout: 20000 });
  } catch {
    return null;
  }
};

/** The one file both handlers run: whichever URL arrives goes in the code file. */
const writeCatcher = () => {
  mkdirSync(stateRoot(), { recursive: true });
  const script = scriptPath();
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${codePath()}"\n`, { mode: 0o700 });
  chmodSync(script, 0o700);
};

const installMac = async () => {
  const app = appPath();
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(homedir(), "Applications"), { recursive: true });

  const appleScript = [
    "on open location theURL",
    `  do shell script "/bin/sh " & quoted form of "${scriptPath()}" & " " & quoted form of theURL`,
    "  quit",
    "end open location",
  ].flatMap((line) => ["-e", line]);

  if (!(await attempt("osacompile", ["-o", app, ...appleScript]))) return false;

  const plist = join(app, "Contents", "Info.plist");
  const commands = [
    `Delete :CFBundleURLTypes`,
    `Set :CFBundleIdentifier ${BUNDLE_ID}`,
    `Add :CFBundleURLTypes array`,
    `Add :CFBundleURLTypes:0 dict`,
    `Add :CFBundleURLTypes:0:CFBundleURLName string devnull.device`,
    `Add :CFBundleURLTypes:0:CFBundleURLSchemes array`,
    `Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${SCHEME}`,
  ];
  for (const command of commands) await attempt("/usr/libexec/PlistBuddy", ["-c", command, plist]);

  return Boolean(await attempt(LSREGISTER, ["-f", app]));
};

const installLinux = async () => {
  const desktop = desktopPath();
  mkdirSync(join(homedir(), ".local", "share", "applications"), { recursive: true });
  writeFileSync(
    desktop,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=/dev/null approval for Herdr",
      `Exec=/bin/sh ${scriptPath()} %u`,
      "NoDisplay=true",
      "Terminal=false",
      `MimeType=x-scheme-handler/${SCHEME};`,
      "",
    ].join("\n"),
  );
  const set = await attempt("xdg-mime", ["default", DESKTOP_NAME, `x-scheme-handler/${SCHEME}`]);
  if (set) return true;
  // No xdg-mime: the same default, written where the desktop reads it.
  const file = mimeappsPath();
  const line = `x-scheme-handler/${SCHEME}=${DESKTOP_NAME}`;
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "[Default Applications]\n";
  const kept = existing
    .split("\n")
    .filter((row) => row.trim() && !row.startsWith(`x-scheme-handler/${SCHEME}=`));
  const header = kept.some((row) => row.startsWith("[")) ? [] : ["[Default Applications]"];
  mkdirSync(join(homedir(), ".config"), { recursive: true });
  writeFileSync(file, [...header, ...kept, line, ""].join("\n"));
  return true;
};

let installed = false;

/**
 * Registers the handler for this approval. Resolves false when the platform has
 * no way to do it, and the pane falls back to pasting the code.
 */
export async function install() {
  if (!supported()) return false;
  rmSync(codePath(), { force: true });
  writeCatcher();
  installed = platform() === "darwin" ? await installMac() : await installLinux();
  if (installed && platform() === "linux") {
    await attempt("update-desktop-database", [join(homedir(), ".local", "share", "applications")]);
  }
  if (!installed) await remove();
  return installed;
}

export async function remove() {
  rmSync(scriptPath(), { force: true });
  rmSync(codePath(), { force: true });
  if (platform() === "darwin") {
    await attempt(LSREGISTER, ["-u", appPath()]);
    rmSync(appPath(), { recursive: true, force: true });
  } else if (platform() === "linux") {
    rmSync(desktopPath(), { force: true });
    const file = mimeappsPath();
    if (existsSync(file)) {
      const kept = readFileSync(file, "utf8")
        .split("\n")
        .filter((row) => !row.startsWith(`x-scheme-handler/${SCHEME}=`));
      writeFileSync(file, kept.join("\n"));
    }
    await attempt("update-desktop-database", [join(homedir(), ".local", "share", "applications")]);
  }
  installed = false;
}

/**
 * The URL the handler caught, or null when the approval took too long or the
 * user asked to paste the code instead.
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 */
export async function waitForCode({ timeoutMs = 300_000, signal } = {}) {
  if (!installed) return null;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal?.aborted) return null;
    if (existsSync(codePath())) {
      const caught = readFileSync(codePath(), "utf8").trim().split("\n").pop() ?? "";
      if (/[?&]code=/.test(caught)) return caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}
