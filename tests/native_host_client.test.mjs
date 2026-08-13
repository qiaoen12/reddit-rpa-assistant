import assert from "node:assert/strict";
import test from "node:test";

import { createNativeHostClient } from "../native-host-client.mjs";

function eventHook() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); }
  };
}

test("uses one Native Messaging port and strips transport request IDs", async () => {
  const onMessage = eventHook();
  const onDisconnect = eventHook();
  const sent = [];
  const runtime = {
    connectNative(hostName) {
      assert.equal(hostName, "com.openai.reddit_rpa");
      return {
        onMessage,
        onDisconnect,
        postMessage(message) {
          sent.push(message);
          queueMicrotask(() => onMessage.emit({ request_id: message.request_id, ok: true, status: "ready" }));
        }
      };
    }
  };
  const client = createNativeHostClient({ hostName: "com.openai.reddit_rpa", runtimeApi: runtime });

  assert.deepEqual(await client.operation("status"), { ok: true, status: "ready" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].operation, "status");
  assert.equal(Object.hasOwn(sent[0], "payload"), true);
});

test("falls back cleanly when Native Messaging is unavailable", async () => {
  const client = createNativeHostClient({ hostName: "com.openai.reddit_rpa", runtimeApi: {} });
  assert.equal(await client.operation("status"), null);
});
