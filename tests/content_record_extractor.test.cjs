const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const modelSource = readFileSync(path.join(root, "reddit-model.js"), "utf8");
const selectorsSource = readFileSync(path.join(root, "reddit-dom-selectors.js"), "utf8");
const pageContextSource = readFileSync(path.join(root, "content-page-context.js"), "utf8");
const extractorSource = readFileSync(path.join(root, "content-record-extractor.js"), "utf8");
const AUTHOR_SELECTOR = 'a[href^="/user/"], a[href^="/u/"], a[href*="reddit.com/user/"], a[href*="reddit.com/u/"]';

function element({ attrs = {}, textContent = "", href, children = {}, lists = {} } = {}) {
  return {
    id: attrs.id || "",
    href,
    innerText: textContent,
    textContent,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    querySelector(selector) {
      return children[selector] || null;
    },
    querySelectorAll(selector) {
      return lists[selector] || [];
    }
  };
}

function createExtractor(documentRef) {
  const sandbox = { URL };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(modelSource, sandbox, { filename: "reddit-model.js" });
  vm.runInNewContext(selectorsSource, sandbox, { filename: "reddit-dom-selectors.js" });
  vm.runInNewContext(pageContextSource, sandbox, { filename: "content-page-context.js" });
  vm.runInNewContext(extractorSource, sandbox, { filename: "content-record-extractor.js" });
  const pageContext = sandbox.RedditRpaPageContext.create({
    model: sandbox.RedditRpaModel,
    documentRef,
    locationRef: { href: "https://www.reddit.com/r/VRGaming/comments/abc123/a_listing_post/" },
    URLCtor: URL
  });
  return {
    api: sandbox.RedditRpaRecordExtractor,
    extractor: sandbox.RedditRpaRecordExtractor.create({
      model: sandbox.RedditRpaModel,
      selectors: sandbox.RedditRpaDomSelectors,
      documentRef,
      pageContext
    })
  };
}

function listingPost() {
  const author = element({ textContent: "listing_author", href: "https://www.reddit.com/user/listing_author/" });
  return element({
    attrs: {
      id: "t3_abc123",
      "post-title": "A listing post",
      permalink: "https://www.reddit.com/r/VRGaming/comments/abc123/a_listing_post/",
      "created-timestamp": "2026-08-07T12:00:00.000Z",
      score: "42"
    },
    children: {
      [AUTHOR_SELECTOR]: author,
      '[slot="text-body"]': element({ textContent: "Visible listing body" })
    }
  });
}

test("extracts and de-duplicates verified listing posts", () => {
  const post = listingPost();
  const documentRef = {
    documentElement: post,
    querySelectorAll(selector) {
      return selector === "shreddit-post" ? [post] : [];
    },
    querySelector() {
      return null;
    }
  };
  const { extractor } = createExtractor(documentRef);
  const result = extractor.collectListing({ subreddit: "VRGaming", post_fullname: null, canonical_url: null });

  assert.equal(result.invalid_permalinks.length, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].fullname, "t3_abc123");
  assert.equal(result.records[0].title, "A listing post");
  assert.equal(result.records[0].content, "Visible listing body");
  assert.equal(result.records[0].author, "listing_author");
  assert.equal(result.records[0].score, 42);
  assert.equal(extractor.mergeListingRecords(result.records, result.records).length, 1);
});

test("keeps only comments whose ownership matches the current post", () => {
  const post = listingPost();
  const commentLink = element({ href: "https://www.reddit.com/r/VRGaming/comments/abc123/a_listing_post/def456/" });
  const commentAuthor = element({ textContent: "commenter", href: "https://www.reddit.com/u/commenter/" });
  const verifiedComment = element({
    attrs: {
      id: "t1_def456",
      "post-fullname": "t3_abc123",
      "parent-fullname": "t3_abc123",
      depth: "0",
      "created-timestamp": "2026-08-07T12:03:00.000Z"
    },
    children: {
      [AUTHOR_SELECTOR]: commentAuthor,
      '[slot="comment"]': element({ textContent: "Top-level comment" })
    },
    lists: {
      'a[href*="/comments/"]': [commentLink]
    }
  });
  const foreignComment = element({
    attrs: { id: "t1_foreign", "post-fullname": "t3_other" },
    lists: { 'a[href*="/comments/"]': [] }
  });
  const documentRef = {
    documentElement: post,
    querySelectorAll(selector) {
      if (selector === "shreddit-post") return [post];
      if (selector === "shreddit-comment") return [verifiedComment, foreignComment];
      return [];
    },
    querySelector() {
      return null;
    }
  };
  const { extractor } = createExtractor(documentRef);
  const result = extractor.collectThread({
    subreddit: "VRGaming",
    post_fullname: "t3_abc123",
    post_id: "abc123",
    canonical_url: "https://www.reddit.com/r/VRGaming/comments/abc123/a_listing_post/"
  });

  const comments = result.records.filter((record) => record.record_type === "comment");
  assert.equal(result.records.filter((record) => record.record_type === "post").length, 1);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].fullname, "t1_def456");
  assert.equal(comments[0].post_fullname, "t3_abc123");
  assert.equal(comments[0].parent_fullname, "t3_abc123");
  assert.equal(comments[0].ownership_verified, true);
  assert.equal(result.rejected_foreign_comment_count, 1);
  assert.deepEqual([...result.native_comment_fullnames], ["t1_def456", "t1_foreign"]);
});

test("rejects incomplete record extraction dependencies", () => {
  const documentRef = { documentElement: null, querySelectorAll: () => [], querySelector: () => null };
  const { api } = createExtractor(documentRef);

  assert.throws(() => api.create(), /页面记录提取依赖无效/);
});
