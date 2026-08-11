const assert = require("node:assert/strict");
const test = require("node:test");

require("../batch-queue.js");
const queue = globalThis.RedditRpaBatchQueue;

function target(id) {
  return { post: { fullname: `t3_${id}`, title: id }, permalink: `https://www.reddit.com/r/test/comments/${id}/title/` };
}

test("defaults to a sequential queue and supports pause, resume, retry, manual review, and failure continuation", () => {
  const job = queue.create({ context: { subreddit: "test" }, targets: [target("one"), target("two")], config: {}, startedAt: "start" });
  assert.equal(job.selected_count, 2);
  assert.equal(queue.claimNext(job, "one").target.post.fullname, "t3_one");
  assert.equal(queue.pause(job), true);
  assert.equal(job.current.attempts, 0, "暂停不应消耗当前帖子的重试次数");
  assert.equal(queue.claimNext(job, "two").status, "paused");
  assert.equal(queue.resume(job), true);
  assert.equal(queue.retry(job, "first failure").retry, true);
  assert.equal(job.current.attempts, 1);
  assert.equal(queue.retry(job, "second failure").retry, false);
  queue.finish(job, { status: "failed", error: "second failure" }, "three");
  assert.equal(job.failed.length, 1);
  assert.equal(queue.claimNext(job, "four").target.post.fullname, "t3_two");
  queue.finish(job, { status: "complete" }, "five");
  assert.equal(job.active, false);
  assert.equal(job.completed.length, 1);
  assert.equal(job.failed.length, 1);
  assert.equal(job.manual.length, 0);
});

test("keeps retry exhausted targets in the manual review bucket", () => {
  const job = queue.create({ context: { subreddit: "test" }, targets: [target("manual")], config: {}, startedAt: "start" });
  queue.claimNext(job, "one");
  queue.retry(job, "first failure");
  queue.finish(job, { status: "manual", error: "needs review" }, "two");
  assert.equal(job.active, false);
  assert.equal(job.completed.length, 0);
  assert.equal(job.manual.length, 1);
  assert.equal(job.failed.length, 0);
});

test("keeps a count-complete but parent-partial tree out of retry and manual buckets", () => {
  const job = queue.create({ context: { subreddit: "test" }, targets: [target("partial")], config: {}, startedAt: "start" });
  queue.claimNext(job, "one");
  queue.finish(job, { status: "tree_partial", error: "无法确认部分父级" }, "two");
  assert.equal(job.active, false);
  assert.equal(job.tree_partial.length, 1);
  assert.equal(job.tree_partial[0].status, "tree_partial");
  assert.equal(job.manual.length, 0);
  assert.equal(job.failed.length, 0);
});

test("lets an operator end a paused batch without losing completed or outstanding targets", () => {
  const job = queue.create({ context: { subreddit: "test" }, targets: [target("one"), target("two")], config: {}, startedAt: "start" });
  queue.claimNext(job, "one");
  queue.finish(job, { status: "complete" }, "two");
  queue.claimNext(job, "three");
  queue.pause(job);
  assert.equal(queue.cancel(job, "four", "manual"), true);
  assert.equal(job.active, false);
  assert.equal(job.paused, false);
  assert.equal(job.cancelled, true);
  assert.equal(job.cancelled_at, "four");
  assert.equal(job.cancel_reason, "manual");
  assert.equal(job.completed.length, 1);
  assert.equal(job.current.post.fullname, "t3_two", "当前未完成目标要保留在审计清单中");
});
