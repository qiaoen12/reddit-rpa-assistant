import assert from "node:assert/strict";
import test from "node:test";

import {
  OutputPathError,
  normaliseUrlSlug,
  postDirectory,
  resolvePostDirectoryName
} from "../output-paths.mjs";

test("builds the required persistent post directory", () => {
  const post = {
    fullname: "t3_1upfiqa",
    canonical_url: "https://www.reddit.com/r/SteamVR/comments/1upfiqa/found_at_goodwill_for_199/"
  };
  assert.deepEqual(
    postDirectory(
      { slug: "steamvr" },
      post
    ),
    {
      slug: "steamvr",
      postId: "1upfiqa",
      urlSlug: "found_at_goodwill_for_199",
      directoryName: "1upfiqa--found_at_goodwill_for_199",
      canonicalUrl: "https://www.reddit.com/r/SteamVR/comments/1upfiqa/found_at_goodwill_for_199/",
      relativeDirectory: "raw/steamvr/1upfiqa--found_at_goodwill_for_199"
    }
  );
  assert.equal(
    postDirectory({ slug: "steamvr" }, post, { layer: "frozen" }).relativeDirectory,
    "raw/steamvr/1upfiqa--found_at_goodwill_for_199"
  );
});

test("rejects unsafe subreddit slugs and mismatched post permalink identity", () => {
  assert.throws(
    () => postDirectory({ slug: "../escape" }, { fullname: "t3_abc123", canonical_url: "https://www.reddit.com/r/x/comments/abc123/title/" }),
    (error) => error instanceof OutputPathError && error.code === "SUBREDDIT_SLUG_UNAVAILABLE"
  );
  assert.throws(
    () => postDirectory({ slug: "vr-gaming" }, { fullname: "t3_abc123", canonical_url: "https://www.reddit.com/r/x/comments/other/title/" }),
    (error) => error instanceof OutputPathError && error.code === "POST_PERMALINK_MISMATCH"
  );
});

test("normalises special URL titles and keeps an existing same-ID folder", () => {
  assert.equal(normaliseUrlSlug("Found at Goodwill for $1.99!"), "found_at_goodwill_for_1_99");
  assert.equal(normaliseUrlSlug("中文标题"), "u4e2d_u6587_u6807_u9898");
  assert.equal(
    resolvePostDirectoryName(["abc123--old_title"], "abc123", "abc123--new_title"),
    "abc123--old_title"
  );
  assert.throws(
    () => resolvePostDirectoryName(["abc123--one", "abc123--two"], "abc123", "abc123--new_title"),
    (error) => error instanceof OutputPathError && error.code === "POST_DIRECTORY_CONFLICT"
  );
});
