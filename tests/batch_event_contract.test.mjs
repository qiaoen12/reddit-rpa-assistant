import assert from "node:assert/strict";
import test from "node:test";
import {
  navigationEventConcludesLease,
  normaliseBatchEvent,
  normaliseTreeDiagnostics,
  validBatchId
} from "../batch-event-contract.mjs";

test("normalises a batch event without relying on Worker storage or Native Messaging", () => {
  const event = normaliseBatchEvent({
    batch_id: "batch-1",
    seq: 2,
    at: "2026-08-12T00:00:00.000Z",
    event: "navigation_error_observed",
    post_fullname: "t3_abc123",
    navigation_id: "nav-1",
    failure_kind: "HTTP_429_ERROR_PAGE_OBSERVED",
    evidence_source: "tab_metadata",
    displayed_http_status: 429,
    elapsed_ms: 1500.4,
    attempt: 1.8,
    cooldown_ms: -4,
    tree_diagnostics: { collapsed_placeholder_count: 2.9, reason_codes: ["MISSING_PARENT", "MISSING_PARENT", ""] }
  });

  assert.equal(event.schema, "reddit-rpa-batch-event-v1");
  assert.equal(event.event_id, "batch-1:2");
  assert.equal(event.elapsed_ms, 1500);
  assert.equal(event.attempt, 1);
  assert.equal(event.cooldown_ms, 0);
  assert.deepEqual(event.tree_diagnostics, {
    deleted_placeholder_count: 0,
    removed_placeholder_count: 0,
    collapsed_placeholder_count: 2,
    unmapped_native_parent_path_count: 0,
    reason_codes: ["MISSING_PARENT"]
  });
});

test("rejects invalid event fields before a batch event can be written", () => {
  assert.equal(validBatchId("batch-2026.08_12"), true);
  assert.equal(validBatchId("batch/path"), false);
  assert.throws(
    () => normaliseBatchEvent({ batch_id: "batch-1", seq: 1, event: "unexpected" }),
    (error) => error.code === "BATCH_EVENT_INVALID"
  );
  assert.throws(
    () => normaliseBatchEvent({ batch_id: "batch-1", seq: 1, event: "page_ready", post_fullname: "t1_abc123" }),
    (error) => error.code === "BATCH_EVENT_INVALID"
  );
  assert.throws(
    () => normaliseBatchEvent({ batch_id: "batch-1", seq: 1, event: "page_ready", displayed_http_status: 700 }),
    (error) => error.code === "BATCH_EVENT_INVALID"
  );
});

test("keeps lease completion semantics explicit", () => {
  assert.equal(navigationEventConcludesLease("page_ready"), true);
  assert.equal(navigationEventConcludesLease("navigation_timeout"), true);
  assert.equal(navigationEventConcludesLease("batch_started"), false);
  assert.equal(normaliseTreeDiagnostics(null), null);
});
