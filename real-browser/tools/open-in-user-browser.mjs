/**
 * Open a URL in the user's REAL browser (their default profile, exactly like
 * clicking the taskbar shortcut). No --user-data-dir, no cloning.
 *
 * The agent can only open + screenshot this window; remote debugging is blocked
 * on the default profile by Chrome/Edge 136+, so this is a "show the user" path,
 * not an automation path.
 *
 * Usage: node tools/open-in-user-browser.mjs <chrome|edge|auto> <url>
 */
import { spawn } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const [browserArg = "auto", url] = process.argv.slice(2);
if (!url) {
  console.error("usage: node tools/open-in-user-browser.mjs <chrome|edge|auto> <url>");
  process.exit(2);
}
const exe = browserArg === "edge" ? EDGE : browserArg === "chrome" ? CHROME : CHROME;
const child = spawn(exe, [url], {
  detached: true,
  stdio: "ignore",
  windowsHide: false,
});
child.unref();
console.log(JSON.stringify({ opened: url, browser: browserArg, exe, pid: child.pid ?? null }));
