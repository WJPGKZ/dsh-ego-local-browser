#!/usr/bin/env node
/**
 * ego-browser, Linux edition.
 *
 * Same CLI shape as the macOS app's `ego-browser`: a heredoc of JS on stdin,
 * executed with every ego-browser helper preloaded. The difference is what backs
 * it — `globalThis.ego` is this port's CDP shim over a stock Chromium instead of
 * the app's native bindings. Everything above that line is the upstream harness,
 * unmodified.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { browserStatus, stopBrowser } from "../src/chrome.mjs";
import { installDesktopEntry } from "../src/desktop.mjs";
import {
  CHROME_CONFIG_CANDIDATES,
  PROFILE_DIR,
  SPACES_STATE_FILE,
  TASK_SPACE_FILE,
  STATE_DIR,
} from "../src/paths.mjs";
import { createEgoShim } from "../src/shim.mjs";
import { startSpacesServer } from "../src/spaces-server.mjs";

const HARNESS = new URL("../../ego-browser/dist/out/index.js", import.meta.url);
const SKILL_WORKSPACE = new URL("../../skills/ego-browser", import.meta.url); // vendored layout: runtime/ego-linux/bin -> runtime/skills/ego-browser

const USAGE = `ego-browser (Linux port)

  ego-browser <<'JS'
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS

Linux-only commands:
  --status                  show the backing browser's connection state
  --open                    open the shared agent browser window
  --spaces                  open the Spaces overview panel
  --prune-spaces            close spaces that hold nothing but about:blank
                            Spaces nobody returns to are also closed on their
                            own after 30 minutes idle; a space stays alive as
                            long as its session keeps using it. Set
                            EGO_LINUX_SPACE_IDLE_MIN to change the window, or
                            0 to sweep only by hand
  --stop                    stop the backing browser
  --import-chrome-profile   copy the real browser's login state in — minimal:
                            Local State + the profile's Network/Cookies only
  --install-desktop-entry   add it to your app launcher, with an icon
  --headless                run the backing browser headless (first launch only)
                            EGO_LINUX_HEADLESS=1 makes that the default, so the
                            agent window never opens over your work; --open
                            still gives you a visible one when you want it
`;

const execFileAsync = promisify(execFile);

/** Profile files Chrome/Edge creates next to the data dir while running. */
const SOURCE_LOCK_FILES = ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"];

/**
 * Does this path exist, even as a dangling symlink? (lstat, because Chrome's
 * SingletonLock is a symlink whose target may already be gone.)
 */
function existsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Which real browser owns a user-data-dir candidate (needed for the exe name). */
function sourceBrowserKind(userDataDir) {
  const lower = String(userDataDir).toLowerCase();
  if (lower.includes("microsoft") && lower.includes("edge")) {
    return { label: "Microsoft Edge", exeName: "msedge.exe" };
  }
  return { label: "Google Chrome", exeName: "chrome.exe" };
}

/**
 * Main browser processes running on the *default* user-data-dir (helpers carry
 * --type=/crashpad and are skipped). Used only for the import safety check.
 */
async function sourceBrowserProcesses(exeName) {
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-x", exeName.replace(/\.exe$/i, "")], {
        timeout: 10000,
      });
      return String(stdout)
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch (error) {
      if (error?.code === 1) return [];
      return [];
    }
  }
  const script = [
    `Get-CimInstance Win32_Process -Filter "Name='${exeName}'"`,
    `| Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' -and $_.CommandLine -notmatch '--user-data-dir=' }`,
    `| Select-Object -ExpandProperty ProcessId`,
  ].join(" ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { timeout: 15000, windowsHide: true },
    );
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** Port from a DevToolsActivePort file, or null. */
function parseDevToolsPort(text) {
  const line = String(text || "").split(/\r?\n/)[0].trim();
  const port = Number(line);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** Is something listening on 127.0.0.1:<port>? */
function tcpListening(port, timeoutMs = 800) {
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
      socket = netConnect({ host: "127.0.0.1", port });
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
 * Is the agent profile held by another live instance? The import must never
 * overwrite a profile a browser is using (its SQLite cookie store would be
 * corrupted), so any lock file / listening DevTools port blocks the import.
 */
async function targetProfileBusy() {
  const lockFiles = SOURCE_LOCK_FILES.filter((name) => existsNoFollow(join(PROFILE_DIR, name)));
  let devtoolsPort = null;
  let portListening = false;
  try {
    devtoolsPort = parseDevToolsPort(
      await readFile(join(PROFILE_DIR, "DevToolsActivePort"), "utf8"),
    );
    if (devtoolsPort) portListening = await tcpListening(devtoolsPort);
  } catch {
    devtoolsPort = null;
  }
  return {
    busy: lockFiles.length > 0 || portListening,
    lockFiles,
    devtoolsPort,
    portListening,
  };
}

/** Copy one file via temp name + rename so readers never see a half-written file. */
async function copyFileAtomic(from, to) {
  await mkdir(dirname(to), { recursive: true });
  const temp = `${to}.import-${process.pid}.tmp`;
  try {
    await copyFile(from, temp);
    await rename(temp, to);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Copy the system browser's login state in — MINIMAL COPY ONLY.
 *
 * Only `Local State` (the OS-key-encryption material, incl. the App-Bound key
 * for v20 cookies) and `<profile>\Network\Cookies` (+ existing SQLite sidecars;
 * a rollback journal only when non-empty) are copied. Bookmarks, history,
 * extensions, passwords and every other file under Default\ are deliberately
 * NOT copied (review P0-1 / contract §2.3).
 *
 * The source profile is read-only: a running source browser or leftover lock
 * files stop the import with a non-zero exit instead of silently copying a
 * half-written cookie store.
 */
async function importChromeProfile() {
  const source = CHROME_CONFIG_CANDIDATES.find((candidate) =>
    existsSync(join(candidate, "Default")),
  );
  if (!source) {
    process.stderr.write("no Chrome/Chromium profile found to import\n");
    return 1;
  }
  const kind = sourceBrowserKind(source);
  const status = await browserStatus();
  if (status.running) {
    process.stderr.write(
      "the backing browser is running; run --stop and close it before importing\n",
    );
    return 1;
  }

  const sourceLocalState = join(source, "Local State");
  const sourceProfile = join(source, "Default");
  const sourceCookies = join(sourceProfile, "Network", "Cookies");

  // 1. Source ownership check: never copy from a live/dirty source profile.
  const pids = await sourceBrowserProcesses(kind.exeName);
  const lockFiles = SOURCE_LOCK_FILES.filter((name) => existsNoFollow(join(source, name)));
  if (pids.length > 0 || lockFiles.length > 0) {
    const detail = [
      pids.length > 0 ? `pids ${pids.join(",")}` : "",
      lockFiles.length > 0 ? `lock files ${lockFiles.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    process.stderr.write(
      `error: source-locked — ${kind.label} appears to be running on ${source} (${detail}). ` +
        `Quit it completely and retry` +
        (lockFiles.length > 0
          ? ` (if it is already closed, these are stale lock files and can be removed).\n`
          : ".\n"),
    );
    return 1;
  }
  if (!existsSync(sourceLocalState)) {
    process.stderr.write(
      `error: local-state-missing — ${sourceLocalState} was not found. ` +
        `Launch ${kind.label} once so it writes Local State, then retry.\n`,
    );
    return 1;
  }
  if (!existsSync(sourceCookies)) {
    process.stderr.write(
      `error: cookies-missing — ${sourceCookies} was not found. ` +
        `Launch ${kind.label}, visit the sites you want to keep, then retry.\n`,
    );
    return 1;
  }

  // SQLite sidecars: -wal/-shm when present; -journal only when non-empty.
  const sidecarSuffixes = [];
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const path = sourceCookies + suffix;
    if (!existsNoFollow(path)) continue;
    if (suffix === "-journal") {
      let bytes = 0;
      try {
        bytes = statSync(path).size;
      } catch {
        bytes = 0;
      }
      if (bytes === 0) continue;
    }
    sidecarSuffixes.push(suffix);
  }

  // 2. Target ownership check: never overwrite a profile a browser is using.
  const target = await targetProfileBusy();
  if (target.busy) {
    const detail = [
      target.lockFiles.length > 0 ? `lock files ${target.lockFiles.join(", ")}` : "",
      target.portListening ? `DevTools port ${target.devtoolsPort} is listening` : "",
    ]
      .filter(Boolean)
      .join("; ");
    process.stderr.write(
      `error: target-busy — the agent profile ${PROFILE_DIR} is in use (${detail}). ` +
        `Stop the backing browser (ego-browser --stop) and retry.\n`,
    );
    return 1;
  }
  // Proven idle: clear leftover transient files from an earlier crashed run.
  for (const name of [...SOURCE_LOCK_FILES, "DevToolsActivePort"]) {
    await rm(join(PROFILE_DIR, name), { force: true }).catch(() => {});
  }
  const targetCookies = join(PROFILE_DIR, "Default", "Network", "Cookies");
  try {
    await mkdir(dirname(targetCookies), { recursive: true });
  } catch (error) {
    process.stderr.write(
      `error: copy-failed — could not create ${dirname(targetCookies)}: ${error?.message || error}\n`,
    );
    return 1;
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await rm(targetCookies + suffix, { force: true }).catch(() => {});
  }

  const transfers = [
    { label: "Cookies", from: sourceCookies, to: targetCookies },
    ...sidecarSuffixes.map((suffix) => ({
      label: `Cookies${suffix}`,
      from: sourceCookies + suffix,
      to: targetCookies + suffix,
    })),
    // Local State last: its presence means the minimal import completed.
    { label: "Local State", from: sourceLocalState, to: join(PROFILE_DIR, "Local State") },
  ];
  process.stderr.write(
    `importing ${transfers.map((transfer) => transfer.label).join(" + ")} ` +
      `from ${sourceProfile} -> ${PROFILE_DIR}\n`,
  );
  for (const transfer of transfers) {
    try {
      await copyFileAtomic(transfer.from, transfer.to);
    } catch (error) {
      const code =
        error?.code === "EBUSY" || error?.code === "EPERM" ? "source-locked" : "copy-failed";
      process.stderr.write(
        `error: ${code} — could not copy ${transfer.label}: ${error?.message || error}\n`,
      );
      return 1;
    }
    process.stderr.write(`copied ${transfer.label}\n`);
  }

  process.stderr.write("done — logins and cookies now carry into agent tasks\n");
  return 0;
}

/** Is a Spaces server already listening on the recorded port? */
async function liveSpacesServer() {
  try {
    const state = JSON.parse(await readFile(SPACES_STATE_FILE, "utf8"));
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? state.port : null;
  } catch {
    return null;
  }
}

/** Open the panel as a chrome-less app window on the shared browser. */
async function openPanelWindow(url) {
  const status = await browserStatus();
  spawn(status.binary || "google-chrome", [`--user-data-dir=${PROFILE_DIR}`, `--app=${url}`], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/**
 * Serve the Spaces panel until the browser goes away.
 *
 * Runs detached, because the panel's backend must outlive the command that
 * opened it. Tying the server to a foreground CLI process meant that closing
 * the terminal — or any timeout around it — left the panel showing
 * "cannot reach the browser".
 */
async function runSpacesDaemon() {
  // Spaces created from the panel are the user's, not the profile that happened
  // to launch this daemon (see agent-identity.mjs).
  process.env.EGO_LINUX_PANEL = "1";
  const shim = await createEgoShim({ headless: false });
  const spaces = await startSpacesServer(shim);
  const url = `http://127.0.0.1:${spaces.port}/`;

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    SPACES_STATE_FILE,
    JSON.stringify({ port: spaces.port, pid: process.pid }, null, 2),
  );

  // The daemon owns the window it serves, so starting one always shows it.
  await openPanelWindow(url);

  const outcome = await new Promise((resolve) => {
    process.on("SIGINT", () => resolve("signal"));
    process.on("SIGTERM", () => resolve("signal"));

    // Give Chrome a moment to register the window before deciding it is absent.
    let seenPanel = false;
    const started = Date.now();

    const timer = setInterval(async () => {
      let tabs;
      try {
        ({ tabs } = await shim.ego.listTabs());
      } catch {
        // The browser went away, taking every window — including this panel —
        // with it. That is a restart, not a decision, so hand off to a fresh
        // daemon that will reopen the panel against the new browser.
        clearInterval(timer);
        resolve("browser-gone");
        return;
      }

      const open = tabs.some((tab) => tab.url.startsWith(url));
      if (open) {
        seenPanel = true;
        return;
      }
      // Closing the panel while the browser keeps running is deliberate: stop
      // serving rather than reopening a window the user just dismissed.
      if (seenPanel || Date.now() - started > 20000) {
        clearInterval(timer);
        resolve("panel-closed");
      }
    }, 2500);
  });

  spaces.close();
  shim.close();
  await rm(SPACES_STATE_FILE, { force: true });

  if (outcome === "browser-gone") {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--spaces-daemon"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  return 0;
}

/**
 * Open the Spaces overview.
 *
 * The panel is a real Chrome app window (`--app`): no tab strip, no toolbar, its
 * own app_id. Chrome routes the request to the already-running instance because
 * the profile matches, so this adds a window rather than a second browser.
 */
async function openSpaces() {
  const running = await liveSpacesServer();

  // A running daemon already owns a window; ask it for another one. A cold start
  // opens its own, so opening one here too would give you two.
  if (running) {
    await openPanelWindow(`http://127.0.0.1:${running}/`);
    process.stderr.write(`Spaces panel: http://127.0.0.1:${running}/\n`);
    return 0;
  }

  spawn(process.execPath, [fileURLToPath(import.meta.url), "--spaces-daemon"], {
    detached: true,
    stdio: "ignore",
  }).unref();

  let port = null;
  const deadline = Date.now() + 30000;
  while (!port && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    port = await liveSpacesServer();
  }
  if (!port) {
    process.stderr.write("the Spaces server did not come up\n");
    return 1;
  }

  process.stderr.write(`Spaces panel: http://127.0.0.1:${port}/\n`);
  return 0;
}

/**
 * Sweep spaces that hold nothing but about:blank.
 *
 * The automatic sweep in reconcile only touches spaces stamped with a creation
 * time, so it cannot reach the drift left behind before that existed — and a
 * user staring at twenty empty windows wants them gone now, not in two minutes.
 * Explicitly invoked, so it ignores age and asks no questions.
 */
async function pruneSpaces() {
  // Maintenance must never be the thing that opens a browser. Forcing a headed
  // launch here meant running the sweep on a quiet machine started a visible
  // window — producing exactly the empty windows it exists to clear.
  const status = await browserStatus();
  if (!status.running) {
    process.stdout.write("no backing browser is running; nothing to prune\n");
    return 0;
  }
  const shim = await createEgoShim({ headless: status.headless === true });
  try {
    const { taskSpaces = [] } = await shim.ego.listTaskSpaces();
    // The selected space is the one an agent is working in right now, and its
    // tab is about:blank for a moment on every navigation. Closing it would
    // take the agent's context out from under it mid-task.
    let selectedId = null;
    try {
      ({ selectedId = null } = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8")));
    } catch {
      // No state file means no selection to protect.
    }
    const { targetInfos = [] } = await shim.cdp.call("Target.getTargets");
    const byTarget = new Map(targetInfos.map((target) => [target.targetId, target]));

    let closed = 0;
    for (const space of taskSpaces) {
      const tabs = (space.targetIds || []).map((id) => byTarget.get(id)).filter(Boolean);
      if (tabs.length === 0) continue;
      if (space.id === selectedId) continue;
      if (space.lastContentAt) continue;
      if (!tabs.every((target) => target.url === "about:blank")) continue;
      await shim.ego.closeTaskSpace(space.id).then(
        () => {
          closed += 1;
        },
        () => {},
      );
    }
    process.stdout.write(
      closed === 0
        ? "no empty spaces to close\n"
        : `closed ${closed} empty ${closed === 1 ? "space" : "spaces"}\n`,
    );
  } finally {
    shim.close();
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);

  // The skill documents `ego-browser nodejs <<'EOF'`; accept it as a no-op prefix.
  if (argv[0] === "nodejs") argv.shift();

  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === "--status") {
    process.stdout.write(`${JSON.stringify(await browserStatus(), null, 2)}\n`);
    return 0;
  }
  if (argv[0] === "--stop") {
    const stopped = await stopBrowser();
    process.stdout.write(
      stopped
        ? "backing browser stopped; the next run launches a fresh one\n"
        : "no backing browser was running; profile lock cleared\n",
    );
    return 0;
  }
  if (argv[0] === "--import-chrome-profile") {
    return importChromeProfile();
  }
  if (argv[0] === "--prune-spaces") {
    return pruneSpaces();
  }
  if (argv[0] === "--spaces") {
    return openSpaces();
  }
  if (argv[0] === "--spaces-daemon") {
    return runSpacesDaemon();
  }
  if (argv[0] === "--install-desktop-entry") {
    const { entryPath, iconPath } = await installDesktopEntry();
    process.stdout.write(`installed ${entryPath}\n         ${iconPath}\n`);
    return 0;
  }
  if (argv[0] === "--open") {
    // Launched from a desktop icon there is no terminal to read an error in, so
    // this has to succeed rather than explain. A headless browser has no window
    // to show, so trade it for a visible one.
    const status = await browserStatus();
    if (status.running && status.headless) {
      process.stderr.write("replacing the headless browser with a visible one\n");
      await stopBrowser();
    }
    const shim = await createEgoShim({ headless: false });
    try {
      const { tabs } = await shim.ego.listTabs();
      // A browser with no page target shows no window; give it one.
      let targetId = tabs.find((tab) => tab.active)?.targetId ?? tabs[0]?.targetId;
      if (!targetId) ({ targetId } = await shim.ego.createTab("about:blank"));

      // The window usually already exists — it is just behind everything else.
      // Clicking a launcher icon has to raise it, not quietly confirm it is
      // running, which looks identical to nothing happening.
      await shim.cdp.call("Target.activateTarget", { targetId }).catch(() => {});
      const { sessionId } = await shim.cdp.call("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await shim.cdp.call("Page.bringToFront", {}, sessionId).catch(() => {});
    } finally {
      shim.close();
    }
    return 0;
  }

  // EGO_LINUX_HEADLESS is for a machine whose owner does not want the agent
  // window in front of their work (or a box with no display at all). When a
  // usable X display is present (e.g. an Xvfb), run headed so the compositor
  // produces full-rate screencast frames for the watch panel — headless would
  // fall back to swiftshader (~1 fps). --headless still forces headless per run.
  // Windows always "has a display" (the desktop session; see ensureXDisplay's
  // win32 branch) — without this the post-#22 default flipped headed cold
  // starts into an Xvfb lookup that can never succeed there.
  const hasDisplay =
    process.platform === "win32" || (process.env.DISPLAY || "").trim() !== "";
  // An explicit EGO_LINUX_HEADLESS=1 always wins — even on Windows, where
  // hasDisplay is hard-coded true (issue #35: the variable used to be silently
  // ignored there). The display probe only decides when the variable is unset.
  const headlessEnv = (process.env.EGO_LINUX_HEADLESS ?? "").toLowerCase();
  const envHeadless = ["1", "true", "yes", "on"].includes(headlessEnv)
    ? true
    : hasDisplay
      ? false
      : !["", "0", "false", "no"].includes(headlessEnv);
  const headless = argv.includes("--headless") || envHeadless;
  const rest = argv.filter((arg) => arg !== "--headless");

  // `--sdk-path <file>` selects which harness bundle to run. Upstream's real
  // browser e2e runner passes it to test a local build; here the local build is
  // the only harness there is, so honour the path it names.
  let harness = HARNESS.href;
  const sdkFlag = rest.indexOf("--sdk-path");
  if (sdkFlag !== -1) {
    const path = rest[sdkFlag + 1];
    if (!path) {
      process.stderr.write("--sdk-path requires a path\n");
      return 2;
    }
    harness = pathToFileURL(path).href;
    rest.splice(sdkFlag, 2);
  }

  // Site skills and learnings live in the repo's skill directory.
  process.env.EGO_BROWSER_AGENT_WORKSPACE ||= SKILL_WORKSPACE.pathname;

  const shim = await createEgoShim({ headless });
  globalThis.ego = shim.ego;

  const { runMain } = await import(harness);
  try {
    return await runMain({ argv: rest });
  } finally {
    shim.close();
  }
}

main()
  .then((code) => {
    // [#62] Never process.exit() straight after a CDP teardown: the socket
    // close is asynchronous, and exiting while a handle is mid-close trips
    // libuv's `!(handle->flags & UV_HANDLE_CLOSING)` assertion on Windows —
    // the run succeeds but the process reports exit code 1, so callers
    // branching on $LASTEXITCODE read it as a failure. Set the code and let
    // the loop drain; the unref'd guard only fires on a genuine handle leak
    // (which would otherwise hang --open forever).
    process.exitCode = code ?? 0;
    const guard = setTimeout(() => process.exit(process.exitCode ?? 0), 3000);
    guard.unref();
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
    const guard = setTimeout(() => process.exit(1), 3000);
    guard.unref();
  });