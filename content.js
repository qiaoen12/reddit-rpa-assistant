(() => {
  const CONTENT_SCRIPT_VERSION = "0.8.2";
  const CONTENT_SCRIPT_CONTROLLER_KEY = "__redditRpaContentScriptController";
  // 扩展重载会让旧内容脚本的 chrome.runtime 失效，但页面的 isolated
  // world 仍可能保留旧全局变量。新脚本必须接管，而不能被旧布尔标记拦住。
  try {
    globalThis[CONTENT_SCRIPT_CONTROLLER_KEY]?.dispose?.();
  } catch {
    // 旧扩展上下文已失效时，清理动作可能不可用；新控制器仍应接管页面。
  }
  // 旧版本用此标记阻止重复注入；现在以可释放的 controller 为唯一真相。
  // 清除遗留标记，避免它被误解为仍在使用的生命周期状态。
  delete globalThis.__redditRpaContentScriptLoaded;

  const STATE_KEY = "reddit-rpa-capture-state-v1";
  const MAX_THREAD_EXPANSION_PASSES = 14;
  const MAX_CONTROLS_PER_PASS = 30;
  const NAVIGATION_DISPATCH_DELAY_MS = 250;
  const CONTROL_POLL_INTERVAL_MS = 1000;
  const RATE_LIMIT_PAGE_TEXT = /(?:you(?:'|’)ve been doing that a lot|whoa there, pardner|too many requests|rate limit(?:ed)?|try again later)/iu;
  const HTTP_429_PAGE_TEXT = /\bHTTP\s+ERROR\s+429\b/iu;
  const collectorConfig = globalThis.RedditRpaCollectorConfig;
  const model = globalThis.RedditRpaModel;
  const selectors = globalThis.RedditRpaDomSelectors;
  const batchQueue = globalThis.RedditRpaBatchQueue;
  const listingSelection = globalThis.RedditRpaListingSelection;
  const pageContextModule = globalThis.RedditRpaPageContext;
  const recordExtractorModule = globalThis.RedditRpaRecordExtractor;
  const commandRegistryModule = globalThis.RedditRpaCommandRegistry;
  if (!collectorConfig?.DEFAULT_CONFIG || !model || !selectors || !batchQueue || !listingSelection
    || typeof pageContextModule?.create !== "function" || typeof recordExtractorModule?.create !== "function"
    || typeof commandRegistryModule?.create !== "function") {
    console.error("Reddit RPA 页面采集依赖未加载。");
    return;
  }
  const { DEFAULT_CONFIG } = collectorConfig;
  const pageContext = pageContextModule.create({
    model,
    documentRef: document,
    locationRef: location,
    URLCtor: URL
  });
  const {
    normalisedPageUrl,
    textOf,
    attributeOf,
    absoluteUrl,
    firstText,
    subredditFromDocument,
    currentContext,
    contextsMatch,
    postContextsMatch,
    threadTargetContext
  } = pageContext;
  const {
    thingFullname,
    postNodes,
    collectListing,
    collectThread,
    mergeListingRecords
  } = recordExtractorModule.create({
    model,
    selectors,
    documentRef: document,
    pageContext
  });

  const state = {
    records: [],
    context: null,
    activeThreadJob: null,
    activeBatchJob: null,
    pendingControlRun: null,
    pendingRecoveryRun: null,
    lastResult: null,
    version: CONTENT_SCRIPT_VERSION
  };

  let hasHydrated = false;
  let resumeInFlight = false;
  let navigationResumeTimer = null;
  let threadProgressWatchdog = null;
  let commandResponsePending = false;
  let deferredThreadNavigation = null;
  let navigationDispatchTimer = null;
  let pageNavigationWatcher = null;
  let commandMessageListener = null;
  let controlPollTimer = null;
  let controlPollInFlight = false;
  let rateLimitResumeTimer = null;
  let disposed = false;
  let lastObservedPageUrl = normalisedPageUrl();
  const controller = {
    version: CONTENT_SCRIPT_VERSION,
    dispose: disposeController
  };
  globalThis[CONTENT_SCRIPT_CONTROLLER_KEY] = controller;
  const ready = hydrate();
  watchPageNavigation();
  startControlPoller();

  function runtimeAvailable() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function extensionContextInvalidated(error) {
    return !runtimeAvailable() || /Extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function invalidatedContextError() {
    const error = new Error("扩展已重载，旧页面脚本已失效；正在由新脚本接管当前页面。");
    error.code = "EXTENSION_CONTEXT_INVALIDATED";
    return error;
  }

  function disposeController() {
    if (disposed) return;
    disposed = true;
    clearThreadProgressWatchdog();
    if (navigationResumeTimer) window.clearTimeout(navigationResumeTimer);
    if (navigationDispatchTimer) window.clearTimeout(navigationDispatchTimer);
    if (pageNavigationWatcher) window.clearInterval(pageNavigationWatcher);
    if (controlPollTimer) window.clearInterval(controlPollTimer);
    if (rateLimitResumeTimer) window.clearTimeout(rateLimitResumeTimer);
    navigationResumeTimer = null;
    navigationDispatchTimer = null;
    pageNavigationWatcher = null;
    controlPollTimer = null;
    rateLimitResumeTimer = null;
    deferredThreadNavigation = null;
    if (commandMessageListener) {
      try {
        chrome.runtime.onMessage.removeListener(commandMessageListener);
      } catch {
        // 旧 runtime 已失效时无需继续清理监听器。
      }
    }
    if (globalThis[CONTENT_SCRIPT_CONTROLLER_KEY] === controller) delete globalThis[CONTENT_SCRIPT_CONTROLLER_KEY];
  }

  async function sendRuntimeMessage(message) {
    if (disposed || !runtimeAvailable()) {
      disposeController();
      throw invalidatedContextError();
    }
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (extensionContextInvalidated(error)) disposeController();
      throw error;
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function threadSettleDelay(config = {}) {
    const requested = Number(config.waitMs);
    return Math.max(250, Math.min(5000, Number.isFinite(requested) ? requested : DEFAULT_CONFIG.waitMs));
  }

  function threadSettlePlan(config = {}, random = Math.random) {
    const settleWaitMs = threadSettleDelay(config);
    const requestedJitter = Number(config.navigationJitterMs);
    const maximumJitterMs = Math.max(0, Math.min(1500, Number.isFinite(requestedJitter) ? requestedJitter : DEFAULT_CONFIG.navigationJitterMs));
    const jitterMs = Math.round(Math.max(0, Math.min(1, Number(random()) || 0)) * maximumJitterMs);
    return { settleWaitMs, jitterMs, totalWaitMs: settleWaitMs + jitterMs };
  }

  function threadProgressTimeout(config = {}) {
    const requested = Number(config.progressTimeoutMs);
    return Math.max(15000, Math.min(120000, Number.isFinite(requested) ? requested : DEFAULT_CONFIG.progressTimeoutMs));
  }

  function navigationLeaseTimeout(config = {}) {
    const requested = Number(config.navigationTimeoutMs ?? config.progressTimeoutMs);
    return Math.max(30000, Math.min(300000, Number.isFinite(requested) ? requested : DEFAULT_CONFIG.navigationTimeoutMs));
  }

  function clearThreadProgressWatchdog() {
    if (threadProgressWatchdog) window.clearTimeout(threadProgressWatchdog);
    threadProgressWatchdog = null;
  }

  function currentThreadJob(job) {
    return Boolean(job?.active && state.activeThreadJob === job);
  }

  function startThreadProgressWatchdog(job, pageUrl) {
    clearThreadProgressWatchdog();
    const timeoutMs = threadProgressTimeout(job?.config);
    threadProgressWatchdog = window.setTimeout(() => {
      threadProgressWatchdog = null;
      if (!currentThreadJob(job) || job.visited_urls?.includes(pageUrl) || normalisedPageUrl() !== pageUrl) return;
      const error = new Error(`页面在 ${Math.round(timeoutMs / 1000)} 秒内没有完成采集。`);
      error.code = "PAGE_NAVIGATION_TIMEOUT";
      recordThreadError(error).catch(() => null);
    }, timeoutMs);
    return timeoutMs;
  }

  function timestampLabel(value = new Date()) {
    const pad = (number, size = 2) => String(number).padStart(size, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}_${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}_${pad(value.getMilliseconds(), 3)}`;
  }

  function navigationId() {
    const suffix = globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 10)
      || Math.random().toString(36).slice(2, 12);
    return `nav-${timestampLabel()}-${suffix}`;
  }

  async function hydrate() {
    try {
      const stored = await chrome.storage.local.get(STATE_KEY);
      if (disposed) return;
      const saved = stored?.[STATE_KEY];
      if (saved && typeof saved === "object") {
        state.records = Array.isArray(saved.records) ? saved.records : [];
        state.context = saved.context || null;
        state.activeThreadJob = saved.activeThreadJob || null;
        state.activeBatchJob = saved.activeBatchJob || null;
        state.pendingControlRun = saved.pendingControlRun || null;
        state.pendingRecoveryRun = saved.pendingRecoveryRun || null;
        state.lastResult = saved.lastResult || null;
      }
      hasHydrated = true;
      scheduleRateLimitResume(state.activeBatchJob);
      scheduleActiveJobResume();
    } catch (error) {
      if (extensionContextInvalidated(error)) {
        // 这是扩展重载前的旧脚本；停止它，交给新注入的控制器接管。
        disposeController();
        return;
      }
      state.lastResult = { ok: false, code: "STATE_LOAD_FAILED", error: String(error?.message || error) };
    }
  }

  function activeJobResumeDelay() {
    const requested = Number(state.activeThreadJob?.config?.waitMs);
    return Math.max(250, Math.min(1000, Number.isFinite(requested) ? requested : 250));
  }

  function scheduleActiveJobResume() {
    if (!hasHydrated || disposed) return;
    if (navigationResumeTimer) window.clearTimeout(navigationResumeTimer);
    navigationResumeTimer = window.setTimeout(() => {
      navigationResumeTimer = null;
      resumeActiveJobForCurrentPage().catch((error) => {
        if (extensionContextInvalidated(error)) return;
        recordThreadError(error).catch((followupError) => {
          if (!extensionContextInvalidated(followupError)) console.error("Reddit RPA 自动恢复失败。", followupError);
        });
      });
    }, activeJobResumeDelay());
  }

  async function resumeActiveJobForCurrentPage() {
    if (!hasHydrated || resumeInFlight) return null;
    resumeInFlight = true;
    try {
      const context = currentContext();
      const pending = state.pendingControlRun;
      const pendingRecovery = state.pendingRecoveryRun;
      if (pending && !state.activeBatchJob?.active && context.page_type === "listing"
        && context.subreddit?.toLowerCase() === String(pending.subreddit || "").toLowerCase()) {
        return await runControlledBatch(pending);
      }
      if (pendingRecovery && !state.activeBatchJob?.active && context.page_type === "listing"
        && context.subreddit?.toLowerCase() === String(pendingRecovery.subreddit || "").toLowerCase()) {
        return await retryUnfinishedBatch(pendingRecovery);
      }
      if (state.activeBatchJob?.active) {
        const worker = await batchWorkerStatus();
        if (!worker?.ok || !worker.owner) return null;
      }
      if (state.activeThreadJob?.active && canResumeThreadJob(context)) return await resumeThreadJob();
      if (state.activeBatchJob?.active && !state.activeBatchJob.paused && !state.activeThreadJob?.active && contextsMatch(state.activeBatchJob.context, context)) {
        return await advanceBatchJob();
      }
      return null;
    } finally {
      resumeInFlight = false;
    }
  }

  function watchPageNavigation() {
    pageNavigationWatcher = window.setInterval(() => {
      if (disposed) return;
      const currentPageUrl = normalisedPageUrl();
      if (currentPageUrl === lastObservedPageUrl) return;
      lastObservedPageUrl = currentPageUrl;
      scheduleActiveJobResume();
    }, 250);
  }

  function startControlPoller() {
    if (controlPollTimer || disposed) return;
    controlPollTimer = window.setInterval(() => {
      pollControlQueue().catch((error) => {
        if (!extensionContextInvalidated(error)) console.debug("Reddit RPA 控制轮询暂不可用。", error);
      });
    }, CONTROL_POLL_INTERVAL_MS);
  }

  async function pollControlQueue() {
    if (disposed || !hasHydrated || controlPollInFlight || !runtimeAvailable()) return null;
    controlPollInFlight = true;
    try {
      return await sendRuntimeMessage({
        type: "reddit-rpa-control-poll",
        context: currentContext(),
        active_batch: batchSummary()
      });
    } finally {
      controlPollInFlight = false;
    }
  }

  async function persist() {
    await chrome.storage.local.set({
      [STATE_KEY]: {
        records: state.records,
        context: state.context,
        activeThreadJob: state.activeThreadJob,
        activeBatchJob: state.activeBatchJob,
        pendingControlRun: state.pendingControlRun,
        pendingRecoveryRun: state.pendingRecoveryRun,
        lastResult: state.lastResult,
        version: CONTENT_SCRIPT_VERSION
      }
    });
  }

  function runtimeError(result, fallback) {
    const error = new Error(result?.error || fallback);
    error.code = result?.code || "WORKER_NOT_OWNER";
    return error;
  }

  async function batchWorkerStatus(batch = state.activeBatchJob) {
    if (!batch?.active) return { ok: true, active: false, owner: true };
    return sendRuntimeMessage({
      type: "reddit-rpa-worker-status",
      worker_token: batch.worker_token || null
    });
  }

  async function requireBatchWorker() {
    const batch = state.activeBatchJob;
    if (!batch?.active) return { ok: true, owner: true };
    const result = await batchWorkerStatus(batch);
    if (!result?.ok || !result.owner) throw runtimeError(result, "当前标签页不是此批量任务的工作标签页。");
    return result;
  }

  async function claimBatchWorker(batchId, expectedTabId = null) {
    const result = await sendRuntimeMessage({
      type: "reddit-rpa-claim-worker",
      batch_id: batchId,
      expected_tab_id: expectedTabId
    });
    if (!result?.ok) throw runtimeError(result, "无法取得批量任务的工作标签页权限。");
    return result;
  }

  async function restoreBatchWorker(batch) {
    const restored = await sendRuntimeMessage({
      type: "reddit-rpa-restore-worker",
      batch_id: batch.batch_id,
      expected_tab_id: batch.worker_tab_id ?? null
    });
    if (!restored?.ok) throw runtimeError(restored, "无法恢复当前批量任务的工作标签页权限。");
    batch.worker_token = restored.worker_token;
    batch.worker_tab_id = restored.tab_id;
    return restored;
  }

  async function releaseBatchWorker(batch = state.activeBatchJob) {
    if (!batch?.worker_token) return { ok: true, status: "worker_not_claimed" };
    const result = await sendRuntimeMessage({
      type: "reddit-rpa-release-worker",
      worker_token: batch.worker_token
    });
    if (!result?.ok) throw runtimeError(result, "无法释放批量任务的工作标签页权限。");
    return result;
  }

  async function persistBatchManifest(batch = state.activeBatchJob) {
    const result = await sendRuntimeMessage({
      type: "reddit-rpa-store-batch",
      context: batch.context,
      batch,
      worker_token: batch.worker_token
    });
    if (!result?.ok) throw runtimeError(result, "无法写入批次目标清单。");
    batch.manifest_path = result.relativePath;
    return result;
  }

  async function startBackgroundNavigationLease(batch, job) {
    const result = await sendRuntimeMessage({
      type: "reddit-rpa-navigation-started",
      worker_token: batch.worker_token,
      batch_id: batch.batch_id,
      post_fullname: job.post_fullname,
      navigation_id: job.navigation_id,
      target_url: job.context.canonical_url,
      timeout_ms: navigationLeaseTimeout(job.config)
    });
    if (!result?.ok) throw runtimeError(result, "无法登记工作页导航租约。");
    return result;
  }

  function ensureNoActiveBatch() {
    if (state.activeBatchJob?.active) {
      throw new Error("批量采集正在运行；请只在它的工作标签页暂停、继续或等待完成，避免多个标签页混入同一批数据。");
    }
  }

  function resetState(reason = "manual") {
    state.records = [];
    state.context = null;
    state.activeThreadJob = null;
    state.activeBatchJob = null;
    state.pendingControlRun = null;
    state.pendingRecoveryRun = null;
    state.lastResult = { ok: true, status: "cleared", reason, cleared_at: model.nowIso() };
  }

  async function clearLocalState() {
    if (state.activeBatchJob?.active) {
      await requireBatchWorker();
      await releaseBatchWorker(state.activeBatchJob);
    }
    resetState("manual");
    await persist();
    return state.lastResult;
  }

  function ensureContext(context) {
    if (!context.subreddit) {
      throw new Error("无法从当前页面识别 subreddit；请打开 r/<name> 列表页或帖子页后重试。");
    }
    if (state.activeBatchJob?.active && !contextsMatch(state.activeBatchJob.context, context)) {
      throw new Error(`批量任务属于 r/${state.activeBatchJob.context.subreddit}；请返回该子版块后再继续。`);
    }
    if (state.context && !contextsMatch(state.context, context) && !state.activeBatchJob?.active) {
      state.records = [];
      state.activeThreadJob = null;
    }
    state.context = { ...state.context, ...context, subreddit: context.subreddit };
  }

  function mergeIntoState(records, expectedPostFullname = null) {
    const merged = model.mergeRecords([...state.records, ...(records || [])]);
    if (!expectedPostFullname) {
      state.records = merged;
      return state.records;
    }
    const comments = model.validateCommentParents(
      merged.filter((record) => record.record_type === "comment"),
      expectedPostFullname
    );
    state.records = model.mergeRecords([
      ...merged.filter((record) => record.record_type !== "comment"),
      ...comments
    ]);
    return state.records;
  }

  function activeButtons() {
    return [...document.querySelectorAll('button, [role="button"]')].filter((node) => {
      const label = model.asText(`${textOf(node)} ${attributeOf(node, ["aria-label", "title"]) || ""}`);
      return model.isExpansionControlLabel(label)
        && attributeOf(node, ["aria-hidden"]) !== "true"
        && !node.disabled
        && node.getClientRects().length > 0;
    });
  }

  async function expandThreadControls(config) {
    const events = [];
    const maximumPasses = Math.min(MAX_THREAD_EXPANSION_PASSES, Math.max(1, Number(config.expansionPasses) || DEFAULT_CONFIG.expansionPasses));
    for (let pass = 0; pass < maximumPasses; pass += 1) {
      const controls = activeButtons().slice(0, MAX_CONTROLS_PER_PASS);
      if (!controls.length) break;
      let clicked = 0;
      for (const control of controls) {
        try {
          control.click();
          clicked += 1;
        } catch { /* A detached control is reflected in quality output. */ }
      }
      events.push({ pass: pass + 1, clicked, at: model.nowIso() });
      await delay(Math.max(200, Number(config.waitMs) || DEFAULT_CONFIG.waitMs));
    }
    return {
      events,
      unexpanded: activeButtons().map((node) => model.asText(`${textOf(node)} ${attributeOf(node, ["aria-label"]) || ""}`)).filter(Boolean)
    };
  }

  function continuationUrls(context) {
    const urls = new Set();
    for (const link of document.querySelectorAll('a[href*="/comments/"]')) {
      const label = model.asText(`${textOf(link)} ${attributeOf(link, ["aria-label", "title"]) || ""}`);
      if (!model.isContinuationThreadLabel(label)) continue;
      const parsed = model.parseRedditUrl(link.href);
      if (!parsed.postId || !context.post_id || parsed.postId.toLowerCase() !== context.post_id.toLowerCase()) continue;
      const href = normalisedPageUrl(link.href);
      if (href) urls.add(href);
    }
    return [...urls];
  }

  function reportedCommentCount(context) {
    const node = postNodes().find((candidate) => thingFullname(candidate, "t3") === context.post_fullname)
      || document.querySelector("shreddit-post");
    const raw = attributeOf(node, ["comment-count", "comment_count", "num-comments", "data-comment-count"])
      || firstText(node, ['[slot="comment-count"]', '[data-testid="comment-count"]']);
    const match = String(raw || "").replace(/,/g, "").match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  function pageRateLimitError() {
    const pageText = model.asText(`${document.title} ${textOf(document.querySelector("main") || document.body)}`);
    const displayedHttp429 = HTTP_429_PAGE_TEXT.test(pageText);
    if (!displayedHttp429 && !RATE_LIMIT_PAGE_TEXT.test(pageText)) return null;
    const error = new Error(displayedHttp429
      ? "Reddit 工作页显示 HTTP 429；来源服务端未由本扩展验证，当前批次将冷却后只恢复同一帖子。"
      : "Reddit 页面显示限流或临时错误；当前批次将冷却后只恢复同一帖子。");
    error.code = "RATE_LIMITED";
    error.failure_kind = displayedHttp429 ? "HTTP_429_ERROR_PAGE_OBSERVED" : "REDDIT_RATE_LIMIT_PAGE";
    error.evidence_source = "page_dom";
    error.displayed_http_status = displayedHttp429 ? 429 : null;
    return error;
  }

  async function syncPostsToDisk(context, records) {
    const result = await sendRuntimeMessage({
      type: "reddit-rpa-sync-posts",
      context,
      records,
      capturedAt: model.nowIso()
    });
    if (!result?.ok) throw new Error(result?.error || "帖子目录同步失败。");
    return result;
  }

  function listingLimits(config = {}) {
    const targetPostCount = Math.max(1, Math.min(500, Number(config.targetPostCount) || DEFAULT_CONFIG.targetPostCount));
    const maxPosts = Math.max(1, Math.min(500, Number(config.maxPosts) || DEFAULT_CONFIG.maxPosts));
    const effectiveTarget = Math.min(targetPostCount, maxPosts);
    const skipExisting = config.skipExisting === true;
    const requestedCandidateLimit = Number(config.candidatePostLimit);
    const candidatePostLimit = skipExisting
      ? Math.max(effectiveTarget, Math.min(500, Number.isFinite(requestedCandidateLimit) && requestedCandidateLimit > 0 ? Math.floor(requestedCandidateLimit) : 500))
      : maxPosts;
    return { targetPostCount, maxPosts, effectiveTarget, skipExisting, candidatePostLimit };
  }

  function limitListingRecords(records, limit) {
    return mergeListingRecords([], records, limit);
  }

  async function knownListingPostState(context) {
    const result = await sendRuntimeMessage({ type: "reddit-rpa-list-known-post-fullnames", context });
    if (!result?.ok) throw new Error(result?.error || "无法读取已有帖子代码，未启动补采。");
    const fullnames = listingSelection.knownPostFullnames(result.post_fullnames);
    return { fullnames, known_post_count: fullnames.size };
  }

  function listingSelectionFor(records, limits, known = null) {
    if (!limits.skipExisting) {
      const selected = limitListingRecords(records, limits.effectiveTarget);
      return {
        records: selected,
        scanned_post_count: records.length,
        skipped_existing_count: 0,
        duplicate_listing_count: 0,
        invalid_post_count: 0,
        available_new_count: selected.length,
        selected_new_count: selected.length
      };
    }
    return listingSelection.selectUnseenRecords(records, known?.fullnames || new Set(), limits.effectiveTarget);
  }

  function postFullnames(items) {
    return listingSelection.knownPostFullnames(items);
  }

  async function captureListing(config = {}) {
    const context = currentContext();
    if (context.page_type !== "listing") throw new Error("请在 subreddit 列表页同步帖子目录。帖子页请使用“采集帖子评论树”。");
    ensureNoActiveBatch();
    ensureContext(context);
    const captured = collectListing(context);
    const limits = listingLimits({ ...DEFAULT_CONFIG, ...config });
    const records = limitListingRecords(captured.records, limits.effectiveTarget);
    state.records = records;
    const disk = await syncPostsToDisk(context, records);
    state.lastResult = {
      ok: true,
      status: "posts_synced",
      mode: "listing",
      records: records.length,
      target_post_count: limits.targetPostCount,
      max_posts: limits.maxPosts,
      invalid_permalink_records: captured.invalid_permalinks,
      directory_sync: disk,
      quality: model.qualitySummary(records)
    };
    await persist();
    return state.lastResult;
  }

  async function runListing(config = {}, { returnRecords = false } = {}) {
    const context = currentContext();
    if (context.page_type !== "listing") throw new Error("请在 subreddit 列表页运行列表同步。帖子页请使用“采集帖子评论树”。");
    ensureNoActiveBatch();
    ensureContext(context);
    const safeConfig = { ...DEFAULT_CONFIG, ...config };
    const steps = Math.max(1, Math.min(100, Number(safeConfig.listingSteps) || DEFAULT_CONFIG.listingSteps));
    const limits = listingLimits(safeConfig);
    const known = limits.skipExisting ? await knownListingPostState(context) : { fullnames: new Set(), known_post_count: 0 };
    const events = [];
    let records = [];
    let noProgress = 0;
    let stopReason = null;
    for (let step = 0; step < steps; step += 1) {
      const beforeCount = records.length;
      const beforeY = window.scrollY;
      records = mergeListingRecords(records, collectListing(context).records, limits.candidatePostLimit);
      if (listingSelectionFor(records, limits, known).selected_new_count >= limits.effectiveTarget) {
        if (!limits.skipExisting) records = limitListingRecords(records, limits.effectiveTarget);
        events.push({ step: step + 1, before_y: beforeY, after_y: beforeY, new_records: records.length - beforeCount, at: model.nowIso() });
        stopReason = "target_post_count";
        break;
      }
      window.scrollBy({ top: Math.round(window.innerHeight * Math.max(20, Math.min(95, Number(safeConfig.scrollPercent) || DEFAULT_CONFIG.scrollPercent)) / 100), behavior: "auto" });
      await delay(Math.max(150, Number(safeConfig.waitMs) || DEFAULT_CONFIG.waitMs));
      records = mergeListingRecords(records, collectListing(context).records, limits.candidatePostLimit);
      const afterY = window.scrollY;
      const added = records.length - beforeCount;
      noProgress = added === 0 && afterY === beforeY ? noProgress + 1 : 0;
      events.push({ step: step + 1, before_y: beforeY, after_y: afterY, new_records: added, at: model.nowIso() });
      if (listingSelectionFor(records, limits, known).selected_new_count >= limits.effectiveTarget) {
        if (!limits.skipExisting) records = limitListingRecords(records, limits.effectiveTarget);
        stopReason = "target_post_count";
        break;
      }
      if (noProgress >= 2) {
        stopReason = "page_boundary_or_no_progress";
        break;
      }
    }
    let selection = listingSelectionFor(records, limits, known);
    const disk = await syncPostsToDisk(context, selection.records);
    let selectedRecords = selection.records;
    if (limits.skipExisting) {
      const created = postFullnames(disk.created);
      const existingAfterRead = Math.max(0, Number(disk.existing_count) || 0);
      selectedRecords = selectedRecords.filter((record) => created.has(listingSelection.postFullname(record?.fullname)));
      selection = {
        ...selection,
        records: selectedRecords,
        selected_new_count: selectedRecords.length,
        skipped_existing_count: selection.skipped_existing_count + existingAfterRead,
        post_sync_existing_count: existingAfterRead
      };
    }
    state.records = selectedRecords;
    state.lastResult = {
      ok: true,
      status: "completed",
      mode: "listing_sync",
      records: selectedRecords.length,
      requested_steps: steps,
      completed_steps: events.length,
      target_post_count: limits.targetPostCount,
      max_posts: limits.maxPosts,
      candidate_post_limit: limits.candidatePostLimit,
      skip_existing: limits.skipExisting,
      known_post_count: known.known_post_count,
      scanned_post_count: selection.scanned_post_count,
      skipped_existing_count: selection.skipped_existing_count,
      available_new_count: selection.available_new_count,
      selected_new_count: selection.selected_new_count,
      duplicate_listing_count: selection.duplicate_listing_count,
      invalid_post_count: selection.invalid_post_count,
      post_sync_existing_count: selection.post_sync_existing_count || 0,
      stop_reason: stopReason || "requested_steps",
      events,
      directory_sync: disk,
      quality: model.qualitySummary(selectedRecords)
    };
    await persist();
    return returnRecords ? { result: state.lastResult, records: selectedRecords, context, limits, selection } : state.lastResult;
  }

  function canResumeThreadJob(context) {
    const job = state.activeThreadJob;
    return Boolean(job?.active && context.page_type === "thread" && postContextsMatch(job.context, context));
  }

  function newThreadJob(context, config = {}, currentNavigationId = null) {
    return {
      active: true,
      capture_id: timestampLabel(),
      navigation_id: currentNavigationId || navigationId(),
      context: { ...context, canonical_url: model.canonicalPostUrl(context.canonical_url, context.post_fullname) || context.canonical_url },
      post_fullname: context.post_fullname,
      initial_url: normalisedPageUrl(),
      visited_urls: [],
      queue: [],
      continuation_urls: [],
      unexpanded_controls: [],
      rejected_foreign_comment_count: 0,
      native_comment_fullnames: [],
      native_comment_dom_observed: false,
      native_comment_dom_complete: true,
      tree_diagnostics: {
        deleted_placeholder_count: 0,
        removed_placeholder_count: 0,
        collapsed_placeholder_count: 0,
        unmapped_native_parent_path_count: 0,
        reason_codes: []
      },
      events: [],
      reported_comment_count: null,
      started_at: model.nowIso(),
      config: { ...DEFAULT_CONFIG, ...config }
    };
  }

  function mergeTreeDiagnostics(current = {}, incoming = {}) {
    const count = (field) => Math.max(0, Number(current[field]) || 0) + Math.max(0, Number(incoming[field]) || 0);
    return {
      deleted_placeholder_count: count("deleted_placeholder_count"),
      removed_placeholder_count: count("removed_placeholder_count"),
      collapsed_placeholder_count: count("collapsed_placeholder_count"),
      unmapped_native_parent_path_count: count("unmapped_native_parent_path_count"),
      reason_codes: [...new Set([...(current.reason_codes || []), ...(incoming.reason_codes || [])])]
    };
  }

  async function captureThreadPage(job, config) {
    const context = currentContext();
    if (context.page_type !== "thread" || !context.post_fullname) throw new Error("请在 Reddit 帖子页运行评论树采集。");
    if (!postContextsMatch(job.context, context)) throw new Error("评论续串页面与当前帖子不匹配，已停止本次采集。");
    ensureContext(job.context);
    const rateLimitError = pageRateLimitError();
    if (rateLimitError) throw rateLimitError;
    const expansion = await expandThreadControls(config);
    if (!currentThreadJob(job)) return { cancelled: true };
    const collected = collectThread(context, { collapsedPlaceholderCount: expansion.unexpanded.length });
    mergeIntoState(collected.records, job.post_fullname);
    return {
      context,
      records: collected.records,
      rejectedForeignCommentCount: collected.rejected_foreign_comment_count,
      nativeCommentFullnames: collected.native_comment_fullnames,
      nativeCommentNodeCount: collected.native_comment_node_count,
      treeDiagnostics: collected.tree_diagnostics,
      expansion,
      continuations: continuationUrls(context),
      reportedCommentCount: reportedCommentCount(context)
    };
  }

  function commentRecordCount(records) {
    return (records || []).filter((record) => record?.record_type === "comment").length;
  }

  async function captureStableThreadPage(job, config, settleWaitMs) {
    const initial = await captureThreadPage(job, config);
    if (initial.cancelled) return initial;
    const initialCollectedCommentCount = commentRecordCount(initial.records);
    const shouldRecheck = model.shouldRecheckZeroCommentCapture({
      reportedCommentCount: initial.reportedCommentCount,
      collectedCommentCount: initialCollectedCommentCount
    });
    if (!shouldRecheck) {
      return {
        ...initial,
        stability: {
          zero_comment_recheck: false,
          initial_reported_comment_count: initial.reportedCommentCount,
          initial_collected_comment_count: initialCollectedCommentCount,
          zero_comment_recheck_wait_ms: 0
        }
      };
    }
    await delay(settleWaitMs);
    if (!currentThreadJob(job)) return { cancelled: true };
    const confirmed = await captureThreadPage(job, config);
    if (confirmed.cancelled) return confirmed;
    return {
      ...confirmed,
      stability: {
        zero_comment_recheck: true,
        initial_reported_comment_count: initial.reportedCommentCount,
        initial_collected_comment_count: initialCollectedCommentCount,
        zero_comment_recheck_wait_ms: settleWaitMs
      }
    };
  }

  async function startThreadJob(config = {}) {
    const context = currentContext();
    if (context.page_type !== "thread" || !context.post_fullname) throw new Error("请打开一个 Reddit 帖子页后再采集评论树。");
    if (state.activeBatchJob?.active) throw new Error("批量采集正在运行；请先暂停批量任务，或等待它完成。");
    ensureContext(context);
    state.records = [];
    state.activeThreadJob = newThreadJob(context, config);
    await persist();
    return processThreadJob();
  }

  async function resumeThreadJob() {
    if (!state.activeThreadJob?.active) return { ok: true, status: "no_active_thread_job" };
    await requireBatchWorker();
    return processThreadJob();
  }

  function batchSummary(job = state.activeBatchJob) {
    if (!job) return null;
    return {
      active: Boolean(job.active),
      paused: Boolean(job.paused),
      cancelled: Boolean(job.cancelled),
      cancelled_at: job.cancelled_at || null,
      cancel_reason: job.cancel_reason || null,
      subreddit: job.context?.subreddit || null,
      selected_count: Number(job.selected_count) || 0,
      queued_count: job.queue?.length || 0,
      unprocessed_count: (job.queue?.length || 0) + (job.current ? 1 : 0),
      current: job.current ? {
        fullname: job.current.post?.fullname || null,
        title: job.current.post?.title || "",
        attempts: Number(job.current.attempts) || 0
      } : null,
      completed_count: job.completed?.length || 0,
      tree_partial_count: job.tree_partial?.length || 0,
      manual_count: job.manual?.length || 0,
      failed_count: job.failed?.length || 0,
      rate_limit: job.rate_limit || null,
      navigation_failure: job.navigation_failure || null,
      recovery: job.recovery || null,
      selection_mode: job.selection_mode || "selected",
      worker_tab_id: Number.isInteger(job.worker_tab_id) ? job.worker_tab_id : null,
      manifest_path: job.manifest_path || null,
      started_at: job.started_at || null,
      completed_at: job.completed_at || null
    };
  }

  function batchElapsedMs(batch) {
    const startedAt = Date.parse(batch?.started_at || "");
    return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
  }

  async function recordBatchEvent(event, fields = {}, batch = state.activeBatchJob) {
    if (!batch?.batch_id || !batch.worker_token) return null;
    const seq = (Number(batch.event_seq) || 0) + 1;
    batch.event_seq = seq;
    const payload = {
      schema: "reddit-rpa-batch-event-v1",
      batch_id: batch.batch_id,
      seq,
      at: model.nowIso(),
      event,
      post_fullname: fields.post_fullname || batch.current?.post?.fullname || null,
      elapsed_ms: batchElapsedMs(batch),
      attempt: fields.attempt ?? batch.current?.attempts ?? null,
      reason_code: fields.reason_code || null,
      reason: fields.reason || null,
      reported_comment_count: fields.reported_comment_count ?? null,
      collected_comment_count: fields.collected_comment_count ?? null,
      cooldown_ms: fields.cooldown_ms ?? null,
      tree_diagnostics: fields.tree_diagnostics || null,
      navigation_id: fields.navigation_id ?? state.activeThreadJob?.navigation_id ?? batch.current?.navigation_id ?? null,
      failure_kind: fields.failure_kind ?? null,
      evidence_source: fields.evidence_source ?? null,
      displayed_http_status: fields.displayed_http_status ?? null
    };
    try {
      const result = await sendRuntimeMessage({
        type: "reddit-rpa-store-batch-event",
        worker_token: batch.worker_token,
        event: payload
      });
      return result?.ok ? result : null;
    } catch {
      // 事件日志只用于观察运行过程，不能改变已验证的采集和落盘语义。
      return null;
    }
  }

  function coverageAssessment(job, quality) {
    const coverage = model.classifyThreadCoverage({
      reportedCommentCount: job.reported_comment_count,
      collectedCommentCount: quality.comment_count,
      visibleCommentCount: job.native_comment_dom_observed && job.native_comment_dom_complete
        ? (job.native_comment_fullnames || []).length
        : null,
      unexpandedControls: quality.unexpanded_controls,
      unknownParentComment: quality.unknown_parent_comment
    });
    // 外来或无法证明归属的节点会被严格拒收，不写入当前帖子。
    // 它们本身不代表当前帖的可靠评论缺失；否则 Reddit 页面中的旁路
    // 评论组件会把完整采集误判为 manual。
    return {
      ...coverage,
      rejected_foreign_comment_count: Number(job.rejected_foreign_comment_count) || 0
    };
  }

  async function storeCompletedThread(job, records, quality, coverage, status = "complete", error = null) {
    const result = await sendRuntimeMessage({
      type: "reddit-rpa-store-thread",
      context: job.context,
      records,
      worker_token: state.activeBatchJob?.worker_token || null,
      capture: {
        capture_id: job.capture_id,
        captured_at: model.nowIso(),
        source_url: job.context.canonical_url,
        reported_comment_count: job.reported_comment_count,
        coverage_status: coverage.status || status,
        comment_count_gap: coverage.comment_count_gap,
        visible_comment_count: coverage.visible_comment_count,
        rejected_foreign_comment_count: coverage.rejected_foreign_comment_count,
        settle_wait_ms: (job.events || []).reduce((total, event) => total + (Number(event.settle_wait_ms) || 0), 0),
        navigation_jitter_ms: (job.events || []).reduce((total, event) => total + (Number(event.navigation_jitter_ms) || 0), 0),
        total_wait_ms: (job.events || []).reduce((total, event) => total + (Number(event.total_wait_ms) || 0), 0),
        zero_comment_recheck_count: (job.events || []).filter((event) => event.zero_comment_recheck).length,
        page_events: job.events || [],
        tree_diagnostics: job.tree_diagnostics,
        quality,
        status,
        error
      }
    });
    if (!result?.ok) {
      const storageError = new Error(result?.error || "评论树写入失败。");
      storageError.code = result?.code || "THREAD_STORE_FAILED";
      throw storageError;
    }
    return result;
  }

  function requiresOutputPermission(error) {
    return [
      "OUTPUT_ROOT_REQUIRED",
      "OUTPUT_PERMISSION_UNKNOWN",
      "OUTPUT_PERMISSION_REQUIRED",
      "OUTPUT_PERMISSION_REQUEST_FAILED"
    ].includes(error?.code);
  }

  async function verifyWritableOutputRoot() {
    const result = await sendRuntimeMessage({ type: "reddit-rpa-output-root-preflight" });
    if (result?.ok) return result;
    const error = new Error(result?.error || "无法确认 VR-XR 目录的写入授权。");
    error.code = result?.code || "OUTPUT_PERMISSION_REQUIRED";
    throw error;
  }

  function dispatchThreadNavigation({ url, forceReload = false }) {
    const samePage = normalisedPageUrl(url) === normalisedPageUrl();
    if (navigationDispatchTimer) window.clearTimeout(navigationDispatchTimer);
    navigationDispatchTimer = window.setTimeout(() => {
      navigationDispatchTimer = null;
      if (forceReload || samePage) {
        location.reload();
        return;
      }
      location.assign(url);
    }, NAVIGATION_DISPATCH_DELAY_MS);
  }

  function clearPendingThreadNavigation() {
    if (navigationDispatchTimer) window.clearTimeout(navigationDispatchTimer);
    navigationDispatchTimer = null;
    deferredThreadNavigation = null;
  }

  function flushDeferredThreadNavigation() {
    const navigation = deferredThreadNavigation;
    deferredThreadNavigation = null;
    if (navigation) dispatchThreadNavigation(navigation);
  }

  function navigateOrResumeThread(url, { forceReload = false } = {}) {
    const navigation = { url, forceReload };
    if (commandResponsePending) {
      deferredThreadNavigation = navigation;
      return;
    }
    dispatchThreadNavigation(navigation);
  }

  async function finaliseThreadJob(job) {
    clearThreadProgressWatchdog();
    const unvalidated = state.records.filter((record) => record.post_fullname === job.post_fullname || record.fullname === job.post_fullname);
    const records = model.mergeRecords([
      ...unvalidated.filter((record) => record.record_type !== "comment"),
      ...model.validateCommentParents(unvalidated.filter((record) => record.record_type === "comment"), job.post_fullname)
    ]);
    state.records = records;
    const quality = model.qualitySummary(records, {
      continuationUrls: job.continuation_urls,
      unexpandedControls: job.unexpanded_controls
    });
    const coverage = coverageAssessment(job, quality);
    const batch = state.activeBatchJob;
    const canRetry = coverage.retryable && batch?.active && batch.current?.post?.fullname === job.post_fullname
      && Number(batch.current.attempts) < 1 && !batch.paused;
    const status = coverage.complete ? "complete" : canRetry ? "retry" : coverage.tree_partial ? "tree_partial" : "manual";
    const acceptable = status === "complete" || status === "tree_partial";
    const storage = await storeCompletedThread(job, records, quality, coverage, status, coverage.complete ? null : coverage.reasons.join("；"));
    await recordBatchEvent("capture_saved", {
      post_fullname: job.post_fullname,
      reported_comment_count: job.reported_comment_count,
      collected_comment_count: quality.comment_count,
      reason: coverage.complete ? null : coverage.reasons.join("；"),
      tree_diagnostics: job.tree_diagnostics
    });
    if (!currentThreadJob(job)) return state.lastResult || { ok: true, status: "thread_cancelled" };
    job.active = false;
    job.completed_at = model.nowIso();
    state.lastResult = {
      ok: acceptable,
      status: coverage.complete ? "completed" : status === "retry" ? "completed_with_retry" : status === "tree_partial" ? "completed_with_tree_partial" : "manual_review_required",
      mode: "thread",
      post_fullname: job.post_fullname,
      records: records.length,
      quality,
      coverage,
      storage
    };
    if (state.activeBatchJob?.active && state.activeBatchJob.current?.post?.fullname === job.post_fullname) {
      return completeBatchAfterStoredThread(job, storage, status, quality, coverage);
    }
    await persist();
    return state.lastResult;
  }

  async function navigateThreadContinuation(job, nextUrl) {
    clearThreadProgressWatchdog();
    state.lastResult = { ok: true, status: "navigating_continuation", next_url: nextUrl, visited: job.visited_urls.length };
    await persist();
    navigateOrResumeThread(nextUrl);
    return state.lastResult;
  }

  async function processThreadJob() {
    const job = state.activeThreadJob;
    if (!job?.active) return { ok: true, status: "no_active_thread_job" };
    await requireBatchWorker();
    if (!currentThreadJob(job)) return state.lastResult || { ok: true, status: "no_active_thread_job" };
    const pageUrl = normalisedPageUrl();
    if (job.visited_urls.includes(pageUrl)) {
      clearThreadProgressWatchdog();
      const nextUrl = job.queue.shift();
      if (nextUrl) return navigateThreadContinuation(job, nextUrl);
      return finaliseThreadJob(job);
    }
    const settlePlan = threadSettlePlan(job.config);
    const watchdogTimeoutMs = startThreadProgressWatchdog(job, pageUrl);
    await delay(settlePlan.totalWaitMs);
    if (!currentThreadJob(job)) return state.lastResult || { ok: true, status: "thread_no_longer_active" };
    const result = await captureStableThreadPage(job, job.config, settlePlan.settleWaitMs);
    clearThreadProgressWatchdog();
    if (result.cancelled || !currentThreadJob(job)) return state.lastResult || { ok: true, status: "thread_no_longer_active" };
    job.visited_urls.push(pageUrl);
    job.unexpanded_controls.push(...result.expansion.unexpanded);
    job.continuation_urls.push(...result.continuations);
    job.rejected_foreign_comment_count += Number(result.rejectedForeignCommentCount) || 0;
    job.tree_diagnostics = mergeTreeDiagnostics(job.tree_diagnostics, result.treeDiagnostics);
    if (Number.isFinite(Number(result.reportedCommentCount))) {
      const reported = Number(result.reportedCommentCount);
      job.reported_comment_count = job.reported_comment_count == null ? reported : Math.max(job.reported_comment_count, reported);
    }
    if (Array.isArray(result.nativeCommentFullnames)) {
      job.native_comment_dom_observed = true;
      job.native_comment_dom_complete = Boolean(job.native_comment_dom_complete)
        && Number(result.nativeCommentNodeCount) === result.nativeCommentFullnames.length;
      job.native_comment_fullnames = [...new Set([
        ...(job.native_comment_fullnames || []),
        ...result.nativeCommentFullnames
      ])];
    }
    for (const url of result.continuations) {
      if (!job.visited_urls.includes(url) && !job.queue.includes(url)) job.queue.push(url);
    }
    job.events.push({
      url: pageUrl,
      record_count: result.records.length,
      reported_comment_count: result.reportedCommentCount,
      visible_comment_count: Array.isArray(result.nativeCommentFullnames) ? result.nativeCommentFullnames.length : null,
      rejected_foreign_comment_count: result.rejectedForeignCommentCount,
      settle_wait_ms: settlePlan.settleWaitMs,
      navigation_jitter_ms: settlePlan.jitterMs,
      total_wait_ms: settlePlan.totalWaitMs,
      progress_watchdog_timeout_ms: watchdogTimeoutMs,
      zero_comment_recheck: Boolean(result.stability?.zero_comment_recheck),
      initial_reported_comment_count: result.stability?.initial_reported_comment_count ?? null,
      initial_collected_comment_count: result.stability?.initial_collected_comment_count ?? null,
      zero_comment_recheck_wait_ms: Number(result.stability?.zero_comment_recheck_wait_ms) || 0,
      expansion_events: result.expansion.events,
      at: model.nowIso()
    });
    await recordBatchEvent("page_ready", {
      post_fullname: job.post_fullname,
      reported_comment_count: result.reportedCommentCount,
      collected_comment_count: commentRecordCount(result.records)
    });
    const nextUrl = job.queue.shift();
    if (nextUrl) return navigateThreadContinuation(job, nextUrl);
    return finaliseThreadJob(job);
  }

  async function listThreadTargets() {
    const context = currentContext();
    if (context.page_type !== "listing") throw new Error("请在 subreddit 列表页选择评论树采集目标。");
    ensureNoActiveBatch();
    ensureContext(context);
    const result = await sendRuntimeMessage({ type: "reddit-rpa-list-known-posts", context });
    if (!result?.ok) throw new Error(result?.error || "无法读取已同步帖子目录。");
    state.lastResult = { ...result, selected_by_default: [] };
    await persist();
    return state.lastResult;
  }

  function validBatchTargets(posts, selectedFullnames) {
    const selected = new Set((selectedFullnames || []).map((value) => String(value || "").toLowerCase()));
    return (posts || []).flatMap((item) => {
      const fullname = model.fullname(item?.post?.fullname, "t3");
      if (!fullname || !selected.has(fullname)) return [];
      const permalink = model.postPermalinkForPost([item.permalink, item.post?.canonical_url, item.post?.source_url, item.post?.source_url_or_raw_path], fullname);
      if (!permalink) return [];
      return [{
        post: item.post,
        permalink,
        directory_name: item.directory_name,
        attempts: 0
      }];
    });
  }

  function listingBatchTargets(records) {
    return (records || []).flatMap((post) => {
      const fullname = model.fullname(post?.fullname, "t3");
      const permalink = model.postPermalinkForPost(
        [post?.canonical_url, post?.source_url, post?.source_url_or_raw_path],
        fullname
      );
      if (!fullname || !permalink) return [];
      return [{ post, permalink, directory_name: null, attempts: 0 }];
    });
  }

  async function createBatch(context, targets, config = {}, selectionMode = "selected", recovery = null) {
    if (!targets.length) throw new Error("没有可验证的帖子目标，未启动批量采集。");
    const batchId = timestampLabel();
    const worker = await claimBatchWorker(batchId);
    state.records = [];
    state.activeThreadJob = null;
    state.activeBatchJob = batchQueue.create({
      context: { ...context, page_type: "listing" },
      targets,
      config: { ...DEFAULT_CONFIG, ...config },
      startedAt: model.nowIso()
    });
    state.activeBatchJob.batch_id = batchId;
    state.activeBatchJob.worker_token = worker.worker_token;
    state.activeBatchJob.worker_tab_id = worker.tab_id;
    state.activeBatchJob.selection_mode = selectionMode;
    state.activeBatchJob.recovery = recovery;
    try {
      await persistBatchManifest(state.activeBatchJob);
      await recordBatchEvent("batch_started", { post_fullname: null }, state.activeBatchJob);
      state.lastResult = { ok: true, status: "batch_started", batch: batchSummary() };
      await persist();
      return advanceBatchJob();
    } catch (error) {
      await releaseBatchWorker(state.activeBatchJob).catch(() => null);
      state.activeThreadJob = null;
      state.activeBatchJob = null;
      await persist();
      throw error;
    }
  }

  async function startBatch(config = {}, selectedFullnames = null) {
    const context = currentContext();
    if (context.page_type !== "listing") throw new Error("请在 subreddit 列表页启动批量评论树采集。");
    ensureContext(context);
    if (state.activeBatchJob?.active) throw new Error("已有批量任务正在运行；请先暂停或等待它完成。");
    const known = await sendRuntimeMessage({ type: "reddit-rpa-list-known-posts", context });
    if (!known?.ok) throw new Error(known?.error || "无法读取已同步帖子目录。");
    const selected = Array.isArray(selectedFullnames) ? selectedFullnames : [];
    if (!selected.length) throw new Error("请至少选择一个帖子目录后再启动批量采集。");
    const targets = validBatchTargets(known.posts, selected);
    if (!targets.length) throw new Error("所选帖子没有可验证的永久链接，未启动批量采集。");
    return createBatch(context, targets, config, "selected");
  }

  async function startLatestListingBatch(config = {}) {
    const context = currentContext();
    if (context.page_type !== "listing") throw new Error("请先回到 subreddit 列表页，再开始采集刚同步的帖子。");
    ensureNoActiveBatch();
    ensureContext(context);
    if (state.lastResult?.mode !== "listing_sync" || !state.records.length) {
      throw new Error("请先完成步骤 1：同步当前列表。扩展只会采集刚同步的这一批帖子。");
    }
    const limits = listingLimits({ ...DEFAULT_CONFIG, ...config });
    const records = limitListingRecords(state.records, limits.effectiveTarget);
    const targets = listingBatchTargets(records);
    if (!targets.length) throw new Error("刚同步的列表没有可验证的帖子，未启动批量采集。");
    return createBatch(context, targets, config, "just_synced");
  }

  async function syncAndStartBatch(config = {}) {
    const listing = await runListing(config, { returnRecords: true });
    const targets = listingBatchTargets(listing.records);
    if (!targets.length) {
      if (!listing.limits.skipExisting) throw new Error("列表同步后没有得到可验证的帖子，未启动批量采集。");
      state.lastResult = {
        ...listing.result,
        ok: true,
        status: "no_unseen_posts",
        requested_count: listing.limits.effectiveTarget,
        no_batch_started: true
      };
      await persist();
      return state.lastResult;
    }
    const selectionMode = listing.limits.skipExisting ? "unseen_current_listing" : "just_synced";
    const result = await createBatch(listing.context, targets, config, selectionMode);
    return {
      ...result,
      listing: listing.result,
      selection: {
        skip_existing: listing.limits.skipExisting,
        known_post_count: listing.result.known_post_count,
        scanned_post_count: listing.result.scanned_post_count,
        skipped_existing_count: listing.result.skipped_existing_count,
        selected_new_count: listing.result.selected_new_count
      }
    };
  }

  function controlSubredditName(value) {
    const subreddit = String(value || "").trim();
    if (!/^[A-Za-z0-9_]+$/.test(subreddit)) throw new Error("控制命令的 subreddit 无效。");
    return subreddit;
  }

  function controlSkipExisting(value) {
    if (value != null && typeof value !== "boolean") throw new Error("控制命令的 skip_existing 必须是布尔值。");
    return value === true;
  }

  function controlBatch(batchId) {
    const batch = state.activeBatchJob;
    if (!batch?.active) throw new Error("没有可控制的运行中批次。");
    if (String(batch.batch_id || "") !== String(batchId || "")) {
      throw new Error("控制命令的 batch_id 与当前批次不一致，未执行。");
    }
    return batch;
  }

  async function prepareControlPage({ subreddit } = {}) {
    ensureNoActiveBatch();
    const safeSubreddit = controlSubredditName(subreddit);
    state.pendingControlRun = null;
    state.lastResult = { ok: true, status: "control_preparing", subreddit: safeSubreddit };
    await persist();
    navigateOrResumeThread(`https://www.reddit.com/r/${encodeURIComponent(safeSubreddit)}/new/`);
    return state.lastResult;
  }

  async function runControlledBatch({ subreddit, count, skip_existing: skipExisting } = {}) {
    const safeSubreddit = controlSubredditName(subreddit);
    const safeCount = Math.max(1, Math.min(50, Math.floor(Number(count) || 0)));
    const safeSkipExisting = controlSkipExisting(skipExisting);
    const context = currentContext();
    ensureNoActiveBatch();
    if (context.page_type !== "listing" || !context.subreddit || context.subreddit.toLowerCase() !== safeSubreddit.toLowerCase()) {
      state.pendingControlRun = { subreddit: safeSubreddit, count: safeCount, skip_existing: safeSkipExisting };
      state.lastResult = { ok: true, status: "control_preparing", subreddit: safeSubreddit, count: safeCount, skip_existing: safeSkipExisting };
      await persist();
      navigateOrResumeThread(`https://www.reddit.com/r/${encodeURIComponent(safeSubreddit)}/new/`);
      return state.lastResult;
    }
    await verifyWritableOutputRoot();
    state.pendingControlRun = null;
    await persist();
    return syncAndStartBatch({
      targetPostCount: safeCount,
      maxPosts: safeCount,
      skipExisting: safeSkipExisting,
      candidatePostLimit: safeSkipExisting ? 500 : safeCount
    });
  }

  function recoverySourceBatchId(value) {
    const batchId = String(value || "").trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(batchId)) throw new Error("精确补采缺少有效的源批次 ID。");
    return batchId;
  }

  async function retryUnfinishedBatch({ source_batch_id: sourceBatchId } = {}) {
    ensureNoActiveBatch();
    const safeSourceBatchId = recoverySourceBatchId(sourceBatchId);
    const recovery = await sendRuntimeMessage({
      type: "reddit-rpa-load-recovery-targets",
      source_batch_id: safeSourceBatchId
    });
    if (!recovery?.ok) throw runtimeError(recovery, "无法读取源批次的未完成目标。");
    const context = currentContext();
    const subreddit = controlSubredditName(recovery.subreddit);
    if (context.page_type !== "listing" || context.subreddit?.toLowerCase() !== subreddit.toLowerCase()) {
      state.pendingControlRun = null;
      state.pendingRecoveryRun = { source_batch_id: safeSourceBatchId, subreddit };
      state.lastResult = {
        ok: true,
        status: "recovery_preparing",
        source_batch_id: safeSourceBatchId,
        subreddit,
        recovery_count: Number(recovery.recovery_count) || 0
      };
      await persist();
      navigateOrResumeThread(`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new/`);
      return state.lastResult;
    }
    ensureContext(context);
    state.pendingRecoveryRun = null;
    if (!Array.isArray(recovery.targets) || !recovery.targets.length) {
      state.lastResult = {
        ok: true,
        status: "no_recovery_targets",
        source_batch_id: safeSourceBatchId,
        subreddit
      };
      await persist();
      return state.lastResult;
    }
    return createBatch(
      context,
      recovery.targets,
      recovery.config || {},
      "unfinished_from_batch",
      {
        source_batch_id: safeSourceBatchId,
        source_statuses: ["unprocessed", "interrupted"],
        target_count: recovery.targets.length
      }
    );
  }

  async function pauseControlledBatch({ batch_id: batchId } = {}) {
    controlBatch(batchId);
    return pauseBatch();
  }

  async function resumeControlledBatch({ batch_id: batchId } = {}) {
    controlBatch(batchId);
    return resumeBatch();
  }

  async function cancelControlledBatch({ batch_id: batchId } = {}) {
    controlBatch(batchId);
    return cancelBatch();
  }

  function hasBatchIntegrityIssue(integrity) {
    return !integrity?.ok
      || Number(integrity.duplicate_comment_count) > 0
      || Number(integrity.self_parent_count) > 0
      || Number(integrity.mismatched_post_count) > 0;
  }

  async function finishBatch(job) {
    let integrity;
    try {
      integrity = await sendRuntimeMessage({
        type: "reddit-rpa-validate-comment-owners",
        context: job.context,
        worker_token: job.worker_token
      });
    } catch (error) {
      integrity = { ok: false, error: String(error?.message || error) };
    }
    job.integrity = integrity;
    let manifestError = null;
    try {
      await persistBatchManifest(job);
    } catch (error) {
      manifestError = String(error?.message || error);
    }
    await recordBatchEvent("batch_finished", {
      post_fullname: null,
      reason: manifestError || null
    }, job);
    const taskIssues = (job.manual?.length || 0) + (job.failed?.length || 0);
    const treePartialCount = job.tree_partial?.length || 0;
    const clean = !hasBatchIntegrityIssue(integrity) && taskIssues === 0 && !manifestError;
    state.lastResult = {
      ok: clean,
      status: clean ? (treePartialCount ? "batch_completed_with_tree_partial" : "batch_completed") : "batch_manual_review_required",
      batch: batchSummary(job),
      integrity,
      manifest_error: manifestError
    };
    await persist();
    try {
      await releaseBatchWorker(job);
    } catch (error) {
      state.lastResult = {
        ...state.lastResult,
        ok: false,
        status: "batch_manual_review_required",
        worker_release_error: String(error?.message || error)
      };
      await persist();
    }
    return state.lastResult;
  }

  async function persistBatchProgress(batch = state.activeBatchJob) {
    try {
      await persistBatchManifest(batch);
      return true;
    } catch (error) {
      batchQueue.pause(batch);
      state.lastResult = {
        ok: false,
        status: "batch_paused_manifest_write_failed",
        error: String(error?.message || error),
        batch: batchSummary(batch)
      };
      await persist();
      return false;
    }
  }

  async function completeBatchItem(outcome) {
    const batch = state.activeBatchJob;
    if (!batch?.active || !batch.current) return state.lastResult;
    await requireBatchWorker();
    batchQueue.finish(batch, outcome, model.nowIso());
    state.activeThreadJob = null;
    state.records = [];
    if (!batch.active) {
      return finishBatch(batch);
    }
    if (!await persistBatchProgress(batch)) return state.lastResult;
    if (batch.paused) {
      state.lastResult = { ok: true, status: "batch_paused", batch: batchSummary() };
      await persist();
      return state.lastResult;
    }
    await persist();
    return advanceBatchJob();
  }

  async function completeBatchAfterStoredThread(job, storage, status, quality, coverage) {
    const batch = state.activeBatchJob;
    const target = batch?.current;
    if (!batch?.active || !target) {
      await persist();
      return state.lastResult;
    }
    if (status === "retry" && Number(target.attempts) < 1 && !batch.paused) {
      batchQueue.retry(batch, coverage.reasons.join("；"));
      state.activeThreadJob = null;
      state.records = [];
      await recordBatchEvent("retry", {
        post_fullname: target.post?.fullname,
        attempt: target.attempts,
        reason: coverage.reasons.join("；")
      }, batch);
      state.lastResult = { ok: true, status: "batch_retrying", reason: target.last_error, storage, batch: batchSummary() };
      await persist();
      navigateOrResumeThread(target.permalink, { forceReload: true });
      return state.lastResult;
    }
    return completeBatchItem({ status, storage, quality, coverage, error: coverage.complete ? null : coverage.reasons.join("；") });
  }

  async function pauseBatchForOutputPermission(batch, error) {
    batchQueue.pause(batch);
    state.activeThreadJob = null;
    state.records = [];
    state.lastResult = {
      ok: false,
      code: error.code,
      status: "batch_paused_output_permission_required",
      error: String(error?.message || error),
      batch: batchSummary()
    };
    await persist();
    return state.lastResult;
  }

  function rateLimitCooldownMs(batch) {
    const requested = Number(batch?.config?.rateLimitCooldownMs);
    return Math.max(15000, Math.min(300000, Number.isFinite(requested) ? requested : DEFAULT_CONFIG.rateLimitCooldownMs));
  }

  function rateLimitedError(error) {
    return error?.code === "RATE_LIMITED";
  }

  function navigationTimeoutError(error) {
    return error?.code === "PAGE_NAVIGATION_TIMEOUT";
  }

  function scheduleRateLimitResume(batch = state.activeBatchJob) {
    if (rateLimitResumeTimer) window.clearTimeout(rateLimitResumeTimer);
    rateLimitResumeTimer = null;
    const cooldownUntil = Date.parse(batch?.rate_limit?.cooldown_until || "");
    if (!batch?.active || !batch?.paused || !batch?.current || !Number.isFinite(cooldownUntil)) return;
    const delayMs = Math.max(0, cooldownUntil - Date.now());
    rateLimitResumeTimer = window.setTimeout(() => {
      rateLimitResumeTimer = null;
      if (state.activeBatchJob !== batch || !batch.active || !batch.paused || !batch.current) return;
      resumeBatch({ allowRateLimitCooldown: true, rateLimitResume: true }).catch((error) => recordThreadError(error).catch(() => null));
    }, delayMs);
  }

  async function markRateLimitedTargetManual(batch, error) {
    const target = batch.current;
    const message = String(error?.message || error);
    batch.rate_limit = {
      post_fullname: target.post?.fullname || null,
      failure_count: Number(target.rate_limit_failures) || 2,
      reason_code: error?.code || "RATE_LIMITED",
      reason: message,
      failure_kind: error?.failure_kind || "REDDIT_RATE_LIMIT_PAGE",
      evidence_source: error?.evidence_source || "page_dom",
      displayed_http_status: error?.displayed_http_status ?? null,
      cooldown_until: null,
      outcome: "manual"
    };
    batchQueue.pause(batch);
    state.activeThreadJob = null;
    state.records = [];
    let audit = null;
    try {
      const targetContext = threadTargetContext(target, batch.context);
      audit = await sendRuntimeMessage({
        type: "reddit-rpa-record-thread-failure",
        context: targetContext,
        target,
        worker_token: batch.worker_token,
        capture: {
          capture_id: timestampLabel(),
          captured_at: model.nowIso(),
          source_url: target.permalink,
          coverage_status: "rate_limited",
          status: "manual",
          error: message
        }
      });
      if (!audit?.ok) throw new Error(audit?.error || "限流状态写入失败。");
    } catch (auditError) {
      audit = { ok: false, error: String(auditError?.message || auditError) };
    }
    await recordBatchEvent("rate_limited", {
      post_fullname: target.post?.fullname,
      reason_code: error?.code || "RATE_LIMITED",
      reason: message,
      failure_kind: error?.failure_kind || "REDDIT_RATE_LIMIT_PAGE",
      evidence_source: error?.evidence_source || "page_dom",
      displayed_http_status: error?.displayed_http_status ?? null
    }, batch);
    const result = await completeBatchItem({ status: "manual", error: message, audit });
    state.lastResult = {
      ...result,
      ok: false,
      code: error?.code || "RATE_LIMITED",
      status: "batch_rate_limited_manual_review",
      batch: batchSummary(batch),
      error: message
    };
    await persist();
    return state.lastResult;
  }

  async function pauseBatchForRateLimit(batch, error) {
    const target = batch.current;
    target.rate_limit_failures = (Number(target.rate_limit_failures) || 0) + 1;
    if (target.rate_limit_failures >= 2) return markRateLimitedTargetManual(batch, error);
    const cooldownMs = rateLimitCooldownMs(batch);
    const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    const message = String(error?.message || error);
    batch.rate_limit = {
      post_fullname: target.post?.fullname || null,
      failure_count: target.rate_limit_failures,
      reason_code: error?.code || "RATE_LIMITED",
      reason: message,
      failure_kind: error?.failure_kind || "REDDIT_RATE_LIMIT_PAGE",
      evidence_source: error?.evidence_source || "page_dom",
      displayed_http_status: error?.displayed_http_status ?? null,
      cooldown_until: cooldownUntil,
      outcome: "cooling_down"
    };
    batchQueue.pause(batch);
    state.activeThreadJob = null;
    state.records = [];
    await recordBatchEvent("rate_limited", {
      post_fullname: target.post?.fullname,
      reason_code: batch.rate_limit.reason_code,
      reason: message,
      cooldown_ms: cooldownMs,
      failure_kind: batch.rate_limit.failure_kind,
      evidence_source: batch.rate_limit.evidence_source,
      displayed_http_status: batch.rate_limit.displayed_http_status
    }, batch);
    state.lastResult = {
      ok: false,
      code: batch.rate_limit.reason_code,
      status: "batch_rate_limited",
      error: message,
      cooldown_until: cooldownUntil,
      batch: batchSummary(batch)
    };
    if (!await persistBatchProgress(batch)) return state.lastResult;
    await persist();
    scheduleRateLimitResume(batch);
    return state.lastResult;
  }

  async function pauseBatchForNavigationFailure(batch, error) {
    const target = batch.current;
    const message = String(error?.message || error);
    target.navigation_failures = (Number(target.navigation_failures) || 0) + 1;
    target.last_failure = {
      navigation_id: state.activeThreadJob?.navigation_id || target.navigation_id || null,
      failure_kind: error?.failure_kind || "PAGE_NAVIGATION_TIMEOUT",
      reason_code: error?.code || "PAGE_NAVIGATION_TIMEOUT",
      evidence_source: error?.evidence_source || "page_dom",
      displayed_http_status: error?.displayed_http_status ?? null,
      observed_at: model.nowIso()
    };
    batch.navigation_failure = {
      ...target.last_failure,
      post_fullname: target.post?.fullname || null,
      reason: message
    };
    batchQueue.pause(batch);
    state.activeThreadJob = null;
    state.records = [];
    await recordBatchEvent("navigation_timeout", {
      post_fullname: target.post?.fullname,
      reason_code: error?.code || "PAGE_NAVIGATION_TIMEOUT",
      reason: message,
      failure_kind: target.last_failure.failure_kind,
      evidence_source: target.last_failure.evidence_source,
      displayed_http_status: target.last_failure.displayed_http_status,
      navigation_id: target.last_failure.navigation_id
    }, batch);
    state.lastResult = {
      ok: false,
      code: error?.code || "PAGE_NAVIGATION_TIMEOUT",
      status: "batch_navigation_paused",
      error: message,
      batch: batchSummary(batch)
    };
    if (!await persistBatchProgress(batch)) return state.lastResult;
    await persist();
    return state.lastResult;
  }

  async function recordBatchFailure(error) {
    const batch = state.activeBatchJob;
    const target = batch?.current;
    const message = String(error?.message || error);
    if (!batch?.active || !target) throw error;
    await requireBatchWorker();
    if (requiresOutputPermission(error)) {
      await recordBatchEvent("permission_required", {
        post_fullname: target.post?.fullname,
        reason_code: error.code,
        reason: message
      }, batch);
      return pauseBatchForOutputPermission(batch, error);
    }
    if (rateLimitedError(error)) return pauseBatchForRateLimit(batch, error);
    if (navigationTimeoutError(error)) return pauseBatchForNavigationFailure(batch, error);
    const retry = batch.paused ? { retry: false, target } : batchQueue.retry(batch, message);
    if (retry.retry && !batch.paused) {
      state.activeThreadJob = null;
      state.records = [];
      await recordBatchEvent("retry", {
        post_fullname: target.post?.fullname,
        attempt: target.attempts,
        reason: message
      }, batch);
      state.lastResult = { ok: true, status: "batch_retrying", error: message, batch: batchSummary() };
      await persist();
      navigateOrResumeThread(target.permalink, { forceReload: true });
      return state.lastResult;
    }
    let audit = null;
    try {
      const targetContext = threadTargetContext(target, batch.context);
      audit = await sendRuntimeMessage({
        type: "reddit-rpa-record-thread-failure",
        context: targetContext,
        target,
        worker_token: batch.worker_token,
        capture: {
          capture_id: timestampLabel(),
          captured_at: model.nowIso(),
          source_url: target.permalink,
          status: "failed",
          error: message
        }
      });
      if (!audit?.ok) throw new Error(audit?.error || "失败状态写入失败。");
    } catch (auditError) {
      audit = { ok: false, error: String(auditError?.message || auditError) };
    }
    return completeBatchItem({ status: "failed", error: message, audit });
  }

  async function advanceBatchJob() {
    const batch = state.activeBatchJob;
    if (!batch?.active) return { ok: true, status: "no_active_batch_job" };
    await requireBatchWorker();
    if (batch.paused) return { ok: true, status: "batch_paused", batch: batchSummary() };
    if (state.activeThreadJob?.active) return { ok: true, status: "thread_running", batch: batchSummary() };
    const claimed = batchQueue.claimNext(batch, model.nowIso());
    if (claimed.status === "completed") {
      return finishBatch(batch);
    }
    if (claimed.status === "paused") return { ok: true, status: "batch_paused", batch: batchSummary() };
    try {
      const targetContext = threadTargetContext(batch.current, batch.context);
      const currentNavigationId = navigationId();
      batch.current.navigation_id = currentNavigationId;
      state.records = [];
      state.activeThreadJob = newThreadJob(targetContext, batch.config, currentNavigationId);
      if (!await persistBatchProgress(batch)) return state.lastResult;
      state.lastResult = { ok: true, status: "navigating_batch_post", target: { fullname: batch.current.post.fullname, title: batch.current.post.title || "" }, batch: batchSummary() };
      await recordBatchEvent("post_navigation_started", {
        post_fullname: batch.current.post.fullname,
        attempt: batch.current.attempts,
        navigation_id: currentNavigationId
      }, batch);
      await startBackgroundNavigationLease(batch, state.activeThreadJob);
      await persist();
      navigateOrResumeThread(batch.current.permalink);
      return state.lastResult;
    } catch (error) {
      return recordBatchFailure(error);
    }
  }

  async function pauseBatch() {
    if (!state.activeBatchJob?.active) return { ok: true, status: "no_active_batch_job" };
    await requireBatchWorker();
    batchQueue.pause(state.activeBatchJob);
    await recordBatchEvent("paused", {
      post_fullname: state.activeBatchJob.current?.post?.fullname || null,
      reason: "manual"
    }, state.activeBatchJob);
    state.lastResult = {
      ok: true,
      status: state.activeThreadJob?.active ? "batch_pause_requested" : "batch_paused",
      batch: batchSummary()
    };
    if (!await persistBatchProgress(state.activeBatchJob)) return state.lastResult;
    await persist();
    return state.lastResult;
  }

  async function cancelBatch() {
    const batch = state.activeBatchJob;
    if (!batch?.active) return { ok: true, status: "no_active_batch_job" };
    const worker = await batchWorkerStatus(batch);
    if (!worker?.ok || (worker.active && !worker.owner)) {
      throw runtimeError(worker, "当前标签页不是该批量任务的工作标签页，未结束任务。");
    }
    // 结束批次也必须先确认磁盘可写：否则只改页面内存会让 UI 误报“已结束”。
    await verifyWritableOutputRoot();
    clearThreadProgressWatchdog();
    clearPendingThreadNavigation();
    const cancelledAt = model.nowIso();
    const priorBatchState = {
      active: batch.active,
      paused: batch.paused,
      cancelled: batch.cancelled,
      cancelled_at: batch.cancelled_at,
      cancel_reason: batch.cancel_reason
    };
    batchQueue.cancel(batch, cancelledAt, "manual");
    try {
      await persistBatchManifest(batch);
    } catch (error) {
      Object.assign(batch, priorBatchState);
      throw error;
    }
    if (state.activeThreadJob) {
      state.activeThreadJob.active = false;
      state.activeThreadJob.cancelled_at = cancelledAt;
    }
    state.activeThreadJob = null;
    state.records = [];
    await recordBatchEvent("cancelled", { post_fullname: batch.current?.post?.fullname || null, reason: "manual" }, batch);
    let workerReleaseError = null;
    try {
      await releaseBatchWorker(batch);
    } catch (error) {
      workerReleaseError = String(error?.message || error);
    }
    state.lastResult = {
      ok: !workerReleaseError,
      status: workerReleaseError ? "batch_cancelled_worker_release_failed" : "batch_cancelled",
      batch: batchSummary(batch),
      worker_release_error: workerReleaseError
    };
    await persist();
    return state.lastResult;
  }

  // 仅迁移旧版的“本地已结束、磁盘未写入”状态。新版在取消前已预检写入权，
  // 因此不会产生该状态；这里让恢复授权后的用户能把既有结束动作真正落盘。
  async function repairCancelledBatchManifest() {
    const batch = state.activeBatchJob;
    if (!batch?.cancelled || !state.lastResult?.manifest_error) {
      return { ok: true, status: "no_cancelled_batch_repair_needed" };
    }
    await verifyWritableOutputRoot();
    await persistBatchManifest(batch);
    state.lastResult = {
      ok: true,
      status: "batch_cancelled",
      batch: batchSummary(batch),
      repaired_at: model.nowIso()
    };
    await persist();
    return state.lastResult;
  }

  async function resumeBatch({ allowRateLimitCooldown = false, rateLimitResume = false } = {}) {
    if (!state.activeBatchJob?.active) return { ok: true, status: "no_active_batch_job" };
    const batch = state.activeBatchJob;
    const cooldownUntil = Date.parse(batch.rate_limit?.cooldown_until || "");
    if (!allowRateLimitCooldown && Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
      scheduleRateLimitResume(batch);
      return {
        ok: true,
        status: "batch_rate_limited",
        cooldown_until: batch.rate_limit.cooldown_until,
        batch: batchSummary(batch)
      };
    }
    try {
      await verifyWritableOutputRoot();
    } catch (error) {
      if (requiresOutputPermission(error)) return pauseBatchForOutputPermission(batch, error);
      throw error;
    }
    await restoreBatchWorker(batch);
    batchQueue.resume(batch);
    if (batch.rate_limit?.cooldown_until) {
      batch.rate_limit = {
        ...batch.rate_limit,
        cooldown_until: null,
        outcome: "resumed",
        resumed_at: model.nowIso()
      };
      await recordBatchEvent("rate_limit_cooldown_complete", {
        post_fullname: batch.current?.post?.fullname || null,
        reason_code: batch.rate_limit.reason_code,
        reason: rateLimitResume ? "冷却完成后恢复同一帖子。" : "冷却结束后手动恢复同一帖子。"
      }, batch);
    } else {
      await recordBatchEvent("resumed", { post_fullname: batch.current?.post?.fullname || null }, batch);
    }
    if (!await persistBatchProgress(batch)) return state.lastResult;
    await persist();
    return advanceBatchJob();
  }

  async function recordThreadError(error) {
    clearThreadProgressWatchdog();
    if (state.activeBatchJob?.cancelled) return state.lastResult || { ok: true, status: "batch_cancelled", batch: batchSummary() };
    const message = String(error?.message || error);
    if (state.activeBatchJob?.active && state.activeBatchJob.current) {
      const worker = await batchWorkerStatus();
      if (!worker?.ok || !worker.owner) {
        return { ok: false, code: "WORKER_NOT_OWNER", error: "当前标签页不是此批量任务的工作标签页，未更改任务状态。" };
      }
      return recordBatchFailure(error);
    }
    if (state.activeThreadJob) {
      state.activeThreadJob.active = false;
      state.activeThreadJob.error = message;
      state.activeThreadJob.completed_at = model.nowIso();
    }
    state.lastResult = { ok: false, code: "THREAD_CAPTURE_FAILED", error: message };
    await persist();
    return state.lastResult;
  }

  async function probe() {
    const context = currentContext();
    ensureNoActiveBatch();
    ensureContext(context);
    const before = context.page_type === "thread" ? collectThread(context).records : collectListing(context).records;
    const beforeY = window.scrollY;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.35), behavior: "auto" });
    await delay(350);
    const after = context.page_type === "thread" ? collectThread(context).records : collectListing(context).records;
    const beforeIds = new Set(before.map((record) => record.fullname));
    const afterIds = new Set(after.map((record) => record.fullname));
    const overlap = [...beforeIds].filter((id) => afterIds.has(id)).length;
    const newRendered = [...afterIds].filter((id) => !beforeIds.has(id)).length;
    state.lastResult = {
      ok: true,
      status: "probed",
      page_type: context.page_type,
      before_y: beforeY,
      after_y: window.scrollY,
      before_records: beforeIds.size,
      after_records: afterIds.size,
      overlap,
      new_rendered: newRendered,
      passed: window.scrollY !== beforeY && (overlap > 0 || newRendered > 0)
    };
    await persist();
    return state.lastResult;
  }

  function status() {
    const context = currentContext();
    return {
      ok: true,
      version: CONTENT_SCRIPT_VERSION,
      context,
      saved_context: state.context,
      record_count: state.records.length,
      pending_control_run: state.pendingControlRun,
      active_thread_job: state.activeThreadJob ? {
        active: state.activeThreadJob.active,
        post_fullname: state.activeThreadJob.post_fullname,
        visited_count: state.activeThreadJob.visited_urls?.length || 0,
        queued_continuations: state.activeThreadJob.queue?.length || 0
      } : null,
      active_batch_job: batchSummary(),
      last_result: state.lastResult
    };
  }

  const commandRegistry = commandRegistryModule.create([
    ["probe", () => probe()],
    ["captureListing", (message) => captureListing(message.config || {})],
    ["runListing", (message) => runListing(message.config || {})],
    ["captureThread", (message) => startThreadJob(message.config || {}), { captureFailure: true }],
    ["resumeThread", () => resumeThreadJob(), { captureFailure: true }],
    ["listThreadTargets", () => listThreadTargets()],
    ["syncAndStartBatch", (message) => syncAndStartBatch(message.config || {}), { captureFailure: true }],
    ["prepareControlPage", (message) => prepareControlPage(message)],
    ["runControlledBatch", (message) => runControlledBatch(message), { captureFailure: true }],
    ["retryUnfinishedBatch", (message) => retryUnfinishedBatch(message), { captureFailure: true }],
    ["pauseControlledBatch", (message) => pauseControlledBatch(message)],
    ["resumeControlledBatch", (message) => resumeControlledBatch(message), { captureFailure: true }],
    ["cancelControlledBatch", (message) => cancelControlledBatch(message)],
    ["repairCancelledBatch", () => repairCancelledBatchManifest()],
    ["startLatestListingBatch", (message) => startLatestListingBatch(message.config || {}), { captureFailure: true }],
    ["startBatch", (message) => startBatch(message.config || {}, message.selectedFullnames), { captureFailure: true }],
    ["pauseBatch", () => pauseBatch()],
    ["cancelBatch", () => cancelBatch()],
    ["resumeBatch", () => resumeBatch(), { captureFailure: true }],
    ["status", () => status()],
    ["clearLocal", () => clearLocalState()]
  ]);

  commandMessageListener = (message, _sender, sendResponse) => {
    if (disposed) return undefined;
    commandResponsePending = true;
    (async () => {
      await ready;
      return commandRegistry.execute(message);
    })().then((result) => {
      sendResponse(result);
      commandResponsePending = false;
      flushDeferredThreadNavigation();
    }).catch(async (error) => {
      const captureCommand = commandRegistry.capturesFailure(message);
      const result = captureCommand
        ? await recordThreadError(error).catch(() => ({ ok: false, code: "CAPTURE_FAILED", error: String(error?.message || error) }))
        : { ok: false, code: "CAPTURE_FAILED", error: String(error?.message || error) };
      sendResponse(result?.ok ? result : { ok: false, code: result?.code || "CAPTURE_FAILED", error: result?.error || String(error?.message || error) });
      commandResponsePending = false;
      flushDeferredThreadNavigation();
    });
    return true;
  };
  chrome.runtime.onMessage.addListener(commandMessageListener);
})();
