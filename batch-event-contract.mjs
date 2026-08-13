import { validNavigationId, validPostFullname } from "./navigation-lease.mjs";

export const BATCH_EVENT_NAMES = new Set([
  "batch_started", "post_navigation_started", "page_ready", "capture_saved",
  "retry", "paused", "resumed", "rate_limited", "rate_limit_cooldown_complete",
  "permission_required", "navigation_error_observed", "navigation_timeout", "batch_finished", "cancelled"
]);

export const NAVIGATION_FAILURE_KINDS = new Set([
  "HTTP_429_ERROR_PAGE_OBSERVED", "REDDIT_RATE_LIMIT_PAGE", "CLIENT_BLOCKED",
  "NAVIGATION_ERROR_PAGE", "PAGE_NAVIGATION_TIMEOUT"
]);

export const NAVIGATION_EVIDENCE_SOURCES = new Set(["page_dom", "tab_metadata", "background_watchdog"]);

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validBatchId(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || ""));
}

export function normaliseTreeDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = (field) => Math.max(0, Math.floor(Number(value[field]) || 0));
  return {
    deleted_placeholder_count: count("deleted_placeholder_count"),
    removed_placeholder_count: count("removed_placeholder_count"),
    collapsed_placeholder_count: count("collapsed_placeholder_count"),
    unmapped_native_parent_path_count: count("unmapped_native_parent_path_count"),
    reason_codes: [...new Set((value.reason_codes || []).map((code) => String(code || "").trim()).filter(Boolean))]
  };
}

export function normaliseBatchEvent(event = {}, { schema = "reddit-rpa-batch-event-v1" } = {}) {
  const batchId = String(event.batch_id || "").trim();
  const eventName = String(event.event || "").trim();
  const sequence = Number(event.seq);
  if (!validBatchId(batchId)) throw contractError("BATCH_ID_INVALID", "批次事件缺少有效 batch_id，未写入事件日志。");
  if (!BATCH_EVENT_NAMES.has(eventName)) throw contractError("BATCH_EVENT_INVALID", "批次事件类型无效，未写入事件日志。");
  if (!Number.isInteger(sequence) || sequence < 1) throw contractError("BATCH_EVENT_INVALID", "批次事件缺少有效序号，未写入事件日志。");
  const postFullname = event.post_fullname == null ? null : String(event.post_fullname);
  if (postFullname && !validPostFullname(postFullname)) {
    throw contractError("BATCH_EVENT_INVALID", "批次事件的帖子代码无效，未写入事件日志。");
  }
  const navigationId = event.navigation_id == null ? null : String(event.navigation_id).trim();
  if (navigationId && !validNavigationId(navigationId)) {
    throw contractError("BATCH_EVENT_INVALID", "批次事件的导航标识无效，未写入事件日志。");
  }
  const failureKind = event.failure_kind == null ? null : String(event.failure_kind).trim();
  if (failureKind && !NAVIGATION_FAILURE_KINDS.has(failureKind)) {
    throw contractError("BATCH_EVENT_INVALID", "批次事件的失败分类无效，未写入事件日志。");
  }
  const evidenceSource = event.evidence_source == null ? null : String(event.evidence_source).trim();
  if (evidenceSource && !NAVIGATION_EVIDENCE_SOURCES.has(evidenceSource)) {
    throw contractError("BATCH_EVENT_INVALID", "批次事件的证据来源无效，未写入事件日志。");
  }
  const displayedHttpStatus = event.displayed_http_status == null ? null : Number(event.displayed_http_status);
  if (displayedHttpStatus != null && (!Number.isInteger(displayedHttpStatus) || displayedHttpStatus < 100 || displayedHttpStatus > 599)) {
    throw contractError("BATCH_EVENT_INVALID", "批次事件的 HTTP 状态无效，未写入事件日志。");
  }
  return {
    schema,
    event_id: `${batchId}:${sequence}`,
    seq: sequence,
    at: String(event.at || new Date().toISOString()),
    batch_id: batchId,
    event: eventName,
    post_fullname: postFullname,
    elapsed_ms: Number.isFinite(Number(event.elapsed_ms)) ? Math.max(0, Math.round(Number(event.elapsed_ms))) : null,
    attempt: Number.isFinite(Number(event.attempt)) ? Math.max(0, Math.floor(Number(event.attempt))) : null,
    reason_code: event.reason_code == null ? null : String(event.reason_code),
    reason: event.reason == null ? null : String(event.reason),
    reported_comment_count: Number.isFinite(Number(event.reported_comment_count)) ? Number(event.reported_comment_count) : null,
    collected_comment_count: Number.isFinite(Number(event.collected_comment_count)) ? Number(event.collected_comment_count) : null,
    cooldown_ms: Number.isFinite(Number(event.cooldown_ms)) ? Math.max(0, Math.round(Number(event.cooldown_ms))) : null,
    tree_diagnostics: normaliseTreeDiagnostics(event.tree_diagnostics),
    navigation_id: navigationId,
    failure_kind: failureKind,
    evidence_source: evidenceSource,
    displayed_http_status: displayedHttpStatus
  };
}

export function navigationEventConcludesLease(eventName) {
  return new Set([
    "page_ready", "capture_saved", "retry", "rate_limited", "navigation_error_observed",
    "navigation_timeout", "paused", "batch_finished", "cancelled"
  ]).has(eventName);
}
