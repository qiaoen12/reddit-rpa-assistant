const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const selectorsSource = readFileSync(path.join(root, "reddit-dom-selectors.js"), "utf8");
const modelSource = readFileSync(path.join(root, "reddit-model.js"), "utf8");
const queueSource = readFileSync(path.join(root, "batch-queue.js"), "utf8");
const listingSelectionSource = readFileSync(path.join(root, "listing-selection.js"), "utf8");
const contentSource = readFileSync(path.join(root, "content.js"), "utf8");

function createPageRuntime({ storageGetError = null } = {}) {
  const listeners = new Set();
  let nextTimer = 1;
  const timers = new Map();
  const runtime = {
    id: "reddit-rpa-test",
    sendMessage: async () => ({ ok: true }),
    onMessage: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); }
    }
  };
  const sandbox = {
    URL,
    console,
    chrome: {
      runtime,
      storage: {
        local: {
          get: async () => {
            if (storageGetError) throw storageGetError;
            return {};
          },
          set: async () => undefined
        }
      }
    },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null
    },
    location: { href: "https://www.reddit.com/r/WindowsMR/comments/1vcpcwm/acer_ah101_constant_blackout/" },
    window: {
      setTimeout(callback) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
      setInterval(callback) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearInterval(id) { timers.delete(id); },
      scrollBy() {}
    }
  };
  sandbox.globalThis = sandbox;
  return { sandbox, listeners, timers, runtime };
}

function injectCurrentScripts(runtime) {
  vm.runInNewContext(selectorsSource, runtime.sandbox, { filename: "reddit-dom-selectors.js" });
  vm.runInNewContext(modelSource, runtime.sandbox, { filename: "reddit-model.js" });
  vm.runInNewContext(queueSource, runtime.sandbox, { filename: "batch-queue.js" });
  vm.runInNewContext(listingSelectionSource, runtime.sandbox, { filename: "listing-selection.js" });
  vm.runInNewContext(contentSource, runtime.sandbox, { filename: "content.js" });
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("takes over a page whose old extension script left the legacy loaded flag behind", async () => {
  const runtime = createPageRuntime();
  runtime.sandbox.__redditRpaContentScriptLoaded = true;

  injectCurrentScripts(runtime);
  await flushMicrotasks();

  assert.equal(runtime.sandbox.__redditRpaContentScriptLoaded, "0.8.2");
  assert.equal(runtime.listeners.size, 1, "the current script must install a usable command listener");
  assert.equal(runtime.timers.size, 3, "the current script should retain its watcher, hydration timer and control poller");

  injectCurrentScripts(runtime);
  await flushMicrotasks();

  assert.equal(runtime.listeners.size, 1, "reinjection must replace, not duplicate, the listener");
  assert.equal(runtime.timers.size, 3, "reinjection must dispose previous timers before hydrating again");
});

test("stops an old controller when extension reload invalidates state hydration", async () => {
  const runtime = createPageRuntime({ storageGetError: new Error("Extension context invalidated.") });

  injectCurrentScripts(runtime);
  await flushMicrotasks();

  assert.equal(runtime.listeners.size, 0, "an invalidated controller must not retain its command listener");
  assert.equal(runtime.timers.size, 0, "an invalidated controller must not retain page watchers");
  assert.equal(runtime.sandbox.__redditRpaContentScriptController, undefined);
});
