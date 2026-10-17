import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SERVER = join(ROOT, "server.mjs");
const TOKEN = "dsh-bridge-local";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function start(port, extra = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DSH_BRIDGE_PORT: String(port), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  return child;
}

async function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForStatus(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status?token=${TOKEN}`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("bridge did not become ready");
}

async function sendHeartbeat(port, ownerNonce) {
  const response = await fetch(`http://127.0.0.1:${port}/heartbeat?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerNonce }),
  });
  assert.equal(response.status, 200);
}

test("bridge exposes identity and rejects duplicate ports", async () => {
  const port = await freePort();
  const ownerNonce = "identity-test";
  const first = start(port, { DSH_BRIDGE_OWNER_NONCE: ownerNonce, DSH_BRIDGE_OWNER_LEASE_MS: "2000" });
  const heartbeat = setInterval(() => {
    sendHeartbeat(port, ownerNonce).catch(() => {});
  }, 500);
  try {
    const status = await waitForStatus(port);
    assert.equal(status.bridgeId, "dsh-real-browser-bridge");
    assert.equal(status.ownerNonce, ownerNonce);
    await sendHeartbeat(port, ownerNonce);

    const duplicate = start(port, { DSH_BRIDGE_OWNER_NONCE: "duplicate-test" });
    const result = await waitForExit(duplicate);
    assert.equal(result.code, 1);
  } finally {
    clearInterval(heartbeat);
    first.kill();
    await waitForExit(first).catch(() => {});
  }
});

test("bridge exits when the owner heartbeat lease expires", async () => {
  const port = await freePort();
  const child = start(port, { DSH_BRIDGE_OWNER_NONCE: "lease-test", DSH_BRIDGE_OWNER_LEASE_MS: "250" });
  const result = await waitForExit(child, 3000);
  assert.equal(result.code, 0);
});

test("client has no body-wide MutationObserver regression", async () => {
  const client = await readFile(join(ROOT, "..", "..", "lib", "client.js"), "utf8");
  assert.doesNotMatch(client, /new\s+MutationObserver\s*\(/);
  assert.doesNotMatch(client, /observe\s*\(\s*document\.body\b/);
});
