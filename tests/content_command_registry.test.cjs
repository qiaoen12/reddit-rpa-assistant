const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "content-command-registry.js"), "utf8");

function registryModule() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "content-command-registry.js" });
  return sandbox.RedditRpaCommandRegistry;
}

test("keeps command dispatch and capture-failure classification in one declarative registry", async () => {
  const calls = [];
  const registry = registryModule().create([
    ["capture", (message) => {
      calls.push(message.payload);
      return { ok: true, status: "captured" };
    }, { captureFailure: true }],
    ["status", () => ({ ok: true, status: "ready" })]
  ]);

  assert.deepEqual(Array.from(registry.names()), ["capture", "status"]);
  assert.deepEqual(await registry.execute({ command: "capture", payload: "synthetic" }), { ok: true, status: "captured" });
  assert.deepEqual(calls, ["synthetic"]);
  assert.equal(registry.capturesFailure({ command: "capture" }), true);
  assert.equal(registry.capturesFailure({ command: "status" }), false);
  assert.deepEqual({ ...await registry.execute({ command: "unknown" }) }, {
    ok: false,
    code: "UNKNOWN_COMMAND",
    error: "未知 Reddit RPA 命令。"
  });
});

test("rejects duplicate or malformed command declarations during startup", () => {
  const module = registryModule();
  assert.throws(() => module.create([["status", () => null], ["status", () => null]]), /命令登记表无效/);
  assert.throws(() => module.create([["", () => null]]), /命令登记表无效/);
});
