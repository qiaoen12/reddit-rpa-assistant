const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const modelSource = readFileSync(path.join(root, "reddit-model.js"), "utf8");
const pageContextSource = readFileSync(path.join(root, "content-page-context.js"), "utf8");

function createHelpers({
  href = "https://www.reddit.com/r/WindowsMR/comments/1vcpcwm/acer_ah101_constant_blackout/?utm_source=test#comments",
  anchors = []
} = {}) {
  const sandbox = { URL };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(modelSource, sandbox, { filename: "reddit-model.js" });
  vm.runInNewContext(pageContextSource, sandbox, { filename: "content-page-context.js" });
  const documentRef = {
    querySelectorAll() {
      return anchors;
    }
  };
  return {
    api: sandbox.RedditRpaPageContext,
    helpers: sandbox.RedditRpaPageContext.create({
      model: sandbox.RedditRpaModel,
      documentRef,
      locationRef: { href },
      URLCtor: URL
    })
  };
}

test("normalises page URLs and builds the current thread context", () => {
  const { helpers } = createHelpers();

  assert.equal(
    helpers.normalisedPageUrl(),
    "https://www.reddit.com/r/WindowsMR/comments/1vcpcwm/acer_ah101_constant_blackout"
  );
  assert.equal(helpers.absoluteUrl("/r/WindowsMR/"), "https://www.reddit.com/r/WindowsMR/");
  assert.equal(helpers.absoluteUrl("http://www.reddit.com/r/WindowsMR/"), null);

  const context = helpers.currentContext();
  assert.equal(context.collection_id, "vr-xr");
  assert.equal(context.page_type, "thread");
  assert.equal(context.subreddit, "WindowsMR");
  assert.equal(context.post_id, "1vcpcwm");
  assert.equal(context.post_fullname, "t3_1vcpcwm");
  assert.equal(context.canonical_url, "https://www.reddit.com/r/WindowsMR/comments/1vcpcwm/acer_ah101_constant_blackout/");
});

test("uses document fallbacks and keeps lightweight DOM helpers deterministic", () => {
  const { helpers } = createHelpers({
    href: "https://www.reddit.com/?utm_source=test",
    anchors: [{ href: "https://www.reddit.com/r/VirtualReality/" }]
  });
  const rootNode = {
    querySelector(selector) {
      return selector === ".preferred" ? { textContent: "  Preferred\n title " } : null;
    }
  };
  const node = {
    innerText: "  Primary\n text ",
    getAttribute(name) {
      return name === "data-id" ? "abc" : "";
    }
  };

  assert.equal(helpers.subredditFromDocument(), "VirtualReality");
  assert.equal(helpers.currentContext().subreddit, "VirtualReality");
  assert.equal(helpers.textOf(node), "Primary text");
  assert.equal(helpers.attributeOf(node, ["missing", "data-id"]), "abc");
  assert.equal(helpers.attributeOf(node, ["missing"]), null);
  assert.equal(helpers.firstText(rootNode, [".missing", ".preferred"]), "Preferred title");
});

test("validates batch target context and compares identity case-insensitively", () => {
  const { helpers } = createHelpers();
  const context = helpers.threadTargetContext({
    post: {
      fullname: "t3_1vcpcwm",
      canonical_url: "https://www.reddit.com/r/WindowsMR/comments/1vcpcwm/acer_ah101_constant_blackout/"
    }
  }, { category: "scheduled" });

  assert.equal(context.post_fullname, "t3_1vcpcwm");
  assert.equal(context.subreddit, "WindowsMR");
  assert.equal(context.category, "scheduled");
  assert.equal(
    helpers.contextsMatch({ subreddit: "WindowsMR" }, { subreddit: "windowsmr" }),
    true
  );
  assert.equal(
    helpers.postContextsMatch(
      { subreddit: "WindowsMR", post_fullname: "t3_1VCPCWM" },
      { subreddit: "windowsmr", post_fullname: "t3_1vcpcwm" }
    ),
    true
  );
  assert.throws(
    () => helpers.threadTargetContext({ post: { fullname: "t3_1vcpcwm" } }),
    /批量目标缺少可验证的帖子代码或永久链接/
  );
});

test("rejects an incomplete dependency injection", () => {
  const { api } = createHelpers();

  assert.throws(() => api.create(), /页面上下文依赖无效/);
});
