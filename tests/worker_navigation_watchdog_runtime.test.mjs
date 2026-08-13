import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerUrl = pathToFileURL(path.join(testDirectory, "..", "service-worker.js")).href;
const LOCK_KEY = "reddit-rpa-active-worker-v1";
const STATE_KEY = "reddit-rpa-capture-state-v1";
const LEASE_KEY = "reddit-rpa-navigation-lease-v1";

function eventHook() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); }
  };
}

function storageArea(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get: async (key) => ({ [key]: values[key] }),
    set: async (next) => { Object.assign(values, next); },
    remove: async (key) => { delete values[key]; }
  };
}

function batchState() {
  const target = {
    post: {
      record_type: "post",
      fullname: "t3_abc123",
      post_fullname: "t3_abc123",
      post_id: "abc123",
      subreddit: "SteamVR",
      title: "Synthetic post",
      canonical_url: "https://www.reddit.com/r/SteamVR/comments/abc123/synthetic/"
    },
    permalink: "https://www.reddit.com/r/SteamVR/comments/abc123/synthetic/",
    attempts: 0
  };
  return {
    activeThreadJob: { active: true, post_fullname: "t3_abc123", navigation_id: "nav-1" },
    activeBatchJob: {
      active: true,
      paused: false,
      batch_id: "batch-1",
      worker_token: "worker-1",
      context: { subreddit: "SteamVR", page_type: "listing" },
      current: target,
      queue: [],
      completed: [],
      tree_partial: [],
      manual: [],
      failed: [],
      selected_count: 1,
      started_at: "2026-08-12T00:00:00.000Z",
      config: { navigationTimeoutMs: 60000, rateLimitCooldownMs: 60000 },
      event_seq: 1
    }
  };
}

function redditSender() {
  return { tab: { id: 19, url: "https://www.reddit.com/r/SteamVR/new/" } };
}

async function waitFor(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

async function runtime() {
  const onMessage = eventHook();
  const onUpdated = eventHook();
  const onRemoved = eventHook();
  const onAlarm = eventHook();
  const operations = [];
  const session = storageArea({
    [LOCK_KEY]: { batch_id: "batch-1", tab_id: 19, worker_token: "worker-1", claimed_at: "2026-08-12T00:00:00.000Z" }
  });
  const local = storageArea({ [STATE_KEY]: batchState() });
  const portListeners = [];
  const port = {
    onMessage: { addListener(listener) { portListeners.push(listener); } },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      operations.push(message);
      const result = message.operation === "store_batch_event"
        ? { ok: true, status: "batch_event_stored", event: message.payload.event }
        : message.operation === "store_batch"
          ? { ok: true, status: "batch_manifest_stored", relativePath: "raw/batches/batch-1.json" }
          : message.operation === "record_thread_failure"
            ? { ok: true, status: "thread_failure_recorded", relativePath: "raw/steamvr/abc123--synthetic" }
            : { ok: true, status: "native_host_connected", configured: true, permission: "granted", backend: "native" };
      queueMicrotask(() => {
        for (const listener of portListeners) listener({ request_id: message.request_id, ...result });
      });
    }
  };
  globalThis.chrome = {
    storage: { session, local },
    tabs: { onRemoved, onUpdated, sendMessage: async () => ({ version: "0.8.2" }) },
    alarms: { create() {}, onAlarm },
    scripting: { executeScript: async () => undefined },
    runtime: {
      getManifest: () => ({ version: "0.8.2" }),
      onMessage,
      onInstalled: eventHook(),
      onStartup: eventHook(),
      connectNative: () => port
    }
  };
  await import(`${serviceWorkerUrl}?navigation-watchdog-test=${Date.now()}-${Math.random()}`);
  return {
    local,
    operations,
    onUpdated,
    onAlarm,
    send(message, sender = redditSender()) {
      return new Promise((resolve) => {
        const asynchronous = onMessage.emit(message, sender, resolve);
        assert.equal(asynchronous, undefined, "event hook emits listeners without a direct return value");
      });
    }
  };
}

async function startLease(worker) {
  return worker.send({
    type: "reddit-rpa-navigation-started",
    worker_token: "worker-1",
    batch_id: "batch-1",
    post_fullname: "t3_abc123",
    navigation_id: "nav-1",
    target_url: "https://www.reddit.com/r/SteamVR/comments/abc123/synthetic/",
    timeout_ms: 60000
  });
}

test("validates a batch event before sending it to the Native Host", async () => {
  const worker = await runtime();
  const response = await worker.send({
    type: "reddit-rpa-store-batch-event",
    worker_token: "worker-1",
    event: { batch_id: "batch-1", seq: 1, event: "not_an_event" }
  });

  assert.equal(response.ok, false);
  assert.equal(response.code, "BATCH_EVENT_INVALID");
  assert.equal(worker.operations.length, 0, "invalid events must not cross the Native Messaging boundary");
  delete globalThis.chrome;
});

test("records an observed HTTP 429 error page without claiming a verified Reddit origin", async () => {
  const worker = await runtime();
  const started = await startLease(worker);
  assert.equal(started.ok, true);

  worker.onUpdated.emit(19, { title: "HTTP ERROR 429" }, { id: 19, url: "chrome-error://chromewebdata/", title: "HTTP ERROR 429" });
  await waitFor(() => assert.equal(worker.local.values[STATE_KEY].activeBatchJob.paused, true));

  const batch = worker.local.values[STATE_KEY].activeBatchJob;
  assert.equal(batch.rate_limit.failure_kind, "HTTP_429_ERROR_PAGE_OBSERVED");
  assert.equal(batch.rate_limit.evidence_source, "tab_metadata");
  assert.equal(batch.rate_limit.displayed_http_status, 429);
  assert.equal(batch.current.last_failure.failure_kind, "HTTP_429_ERROR_PAGE_OBSERVED");
  assert.equal(batch.event_seq, 2, "Worker must persist the sequence after the pure event builder returns");
  assert.equal(worker.local.values[LEASE_KEY], undefined, "a classified navigation must not remain silently pending");
  const event = worker.operations.find((operation) => operation.operation === "store_batch_event").payload.event;
  assert.equal(event.event, "navigation_error_observed");
  assert.equal(event.failure_kind, "HTTP_429_ERROR_PAGE_OBSERVED");
  assert.equal(event.evidence_source, "tab_metadata");
  assert.equal(event.displayed_http_status, 429);
  assert.equal(Object.hasOwn(event, "title"), false, "raw tab titles must not enter the audit log");
  delete globalThis.chrome;
});

test("separates client blocking and watchdog timeout from rate-limit counters", async () => {
  const blocked = await runtime();
  await startLease(blocked);
  blocked.onUpdated.emit(19, { title: "ERR_BLOCKED_BY_CLIENT" }, { id: 19, url: "chrome-error://chromewebdata/", title: "ERR_BLOCKED_BY_CLIENT" });
  await waitFor(() => assert.equal(blocked.local.values[STATE_KEY].activeBatchJob.paused, true));
  assert.equal(blocked.local.values[STATE_KEY].activeBatchJob.rate_limit, undefined);
  assert.equal(blocked.local.values[STATE_KEY].activeBatchJob.navigation_failure.failure_kind, "CLIENT_BLOCKED");

  const timeout = await runtime();
  await startLease(timeout);
  timeout.local.values[LEASE_KEY] = { ...timeout.local.values[LEASE_KEY], deadline_at: "2000-01-01T00:00:00.000Z" };
  timeout.onAlarm.emit({ name: "reddit-rpa-navigation-watchdog-v1" });
  await waitFor(() => assert.equal(timeout.local.values[STATE_KEY].activeBatchJob.paused, true));
  assert.equal(timeout.local.values[STATE_KEY].activeBatchJob.rate_limit, undefined);
  assert.equal(timeout.local.values[STATE_KEY].activeBatchJob.navigation_failure.failure_kind, "PAGE_NAVIGATION_TIMEOUT");
  const event = timeout.operations.find((operation) => operation.operation === "store_batch_event").payload.event;
  assert.equal(event.event, "navigation_timeout");
  delete globalThis.chrome;
});
