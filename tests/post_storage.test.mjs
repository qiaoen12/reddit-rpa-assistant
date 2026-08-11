import assert from "node:assert/strict";
import test from "node:test";

import {
  buildThreadDocument,
  makeCaptureRecord,
  makePostDocument,
  parseJsonLines,
  serialiseJsonLines
} from "../post-storage.mjs";

const post = {
  fullname: "t3_abc123", record_type: "post", title: "Post", content: "Body",
  canonical_url: "https://www.reddit.com/r/VRGaming/comments/abc123/post/"
};
const originalComment = {
  fullname: "t1_def456", record_type: "comment", post_fullname: "t3_abc123", parent_fullname: "t3_abc123",
  content: "Original body", published_at: "2026-08-07T12:00:00.000Z"
};
const newComment = {
  fullname: "t1_ghi789", record_type: "comment", post_fullname: "t3_abc123", parent_fullname: "t1_def456",
  content: "New reply", published_at: "2026-08-07T12:01:00.000Z"
};

test("serialises a complete comment snapshot without JSONL corruption", () => {
  const encoded = serialiseJsonLines([originalComment, newComment]);
  assert.deepEqual(parseJsonLines(encoded), [originalComment, newComment]);
});

test("rebuilds a current thread and retains capture audit state", () => {
  const document = makePostDocument(post, { directoryName: "abc123--post", postId: "abc123", urlSlug: "post" }, "2026-08-07T12:00:00.000Z");
  const first = makeCaptureRecord({
    captureId: "first", capturedAt: "2026-08-07T12:00:00.000Z", sourceUrl: post.canonical_url,
    postFullname: post.fullname, collectedCommentCount: 1, knownCommentCount: 1, newCommentCount: 1,
    quality: { comment_count: 1 }
  });
  const second = makeCaptureRecord({
    captureId: "second", capturedAt: "2026-08-08T12:00:00.000Z", sourceUrl: post.canonical_url,
    postFullname: post.fullname, collectedCommentCount: 2, knownCommentCount: 2, newCommentCount: 1,
    quality: { comment_count: 2 }, status: "completed"
  });
  const thread = buildThreadDocument(document, [originalComment, newComment], [first, second], "2026-08-08T12:00:01.000Z");
  assert.equal(thread.schema, "reddit-rpa-thread-v1");
  assert.equal(thread.capture_count, 2);
  assert.equal(thread.comments.length, 2);
  assert.equal(thread.latest_capture.capture_id, "second");
  assert.equal(thread.quality.comment_count, 2);
  assert.equal(first.reported_comment_count, null);
  const zeroReported = makeCaptureRecord({
    captureId: "zero", capturedAt: "2026-08-09T12:00:00.000Z", sourceUrl: post.canonical_url,
    postFullname: post.fullname, reportedCommentCount: 0, commentCountGap: 0, coverageStatus: "complete"
  });
  assert.equal(zeroReported.reported_comment_count, 0);
  assert.equal(zeroReported.comment_count_gap, 0);
  assert.equal(zeroReported.coverage_status, "complete");
  const audited = makeCaptureRecord({
    captureId: "audited", capturedAt: "2026-08-10T12:00:00.000Z", sourceUrl: post.canonical_url,
    postFullname: post.fullname, reportedCommentCount: 25, collectedCommentCount: 25, visibleCommentCount: 25,
    settleWaitMs: 1500, navigationJitterMs: 750, totalWaitMs: 2250, zeroCommentRecheckCount: 1,
    pageEvents: [{
      url: post.canonical_url, record_count: 26, reported_comment_count: 25, visible_comment_count: 25,
      settle_wait_ms: 1500, navigation_jitter_ms: 750, total_wait_ms: 2250,
      progress_watchdog_timeout_ms: 45000, zero_comment_recheck: true,
      initial_reported_comment_count: 0, initial_collected_comment_count: 0,
      zero_comment_recheck_wait_ms: 1500, expansion_events: [{ pass: 1, clicked: 2 }], at: "2026-08-10T12:00:00.000Z"
    }]
  });
  assert.equal(audited.settle_wait_ms, 1500);
  assert.equal(audited.navigation_jitter_ms, 750);
  assert.equal(audited.total_wait_ms, 2250);
  assert.equal(audited.zero_comment_recheck_count, 1);
  assert.equal(audited.visible_comment_count, 25);
  assert.equal(audited.page_events.length, 1);
  assert.equal(audited.page_events[0].visible_comment_count, 25);
  assert.equal(audited.page_events[0].initial_reported_comment_count, 0);
  assert.equal(audited.page_events[0].zero_comment_recheck, true);

  const diagnosed = makeCaptureRecord({
    captureId: "diagnosed", capturedAt: "2026-08-11T12:00:00.000Z", sourceUrl: post.canonical_url,
    postFullname: post.fullname,
    treeDiagnostics: {
      deleted_placeholder_count: 1,
      removed_placeholder_count: 0,
      collapsed_placeholder_count: 2,
      unmapped_native_parent_path_count: 1,
      reason_codes: ["DELETED_ANCESTOR_OBSERVED", "DELETED_ANCESTOR_OBSERVED"]
    }
  });
  assert.deepEqual(diagnosed.tree_diagnostics, {
    deleted_placeholder_count: 1,
    removed_placeholder_count: 0,
    collapsed_placeholder_count: 2,
    unmapped_native_parent_path_count: 1,
    reason_codes: ["DELETED_ANCESTOR_OBSERVED"]
  });
});
