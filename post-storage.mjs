export const POST_DOCUMENT_SCHEMA = "reddit-rpa-post-v1";
export const THREAD_DOCUMENT_SCHEMA = "reddit-rpa-thread-v1";
export const THREAD_CAPTURE_SCHEMA = "reddit-rpa-thread-capture-v1";

function asText(value) {
  return String(value ?? "").trim();
}

function stableRecords(records, recordType) {
  const byFullname = new Map();
  for (const record of records || []) {
    if (!record || record.record_type !== recordType || !asText(record.fullname)) continue;
    if (!byFullname.has(record.fullname)) byFullname.set(record.fullname, record);
  }
  return [...byFullname.values()].sort((left, right) => {
    const leftTime = left.published_at || left.captured_at || "";
    const rightTime = right.published_at || right.captured_at || "";
    return leftTime.localeCompare(rightTime) || left.fullname.localeCompare(right.fullname);
  });
}

export function parseJsonLines(text) {
  const records = [];
  for (const [index, line] of String(text || "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`JSONL 第 ${index + 1} 行无效。`);
    }
  }
  return records;
}

export function serialiseJsonLines(records) {
  const rows = Array.isArray(records) ? records : [];
  return rows.length ? `${rows.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
}

export function makePostDocument(post, directory, capturedAt) {
  if (!post?.fullname || post.record_type !== "post") throw new Error("帖子记录无效。");
  return {
    schema: POST_DOCUMENT_SCHEMA,
    created_at: capturedAt,
    directory: {
      name: directory.directoryName,
      post_id: directory.postId,
      url_slug: directory.urlSlug
    },
    post
  };
}

export function buildThreadDocument(postDocument, comments, captures, generatedAt) {
  if (postDocument?.schema !== POST_DOCUMENT_SCHEMA || !postDocument.post) throw new Error("帖子目录缺少有效 post.json。");
  const allComments = stableRecords(comments, "comment");
  const captureRows = Array.isArray(captures) ? captures : [];
  const firstCapture = captureRows[0]?.captured_at || postDocument.created_at || generatedAt;
  const lastCapture = captureRows.at(-1)?.captured_at || firstCapture;
  return {
    schema: THREAD_DOCUMENT_SCHEMA,
    generated_at: generatedAt,
    first_captured_at: firstCapture,
    last_captured_at: lastCapture,
    capture_count: captureRows.length,
    post: postDocument.post,
    comments: allComments,
    latest_capture: captureRows.at(-1) || null,
    quality: captureRows.at(-1)?.quality || null
  };
}

function nonNegativeNumber(value) {
  return Math.max(0, Number(value) || 0);
}

function pageEventSnapshot(events) {
  return (Array.isArray(events) ? events : []).slice(0, 50).map((event) => ({
    url: asText(event?.url) || null,
    record_count: nonNegativeNumber(event?.record_count),
    reported_comment_count: event?.reported_comment_count == null || !Number.isFinite(Number(event.reported_comment_count))
      ? null
      : Number(event.reported_comment_count),
    visible_comment_count: event?.visible_comment_count == null || !Number.isFinite(Number(event.visible_comment_count))
      ? null
      : Number(event.visible_comment_count),
    rejected_foreign_comment_count: nonNegativeNumber(event?.rejected_foreign_comment_count),
    settle_wait_ms: nonNegativeNumber(event?.settle_wait_ms),
    navigation_jitter_ms: nonNegativeNumber(event?.navigation_jitter_ms),
    total_wait_ms: nonNegativeNumber(event?.total_wait_ms),
    progress_watchdog_timeout_ms: nonNegativeNumber(event?.progress_watchdog_timeout_ms),
    zero_comment_recheck: Boolean(event?.zero_comment_recheck),
    initial_reported_comment_count: event?.initial_reported_comment_count == null || !Number.isFinite(Number(event.initial_reported_comment_count))
      ? null
      : Number(event.initial_reported_comment_count),
    initial_collected_comment_count: nonNegativeNumber(event?.initial_collected_comment_count),
    zero_comment_recheck_wait_ms: nonNegativeNumber(event?.zero_comment_recheck_wait_ms),
    expansion_events: Array.isArray(event?.expansion_events) ? event.expansion_events : [],
    at: event?.at || null
  }));
}

function treeDiagnosticsSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = (field) => nonNegativeNumber(value[field]);
  return {
    deleted_placeholder_count: count("deleted_placeholder_count"),
    removed_placeholder_count: count("removed_placeholder_count"),
    collapsed_placeholder_count: count("collapsed_placeholder_count"),
    unmapped_native_parent_path_count: count("unmapped_native_parent_path_count"),
    reason_codes: [...new Set((value.reason_codes || []).map((code) => asText(code)).filter(Boolean))]
  };
}

export function makeCaptureRecord({ captureId, capturedAt, sourceUrl, postFullname, reportedCommentCount = null, collectedCommentCount = 0, knownCommentCount = 0, newCommentCount = 0, coverageStatus = null, commentCountGap = null, visibleCommentCount = null, rejectedForeignCommentCount = 0, settleWaitMs = 0, navigationJitterMs = 0, totalWaitMs = 0, zeroCommentRecheckCount = 0, pageEvents = [], treeDiagnostics = null, quality = null, status = "complete", error = null }) {
  const reportedCount = reportedCommentCount == null || reportedCommentCount === "" || !Number.isFinite(Number(reportedCommentCount))
    ? null
    : Number(reportedCommentCount);
  const countGap = commentCountGap == null || commentCountGap === "" || !Number.isFinite(Number(commentCountGap))
    ? null
    : Number(commentCountGap);
  const visibleCount = visibleCommentCount == null || visibleCommentCount === "" || !Number.isFinite(Number(visibleCommentCount))
    ? null
    : Number(visibleCommentCount);
  return {
    schema: THREAD_CAPTURE_SCHEMA,
    capture_id: asText(captureId),
    captured_at: capturedAt,
    source_url: asText(sourceUrl) || null,
    post_fullname: asText(postFullname),
    reported_comment_count: reportedCount,
    collected_comment_count: nonNegativeNumber(collectedCommentCount),
    known_comment_count: nonNegativeNumber(knownCommentCount),
    new_comment_count: nonNegativeNumber(newCommentCount),
    coverage_status: asText(coverageStatus) || status,
    comment_count_gap: countGap,
    visible_comment_count: visibleCount,
    rejected_foreign_comment_count: nonNegativeNumber(rejectedForeignCommentCount),
    settle_wait_ms: nonNegativeNumber(settleWaitMs),
    navigation_jitter_ms: nonNegativeNumber(navigationJitterMs),
    total_wait_ms: nonNegativeNumber(totalWaitMs),
    zero_comment_recheck_count: nonNegativeNumber(zeroCommentRecheckCount),
    page_events: pageEventSnapshot(pageEvents),
    tree_diagnostics: treeDiagnosticsSnapshot(treeDiagnostics),
    quality: quality || null,
    status,
    error: error ? asText(error) : null
  };
}
