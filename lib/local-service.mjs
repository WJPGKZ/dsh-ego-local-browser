/**
 * lib/local-service.mjs — Lead-owned bridge between the DSH plugin host
 * (lib/index.js) and the local-browser primitives in
 * lib/profile-bootstrap.mjs + lib/local-cdp.mjs.
 *
 * Responsibilities:
 *   - resolve the local data home (E:\AI\DeepSeek\data\dsh-ego-local-browser by default)
 *   - persist the small UI-editable config (local-config.json) and the domain allowlist
 *   - expose status / sync / doctor payloads in the exact shapes the web gateway and
 *     the ego_local_* tools return
 *   - hand the three runtime env vars to the plugin host so every ego subprocess
 *     (and the ego-cast worker) writes to the local home instead of %LOCALAPPDATA%
 *
 * No external dependencies. Cookie VALUES never leave lib/profile-bootstrap.mjs:
 * everything this module returns only carries names, domains, counts and lengths.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_ALLOWLIST,
  DEFAULT_HOME,
  detectBrowsers,
  doctorReport,
  normalizeAllowlist,
  probeSourceBusy,
  readAllowlist,
  readSyncStatus,
  resolveLocalPaths,
  resolveSource,
  runtimeStatus,
  syncProfile,
  writeAllowlist,
} from "./profile-bootstrap.mjs";

export const DEFAULT_HOME_DIR = DEFAULT_HOME;
export const DEFAULT_ALLOWLIST_DOMAINS = DEFAULT_ALLOWLIST;
export const BROWSER_SOURCES = Object.freeze(["auto", "chrome", "edge"]);

/** Keys the settings page may write through /ego/api/local-config. */
export const LOCAL_CONFIG_KEYS = Object.freeze([
  "browserMode",
  "browserSource",
  "browserBinary",
  "sourceUserDataDir",
  "sourceProfileDir",
  "autoSync",
  "allowLiveCopy",
  "autoStartBridge",
]);

const DEFAULT_CONFIG = Object.freeze({
  browserMode: "real",
  browserSource: "auto",
  browserBinary: "",
  sourceUserDataDir: "",
  sourceProfileDir: "",
  autoSync: true,
  // Live copies can capture a mismatched WAL snapshot; opt-in only.
  allowLiveCopy: false,
  autoStartBridge: true,
});

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

const BROWSER_MODES = Object.freeze(["real", "real-only", "agent"]);

function sanitizeConfig(raw, loaderConfig = {}) {
  const merged = { ...DEFAULT_CONFIG };
  for (const key of LOCAL_CONFIG_KEYS) {
    const fromLoader = loaderConfig[key];
    if (fromLoader !== undefined && fromLoader !== null && fromLoader !== "") {
      if (key === "browserMode" && BROWSER_MODES.includes(fromLoader)) merged[key] = fromLoader;
      else if (key === "browserSource" && BROWSER_SOURCES.includes(fromLoader)) merged[key] = fromLoader;
      else if (key === "autoSync" || key === "allowLiveCopy" || key === "autoStartBridge") merged[key] = asBool(fromLoader, DEFAULT_CONFIG[key]);
      else if (typeof fromLoader === "string") merged[key] = fromLoader;
    }
  }
  if (raw && typeof raw === "object") {
    for (const key of LOCAL_CONFIG_KEYS) {
      const value = raw[key];
      if (value === undefined || value === null) continue;
      if (key === "browserMode") {
        if (BROWSER_MODES.includes(value)) merged.browserMode = value;
      } else if (key === "browserSource") {
        if (BROWSER_SOURCES.includes(value)) merged.browserSource = value;
      } else if (key === "autoSync" || key === "allowLiveCopy" || key === "autoStartBridge") {
        merged[key] = asBool(value, merged[key]);
      } else if (typeof value === "string") {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/** Validate an incoming UI/loader config patch; unknown keys and bad types are dropped. */
export function sanitizeConfigPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const key of LOCAL_CONFIG_KEYS) {
    const value = Reflect.get(patch, key);
    if (value === undefined || value === null) continue;
    if (key === "browserMode") {
      if (BROWSER_MODES.includes(value)) out[key] = value;
    } else if (key === "browserSource") {
      if (BROWSER_SOURCES.includes(value)) out[key] = value;
    } else if (key === "autoSync" || key === "allowLiveCopy" || key === "autoStartBridge") {
      if (typeof value === "boolean") out[key] = value;
      else if (typeof value === "string" || typeof value === "number") out[key] = asBool(value, null) !== null ? asBool(value, false) : undefined;
    } else if (typeof value === "string") {
      out[key] = value;
    }
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

async function fileInfo(file) {
  try {
    const info = await stat(file);
    return { exists: true, bytes: info.size, mtime: info.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, mtime: null };
  }
}

/** Bounded directory size/file count (profile folders can hold a few thousand files). */
async function directoryInfo(dir, maxFiles = 4000) {
  let bytes = 0;
  let files = 0;
  const pending = [dir];
  while (pending.length > 0 && files < maxFiles) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= maxFiles) break;
      const full = join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        try {
          bytes += (await stat(full)).size;
          files += 1;
        } catch {}
      }
    }
  }
  return { bytes, files, truncated: files >= maxFiles };
}

/**
 * @param {object} options
 * @param {string} [options.homeDir]      explicit data home (loader config `homeDir` wins)
 * @param {object} [options.loaderConfig] plugin row config defaults for the UI-editable keys
 * @param {object} [options.logger]       DSH ctx.logger (optional)
 */
export function createLocalBrowser(options = {}) {
  const loaderConfig = options.loaderConfig && typeof options.loaderConfig === "object" ? options.loaderConfig : {};
  const explicitHome = asString(options.homeDir, "") || asString(loaderConfig.homeDir, "");
  const logger = options.logger;
  const log = (message) => {
    try {
      logger?.info?.(`dsh-ego-local-browser: ${message}`);
    } catch {}
  };

  let homeDir = "";
  let pathsCache = null;

  /**
   * Service-level serialization: status/sync/doctor/ensureReady share one async
   * chain, so the settings gateway, ego_local_sync, ego_login_import and the boot
   * autoSync can never read or write the same profile concurrently.
   */
  let serviceChain = Promise.resolve();
  function withServiceLock(fn) {
    const run = serviceChain.then(fn, fn);
    serviceChain = run.then(() => void 0, () => void 0);
    return run;
  }

  /** Injected by lib/index.js: gracefully stop the agent browser on the local profile. */
  let stopBackingBrowser = null;
  function setStopBackingBrowser(fn) {
    stopBackingBrowser = typeof fn === "function" ? fn : null;
  }

  async function waitForBrowserStopped(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let running = false;
      try {
        const status = await runtimeStatus(paths().home);
        running = !!(status && status.running === true);
      } catch {
        running = false;
      }
      if (!running) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  function paths() {
    if (pathsCache) return pathsCache;
    let candidate = explicitHome || DEFAULT_HOME;
    try {
      pathsCache = resolveLocalPaths(candidate);
    } catch (error) {
      log(`invalid homeDir "${candidate}" (${error?.message || error}); falling back to ${DEFAULT_HOME}`);
      pathsCache = resolveLocalPaths(DEFAULT_HOME);
    }
    homeDir = pathsCache.home;
    return pathsCache;
  }

  /** All three env vars the vendored runtime + ego-cast worker must inherit. */
  function runtimeEnv() {
    const p = paths();
    return {
      EGO_LOCAL_HOME: p.home,
      EGO_LINUX_PROFILE: p.profileDir,
      EGO_LINUX_STATE_DIR: p.stateDir,
    };
  }

  /** Synchronously apply the runtime env to a process env object (defaults to process.env). */
  function applyRuntimeEnv(env = process.env) {
    for (const [key, value] of Object.entries(runtimeEnv())) {
      if (value) env[key] = value;
    }
    return env;
  }

  const state = { config: sanitizeConfig(null, loaderConfig), loaded: false, loading: null };

  async function loadConfig() {
    let raw = null;
    try {
      const text = await readFile(paths().localConfigFile, "utf8");
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    state.config = sanitizeConfig(raw, loaderConfig);
    state.loaded = true;
    return state.config;
  }

  /** Load local-config.json once (cached after the first successful read). */
  async function config() {
    if (state.loaded) return state.config;
    if (state.loading === null) state.loading = loadConfig().finally(() => (state.loading = null));
    return state.loading;
  }

  function configSync() {
    return state.config;
  }

  function browserMode() {
    return state.config.browserMode;
  }

  /** A sync hint for resolveEgoEnv: which browser binary the agent browser should use. */
  function browserHint() {
    const config = state.config;
    if (config.browserBinary) return config.browserBinary;
    try {
      const detected = detectBrowsers();
      if (config.browserSource === "chrome") return detected.find((b) => b.id === "chrome")?.exePath || "";
      if (config.browserSource === "edge") return detected.find((b) => b.id === "edge")?.exePath || "";
      return detected.find((b) => b.id === "chrome")?.exePath || detected[0]?.exePath || "";
    } catch {
      return "";
    }
  }

  async function setConfig(patch) {
    const clean = sanitizeConfigPatch(patch);
    const p = paths();
    let raw = {};
    try {
      raw = JSON.parse(await readFile(p.localConfigFile, "utf8"));
    } catch {
      raw = {};
    }
    const saved = Object.keys(clean).length > 0;
    if (saved) {
      const nextFile = { ...(raw && typeof raw === "object" ? raw : {}), ...clean, updatedAt: new Date().toISOString() };
      await mkdir(p.home, { recursive: true });
      // Atomic replace: a crash mid-write must never leave an unparsable config.
      const tmpFile = `${p.localConfigFile}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpFile, `${JSON.stringify(nextFile, null, 2)}\n`, "utf8");
      await rename(tmpFile, p.localConfigFile);
      state.loaded = false;
      await loadConfig();
    }
    return { config: state.config, saved };
  }

  async function getAllowlist() {
    const result = await readAllowlist(paths().allowlistFile);
    return {
      domains: result.domains,
      file: result.file,
      exists: !!result.exists,
      source: result.source,
      error: result.error,
    };
  }

  async function setAllowlist(input) {
    const domains = normalizeAllowlist(input);
    const p = paths();
    await mkdir(p.home, { recursive: true });
    const saved = await writeAllowlist(p.allowlistFile, domains);
    return { domains: saved.domains, file: saved.file, exists: true, saved: true };
  }

  async function profileInfo() {
    const p = paths();
    const localState = await fileInfo(join(p.profileDir, "Local State"));
    const cookies = await fileInfo(join(p.profileDir, "Default", "Network", "Cookies"));
    const directory = await directoryInfo(p.profileDir);
    let lastSync = null;
    try {
      lastSync = await readSyncStatus(p.home);
    } catch {}
    return {
      exists: existsSync(p.profileDir),
      localState,
      cookies,
      localStateExists: localState.exists,
      cookiesExists: cookies.exists,
      localStateBytes: localState.bytes,
      cookiesBytes: cookies.bytes,
      totalBytes: directory.bytes,
      fileCount: directory.files,
      truncated: directory.truncated,
      lastSyncAt: lastSync && lastSync.lastSyncAt ? lastSync.lastSyncAt : null,
      status: lastSync,
    };
  }

  async function resolveSourceForStatus(config) {
    try {
      const result = await resolveSource({
        browserSource: config.browserSource,
        browserBinary: config.browserBinary,
        sourceUserDataDir: config.sourceUserDataDir,
        sourceProfileDir: config.sourceProfileDir,
      });
      if (!result.ok) return { resolved: null, resolvedError: result.error || { code: "source-unavailable", message: "source browser could not be resolved" } };
      return { resolved: { browser: result.browser, profile: result.profile }, resolvedError: null };
    } catch (error) {
      return { resolved: null, resolvedError: { code: "source-unavailable", message: String(error?.message || error) } };
    }
  }

  async function statusUnlocked() {
    // NOTE: `config` is the async loader's name; never shadow it with a local
    // const in the same scope (TDZ) — use `cfg` for the resolved values.
    const cfg = await config();
    const p = paths();
    const allowlist = await getAllowlist();
    let detected = [];
    try {
      detected = detectBrowsers();
    } catch (error) {
      log(`detectBrowsers failed: ${error?.message || error}`);
    }
    const { resolved, resolvedError } = await resolveSourceForStatus(cfg);
    let busy = { busy: false, pids: [], lockFiles: [], method: "none" };
    if (resolved) {
      try {
        busy = await probeSourceBusy(resolved.browser);
      } catch (error) {
        busy = { busy: false, pids: [], lockFiles: [], method: "none", error: String(error?.message || error) };
      }
    }
    const profile = await profileInfo();
    let browser = { running: false, port: null, headless: null, binary: null, debugPort: { listening: false, versionReachable: false, browserVersion: null } };
    try {
      browser = await runtimeStatus(p.home);
    } catch (error) {
      browser = { ...browser, error: String(error?.message || error) };
    }
    return {
      homeDir: p.home,
      paths: {
        home: p.home,
        profileDir: p.profileDir,
        stateDir: p.stateDir,
        allowlistFile: p.allowlistFile,
        localConfigFile: p.localConfigFile,
        backupsDir: p.backupsDir,
        cacheDir: p.cacheDir,
      },
      config: cfg,
      allowlist,
      source: { detected, resolved, resolvedError },
      busy,
      profile,
      browser,
      runtime: { home: p.home, tmpDir: join(p.home, "tmp"), env: runtimeEnv() },
    };
  }

  /** Read-only status; serialized so it never observes a half-finished sync. */
  async function status() {
    return withServiceLock(statusUnlocked);
  }

  /**
   * Full sync: stop the agent browser (and prove it stopped), then run the
   * minimal copy + allowlist trim. Callers (tool / gateway / boot) all go through
   * here, so a single profile is only ever written by one sync at a time.
   */
  async function syncUnlocked(options = {}) {
    const cfg = await config();
    const allowLiveCopy = typeof options.allowLiveCopy === "boolean" ? options.allowLiveCopy : cfg.allowLiveCopy;
    let runtime = null;
    try {
      runtime = await runtimeStatus(paths().home);
    } catch {
      runtime = null;
    }
    if (runtime && runtime.running === true) {
      if (typeof stopBackingBrowser !== "function") {
        return {
          ok: false,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          error: {
            code: "agent-browser-running",
            message: "the agent browser is running on the local profile and this host cannot stop it",
            hint: "call ego_status/--stop first, or close the agent browser window, then retry",
          },
        };
      }
      log("stopping the agent browser before sync");
      await stopBackingBrowser();
      if (!(await waitForBrowserStopped())) {
        return {
          ok: false,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          error: {
            code: "agent-browser-running",
            message: "the agent browser did not stop within 25s; refusing to sync a live profile",
            hint: "close the agent browser window (or run --stop) and retry",
          },
        };
      }
    }
    return await syncProfile({
      homeDir: paths().home,
      browserSource: cfg.browserSource,
      browserBinary: cfg.browserBinary,
      sourceUserDataDir: cfg.sourceUserDataDir,
      sourceProfileDir: cfg.sourceProfileDir,
      allowLiveCopy,
      log,
    });
  }

  async function sync(options = {}) {
    return withServiceLock(() => syncUnlocked(options));
  }

  async function doctorUnlocked() {
    const cfg = await config();
    return await doctorReport({
      homeDir: paths().home,
      browserSource: cfg.browserSource,
      browserBinary: cfg.browserBinary,
      sourceUserDataDir: cfg.sourceUserDataDir,
      sourceProfileDir: cfg.sourceProfileDir,
      includeCookies: true,
      log,
    });
  }

  async function doctor() {
    return withServiceLock(doctorUnlocked);
  }

  /**
   * Boot-time preparation, deliberately non-throwing: create the home layout,
   * materialize the default allowlist, and auto-sync once when autoSync is on
   * and the local profile has not been bootstrapped yet. Runs under the same
   * service lock as an explicit sync.
   */
  async function ensureReady() {
    return withServiceLock(async () => {
      const p = paths();
      await config();
      await mkdir(p.home, { recursive: true });
      await mkdir(p.profileDir, { recursive: true });
      await mkdir(p.stateDir, { recursive: true });
      await mkdir(p.backupsDir, { recursive: true });
      await mkdir(join(p.home, "tmp"), { recursive: true });
      if (!existsSync(p.allowlistFile)) {
        await writeAllowlist(p.allowlistFile, DEFAULT_ALLOWLIST);
        log(`materialized default allowlist at ${p.allowlistFile}`);
      }
      const localStateExists = existsSync(join(p.profileDir, "Local State"));
      const cookiesExist = existsSync(join(p.profileDir, "Default", "Network", "Cookies"));
      if (state.config.autoSync && !(localStateExists && cookiesExist)) {
        log("local profile has no imported login state yet -> auto sync from the source browser");
        const report = await syncUnlocked({ allowLiveCopy: state.config.allowLiveCopy });
        if (report && report.ok) {
          log(`auto sync ok: cookies=${report.cookies ? report.cookies.total : "?"} deleted=${report.trim ? report.trim.deleted : "?"} source=${report.source && report.source.browser ? report.source.browser.id : "?"}`);
        } else {
          log(`auto sync failed: ${report && report.error ? `${report.error.code}: ${report.error.message}` : "unknown error"}`);
        }
        return report;
      }
      return { ok: true, skipped: true, reason: "profile already bootstrapped or autoSync disabled" };
    });
  }

  return {
    homeDir: () => paths().home,
    paths,
    runtimeEnv,
    applyRuntimeEnv,
    config,
    configSync,
    browserMode,
    setConfig,
    getAllowlist,
    setAllowlist,
    profileInfo,
    status,
    sync,
    doctor,
    ensureReady,
    setStopBackingBrowser,
    browserHint,
    log,
  };
}
