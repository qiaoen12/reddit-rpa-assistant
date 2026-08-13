export function validNavigationId(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || ""));
}

export function validPostFullname(value) {
  return /^t3_[A-Za-z0-9]+$/i.test(String(value || ""));
}

export function navigationLeaseTimeoutMs(config = {}) {
  const requested = Number(config?.navigationTimeoutMs ?? config?.progressTimeoutMs);
  const fallback = 60000;
  return Math.max(30000, Math.min(300000, Number.isFinite(requested) ? requested : fallback));
}

export function rateLimitCooldownMs(config = {}) {
  const requested = Number(config?.rateLimitCooldownMs);
  return Math.max(15000, Math.min(300000, Number.isFinite(requested) ? requested : 60000));
}

export function navigationLeaseMatches(lease, event = {}) {
  return Boolean(
    lease
    && String(lease.batch_id || "") === String(event.batch_id || "")
    && String(lease.post_fullname || "").toLowerCase() === String(event.post_fullname || "").toLowerCase()
    && String(lease.navigation_id || "") === String(event.navigation_id || "")
  );
}

export function navigationFailureFromTab(changeInfo = {}, tab = {}) {
  const title = String(changeInfo.title ?? tab.title ?? "");
  const url = String(changeInfo.url ?? tab.url ?? "");
  const isChromeErrorPage = /^chrome-error:/iu.test(url);
  if (/\bERR_BLOCKED_BY_CLIENT\b/iu.test(`${title} ${url}`)) {
    return {
      failure_kind: "CLIENT_BLOCKED",
      reason_code: "CLIENT_BLOCKED",
      reason: "浏览器或本机客户端拦截了工作页请求；未将其归因于 Reddit。",
      evidence_source: "tab_metadata",
      displayed_http_status: null,
      rate_limited: false
    };
  }
  if (/\bHTTP\s+ERROR\s+429\b/iu.test(title) || (isChromeErrorPage && /\b429\b/iu.test(title))) {
    return {
      failure_kind: "HTTP_429_ERROR_PAGE_OBSERVED",
      reason_code: "HTTP_429_ERROR_PAGE_OBSERVED",
      reason: "浏览器工作页显示 HTTP 429；来源服务端未由本扩展验证。",
      evidence_source: "tab_metadata",
      displayed_http_status: 429,
      rate_limited: true
    };
  }
  if (isChromeErrorPage || /\bHTTP\s+ERROR\s+\d{3}\b/iu.test(title)) {
    return {
      failure_kind: "NAVIGATION_ERROR_PAGE",
      reason_code: "NAVIGATION_ERROR_PAGE",
      reason: "浏览器工作页显示导航错误；未从页面 DOM 取得可归因的服务端状态。",
      evidence_source: "tab_metadata",
      displayed_http_status: null,
      rate_limited: false
    };
  }
  return null;
}

export function navigationFailureContext(batch, target) {
  const postFullname = String(target?.post?.fullname || target?.fullname || "");
  const permalink = String(target?.permalink || target?.post?.canonical_url || "");
  return {
    ...(batch?.context || {}),
    page_type: "thread",
    source_url: permalink || null,
    canonical_url: permalink || null,
    post_fullname: postFullname || null,
    post_id: postFullname.replace(/^t3_/iu, "") || null
  };
}

export function navigationFailureEvent({ batchEventSchema, batch, target, lease, failure, observedAt }) {
  const sequence = (Number(batch.event_seq) || 0) + 1;
  const startedAt = Date.parse(batch.started_at || "");
  return {
    schema: batchEventSchema,
    batch_id: batch.batch_id,
    seq: sequence,
    at: observedAt,
    event: failure.failure_kind === "PAGE_NAVIGATION_TIMEOUT" ? "navigation_timeout" : "navigation_error_observed",
    post_fullname: target.post?.fullname || target.fullname || null,
    elapsed_ms: Number.isFinite(startedAt) ? Math.max(0, Date.parse(observedAt) - startedAt) : null,
    attempt: Number(target.attempts) || 0,
    reason_code: failure.reason_code,
    reason: failure.reason,
    cooldown_ms: failure.cooldown_ms ?? null,
    navigation_id: lease.navigation_id,
    failure_kind: failure.failure_kind,
    evidence_source: failure.evidence_source,
    displayed_http_status: failure.displayed_http_status ?? null
  };
}

export function navigationFailureRecord(lease, failure, observedAt) {
  return {
    navigation_id: lease.navigation_id,
    failure_kind: failure.failure_kind,
    reason_code: failure.reason_code,
    evidence_source: failure.evidence_source,
    displayed_http_status: failure.displayed_http_status ?? null,
    observed_at: observedAt
  };
}
