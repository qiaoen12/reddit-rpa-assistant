(() => {
  function copyTarget(target) {
    return { ...target, attempts: Number(target?.attempts) || 0 };
  }

  function create({ context, targets, config, startedAt }) {
    const queue = (targets || []).map(copyTarget);
    return {
      active: true,
      paused: false,
      context,
      selected_count: queue.length,
      queue,
      current: null,
      completed: [],
      tree_partial: [],
      manual: [],
      failed: [],
      started_at: startedAt,
      config
    };
  }

  function claimNext(job, at) {
    if (!job?.active) return { status: "inactive", target: null };
    if (job.paused) return { status: "paused", target: null };
    if (job.current) return { status: "current", target: job.current };
    job.current = job.queue.shift() || null;
    if (!job.current) {
      job.active = false;
      job.completed_at = at;
      return { status: "completed", target: null };
    }
    return { status: "claimed", target: job.current };
  }

  function pause(job) {
    if (!job?.active) return false;
    job.paused = true;
    return true;
  }

  function resume(job) {
    if (!job?.active) return false;
    job.paused = false;
    return true;
  }

  function cancel(job, at, reason = "manual") {
    if (!job?.active) return false;
    job.active = false;
    job.paused = false;
    job.cancelled = true;
    job.cancelled_at = at;
    job.cancel_reason = String(reason || "manual");
    return true;
  }

  function retry(job, error) {
    if (!job?.active || !job.current) return { retry: false, target: null };
    if (Number(job.current.attempts) >= 1) return { retry: false, target: job.current };
    job.current.attempts = Number(job.current.attempts || 0) + 1;
    job.current.last_error = String(error || "");
    return { retry: true, target: job.current };
  }

  function finish(job, outcome, at) {
    if (!job?.active || !job.current) return null;
    const target = job.current;
    const item = {
      fullname: target.post?.fullname || null,
      title: target.post?.title || "",
      permalink: target.permalink,
      attempts: Number(target.attempts) || 0,
      finished_at: at,
      ...outcome
    };
    if (outcome?.status === "complete") (job.completed ||= []).push(item);
    else if (outcome?.status === "tree_partial") (job.tree_partial ||= []).push(item);
    else if (outcome?.status === "manual") (job.manual ||= []).push(item);
    else (job.failed ||= []).push(item);
    job.current = null;
    if (!job.queue.length) {
      job.active = false;
      job.completed_at = at;
    }
    return item;
  }

  globalThis.RedditRpaBatchQueue = { create, claimNext, pause, resume, cancel, retry, finish };
})();
