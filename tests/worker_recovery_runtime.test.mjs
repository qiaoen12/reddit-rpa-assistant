import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerUrl = pathToFileURL(path.join(testDirectory, "..", "service-worker.js")).href;

function redditSender(tabId) {
  return {
    tab: {
      id: tabId,
      url: "https://www.reddit.com/r/WindowsMR/comments/1vcpcwm/acer_ah101_constant_blackout/"
    }
  };
}

async function createServiceWorkerRuntime(initialLock = null) {
  let lock = initialLock;
  let messageListener = null;
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: lock }),
        set: async (value) => { lock = value["reddit-rpa-active-worker-v1"] || null; },
        remove: async () => { lock = null; }
      }
    },
    tabs: {
      onRemoved: { addListener() {} },
      sendMessage: async () => ({ version: "0.7.0" })
    },
    runtime: {
      getManifest: () => ({ version: "0.7.0" }),
      onMessage: {
        addListener(listener) { messageListener = listener; }
      }
    },
    scripting: { executeScript: async () => undefined }
  };
  await import(`${serviceWorkerUrl}?worker-recovery-test=${Date.now()}-${Math.random()}`);
  return {
    get lock() { return lock; },
    set lock(value) { lock = value; },
    send(message, sender) {
      return new Promise((resolve) => {
        const asynchronous = messageListener(message, sender, resolve);
        assert.equal(asynchronous, true, "worker recovery should respond asynchronously");
      });
    }
  };
}

test("restores only the original tab and batch after an extension reload", async () => {
  const originalLock = {
    batch_id: "2026-08-10_035120_323",
    tab_id: 19,
    worker_token: "worker-token-before-reload",
    claimed_at: "2026-08-10T12:00:00.000Z"
  };
  const runtime = await createServiceWorkerRuntime({ ...originalLock });

  const restored = await runtime.send({
    type: "reddit-rpa-restore-worker",
    batch_id: originalLock.batch_id,
    expected_tab_id: 19
  }, redditSender(19));
  assert.deepEqual(restored, { ok: true, status: "worker_restored", ...originalLock });
  assert.deepEqual(runtime.lock, originalLock, "same-tab recovery must preserve the one existing lock");

  const wrongTab = await runtime.send({
    type: "reddit-rpa-restore-worker",
    batch_id: originalLock.batch_id,
    expected_tab_id: 19
  }, redditSender(20));
  assert.equal(wrongTab.ok, false);
  assert.equal(wrongTab.code, "WORKER_NOT_OWNER");

  const wrongBatch = await runtime.send({
    type: "reddit-rpa-restore-worker",
    batch_id: "different-batch",
    expected_tab_id: 19
  }, redditSender(19));
  assert.equal(wrongBatch.ok, false);
  assert.equal(wrongBatch.code, "WORKER_ALREADY_ACTIVE");

  runtime.lock = null;
  const claimed = await runtime.send({
    type: "reddit-rpa-restore-worker",
    batch_id: originalLock.batch_id,
    expected_tab_id: 19
  }, redditSender(19));
  assert.equal(claimed.ok, true);
  assert.equal(claimed.status, "worker_claimed");
  assert.equal(claimed.tab_id, 19);
  assert.equal(claimed.batch_id, originalLock.batch_id);
  assert.ok(claimed.worker_token);

  delete globalThis.chrome;
});
