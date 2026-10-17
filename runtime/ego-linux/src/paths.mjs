import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const IS_WIN = process.platform === "win32";

/**
 * Plugin-injected overrides (dsh-ego-local-browser):
 *
 *   EGO_LOCAL_HOME       one data home for everything the plugin owns; when set,
 *                        DATA_DIR and STATE_DIR both default to it
 *   EGO_LINUX_STATE_DIR  explicit runtime state dir (wins over EGO_LOCAL_HOME for
 *                        STATE_DIR; the plugin points this at <home>\state)
 *   EGO_LINUX_PROFILE    explicit browser profile dir (upstream knob, still wins)
 *
 * With none of them set the original ego-lite-linux paths are used unchanged.
 */
const trimEnv = (name) => (process.env[name] || "").trim();
const LOCAL_HOME = trimEnv("EGO_LOCAL_HOME");
const STATE_DIR_OVERRIDE = trimEnv("EGO_LINUX_STATE_DIR");

/** Legacy per-user data root — unchanged when no plugin env is present. */
const DEFAULT_DATA_DIR = IS_WIN
  ? join(process.env.LOCALAPPDATA || join(HOME, "AppData", "Local"), "ego-lite-linux")
  : join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "ego-lite-linux");

/** Legacy per-user state root — unchanged when no plugin env is present. */
const DEFAULT_STATE_DIR = IS_WIN
  ? join(process.env.LOCALAPPDATA || join(HOME, "AppData", "Local"), "ego-lite-linux")
  : join(process.env.XDG_STATE_HOME || join(HOME, ".local", "state"), "ego-lite-linux");

/** Persistent browser profile — the Linux stand-in for the ego lite app's profile. */
export const DATA_DIR = LOCAL_HOME || DEFAULT_DATA_DIR;

/** Runtime state shared across heredoc invocations (each run is its own process). */
export const STATE_DIR = STATE_DIR_OVERRIDE || LOCAL_HOME || DEFAULT_STATE_DIR;

export const PROFILE_DIR = process.env.EGO_LINUX_PROFILE || join(DATA_DIR, "profile");
export const BROWSER_STATE_FILE = join(STATE_DIR, "browser.json");
export const SPACES_STATE_FILE = join(STATE_DIR, "spaces-server.json");
export const TASK_SPACE_FILE = join(STATE_DIR, "task-spaces.json");

/** Where a stock Chrome keeps the profile we can import logins from. */
export const CHROME_CONFIG_CANDIDATES = IS_WIN
  ? [
      join(process.env.LOCALAPPDATA || join(HOME, "AppData", "Local"), "Google", "Chrome", "User Data"),
      join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "User Data"),
      join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "User Data"),
      join(process.env.LOCALAPPDATA || join(HOME, "AppData", "Local"), "Microsoft", "Edge", "User Data"),
    ]
  : [
      join(HOME, ".config", "google-chrome"),
      join(HOME, ".config", "chromium"),
      join(HOME, ".config", "microsoft-edge"),
      join(HOME, ".config", "BraveSoftware", "Brave-Browser"),
    ];
