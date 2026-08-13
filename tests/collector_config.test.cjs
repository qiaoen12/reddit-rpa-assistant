const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "collector-config.js"), "utf8");

test("keeps popup and content-script collection defaults in one immutable contract", () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "collector-config.js" });

  const defaults = sandbox.RedditRpaCollectorConfig.DEFAULT_CONFIG;
  assert.equal(defaults.listingSteps, 25);
  assert.equal(defaults.targetPostCount, 25);
  assert.equal(defaults.maxPosts, 25);
  assert.equal(defaults.waitMs, 1500);
  assert.equal(defaults.navigationTimeoutMs, 60000);
  assert.equal(defaults.rateLimitCooldownMs, 60000);
  assert.equal(Object.isFrozen(defaults), true);
  assert.equal(Object.isFrozen(sandbox.RedditRpaCollectorConfig), true);
});
