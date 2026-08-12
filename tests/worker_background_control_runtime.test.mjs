import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerUrl = pathToFileURL(path.join(testDirectory, "..", "service-worker.js")).href;

function eventHook() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); }
  };
}

function storageArea() {
  const values = {};
  return {
    get: async (key) => ({ [key]: values[key] }),
    set: async (next) => { Object.assign(values, next); },
    remove: async (key) => { delete values[key]; }
  };
}

test("background alarm claims a Native Host command and reuses the sole Reddit work page", async () => {
  const onAlarm = eventHook();
  const onMessage = eventHook();
  const onInstalled = eventHook();
  const onStartup = eventHook();
  const onRemoved = eventHook();
  const tabs = [{ id: 19, url: "https://www.reddit.com/r/ValveIndex/", active: true }];
  const sent = [];
  const nativeOperations = [];
  let resolveWritten;
  const written = new Promise((resolve) => { resolveWritten = resolve; });
  const messageListeners = [];
  const port = {
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      nativeOperations.push(message);
      let result;
      if (message.operation === "next_control_request") {
        result = {
          ok: true,
          status: "control_request_pending",
          request: {
            request_id: "request-1",
            command: "prepare",
            collector_id: message.payload.collector_id,
            subreddit: "ValveIndex",
            count: null,
            batch_id: null
          },
          validation_error: null
        };
      } else if (message.operation === "write_control_response") {
        result = { ok: true, status: "control_response_stored", response: { ...message.payload.result } };
        resolveWritten(message.payload);
      } else {
        result = { ok: true, status: "collector_heartbeat_stored", configured: true, permission: "granted", backend: "native" };
      }
      queueMicrotask(() => {
        for (const listener of messageListeners) listener({ request_id: message.request_id, ...result });
      });
    }
  };

  globalThis.chrome = {
    storage: { session: storageArea(), local: storageArea() },
    tabs: {
      onRemoved,
      query: async () => tabs,
      create: async (details) => {
        const tab = { id: 20, url: details.url, active: Boolean(details.active) };
        tabs.push(tab);
        return tab;
      },
      sendMessage: async (tabId, message) => {
        sent.push({ tabId, message });
        if (message.command === "status") return { version: "0.8.0" };
        return { ok: true, status: "control_preparing", subreddit: message.subreddit };
      }
    },
    scripting: { executeScript: async () => undefined },
    alarms: { create() {}, onAlarm },
    runtime: {
      getManifest: () => ({ version: "0.8.0" }),
      onMessage,
      onInstalled,
      onStartup,
      connectNative: () => port
    }
  };

  await import(`${serviceWorkerUrl}?background-control-test=${Date.now()}-${Math.random()}`);
  onAlarm.emit({ name: "reddit-rpa-native-control-v1" });
  const response = await written;

  assert.equal(response.request.request_id, "request-1");
  assert.equal(response.result.ok, true);
  assert.equal(response.result.status, "control_preparing");
  assert.deepEqual(sent, [
    { tabId: 19, message: { command: "status" } },
    { tabId: 19, message: { command: "prepareControlPage", subreddit: "ValveIndex" } }
  ]);
  assert.equal(tabs.length, 1, "the known sole Reddit tab is reused instead of opening another one");
  assert.equal(nativeOperations.find((operation) => operation.operation === "next_control_request").payload.collector_id, response.request.collector_id);
  delete globalThis.chrome;
});
