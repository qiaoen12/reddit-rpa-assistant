import assert from "node:assert/strict";
import test from "node:test";
import {
  navigationFailureContext,
  navigationFailureEvent,
  navigationFailureFromTab,
  navigationFailureRecord,
  navigationLeaseMatches,
  navigationLeaseTimeoutMs,
  rateLimitCooldownMs,
  validNavigationId,
  validPostFullname
} from "../navigation-lease.mjs";

test("keeps navigation identifiers and timing bounds independent from Chrome APIs", () => {
  assert.equal(validNavigationId("nav-1.safe_2"), true);
  assert.equal(validNavigationId("nav/unsafe"), false);
  assert.equal(validPostFullname("t3_AbC123"), true);
  assert.equal(validPostFullname("t1_abc123"), false);
  assert.equal(navigationLeaseTimeoutMs({ navigationTimeoutMs: 1 }), 30000);
  assert.equal(navigationLeaseTimeoutMs({ progressTimeoutMs: 999999 }), 300000);
  assert.equal(rateLimitCooldownMs({ rateLimitCooldownMs: 1 }), 15000);
  assert.equal(rateLimitCooldownMs({ rateLimitCooldownMs: 999999 }), 300000);
});

test("classifies only browser-visible navigation failures without attributing their source", () => {
  assert.equal(
    navigationFailureFromTab({ title: "ERR_BLOCKED_BY_CLIENT" }, { url: "chrome-error://chromewebdata/" }).failure_kind,
    "CLIENT_BLOCKED"
  );
  const observed429 = navigationFailureFromTab({ title: "HTTP ERROR 429" }, { url: "chrome-error://chromewebdata/" });
  assert.equal(observed429.failure_kind, "HTTP_429_ERROR_PAGE_OBSERVED");
  assert.equal(observed429.rate_limited, true);
  assert.equal(
    navigationFailureFromTab({ title: "HTTP ERROR 500" }, { url: "chrome-error://chromewebdata/" }).failure_kind,
    "NAVIGATION_ERROR_PAGE"
  );
  assert.equal(navigationFailureFromTab({ title: "Reddit" }, { url: "https://www.reddit.com/" }), null);
});

test("builds failure audit records from the lease and preserves the batch event sequence", () => {
  const lease = { batch_id: "batch-1", post_fullname: "t3_abc123", navigation_id: "nav-1" };
  assert.equal(navigationLeaseMatches(lease, { ...lease, post_fullname: "T3_ABC123" }), true);
  assert.equal(navigationLeaseMatches(lease, { ...lease, navigation_id: "nav-2" }), false);

  const failure = {
    failure_kind: "HTTP_429_ERROR_PAGE_OBSERVED",
    reason_code: "HTTP_429_ERROR_PAGE_OBSERVED",
    reason: "浏览器工作页显示 HTTP 429；来源服务端未由本扩展验证。",
    evidence_source: "tab_metadata",
    displayed_http_status: 429,
    rate_limited: true,
    cooldown_ms: 60000
  };
  const observedAt = "2026-08-12T00:01:00.000Z";
  const batch = { batch_id: "batch-1", event_seq: 4, started_at: "2026-08-12T00:00:00.000Z", context: { subreddit: "SteamVR" } };
  const target = { post: { fullname: "t3_abc123" }, permalink: "https://www.reddit.com/r/SteamVR/comments/abc123/example/", attempts: 2 };

  const record = navigationFailureRecord(lease, failure, observedAt);
  assert.deepEqual(record, {
    navigation_id: "nav-1",
    failure_kind: "HTTP_429_ERROR_PAGE_OBSERVED",
    reason_code: "HTTP_429_ERROR_PAGE_OBSERVED",
    evidence_source: "tab_metadata",
    displayed_http_status: 429,
    observed_at: observedAt
  });
  assert.deepEqual(navigationFailureContext(batch, target), {
    subreddit: "SteamVR",
    page_type: "thread",
    source_url: target.permalink,
    canonical_url: target.permalink,
    post_fullname: "t3_abc123",
    post_id: "abc123"
  });
  const event = navigationFailureEvent({
    batchEventSchema: "reddit-rpa-batch-event-v1",
    batch,
    target,
    lease,
    failure,
    observedAt
  });
  assert.equal(batch.event_seq, 4, "event construction must not mutate batch state");
  assert.equal(event.seq, 5);
  assert.equal(event.event, "navigation_error_observed");
  assert.equal(event.elapsed_ms, 60000);
  assert.equal(event.cooldown_ms, 60000);
});
