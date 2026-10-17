/**
 * profile-bootstrap.mjs — copy the system browser's real login state into this
 * plugin's own profile, then trim it down to an allowlist (contract §4.1/§4.3).
 *
 * Shape of the operation (see CONTRACT.md §2):
 *  - the source browser profile is ONLY ever read (Local State + the cookie
 *    store + SQLite sidecars); nothing is written, moved or cleaned there;
 *  - at most three small files are copied into `<home>/profile` — never the
 *    whole multi-hundred-MB user-data-dir;
 *  - the copied profile is booted with the *source* browser binary (App-Bound
 *    Encrypted v20 cookies decrypt under the genuine executable — measured),
 *    every cookie outside the allowlist is deleted over CDP, the deletion is
 *    re-read to verify, then the browser is closed gracefully so Chrome flushes
 *    cookies.sqlite;
 *  - cookie VALUES never appear in reports/logs/evidence: only names, domains,
 *    paths and value lengths.
 *
 * Pure ESM, no external dependencies, Node >= 22.
 */

import { execFile as execFileCallback } from "node:child_process";
import { constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  connectBrowserCdp,
  cookieStats,
  getCookies,
  trimCookies,
  withProfileCdp,
} from "./local-cdp.mjs";

const execFile = promisify(execFileCallback);

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Default data home for this plugin (contract §3). */
export const DEFAULT_HOME = "E:\\AI\\DeepSeek\\data\\dsh-ego-local-browser";

/** Domains worth keeping for the reference workflow (contract §4.1). */
export const DEFAULT_ALLOWLIST = [
  "cityu.edu.hk",
  "exlibrisgroup.com",
  "nih.gov",
  "google.com",
  "google.com.hk",
];

/**
 * Hard data boundary (contract §2.1): every local-browser directory/file
 * (profile, state, backups, cache, status) must stay under this E: root.
 * resolveLocalPaths() rejects relative/UNC/other-drive/".." escapes.
 */
export const ALLOWED_HOME_ROOT = "E:\\AI\\DeepSeek\\data";

/** How many rotated target-cookie backups to keep (review P1-5: at most 2). */
const BACKUP_KEEP = 2;
/** Browser launch budget for a sync/doctor instance. */
const LAUNCH_TIMEOUT_MS = 30000;

const HINTS = {
  "source-browser-not-found":
    "install Chrome/Edge, or set browserSource/sourceUserDataDir in local-config.json",
  "source-profile-not-found": "check sourceProfileDir; the available profiles are listed in the error message",
  "source-userdata-missing": "point sourceUserDataDir at the browser's \"User Data\" directory",
  "source-locked":
    "fully quit the source browser and retry; the source profile is only ever read",
  "local-state-missing": "launch the source browser once so it writes Local State, then retry",
  "cookies-missing": "visit the sites you want in the source browser first, then retry",
  "copy-failed": "check free space on the home drive and file permissions",
  "backup-failed":
    "check that <home>\\backups is a writable directory on E: and retry (the previous Cookies are NOT overwritten)",
  "cdp-launch-timeout": "close anything else using the target profile and retry",
  "profile-busy":
    "stop the browser or sync that is using the target profile (or wait for it to finish), then retry",
  "cdp-connect-failed": "retry; if it persists, run doctorReport() for diagnostics",
  "trim-failed": "retry the sync; if it persists, run doctorReport() and check target Cookies",
  "invalid-path": `homeDir must be an absolute path inside ${ALLOWED_HOME_ROOT}`,
  internal: "see the message/stack for details",
};


/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * Expand `~` and require an absolute path.
 * Throws (never returns a silently wrong path) — contract: relative homeDir rejected.
 */
function expandPath(rawValue, label = "path") {
  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    throw Object.assign(new Error(`${label} must be a non-empty string`), { code: "invalid-path" });
  }
  let value = rawValue.trim();
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(homedir(), value.slice(2));
  if (!isAbsolute(value)) {
    throw Object.assign(new Error(`${label} must be an absolute path (got "${rawValue}")`), {
      code: "invalid-path",
    });
  }
  return normalize(value);
}

/**
 * Resolve every path this feature uses under one data home.
 *
 * Hard boundary (review P0-2): the home must be an absolute path strictly under
 * ALLOWED_HOME_ROOT. Relative paths, UNC (`\\\\`), other drives (C:/D:/...),
 * paths outside the root and any `..` segment are rejected with `invalid-path`.
 *
 * @returns {{home:string, profileDir:string, stateDir:string, allowlistFile:string,
 *            backupsDir:string, cacheDir:string, localConfigFile:string, statusFile:string}}
 */
export function resolveLocalPaths(homeDir = DEFAULT_HOME) {
  const home = validateHomeDir(homeDir);
  return {
    home,
    profileDir: join(home, "profile"),
    stateDir: join(home, "state"),
    allowlistFile: join(home, "allowlist.json"),
    backupsDir: join(home, "backups"),
    cacheDir: join(home, "cache"),
    localConfigFile: join(home, "local-config.json"),
    statusFile: join(home, "local-browser.json"),
  };
}

function invalidPath(message) {
  return Object.assign(new Error(message), { code: "invalid-path" });
}

/** Normalized, case-insensitive form used for path-boundary comparisons. */
function pathCompareKey(value) {
  return normalize(String(value)).replace(/[\\/]+/g, "\\").toLowerCase();
}

/**
 * Validate + normalize a data home against ALLOWED_HOME_ROOT.
 * Never returns a path outside the root; throws `invalid-path` instead.
 */
function validateHomeDir(homeDir) {
  if (typeof homeDir !== "string" || homeDir.trim() === "") {
    throw invalidPath("homeDir must be a non-empty string");
  }
  const raw = homeDir.trim();
  if (/^(?:\\\\|\/\/)/.test(raw)) {
    throw invalidPath(`homeDir must not be a UNC path (got "${raw}")`);
  }
  if (raw.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw invalidPath(`homeDir must not contain ".." path segments (got "${raw}")`);
  }
  // expandPath() keeps the historical "~"/absolute rules; the root check below
  // then pins the result to E:\AI\DeepSeek\data.
  const home = expandPath(raw, "homeDir");
  const root = normalize(ALLOWED_HOME_ROOT);
  const rootKey = pathCompareKey(root);
  const homeKey = pathCompareKey(home);
  const underRoot = homeKey === rootKey || homeKey.startsWith(rootKey + "\\");
  if (!underRoot) {
    throw invalidPath(`homeDir must be inside ${ALLOWED_HOME_ROOT} (got "${home}")`);
  }
  return home;
}

function pathsOf(paths) {
  return {
    home: paths.home,
    profileDir: paths.profileDir,
    stateDir: paths.stateDir,
    allowlistFile: paths.allowlistFile,
  };
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Allowlist
 * ------------------------------------------------------------------ */

/**
 * Normalize string (newline/comma/semicolon separated, `#` comments) or string[]
 * into a clean domain list: lowercased, no leading dots, deduped.
 * Entries containing whitespace or "*" are rejected with an error (no silent drop).
 */
export function normalizeAllowlist(value) {
  if (value === null || value === undefined) return [];
  /** @type {string[]} */
  let lines;
  if (Array.isArray(value)) {
    lines = value.flatMap((item) => (typeof item === "string" ? item.split(/\r?\n/) : []));
  } else if (typeof value === "string") {
    lines = value.split(/\r?\n/);
  } else {
    throw Object.assign(new Error("allowlist must be a string or an array of strings"), {
      code: "invalid-allowlist",
    });
  }
  const domains = [];
  const seen = new Set();
  for (const line of lines) {
    const withoutComment = line.split("#")[0];
    for (const part of withoutComment.split(/[,;]/)) {
      let domain = part.trim().toLowerCase();
      if (domain === "") continue;
      domain = domain.replace(/^\.+/, "");
      if (domain === "") continue;
      if (/\s/.test(domain) || domain.includes("*")) {
        throw Object.assign(
          new Error(`invalid allowlist entry "${part.trim()}": must not contain whitespace or "*"`),
          { code: "invalid-allowlist-entry" },
        );
      }
      if (seen.has(domain)) continue;
      seen.add(domain);
      domains.push(domain);
    }
  }
  return domains;
}

/**
 * Domain filter: "cityu.edu.hk" matches ".cityu.edu.hk" and any subdomain.
 * An empty allowlist matches everything (contract §4.1).
 */
export function cookieMatchesDomain(cookieDomain, domains) {
  const list = Array.isArray(domains) ? domains : [];
  if (list.length === 0) return true;
  const host = String(cookieDomain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");
  return list.some((raw) => {
    const domain = String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/^\.+/, "");
    return domain !== "" && (host === domain || host.endsWith("." + domain));
  });
}

/**
 * Read `<home>/allowlist.json`; missing or malformed falls back to
 * DEFAULT_ALLOWLIST without writing anything and without throwing.
 * @returns {{domains:string[], file:string, exists:boolean, source:"file"|"default",
 *            mtimeMs:number|null, error?:string}}
 */
export function readAllowlist(allowlistFile) {
  const file = String(allowlistFile ?? "");
  const fallback = () => ({
    domains: [...DEFAULT_ALLOWLIST],
    file,
    exists: false,
    source: "default",
    mtimeMs: null,
  });
  if (!file) return fallback();
  try {
    const stats = statSync(file);
    // A hand-edited allowlist (Notepad/PowerShell 5.1) may carry a UTF-8 BOM.
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text);
    const raw = Array.isArray(parsed) ? parsed : parsed?.domains;
    if (!Array.isArray(raw)) {
      return {
        ...fallback(),
        exists: true,
        mtimeMs: stats.mtimeMs,
        error: `allowlist file has no "domains" array: ${file}`,
      };
    }
    const domains = normalizeAllowlist(raw);
    return {
      domains,
      file,
      exists: true,
      source: "file",
      mtimeMs: stats.mtimeMs,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return fallback();
    const stats = safeStatSync(file);
    const result = {
      domains: [...DEFAULT_ALLOWLIST],
      file,
      exists: stats !== null,
      source: "default",
      mtimeMs: stats ? stats.mtimeMs : null,
      error: String(error?.message ?? error),
    };
    return result;
  }
}

function safeStatSync(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * Write the allowlist as UTF-8 (no BOM) JSON with an ISO `updatedAt`.
 * -> { domains, file }
 */
export async function writeAllowlist(allowlistFile, domains) {
  const file = String(allowlistFile ?? "");
  if (!file) {
    throw Object.assign(new Error("writeAllowlist: allowlistFile is required"), { code: "invalid-path" });
  }
  const normalized = normalizeAllowlist(domains);
  await mkdir(dirname(file), { recursive: true });
  const payload = { domains: normalized, updatedAt: new Date().toISOString() };
  // Atomic replace: a crash mid-write must never leave an unparsable allowlist.
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tmpFile, file);
  return { domains: normalized, file };
}

/* ------------------------------------------------------------------ *
 * Browser detection
 * ------------------------------------------------------------------ */

function compareVersionsDesc(a, b) {
  const pa = a.split(".").map((part) => Number(part) || 0);
  const pb = b.split(".").map((part) => Number(part) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Version from the `<Application>/<version>` directory next to the exe. */
function readExeVersion(exePath) {
  if (!exePath) return null;
  try {
    const entries = readdirSync(dirname(exePath), { withFileTypes: true });
    const versions = entries
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersionsDesc);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  } catch {
    return null;
  }
}

/** Where the stock install keeps `Local State` for a browser id. */
function standardUserDataDir(id, env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const base =
      env.LOCALAPPDATA || (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Local") : "");
    if (!base) return "";
    return id === "edge"
      ? join(base, "Microsoft", "Edge", "User Data")
      : join(base, "Google", "Chrome", "User Data");
  }
  const home = env.HOME || env.USERPROFILE || "";
  if (platform === "darwin") {
    return id === "edge"
      ? join(home, "Library", "Application Support", "Microsoft Edge")
      : join(home, "Library", "Application Support", "Google", "Chrome");
  }
  return id === "edge" ? join(home, ".config", "microsoft-edge") : join(home, ".config", "google-chrome");
}

/** Executable candidates in probe order (override first, then standard installs). */
function exeCandidates(id, env = process.env, platform = process.platform, overridePath = "") {
  const list = [];
  if (overridePath) list.push(overridePath);
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pfx = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const lad = env.LOCALAPPDATA || "";
    if (id === "chrome") {
      list.push(join(pf, "Google", "Chrome", "Application", "chrome.exe"));
      list.push(join(pfx, "Google", "Chrome", "Application", "chrome.exe"));
      if (lad) list.push(join(lad, "Google", "Chrome", "Application", "chrome.exe"));
    } else {
      list.push(join(pfx, "Microsoft", "Edge", "Application", "msedge.exe"));
      list.push(join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
      if (lad) list.push(join(lad, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (platform === "darwin") {
    list.push(
      id === "edge"
        ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else if (id === "chrome") {
    list.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  } else {
    list.push("/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable");
  }
  return [...new Set(list)];
}

function inferBrowserIdFromBinary(binaryPath) {
  const name = basename(String(binaryPath || "")).toLowerCase();
  if (name.includes("msedge") || name.includes("edge")) return "edge";
  return "chrome";
}

/**
 * Where would the user data live for this executable?
 *
 * Known vendor installs (Program Files / LOCALAPPDATA) keep `User Data` under
 * LOCALAPPDATA, so the standard location wins. A portable layout
 * `<root>/Application/chrome.exe` + `<root>/User Data` is honored when its
 * `Local State` actually exists; otherwise fall back to the standard path.
 */
function inferUserDataDirFromExe(exePath, id, env = process.env, platform = process.platform) {
  const standard = standardUserDataDir(id, env, platform);
  const exeDir = dirname(String(exePath || ""));
  const knownMarkers =
    platform === "win32"
      ? ["\\google\\chrome\\application", "\\microsoft\\edge\\application", "\\bravesoftware\\"]
      : ["/google/chrome", "/microsoft edge", "/brave-browser"];
  const lower = exeDir.toLowerCase();
  if (knownMarkers.some((marker) => lower.includes(marker))) return standard;
  try {
    if (basename(exeDir).toLowerCase() === "application") {
      const candidate = join(dirname(exeDir), "User Data");
      if (existsSync(join(candidate, "Local State"))) return candidate;
    }
    const sibling = join(exeDir, "User Data");
    if (existsSync(join(sibling, "Local State"))) return sibling;
  } catch {
    // fall through to the standard location
  }
  return standard;
}

/**
 * Installed Chromium-family browsers with a usable profile, Chrome first.
 * -> [{ id, label, exePath, userDataDir, version, exeExists, userDataExists }]
 *
 * `env.browserBinary` (an injected config field, not a real env var) overrides
 * the executable for its inferred browser id.
 */
export function detectBrowsers(env = process.env, platform = process.platform) {
  const safeEnv = env && typeof env === "object" ? env : process.env;
  const override = typeof safeEnv.browserBinary === "string" ? safeEnv.browserBinary.trim() : "";
  const overrideId = override ? inferBrowserIdFromBinary(override) : "";
  const result = [];
  for (const id of ["chrome", "edge"]) {
    const isOverridden = overrideId === id && Boolean(override);
    const userDataDir = isOverridden
      ? inferUserDataDirFromExe(override, id, safeEnv, platform)
      : standardUserDataDir(id, safeEnv, platform);
    const candidates = exeCandidates(id, safeEnv, platform, isOverridden ? override : "");
    const existing = candidates.find((candidate) => candidate && existsSync(candidate));
    const exePath = existing || candidates[0] || "";
    const exeExists = Boolean(existing);
    const userDataExists = Boolean(userDataDir) && existsSync(join(userDataDir, "Local State"));
    if (!exeExists && !userDataExists && !isOverridden) continue;
    result.push({
      id,
      label: id === "edge" ? "Microsoft Edge" : "Google Chrome",
      exePath: isOverridden ? override : exePath,
      userDataDir,
      version: readExeVersion(isOverridden ? override : exePath),
      exeExists: isOverridden ? existsSync(override) : exeExists,
      userDataExists,
    });
  }
  return result;
}

/**
 * Parse `<userDataDir>/Local State` -> profile list, falling back to Default.
 * -> [{ dirName, name, lastUsed, isDefault }]
 */
export function readBrowserProfiles(userDataDir) {
  const fallback = () => [{ dirName: "Default", name: "Default", lastUsed: false, isDefault: true }];
  try {
    if (!userDataDir) return fallback();
    const text = readFileSync(join(String(userDataDir), "Local State"), "utf8");
    const parsed = JSON.parse(text);
    const lastUsedDir = typeof parsed?.profile?.last_used === "string" ? parsed.profile.last_used : null;
    const cache = parsed?.profile?.info_cache;
    if (!cache || typeof cache !== "object") return fallback();
    const profiles = Object.entries(cache)
      .filter(([, info]) => info && typeof info === "object")
      .map(([dirName, info]) => ({
        dirName,
        name: typeof info.name === "string" && info.name !== "" ? info.name : dirName,
        lastUsed: dirName === lastUsedDir,
        isDefault: dirName === "Default",
      }));
    return profiles.length > 0 ? profiles : fallback();
  } catch {
    return fallback();
  }
}

/* ------------------------------------------------------------------ *
 * Source resolution
 * ------------------------------------------------------------------ */

/**
 * Pick the source browser/profile to copy from.
 * -> { ok:true, browser, profile:{dirName,name}, warnings:[] }
 *  | { ok:false, error:{code,message,hint}, detected:[] }
 */
export async function resolveSource(opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const rawSource = String(options.browserSource ?? "auto").trim().toLowerCase();
  const browserSource = rawSource === "chrome" || rawSource === "edge" ? rawSource : "auto";
  const browserBinary = typeof options.browserBinary === "string" ? options.browserBinary.trim() : "";
  const detected = detectBrowsers({ ...process.env, browserBinary });

  if (browserBinary && !existsSync(browserBinary)) {
    return {
      ok: false,
      error: {
        code: "source-browser-not-found",
        message: `configured browserBinary does not exist: ${browserBinary}`,
        hint: "fix browserBinary in local-config.json, or clear it to auto-detect Chrome/Edge",
      },
      detected,
    };
  }

  const browser = browserSource === "auto" ? detected[0] : detected.find((entry) => entry.id === browserSource);
  if (!browser) {
    return {
      ok: false,
      error: {
        code: "source-browser-not-found",
        message:
          browserSource === "auto"
            ? "no Chrome/Edge installation with a profile was found"
            : `no usable ${browserSource} installation/profile was found`,
        hint: HINTS["source-browser-not-found"],
      },
      detected,
    };
  }

  let userDataDir = browser.userDataDir;
  if (typeof options.sourceUserDataDir === "string" && options.sourceUserDataDir.trim() !== "") {
    try {
      userDataDir = expandPath(options.sourceUserDataDir, "sourceUserDataDir");
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "source-userdata-missing",
          message: error.message,
          hint: HINTS["source-userdata-missing"],
        },
        detected,
      };
    }
    if (!existsSync(userDataDir)) {
      return {
        ok: false,
        error: {
          code: "source-userdata-missing",
          message: `sourceUserDataDir does not exist: ${userDataDir}`,
          hint: HINTS["source-userdata-missing"],
        },
        detected,
      };
    }
  }
  if (!userDataDir || !existsSync(userDataDir)) {
    return {
      ok: false,
      error: {
        code: "source-userdata-missing",
        message: `source user-data directory is missing: ${userDataDir || "(none)"}`,
        hint: HINTS["source-userdata-missing"],
      },
      detected,
    };
  }
  const localStatePath = join(userDataDir, "Local State");
  if (!existsSync(localStatePath)) {
    return {
      ok: false,
      error: {
        code: "source-userdata-missing",
        message: `no Local State under source user-data directory: ${userDataDir}`,
        hint: HINTS["source-userdata-missing"],
      },
      detected,
    };
  }
  if (!browser.exePath || !existsSync(browser.exePath)) {
    return {
      ok: false,
      error: {
        code: "source-browser-not-found",
        message: `browser executable not found: ${browser.exePath || "(none)"}; cannot decrypt App-Bound cookies without the genuine binary`,
        hint: HINTS["source-browser-not-found"],
      },
      detected,
    };
  }

  const profiles = readBrowserProfiles(userDataDir);
  const warnings = [];
  let profile = null;
  /** Why this profile was picked: 'requested' | 'last-used' | 'default' | 'first-profile'. */
  let selectionReason = "default";
  const wantedProfile = typeof options.sourceProfileDir === "string" ? options.sourceProfileDir.trim() : "";
  if (wantedProfile) {
    let wantedPath = "";
    try {
      wantedPath = expandPath(wantedProfile, "sourceProfileDir");
    } catch {
      wantedPath = "";
    }
    profile =
      profiles.find((entry) => entry.dirName === wantedProfile) ||
      profiles.find((entry) => entry.name === wantedProfile) ||
      (wantedPath
        ? profiles.find(
            (entry) =>
              normalize(join(userDataDir, entry.dirName)).toLowerCase() === wantedPath.toLowerCase(),
          )
        : null) ||
      (wantedPath && normalize(wantedPath).toLowerCase() === normalize(userDataDir).toLowerCase()
        ? profiles.find((entry) => entry.isDefault)
        : null);
    if (!profile) {
      return {
        ok: false,
        error: {
          code: "source-profile-not-found",
          message: `profile "${wantedProfile}" was not found in ${userDataDir}`,
          hint: `available profiles: ${profiles.map((entry) => entry.dirName).join(", ")}`,
        },
        detected,
      };
    }
    selectionReason = "requested";
  } else {
    // Contract: follow the browser's own `profile.last_used` first, then fall
    // back to Default, then to whatever profile exists (review P1-3).
    profile = profiles.find((entry) => entry.lastUsed === true) || null;
    if (profile) {
      selectionReason = "last-used";
    } else {
      profile = profiles.find((entry) => entry.isDefault) || null;
      if (profile) {
        selectionReason = "default";
      } else {
        profile = profiles[0];
        selectionReason = "first-profile";
        warnings.push(`no recently used or Default profile in ${userDataDir}; using "${profile.dirName}" instead`);
      }
    }
  }

  const profileDir = join(userDataDir, profile.dirName);
  if (!existsSync(profileDir)) {
    return {
      ok: false,
      error: {
        code: "source-profile-not-found",
        message: `profile directory is missing: ${profileDir}`,
        hint: HINTS["source-profile-not-found"],
      },
      detected,
    };
  }

  return {
    ok: true,
    browser: {
      id: browser.id,
      label: browser.label,
      exePath: browser.exePath,
      userDataDir,
      version: browser.version ?? null,
    },
    profile: { dirName: profile.dirName, name: profile.name },
    selectionReason,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * Source busy probing
 * ------------------------------------------------------------------ */

function parsePids(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function powershellQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Main browser processes on the source profile (helpers carry --type=/crashpad and are skipped). */
async function findSourceBrowserPids(browser) {
  const id = browser?.id === "edge" ? "edge" : "chrome";
  const exeBase = browser?.exePath ? basename(browser.exePath) : id === "edge" ? "msedge.exe" : "chrome.exe";
  const userDataDir = String(browser?.userDataDir ?? "").replace(/[\\/]+$/, "");

  if (process.platform === "win32") {
    const exeName = exeBase.toLowerCase().endsWith(".exe") ? exeBase : `${exeBase}.exe`;
    const defaultDir = standardUserDataDir(id, process.env, "win32");
    const isDefaultProfile =
      userDataDir !== "" &&
      defaultDir !== "" &&
      userDataDir.toLowerCase() === defaultDir.replace(/[\\/]+$/, "").toLowerCase();
    const clauses = [];
    if (userDataDir) {
      clauses.push(`$_.CommandLine -match [regex]::Escape(${powershellQuoted(userDataDir)})`);
    }
    if (isDefaultProfile) {
      clauses.push(`$_.CommandLine -notmatch '--user-data-dir='`);
    }
    const filter = clauses.length > 0 ? `(${clauses.join(" -or ")})` : "$true";
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" ` +
      `| Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' -and ${filter} } ` +
      `| Select-Object -ExpandProperty ProcessId`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const { stdout } = await execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: 15000, windowsHide: true },
    );
    return parsePids(stdout);
  }

  const exeName = exeBase.replace(/\.exe$/i, "");
  try {
    const { stdout } = await execFile("pgrep", ["-x", exeName], { timeout: 10000 });
    return parsePids(stdout);
  } catch (error) {
    if (error?.code === 1) return [];
    throw error;
  }
}

/**
 * Is the source browser currently running on its profile?
 * Never throws: any probe failure degrades to { busy:false, pids:[], method:'none' }.
 * -> { busy, pids, lockFiles, method:'process'|'files'|'none' }
 */
export async function probeSourceBusy(browser) {
  const result = { busy: false, pids: [], lockFiles: [], method: "none" };
  if (!browser || typeof browser !== "object") return result;
  const userDataDir = typeof browser.userDataDir === "string" ? browser.userDataDir : "";

  let fileCheckOk = false;
  if (userDataDir) {
    try {
      for (const name of ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        const candidate = join(userDataDir, name);
        // lstat, not access: a dangling SingletonLock symlink still means "was
        // running"; access() would follow the link and report ENOENT.
        try {
          await lstat(candidate);
          result.lockFiles.push(candidate);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      fileCheckOk = true;
    } catch {
      fileCheckOk = false;
    }
  }

  let pidsOk = false;
  try {
    result.pids = await findSourceBrowserPids(browser);
    pidsOk = true;
  } catch {
    result.pids = [];
  }

  result.method = pidsOk ? "process" : fileCheckOk ? "files" : "none";
  result.busy = result.pids.length > 0 || result.lockFiles.length > 0;
  return result;
}

/* ------------------------------------------------------------------ *
 * Target-profile helpers
 * ------------------------------------------------------------------ */

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Snapshot the previous target cookie store into `<home>/backups/<stamp>/Cookies`. */
async function backupTargetCookies(paths, targetCookies) {
  const dir = join(paths.backupsDir, `cookies-${timestampForPath()}`);
  await mkdir(dir, { recursive: true });
  const destination = join(dir, "Cookies");
  await copyFile(targetCookies, destination);
  const stats = await stat(destination);
  await pruneBackups(paths.backupsDir, BACKUP_KEEP);
  return { path: destination, bytes: stats.size };
}

/** Keep only the newest N cookie backups. */
async function pruneBackups(backupsDir, keep) {
  try {
    const entries = (await readdir(backupsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^cookies-/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
      await rm(join(backupsDir, name), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // pruning is best effort
  }
}

/** Recursively total a small directory tree (profile sizes are single-digit MB). */
async function directoryStats(root) {
  let totalBytes = 0;
  let fileCount = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      try {
        const stats = await stat(entryPath);
        totalBytes += stats.size;
        fileCount += 1;
      } catch {
        // vanished mid-walk
      }
      if (fileCount > 20000) return { totalBytes, fileCount };
    }
  }
  return { totalBytes, fileCount };
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

function reportBase(startedAt, startedMs) {
  return { startedAt, durationMs: Date.now() - startedMs };
}

function failureReport(startedAt, startedMs, code, message, hint, extra = {}) {
  return {
    ok: false,
    ...reportBase(startedAt, startedMs),
    error: { code, message, hint: hint || HINTS[code] || HINTS.internal },
    ...extra,
  };
}

function optionalStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Size+mtime fingerprint used to prove the source did not change while copying. */
function fileFingerprint(path) {
  const stats = optionalStat(path);
  return stats ? { bytes: stats.size, mtimeMs: stats.mtimeMs } : null;
}

function fingerprintsEqual(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.bytes === right.bytes &&
    left.mtimeMs === right.mtimeMs
  );
}

/**
 * Full sync: resolve source -> probe busy -> validate -> backup -> minimal copy
 * -> boot copied profile -> trim non-allowlisted cookies -> verify -> graceful
 * close -> persist status.
 *
 * opts: { homeDir, browserSource, browserBinary, sourceUserDataDir,
 *         sourceProfileDir, allowLiveCopy=false, log=(msg)=>{} }
 *
 * `allowLiveCopy` defaults to FALSE (review P1-6): a running source browser is
 * refused unless the caller explicitly opts in, and even then the source files
 * are fingerprinted before/after the copy — a mismatch (or a non-empty SQLite
 * sidecar) is reported as `source-locked` instead of silently copying a
 * half-written cookie store.
 *
 * -> SyncReport | SyncErrorReport (contract §4.3)
 */
export async function syncProfile(opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const log = typeof options.log === "function" ? options.log : () => {};
  const allowLiveCopy = options.allowLiveCopy === true;

  let paths;
  try {
    paths = resolveLocalPaths(options.homeDir || DEFAULT_HOME);
  } catch (error) {
    const code = error?.code === "invalid-path" ? "invalid-path" : "internal";
    return failureReport(startedAt, startedMs, code, `invalid homeDir: ${error.message}`, HINTS[code], {
      paths: null,
      copied: [],
    });
  }

  let source = null;
  const copied = [];
  const warnings = [];

  try {
    const allowRead = readAllowlist(paths.allowlistFile);
    if (allowRead.error) {
      warnings.push(
        `allowlist.json could not be read (${allowRead.error}); falling back to DEFAULT_ALLOWLIST`,
      );
    }
    const allowlist = allowRead.domains;
    if (allowlist.length === 0) {
      warnings.push("allowlist is empty — every cookie in the source profile will be kept");
    }
    log(`[sync] allowlist (${allowRead.source}): ${allowlist.join(", ") || "(empty)"}`);

    /* 1. resolve source -------------------------------------------------- */
    const resolved = await resolveSource({
      browserSource: options.browserSource ?? "auto",
      browserBinary: options.browserBinary ?? "",
      sourceUserDataDir: options.sourceUserDataDir ?? "",
      sourceProfileDir: options.sourceProfileDir ?? "",
    });
    if (!resolved.ok) {
      return failureReport(
        startedAt,
        startedMs,
        resolved.error.code,
        resolved.error.message,
        resolved.error.hint,
        { detected: resolved.detected ?? [], paths: pathsOf(paths), copied },
      );
    }
    const browser = resolved.browser;
    warnings.push(...(resolved.warnings || []));
    log(
      `[sync] source: ${browser.label} ${browser.version ?? "?"} (${browser.exePath}) ` +
        `profile=${resolved.profile.dirName} (${resolved.selectionReason ?? "unknown"})`,
    );

    /* 2. busy probe (the source is only ever read) ----------------------- */
    const busy = await probeSourceBusy(browser);
    source = {
      browser: {
        id: browser.id,
        label: browser.label,
        exePath: browser.exePath,
        version: browser.version ?? null,
        userDataDir: browser.userDataDir,
      },
      profile: { dirName: resolved.profile.dirName, name: resolved.profile.name },
      selectionReason: resolved.selectionReason ?? null,
      busy,
    };
    if (busy.busy) {
      const detail =
        busy.pids.length > 0
          ? `pids ${busy.pids.join(",")}`
          : `lock files ${busy.lockFiles.map((file) => basename(file)).join(",")}`;
      if (!allowLiveCopy) {
        return failureReport(
          startedAt,
          startedMs,
          "source-locked",
          `source browser is running (${detail}) and allowLiveCopy=false`,
          HINTS["source-locked"],
          { source, paths: pathsOf(paths), copied },
        );
      }
      warnings.push(
        `source browser is running (${detail}) — live copy explicitly allowed; the copy is fingerprint-checked and aborts if the source changes mid-copy`,
      );
      log(`[sync] warning: source browser is running (${detail})`);
    }

    /* 3. validate source files ------------------------------------------ */
    const sourceProfileDir = join(browser.userDataDir, resolved.profile.dirName);
    const sourceLocalState = join(browser.userDataDir, "Local State");
    const sourceCookies = join(sourceProfileDir, "Network", "Cookies");
    if (!(await exists(sourceLocalState))) {
      return failureReport(
        startedAt,
        startedMs,
        "local-state-missing",
        `source profile has no Local State: ${sourceLocalState}`,
        HINTS["local-state-missing"],
        { source, paths: pathsOf(paths), copied },
      );
    }
    if (!(await exists(sourceCookies))) {
      return failureReport(
        startedAt,
        startedMs,
        "cookies-missing",
        `source profile has no cookie store: ${sourceCookies}`,
        HINTS["cookies-missing"],
        { source, paths: pathsOf(paths), copied },
      );
    }
    // Source SQLite sidecars: a NON-EMPTY -wal/-shm/-journal means the source
    // cookie store has an in-flight transaction and no consistent snapshot can
    // be guaranteed, so refuse (review P1-6). Empty sidecars are clean-shutdown
    // checkpoints that carry no data — ignored, and never copied.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = sourceCookies + suffix;
      const sidecarStat = optionalStat(sidecar);
      if (sidecarStat && sidecarStat.size > 0) {
        return failureReport(
          startedAt,
          startedMs,
          "source-locked",
          `source cookie store has a non-empty Cookies${suffix} (${sidecarStat.size} B): ` +
            `the source browser is mid-write / was not cleanly closed, so a consistent snapshot cannot be guaranteed`,
          HINTS["source-locked"],
          { source, paths: pathsOf(paths), copied },
        );
      }
    }

    /* 4. back up the previous target cookie store (fatal on failure) ----- */
    const targetCookies = join(paths.profileDir, "Default", "Network", "Cookies");
    let backup = null;
    if (await exists(targetCookies)) {
      try {
        backup = await backupTargetCookies(paths, targetCookies);
        log(`[sync] backed up previous target Cookies -> ${backup.path} (${backup.bytes} B)`);
      } catch (error) {
        // Never overwrite a store we could not back up (review P1-5).
        return failureReport(
          startedAt,
          startedMs,
          "backup-failed",
          `could not back up the previous target Cookies (${targetCookies}): ` +
            `${error?.message ?? error}; refusing to overwrite it`,
          HINTS["backup-failed"],
          { source, paths: pathsOf(paths), copied },
        );
      }
    }

    /* 5. clean stale transient files, then minimal copy ----------------- */
    try {
      await mkdir(join(paths.profileDir, "Default", "Network"), { recursive: true });
    } catch (error) {
      return failureReport(
        startedAt,
        startedMs,
        "copy-failed",
        `cannot create target profile directories: ${error?.message ?? error}`,
        HINTS["copy-failed"],
        { source, paths: pathsOf(paths), copied },
      );
    }
    const staleTargetFiles = [
      join(paths.profileDir, "DevToolsActivePort"),
      join(paths.profileDir, "SingletonLock"),
      join(paths.profileDir, "SingletonCookie"),
      join(paths.profileDir, "SingletonSocket"),
      join(paths.profileDir, "lockfile"),
      join(paths.profileDir, "Default", "Network", "Cookies-journal"),
      join(paths.profileDir, "Default", "Network", "Cookies-wal"),
      join(paths.profileDir, "Default", "Network", "Cookies-shm"),
    ];
    for (const stale of staleTargetFiles) {
      await rm(stale, { force: true }).catch(() => {});
    }

    // Fingerprint the two source files immediately before the copy so a source
    // that is written during the copy window (live browser, another sync) is
    // detected instead of silently producing a torn cookie store.
    const sourceSnapshotBefore = {
      localState: fileFingerprint(sourceLocalState),
      cookies: fileFingerprint(sourceCookies),
    };

    const transfers = [
      { name: "Local State", from: sourceLocalState, to: join(paths.profileDir, "Local State") },
      { name: "Cookies", from: sourceCookies, to: targetCookies },
    ];
    for (const transfer of transfers) {
      try {
        await copyFile(transfer.from, transfer.to);
      } catch (error) {
        const code = error?.code;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
          return failureReport(
            startedAt,
            startedMs,
            "source-locked",
            `cannot copy ${transfer.name}: ${code} (${error?.message ?? error})`,
            HINTS["source-locked"],
            { source, paths: pathsOf(paths), copied },
          );
        }
        return failureReport(
          startedAt,
          startedMs,
          "copy-failed",
          `copy ${transfer.name} failed: ${code ? `${code} ` : ""}${error?.message ?? error}`,
          HINTS["copy-failed"],
          { source, paths: pathsOf(paths), copied },
        );
      }
      const stats = await stat(transfer.to);
      copied.push({ name: transfer.name, from: transfer.from, to: transfer.to, bytes: stats.size });
      log(`[sync] copied ${transfer.name} -> ${transfer.to} (${stats.size} B)`);
    }

    // Consistency gate (review P1-6): both source files must be untouched for
    // the whole copy window, otherwise the copy is not a coherent snapshot.
    const sourceSnapshotAfter = {
      localState: fileFingerprint(sourceLocalState),
      cookies: fileFingerprint(sourceCookies),
    };
    if (
      !fingerprintsEqual(sourceSnapshotBefore.localState, sourceSnapshotAfter.localState) ||
      !fingerprintsEqual(sourceSnapshotBefore.cookies, sourceSnapshotAfter.cookies)
    ) {
      return failureReport(
        startedAt,
        startedMs,
        "source-locked",
        `source files changed while being copied (Local State ` +
          `${JSON.stringify(sourceSnapshotBefore.localState)} -> ${JSON.stringify(sourceSnapshotAfter.localState)}, ` +
          `Cookies ${JSON.stringify(sourceSnapshotBefore.cookies)} -> ${JSON.stringify(sourceSnapshotAfter.cookies)}); ` +
          `a consistent snapshot cannot be guaranteed`,
        HINTS["source-locked"],
        {
          source,
          paths: pathsOf(paths),
          copied,
          snapshotConsistent: false,
        },
      );
    }
    log("[sync] source fingerprint stable across the copy window");

    /* 6. boot the copied profile and trim over CDP ---------------------- */
    let cookies = null;
    let trim = null;
    try {
      const outcome = await withProfileCdp(
        {
          exePath: browser.exePath,
          profileDir: paths.profileDir,
          headless: true,
          timeoutMs: LAUNCH_TIMEOUT_MS,
        },
        async ({ cdp, port }) => {
          log(`[sync] target CDP ready on 127.0.0.1:${port}`);
          const allCookies = await getCookies(cdp);
          const stats = cookieStats(allCookies, allowlist);
          log(
            `[sync] read ${stats.total} cookies (empty ${stats.empty}, allowlisted ${stats.kept})`,
          );
          const trimResult = await trimCookies(cdp, allowlist);
          log(
            `[sync] trim: ${trimResult.deleted} deleted, ${trimResult.totalAfter} left, ` +
              `${trimResult.remainingNonAllowlisted} non-allowlisted remaining, ${trimResult.failures} failures`,
          );
          // A short settle before Browser.close helps the cookie store flush.
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { stats, trim: trimResult };
        },
      );
      cookies = outcome.stats;
      trim = outcome.trim;
    } catch (error) {
      const passThroughCodes = new Set(["cdp-launch-timeout", "cdp-connect-failed", "profile-busy"]);
      const code = passThroughCodes.has(error?.code) ? error.code : "trim-failed";
      return failureReport(
        startedAt,
        startedMs,
        code,
        error?.message ?? String(error),
        error?.hint ?? HINTS[code],
        { source, paths: pathsOf(paths), copied },
      );
    }

    if (trim.remainingNonAllowlisted > 0) {
      warnings.push(
        `${trim.remainingNonAllowlisted} non-allowlisted cookie(s) remained after trimming`,
      );
    }
    if (trim.failures > 0) {
      warnings.push(`${trim.failures} cookie deletion(s) reported a failure`);
    }

    /* 7. persist status -------------------------------------------------- */
    const finishedAt = new Date().toISOString();
    const report = {
      ok: true,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      paths: pathsOf(paths),
      source,
      copied,
      backup: backup ? { path: backup.path, bytes: backup.bytes } : null,
      snapshotConsistent: true,
      allowlist,
      cookies,
      trim,
      warnings,
      lastSyncAt: finishedAt,
    };
    try {
      await mkdir(paths.home, { recursive: true });
      await mkdir(paths.stateDir, { recursive: true });
      // Atomic replace so a crash never leaves a half-written status JSON.
      const statusTmp = `${paths.statusFile}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(statusTmp, JSON.stringify(report, null, 2) + "\n", "utf8");
      await rename(statusTmp, paths.statusFile);
    } catch (error) {
      report.warnings = [
        ...warnings,
        `sync succeeded but the status file ${paths.statusFile} could not be written: ${error?.message ?? error}`,
      ];
    }
    log(`[sync] done in ${report.durationMs}ms ok=${report.cookies.total}->${trim.totalAfter}`);
    return report;
  } catch (error) {
    return failureReport(
      startedAt,
      startedMs,
      "internal",
      error?.stack || String(error),
      HINTS.internal,
      { source, paths: pathsOf(paths), copied },
    );
  }
}

/**
 * Read the last sync status written by syncProfile().
 * -> status object | null (missing/unreadable)
 */
export async function readSyncStatus(homeDir = DEFAULT_HOME) {
  try {
    const paths = resolveLocalPaths(homeDir);
    const text = await readFile(paths.statusFile, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Runtime status
 * ------------------------------------------------------------------ */

function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // already gone
      }
      resolve(ok);
    };
    try {
      socket = netConnect({ host, port });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Is the agent's own browser (the runtime one) alive, and what does its
 * DevTools endpoint say? Never throws; missing fields are false/null.
 * -> { running, port, headless, binary, debugPort:{listening,versionReachable,browserVersion} }
 */
export async function runtimeStatus(homeDir = DEFAULT_HOME) {
  const result = {
    running: false,
    port: null,
    headless: null,
    binary: null,
    debugPort: { listening: false, versionReachable: false, browserVersion: null },
  };
  try {
    const paths = resolveLocalPaths(homeDir);
    let state = null;
    try {
      state = JSON.parse(await readFile(join(paths.stateDir, "browser.json"), "utf8"));
    } catch {
      return result;
    }
    if (!state || typeof state.port !== "number" || state.port <= 0) return result;
    result.port = state.port;
    result.headless = state.headless === true;
    result.binary = typeof state.binary === "string" ? state.binary : null;
    const listening = await probeTcp("127.0.0.1", state.port, 1500);
    result.debugPort.listening = listening;
    if (!listening) return result;
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/json/version`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const version = await response.json();
        result.debugPort.versionReachable = true;
        result.debugPort.browserVersion =
          typeof version?.Browser === "string" ? version.Browser : null;
        result.running = true;
      }
    } catch {
      // listening but not answering HTTP — leave running false
    }
  } catch {
    // never throw from diagnostics
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Doctor
 * ------------------------------------------------------------------ */

function statFields(path) {
  const stats = optionalStat(path);
  if (!stats) return { exists: false, bytes: null, mtime: null };
  return { exists: true, bytes: stats.size, mtime: stats.mtime.toISOString() };
}

/** Read cookie statistics for the doctor report without touching sync state. */
async function collectDoctorCookies(opts, paths, browserStatus, resolvedBrowser) {
  const allowlist = readAllowlist(paths.allowlistFile).domains;
  const attempts = [];
  const notes = [];

  if (browserStatus?.running && browserStatus.port) {
    attempts.push(async () => {
      const attached = await connectBrowserCdp({ port: browserStatus.port, timeoutMs: 5000 });
      try {
        const cookies = await getCookies(attached.cdp);
        return cookieStats(cookies, allowlist);
      } finally {
        attached.close();
      }
    });
    notes.push(`attached to the live browser CDP on port ${browserStatus.port} failed`);
  }

  const targetLocalState = join(paths.profileDir, "Local State");
  const targetCookies = join(paths.profileDir, "Default", "Network", "Cookies");
  if ((await exists(targetLocalState)) && (await exists(targetCookies))) {
    const exePath = resolvedBrowser?.exePath || detectBrowsers()[0]?.exePath || "";
    if (exePath) {
      attempts.push(async () =>
        withProfileCdp(
          { exePath, profileDir: paths.profileDir, headless: true, timeoutMs: LAUNCH_TIMEOUT_MS },
          async ({ cdp }) => cookieStats(await getCookies(cdp), allowlist),
        ),
      );
      notes.push("temporary headless launch on the target profile failed");
    } else {
      notes.push("no browser executable available for a temporary headless launch");
    }
  } else {
    notes.push("target profile has no Local State/Cookies yet");
  }

  if (attempts.length === 0) return { stats: null, reason: notes.join("; ") || "no cookie source" };
  let lastError = null;
  for (const attempt of attempts) {
    try {
      return { stats: await attempt(), reason: null };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    stats: null,
    reason: `${notes.join("; ")}: ${lastError?.message ?? lastError ?? "unknown error"}`,
  };
}

/**
 * Diagnostics snapshot for the settings UI / ego_local_doctor tool.
 * opts = syncProfile opts + { includeCookies=true }
 * -> DoctorReport (contract §4.4); never throws.
 */
export async function doctorReport(opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const generatedAt = new Date().toISOString();
  try {
    const paths = resolveLocalPaths(options.homeDir || DEFAULT_HOME);
    const warnings = [];

    const allowRead = readAllowlist(paths.allowlistFile);
    if (allowRead.error) warnings.push(`allowlist.json could not be read: ${allowRead.error}`);

    const status = await readSyncStatus(paths.home);
    const profileExists = await exists(paths.profileDir);
    const profile = {
      exists: profileExists,
      localState: statFields(join(paths.profileDir, "Local State")),
      cookies: statFields(join(paths.profileDir, "Default", "Network", "Cookies")),
      totalBytes: 0,
      fileCount: 0,
      lastSyncAt: typeof status?.lastSyncAt === "string" ? status.lastSyncAt : null,
      status,
    };
    if (profileExists) {
      const totals = await directoryStats(paths.profileDir);
      profile.totalBytes = totals.totalBytes;
      profile.fileCount = totals.fileCount;
    }

    const browser = await runtimeStatus(paths.home);

    const detected = detectBrowsers();
    let resolved = null;
    let resolvedError = null;
    const resolvedSource = await resolveSource({
      browserSource: options.browserSource ?? "auto",
      browserBinary: options.browserBinary ?? "",
      sourceUserDataDir: options.sourceUserDataDir ?? "",
      sourceProfileDir: options.sourceProfileDir ?? "",
    });
    if (resolvedSource.ok) {
      resolved = {
        browser: {
          id: resolvedSource.browser.id,
          label: resolvedSource.browser.label,
          exePath: resolvedSource.browser.exePath,
          version: resolvedSource.browser.version,
          userDataDir: resolvedSource.browser.userDataDir,
        },
        profile: resolvedSource.profile,
        selectionReason: resolvedSource.selectionReason ?? null,
      };
    } else {
      resolvedError = resolvedSource.error;
      warnings.push(`source browser unresolved: ${resolvedSource.error.message}`);
    }
    const busy = resolved
      ? await probeSourceBusy(resolved.browser)
      : { busy: false, pids: [], lockFiles: [], method: "none" };

    let cookies = null;
    let cookiesError;
    if (options.includeCookies !== false) {
      const collected = await collectDoctorCookies(options, paths, browser, resolved?.browser ?? null);
      cookies = collected.stats;
      if (!cookies) {
        cookiesError = collected.reason || "cookie statistics unavailable";
        warnings.push(`cookie statistics unavailable: ${cookiesError}`);
      }
    }

    const runtime = {
      egoBin: fileURLToPath(new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url)),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };

    return {
      ok: true,
      generatedAt,
      paths: pathsOf(paths),
      profile,
      allowlist: {
        file: paths.allowlistFile,
        domains: allowRead.domains,
        source: allowRead.source,
        exists: allowRead.exists,
      },
      cookies,
      ...(cookiesError ? { cookiesError } : {}),
      browser,
      source: { detected, resolved, ...(resolvedError ? { resolvedError } : {}), busy },
      runtime,
      warnings,
    };
  } catch (error) {
    const code = error?.code === "invalid-path" ? "invalid-path" : "internal";
    const message = code === "invalid-path" ? String(error?.message || error) : String(error?.stack || error);
    return {
      ok: false,
      generatedAt,
      error: { code, message, hint: HINTS[code] ?? HINTS.internal },
    };
  }
}
