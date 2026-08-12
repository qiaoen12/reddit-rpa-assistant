import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerUrl = pathToFileURL(path.join(testDirectory, "..", "service-worker.js")).href;

function nativePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) {
      queueMicrotask(() => {
        for (const listener of messageListeners) {
          listener({ request_id: message.request_id, ok: true, status: "native_host_connected", configured: true, permission: "granted", name: "VR-XR", backend: "native" });
        }
      });
    },
    disconnect() { for (const listener of disconnectListeners) listener(); }
  };
}

async function runtime() {
  let listener = null;
  globalThis.chrome = {
    storage: { session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
    tabs: { onRemoved: { addListener() {} }, sendMessage: async () => ({ version: "0.8.0" }) },
    scripting: { executeScript: async () => undefined },
    runtime: {
      getManifest: () => ({ version: "0.8.0" }),
      onMessage: { addListener(value) { listener = value; } },
      connectNative: () => nativePort()
    }
  };
  await import(`${serviceWorkerUrl}?native-host-test=${Date.now()}-${Math.random()}`);
  return new Promise((resolve) => resolve({
    send(message) {
      return new Promise((done) => {
        const asynchronous = listener(message, {}, done);
        assert.equal(asynchronous, true);
      });
    }
  }));
}

test("uses the Native Host for output preflight without a File System Access handle", async () => {
  const worker = await runtime();
  const response = await worker.send({ type: "reddit-rpa-output-root-preflight" });
  assert.deepEqual(response, { ok: true, status: "native_host_connected", configured: true, permission: "granted", name: "VR-XR", backend: "native" });
  delete globalThis.chrome;
});
