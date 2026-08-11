const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

require("../reddit-model.js");
const model = globalThis.RedditRpaModel;
const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "reddit_dom_descriptors.json"), "utf8"));
const treeDiagnosticsFixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "comment_tree_diagnostics.json"), "utf8"));

test("parses subreddit listing and thread permalinks", () => {
  assert.deepEqual(model.parseRedditUrl(fixture.listing.url), {
    pageType: "listing", subreddit: "VRGaming", postId: null, commentId: null,
    canonicalUrl: "https://www.reddit.com/r/VRGaming/hot/"
  });
  const parsed = model.parseRedditUrl(fixture.thread.url);
  assert.equal(parsed.pageType, "thread");
  assert.equal(parsed.postId, "abc123");
  assert.equal(parsed.commentId, "def456");
});

test("maps every listing post identity to its own permalink and URL slug", () => {
  for (const post of fixture.listing.posts) {
    const fullname = model.fullname(post.postId, "t3");
    const permalink = model.postPermalinkForPost([
      "https://www.reddit.com/r/VRGaming/comments/abc123/a_listing_post/",
      post.canonicalUrl
    ], fullname);
    const parsed = model.parseRedditUrl(permalink);
    assert.equal(parsed.postId, post.postId, post.postId);
    assert.equal(permalink.endsWith(`/${post.canonicalUrl.split("/").filter(Boolean).at(-1)}/`), true, post.postId);
    assert.equal(model.postPermalinkIssue(permalink, fullname, post.subreddit), null, post.postId);
  }
  assert.equal(
    model.postPermalinkForPost([fixture.listing.posts[0].canonicalUrl], "t3_xyz789"),
    null
  );
  assert.equal(
    model.postPermalinkIssue(fixture.listing.posts[0].canonicalUrl, "t3_abc123", "SteamVR"),
    "POST_SUBREDDIT_MISMATCH"
  );
  assert.equal(
    model.postPermalinkIssue(fixture.listing.posts[0].canonicalUrl, "t3_xyz789", "VRGaming"),
    "POST_PERMALINK_MISMATCH"
  );
});

test("recognizes English and Chinese comment expansion and continuation controls", () => {
  for (const label of [
    "More comments",
    "More replies",
    "Load more comments",
    "View more comments",
    "更多评论",
    "另外 21 条回复",
    "查看更多评论"
  ]) {
    assert.equal(model.isExpansionControlLabel(label), true, label);
  }
  for (const label of ["Continue this thread", "继续此讨论串", "繼續此討論串"]) {
    assert.equal(model.isContinuationThreadLabel(label), true, label);
  }
  assert.equal(model.isExpansionControlLabel("Reply"), false);
  assert.equal(model.isContinuationThreadLabel("Share"), false);
});

test("preserves post, top-level comment, and nested comment as two record types", () => {
  const post = model.makePostRecord(fixture.thread.post);
  const topLevel = model.makeCommentRecord(fixture.thread.comments[0]);
  const nested = model.makeCommentRecord(fixture.thread.comments[1]);
  assert.equal(post.record_type, "post");
  assert.equal(post.fullname, "t3_abc123");
  assert.equal(topLevel.record_type, "comment");
  assert.equal(topLevel.parent_fullname, "t3_abc123");
  assert.equal(nested.record_type, "comment");
  assert.equal(nested.parent_fullname, "t1_def456");
  assert.equal(nested.depth, 1);
  for (const field of ["id", "content", "source_id", "source_url", "canonical_url", "fetched_at", "published_at", "language", "content_hash", "confidence", "errors"]) {
    assert.ok(Object.hasOwn(nested, field), "missing DataOps field " + field);
  }
});

test("keeps only verified parents and clears self or unavailable parents", () => {
  const topLevel = model.makeCommentRecord(fixture.thread.comments[0]);
  const nested = model.makeCommentRecord(fixture.thread.comments[1]);
  const selfParent = model.makeCommentRecord({
    ...fixture.thread.comments[1],
    commentId: "self999",
    parentFullname: "t1_self999"
  });
  const unavailableParent = model.makeCommentRecord({
    ...fixture.thread.comments[1],
    commentId: "missing999",
    parentFullname: "t1_not_on_page"
  });
  const checked = model.validateCommentParents(
    [topLevel, nested, selfParent, unavailableParent],
    "t3_abc123"
  );
  assert.equal(checked[0].parent_fullname, "t3_abc123");
  assert.equal(checked[0].parent_status, "verified");
  assert.equal(checked[1].parent_fullname, "t1_def456");
  assert.equal(checked[1].parent_status, "verified");
  assert.equal(checked[2].parent_fullname, null);
  assert.equal(checked[2].parent_status, "unknown");
  assert.equal(checked[2].depth, null);
  assert.equal(checked[3].parent_fullname, null);
  assert.equal(checked[3].parent_status, "unknown");
});

test("rebuilds verified reply depths and clears a cyclic parent chain", () => {
  const topLevel = model.makeCommentRecord(fixture.thread.comments[0]);
  const nested = model.makeCommentRecord(fixture.thread.comments[1]);
  const thirdLevel = model.makeCommentRecord({
    ...fixture.thread.comments[1], commentId: "third999", parentFullname: "t1_ghi789", depth: 0
  });
  const cycleA = model.makeCommentRecord({
    ...fixture.thread.comments[1], commentId: "cyclea", parentFullname: "t1_cycleb"
  });
  const cycleB = model.makeCommentRecord({
    ...fixture.thread.comments[1], commentId: "cycleb", parentFullname: "t1_cyclea"
  });
  const checked = model.validateCommentParents([topLevel, nested, thirdLevel, cycleA, cycleB], "t3_abc123");
  assert.equal(checked.find((record) => record.fullname === "t1_third999").depth, 2);
  assert.equal(checked.find((record) => record.fullname === "t1_cyclea").parent_fullname, null);
  assert.equal(checked.find((record) => record.fullname === "t1_cycleb").parent_status, "unknown");
});

test("merges a continuation duplicate by fullname without inventing a reply type", () => {
  const post = model.makePostRecord(fixture.thread.post);
  const original = model.makeCommentRecord({ ...fixture.thread.comments[1], content: "Short" });
  const continuation = model.makeCommentRecord(fixture.thread.comments[1]);
  const merged = model.mergeRecords([post, original, continuation]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].record_type, "comment");
  assert.equal(merged[1].content, "Nested reply from a continuation page");
  const quality = model.qualitySummary([post, original, continuation], { continuationUrls: [fixture.thread.url] });
  assert.equal(quality.duplicate_fullnames, 1);
  assert.equal(quality.continuation_urls.length, 1);
});

test("uses Reddit native comment position paths only when the exact parent is present", () => {
  const parents = model.resolveNativeCommentParents([
    { fullname: "t1_root", parentPositions: "[]", commentPosition: "0" },
    { fullname: "t1_reply", parentPositions: "[0]", commentPosition: "0" },
    { fullname: "t1_secondroot", parentPositions: "[]", commentPosition: "4" },
    { fullname: "t1_secondreply", parentPositions: "[4]", commentPosition: "0" },
    { fullname: "t1_thirdlevel", parentPositions: "[4,0]", commentPosition: "0" }
  ]);
  assert.equal(parents.get(0), undefined);
  assert.equal(parents.get(1), "t1_root");
  assert.equal(parents.get(3), "t1_secondroot");
  assert.equal(parents.get(4), "t1_secondreply");

  const ambiguous = model.resolveNativeCommentParents([
    { fullname: "t1_first", parentPositions: "[]", commentPosition: "0" },
    { fullname: "t1_conflict", parentPositions: "[]", commentPosition: "0" },
    { fullname: "t1_child", parentPositions: "[0]", commentPosition: "0" }
  ]);
  assert.equal(ambiguous.get(2), undefined, "ambiguous DOM paths must not invent a parent");
});

test("records deleted and removed placeholders as diagnostics without inventing comment parents", () => {
  const deleted = model.diagnoseNativeCommentTree(treeDiagnosticsFixture.deleted_parent, { collapsedPlaceholderCount: 1 });
  assert.equal(deleted.parentReasons.get(1), "deleted_ancestor_observed");
  assert.deepEqual(deleted.treeDiagnostics, {
    deleted_placeholder_count: 1,
    removed_placeholder_count: 0,
    collapsed_placeholder_count: 1,
    unmapped_native_parent_path_count: 1,
    reason_codes: ["DELETED_PLACEHOLDER_OBSERVED", "DELETED_ANCESTOR_OBSERVED", "UNMAPPED_NATIVE_PARENT_PATH", "COLLAPSED_COMMENT_CONTROL"]
  });

  const removed = model.diagnoseNativeCommentTree(treeDiagnosticsFixture.removed_parent);
  assert.equal(removed.parentReasons.get(1), "parent_id_unavailable");
  assert.equal(removed.treeDiagnostics.removed_placeholder_count, 1);
  assert.ok(removed.treeDiagnostics.reason_codes.includes("REMOVED_ANCESTOR_OBSERVED"));

  const normal = model.diagnoseNativeCommentTree(treeDiagnosticsFixture.normal_parent);
  assert.equal(normal.parentReasons.has(1), false);
  assert.equal(normal.treeDiagnostics.unmapped_native_parent_path_count, 0);
});

test("keeps an observed deleted ancestor explanation only when the final parent remains unknown", () => {
  const comment = model.makeCommentRecord({
    ...fixture.thread.comments[1],
    commentId: "deletedchild",
    parentFullname: null,
    parentReason: "deleted_ancestor_observed"
  });
  const checked = model.validateCommentParents([comment], "t3_abc123")[0];
  assert.equal(checked.parent_fullname, null);
  assert.equal(checked.parent_status, "unknown");
  assert.equal(checked.parent_reason, "deleted_ancestor_observed");
});

test("rechecks a rendered 0/0 once and separates retryable coverage gaps from safe tree partials", () => {
  assert.equal(model.shouldRecheckZeroCommentCapture({ reportedCommentCount: 0, collectedCommentCount: 0 }), true);
  assert.equal(model.shouldRecheckZeroCommentCapture({ reportedCommentCount: 25, collectedCommentCount: 0 }), false);
  assert.equal(model.shouldRecheckZeroCommentCapture({ reportedCommentCount: null, collectedCommentCount: 0 }), false);

  const complete = model.classifyThreadCoverage({ reportedCommentCount: 3, collectedCommentCount: 3 });
  assert.equal(complete.complete, true);
  assert.equal(complete.status, "complete");

  const missing = model.classifyThreadCoverage({ reportedCommentCount: 25, collectedCommentCount: 0 });
  assert.equal(missing.complete, false);
  assert.equal(missing.retryable, true);
  assert.equal(missing.status, "retry");
  assert.equal(missing.comment_count_gap, 25);

  const visibleGap = model.classifyThreadCoverage({
    reportedCommentCount: 20, collectedCommentCount: 19, visibleCommentCount: 19
  });
  assert.equal(visibleGap.complete, true);
  assert.equal(visibleGap.retryable, false);
  assert.equal(visibleGap.status, "complete_with_reported_count_gap");
  assert.equal(visibleGap.reported_count_gap_is_non_blocking, true);

  const unverifiedGap = model.classifyThreadCoverage({
    reportedCommentCount: 20, collectedCommentCount: 19, visibleCommentCount: 18
  });
  assert.equal(unverifiedGap.retryable, true, "only a fully verified native DOM snapshot may accept a header-count gap");

  const treePartial = model.classifyThreadCoverage({ reportedCommentCount: 11, collectedCommentCount: 11, unknownParentComment: 5 });
  assert.equal(treePartial.complete, false);
  assert.equal(treePartial.retryable, false);
  assert.equal(treePartial.tree_partial, true);
  assert.equal(treePartial.status, "tree_partial");
});
