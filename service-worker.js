import { loadWritableOutputRoot, outputRootStatus } from "./output-store.js";
import { OutputPathError, postDirectory, resolvePostDirectoryName } from "./output-paths.mjs";
import {
  buildThreadDocument,
  makeCaptureRecord,
  makePostDocument,
  parseJsonLines,
  serialiseJsonLines
} from "./post-storage.mjs";
import {
  SubredditRegistryError,
  normaliseSubredditName,
  parseSubredditRegistry,
  registerSubredditInRegistry
} from "./subreddit-registry.mjs";

const OUTPUT_LAYER = "raw";
const WORKER_LOCK_KEY = "reddit-rpa-active-worker-v1";
const CAPTURE_STATE_KEY = "reddit-rpa-capture-state-v1";
const NAVIGATION_LEASE_KEY = "reddit-rpa-navigation-lease-v1";
const CONTENT_SCRIPT_FILES = ["reddit-dom-selectors.js", "reddit-model.js", "batch-queue.js", "listing-selection.js", "content.js"];
const BATCH_EVENT_SCHEMA = "reddit-rpa-batch-event-v1";
const CONTROL_DIRECTORY = ".reddit-rpa-control";
const CONTROL_REQUEST_SCHEMA = "reddit-rpa-control-request-v1";
const CONTROL_RESPONSE_SCHEMA = "reddit-rpa-control-response-v1";
const CONTROL_COMMANDS = new Set(["prepare", "run", "retry_unfinished", "pause", "resume", "cancel"]);
const NATIVE_HOST_NAME = "com.openai.reddit_rpa";
const NATIVE_REQUEST_TIMEOUT_MS = 10000;
const COLLECTOR_ID_KEY = "reddit-rpa-native-collector-id-v1";
const CONTROL_WORK_TAB_KEY = "reddit-rpa-native-control-work-tab-v1";
const NATIVE_CONTROL_ALARM = "reddit-rpa-native-control-v1";
const NATIVE_CONTROL_PERIOD_MINUTES = 0.5;
const NAVIGATION_WATCHDOG_ALARM = "reddit-rpa-navigation-watchdog-v1";
const NAVIGATION_WATCHDOG_PERIOD_MINUTES = 0.5;
const BATCH_EVENT_NAMES = new Set([
  "batch_started", "post_navigation_started", "page_ready", "capture_saved",
  "retry", "paused", "resumed", "rate_limited", "rate_limit_cooldown_complete",
  "permission_required", "navigation_error_observed", "navigation_timeout", "batch_finished", "cancelled"
]);
const NAVIGATION_FAILURE_KINDS = new Set([
  "HTTP_429_ERROR_PAGE_OBSERVED", "REDDIT_RATE_LIMIT_PAGE", "CLIENT_BLOCKED",
  "NAVIGATION_ERROR_PAGE", "PAGE_NAVIGATION_TIMEOUT"
]);
const NAVIGATION_EVIDENCE_SOURCES = new Set(["page_dom", "tab_metadata", "background_watchdog"]);
let controlRequestInFlight = false;
let nativePort = null;
let nativeRequestSequence = 0;
const nativePendingRequests = new Map();
let navigationLeaseQueue = Promise.resolve();

function outputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nativeHostError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rejectNativePending(error) {
  for (const pending of nativePendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  nativePendingRequests.clear();
}

function connectNativeHost() {
  if (nativePort) return nativePort;
  if (typeof chrome?.runtime?.connectNative !== "function") {
    throw nativeHostError("NATIVE_HOST_UNAVAILABLE", "Chrome Native Messaging Host 尚未安装。");
  }
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port.onMessage.addListener((response) => {
    const requestId = String(response?.request_id || "");
    const pending = nativePendingRequests.get(requestId);
    if (!pending) return;
    nativePendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  });
  port.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message || "Chrome Native Messaging Host 不可用。";
    if (nativePort === port) nativePort = null;
    rejectNativePending(nativeHostError("NATIVE_HOST_UNAVAILABLE", message));
  });
  nativePort = port;
  return port;
}

function nativeHostRequest(operation, payload = {}) {
  let port;
  try {
    port = connectNativeHost();
  } catch (error) {
    return Promise.reject(error);
  }
  const requestId = `${Date.now()}-${++nativeRequestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativePendingRequests.delete(requestId);
      reject(nativeHostError("NATIVE_HOST_TIMEOUT", "Native Host 在 10 秒内没有返回结果。"));
    }, NATIVE_REQUEST_TIMEOUT_MS);
    nativePendingRequests.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({ request_id: requestId, operation, payload });
    } catch (error) {
      nativePendingRequests.delete(requestId);
      clearTimeout(timer);
      reject(nativeHostError("NATIVE_HOST_UNAVAILABLE", String(error?.message || error)));
    }
  });
}

async function nativeHostOperation(operation, payload = {}) {
  try {
    const response = await nativeHostRequest(operation, payload);
    const { request_id: _requestId, ...result } = response || {};
    return result;
  } catch (error) {
    if (error?.code === "NATIVE_HOST_UNAVAILABLE") return null;
    throw error;
  }
}

function registryOutputError(error) {
  if (error instanceof SubredditRegistryError) return outputError(error.code, error.message);
  return error;
}

function timestampLabel(value = new Date()) {
  const pad = (number, size = 2) => String(number).padStart(size, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}_${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}_${pad(value.getMilliseconds(), 3)}`;
}

function newWorkerToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function activeWorkerLock() {
  const stored = await chrome.storage.session.get(WORKER_LOCK_KEY);
  return stored?.[WORKER_LOCK_KEY] || null;
}

function validNavigationId(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || ""));
}

function validPostFullname(value) {
  return /^t3_[A-Za-z0-9]+$/i.test(String(value || ""));
}

function navigationLeaseTimeoutMs(config = {}) {
  const requested = Number(config?.navigationTimeoutMs ?? config?.progressTimeoutMs);
  const fallback = 60000;
  return Math.max(30000, Math.min(300000, Number.isFinite(requested) ? requested : fallback));
}

function rateLimitCooldownMs(config = {}) {
  const requested = Number(config?.rateLimitCooldownMs);
  return Math.max(15000, Math.min(300000, Number.isFinite(requested) ? requested : 60000));
}

async function activeNavigationLease() {
  const stored = await chrome.storage.local.get(NAVIGATION_LEASE_KEY);
  const lease = stored?.[NAVIGATION_LEASE_KEY];
  return lease && typeof lease === "object" ? lease : null;
}

async function storeNavigationLease(lease) {
  await chrome.storage.local.set({ [NAVIGATION_LEASE_KEY]: lease });
  return lease;
}

async function clearNavigationLease() {
  await chrome.storage.local.remove(NAVIGATION_LEASE_KEY);
}

function serialiseNavigationLease(operation) {
  const run = navigationLeaseQueue.then(operation, operation);
  navigationLeaseQueue = run.catch(() => null);
  return run;
}

function navigationLeaseMatches(lease, event = {}) {
  return Boolean(
    lease
    && String(lease.batch_id || "") === String(event.batch_id || "")
    && String(lease.post_fullname || "").toLowerCase() === String(event.post_fullname || "").toLowerCase()
    && String(lease.navigation_id || "") === String(event.navigation_id || "")
  );
}

function navigationFailureFromTab(changeInfo = {}, tab = {}) {
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

function navigationFailureContext(batch, target) {
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

function navigationFailureEvent(batch, target, lease, failure, observedAt) {
  const sequence = (Number(batch.event_seq) || 0) + 1;
  batch.event_seq = sequence;
  const startedAt = Date.parse(batch.started_at || "");
  return {
    schema: BATCH_EVENT_SCHEMA,
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

function navigationFailureRecord(lease, failure, observedAt) {
  return {
    navigation_id: lease.navigation_id,
    failure_kind: failure.failure_kind,
    reason_code: failure.reason_code,
    evidence_source: failure.evidence_source,
    displayed_http_status: failure.displayed_http_status ?? null,
    observed_at: observedAt
  };
}

async function nativeCollectorId() {
  const stored = await chrome.storage.local.get(COLLECTOR_ID_KEY);
  const existing = String(stored?.[COLLECTOR_ID_KEY] || "").trim();
  if (validControlRequestId(existing)) return existing;
  const collectorId = `collector-${newWorkerToken()}`;
  await chrome.storage.local.set({ [COLLECTOR_ID_KEY]: collectorId });
  return collectorId;
}

async function rememberedControlWorkTabId() {
  const stored = await chrome.storage.session.get(CONTROL_WORK_TAB_KEY);
  const tabId = stored?.[CONTROL_WORK_TAB_KEY];
  return Number.isInteger(tabId) ? tabId : null;
}

async function rememberControlWorkTab(tab) {
  if (Number.isInteger(tab?.id)) await chrome.storage.session.set({ [CONTROL_WORK_TAB_KEY]: tab.id });
  return tab;
}

async function claimWorker(sender, batchId, expectedTabId = null) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId) || !isRedditTab(sender?.tab)) {
    throw outputError("REDDIT_PAGE_REQUIRED", "只能从 Reddit 采集页面取得批量工作权。");
  }
  if (Number.isInteger(expectedTabId) && expectedTabId !== tabId) {
    throw outputError("WORKER_NOT_OWNER", "只能由原工作标签页恢复中断的批量任务。");
  }
  const current = await activeWorkerLock();
  if (current) {
    throw outputError("WORKER_ALREADY_ACTIVE", `已有批量工作标签页正在运行（标签页 ${current.tab_id}）。请在该标签页暂停、完成或清空任务后再启动新的批量任务。`);
  }
  const lock = {
    batch_id: String(batchId || timestampLabel()),
    tab_id: tabId,
    worker_token: newWorkerToken(),
    claimed_at: new Date().toISOString()
  };
  await chrome.storage.session.set({ [WORKER_LOCK_KEY]: lock });
  return { ok: true, status: "worker_claimed", ...lock };
}

async function restoreWorker(sender, batchId, expectedTabId = null) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId) || !isRedditTab(sender?.tab)) {
    throw outputError("REDDIT_PAGE_REQUIRED", "只能从 Reddit 采集页面恢复批量工作权。");
  }
  if (Number.isInteger(expectedTabId) && expectedTabId !== tabId) {
    throw outputError("WORKER_NOT_OWNER", "只能由原工作标签页恢复中断的批量任务。");
  }
  const requestedBatchId = String(batchId || "").trim();
  if (!requestedBatchId) {
    throw outputError("WORKER_BATCH_REQUIRED", "恢复批量任务缺少批次标识。");
  }
  const current = await activeWorkerLock();
  if (!current) return claimWorker(sender, requestedBatchId, expectedTabId);
  if (current.tab_id !== tabId) {
    throw outputError("WORKER_NOT_OWNER", `批量任务仍由标签页 ${current.tab_id} 持有，不能从当前标签页接管。`);
  }
  if (current.batch_id !== requestedBatchId) {
    throw outputError("WORKER_ALREADY_ACTIVE", "当前标签页已有另一批量任务，不能混用工作权。请先结束该批次。");
  }
  // 扩展重载会使页面脚本中的副本令牌过期，但同一 tab、同一 batch 的
  // session 锁仍然是唯一可信工作权；返回它让新脚本重新对齐后再写入。
  return { ok: true, status: "worker_restored", ...current };
}

async function workerStatus(sender, workerToken) {
  const current = await activeWorkerLock();
  const owner = Boolean(current && current.tab_id === sender?.tab?.id && current.worker_token === workerToken);
  return {
    ok: true,
    active: Boolean(current),
    owner,
    tab_id: current?.tab_id || null,
    batch_id: current?.batch_id || null
  };
}

async function cancelOrphanedBatchManifest(root, lock) {
  if (!validBatchId(lock?.batch_id)) {
    throw outputError("ORPHANED_WORKER_INVALID", "遗留工作页锁缺少有效批次标识，未修改批次清单。");
  }
  const layer = await root.getDirectoryHandle(OUTPUT_LAYER, { create: false });
  const batches = await layer.getDirectoryHandle("batches", { create: false });
  const filename = `${lock.batch_id}.json`;
  const manifest = await readJsonFile(batches, filename);
  if (manifest?.batch_id !== lock.batch_id) {
    throw outputError("ORPHANED_WORKER_BATCH_MISMATCH", "遗留工作页锁与批次清单不匹配，未修改批次清单。");
  }
  if (!manifest.active || manifest.cancelled) return { ok: true, status: "orphaned_batch_already_final" };
  const cancelledAt = new Date().toISOString();
  manifest.active = false;
  manifest.paused = false;
  manifest.cancelled = true;
  manifest.cancelled_at = cancelledAt;
  manifest.cancel_reason = "worker_tab_closed";
  manifest.targets = (manifest.targets || []).map((target) => {
    if (target?.status === "running") {
      return { ...target, status: "interrupted", error: "唯一工作标签页已关闭", finished_at: cancelledAt };
    }
    if (target?.status === "queued") return { ...target, status: "unprocessed", error: null, finished_at: null };
    return target;
  });
  await writeTextFile(
    await batches.getFileHandle(filename, { create: true }),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "OUTPUT_WRITE_FAILED",
    `${OUTPUT_LAYER}/batches/${filename}`
  );
  return { ok: true, status: "orphaned_batch_cancelled", batch_id: lock.batch_id };
}

async function releaseWorker(sender, workerToken) {
  const current = await activeWorkerLock();
  if (!current) return { ok: true, status: "worker_not_active" };
  if (current.tab_id !== sender?.tab?.id || current.worker_token !== workerToken) {
    throw outputError("WORKER_NOT_OWNER", "当前标签页不是该批量任务的工作标签页，未清空任务锁。");
  }
  await chrome.storage.session.remove(WORKER_LOCK_KEY);
  return { ok: true, status: "worker_released" };
}

async function requireWriteWorker(sender, workerToken) {
  const current = await activeWorkerLock();
  if (!current) return;
  if (current.tab_id === sender?.tab?.id && current.worker_token === workerToken) return;
  throw outputError("WORKER_NOT_OWNER", "当前批量任务只能由启动它的单一 Reddit 标签页写入数据。");
}

chrome.tabs.onRemoved.addListener((tabId) => {
  activeWorkerLock().then(async (current) => {
    if (current?.tab_id === tabId) await chrome.storage.session.remove(WORKER_LOCK_KEY);
    if (await rememberedControlWorkTabId() === tabId) await chrome.storage.session.remove(CONTROL_WORK_TAB_KEY);
    const lease = await activeNavigationLease();
    if (Number(lease?.tab_id) === Number(tabId)) await clearNavigationLease();
  }).catch(() => { /* 关闭标签页时不影响其他扩展功能。 */ });
});

if (chrome?.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void observeNavigationTabUpdate(tabId, changeInfo, tab).catch(() => { /* 错误页观测失败不能影响 Chrome 自身导航。 */ });
  });
}

async function writeTextFile(fileHandle, text, code, label) {
  let writable;
  try {
    writable = await fileHandle.createWritable();
    await writable.write(String(text || ""));
    await writable.close();
  } catch (error) {
    try { await writable?.abort(); } catch { /* Preserve the first write error. */ }
    throw outputError(code, `无法更新 ${label}：${String(error?.message || error)}`);
  }
}

async function appendTextFile(directory, filename, text, label) {
  const handle = await directory.getFileHandle(filename, { create: true });
  if (!text) return;
  const file = await handle.getFile();
  let writable;
  try {
    writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(file.size);
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try { await writable?.abort(); } catch { /* Preserve the first write error. */ }
    throw outputError("OUTPUT_WRITE_FAILED", `无法追加 ${label}：${String(error?.message || error)}`);
  }
}

async function readTextFile(directory, filename, { optional = false } = {}) {
  try {
    const handle = await directory.getFileHandle(filename, { create: false });
    return await (await handle.getFile()).text();
  } catch (error) {
    if (optional && error?.name === "NotFoundError") return null;
    throw outputError("OUTPUT_READ_FAILED", `无法读取 ${filename}：${String(error?.message || error)}`);
  }
}

async function readJsonFile(directory, filename, { optional = false } = {}) {
  const text = await readTextFile(directory, filename, { optional });
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw outputError("OUTPUT_JSON_INVALID", `${filename} 不是有效 JSON，未写入任何文件。`);
  }
}

async function readSubredditRegistry(root) {
  let registryHandle;
  let jsonText;
  try {
    const rules = await root.getDirectoryHandle("rules", { create: false });
    registryHandle = await rules.getFileHandle("subreddit_registry.json", { create: false });
    jsonText = await (await registryHandle.getFile()).text();
  } catch {
    throw outputError("SUBREDDIT_REGISTRY_NOT_FOUND", "所选目录缺少 rules/subreddit_registry.json，未写入任何文件。");
  }
  try {
    return { registryHandle, jsonText, parsed: parseSubredditRegistry(jsonText) };
  } catch (error) {
    throw registryOutputError(error);
  }
}

async function autoRegisterSubreddit(context, registryState) {
  const subreddit = normaliseSubredditName(context?.subreddit);
  if (!subreddit) {
    throw outputError("SUBREDDIT_NAME_UNAVAILABLE", "无法从当前 Reddit 页面读取可靠的 subreddit 名称，未写入任何文件。请刷新页面后重试。");
  }
  let update;
  try {
    update = registerSubredditInRegistry(registryState.jsonText, { subreddit, category: context?.category || "manual" });
  } catch (error) {
    throw registryOutputError(error);
  }
  if (update.changed) {
    await writeTextFile(registryState.registryHandle, update.json, "SUBREDDIT_REGISTRY_WRITE_FAILED", "rules/subreddit_registry.json");
  }
  return { entry: update.entry, autoRegistered: update.changed };
}

async function subredditOutput(context) {
  const root = await loadWritableOutputRoot();
  const subreddit = normaliseSubredditName(context?.subreddit);
  if (!subreddit) throw outputError("SUBREDDIT_NAME_UNAVAILABLE", "当前页面没有可用 subreddit，未写入任何文件。");
  const registryState = await readSubredditRegistry(root);
  let entry = registryState.parsed.entries.find((candidate) => candidate.canonicalName === subreddit.toLowerCase());
  let autoRegistered = false;
  if (!entry) {
    const registration = await autoRegisterSubreddit({ ...context, subreddit }, registryState);
    entry = registration.entry;
    autoRegistered = registration.autoRegistered;
  }
  try {
    const layer = await root.getDirectoryHandle(OUTPUT_LAYER, { create: true });
    const directory = await layer.getDirectoryHandle(entry.slug, { create: true });
    return { root, entry, directory, autoRegistered };
  } catch (error) {
    throw outputError("OUTPUT_DIRECTORY_UNAVAILABLE", `无法创建采集 subreddit 目录：${String(error?.message || error)}`);
  }
}

async function postOutput(context, post) {
  const subreddit = await subredditOutput(context);
  let location;
  try {
    location = postDirectory(subreddit.entry, post);
  } catch (error) {
    if (error instanceof OutputPathError) throw outputError(error.code, error.message);
    throw error;
  }
  try {
    const matches = [];
    for await (const [name, handle] of subreddit.directory.entries()) {
      if (handle.kind === "directory") matches.push({ name, handle });
    }
    const directoryName = resolvePostDirectoryName(matches.map((match) => match.name), location.postId, location.directoryName);
    const existing = matches.find((match) => match.name === directoryName) || null;
    const directory = existing?.handle || await subreddit.directory.getDirectoryHandle(directoryName, { create: true });
    return {
      ...subreddit,
      ...location,
      directoryName,
      relativeDirectory: location.relativeDirectory,
      directory
    };
  } catch (error) {
    if (error instanceof OutputPathError) throw outputError(error.code, error.message);
    throw outputError("OUTPUT_DIRECTORY_UNAVAILABLE", `无法创建帖子目录：${String(error?.message || error)}`);
  }
}

async function ensurePostDocument(target, post, capturedAt) {
  const existing = await readJsonFile(target.directory, "post.json", { optional: true });
  if (existing?.post?.fullname) {
    if (existing.post.fullname !== post.fullname) {
      throw outputError("POST_DIRECTORY_CONFLICT", `帖子目录 ${target.relativeDirectory} 的身份与当前帖子不一致，未写入任何文件。`);
    }
    return { document: existing, created: false };
  }
  const document = makePostDocument(post, target, capturedAt);
  await writeTextFile(
    await target.directory.getFileHandle("post.json", { create: true }),
    `${JSON.stringify(document, null, 2)}\n`,
    "OUTPUT_WRITE_FAILED",
    `${target.relativeDirectory}/post.json`
  );
  return { document, created: true };
}

function postRecordFor(records, postFullname) {
  if (postFullname) {
    return (records || []).find((record) => record?.record_type === "post" && record.fullname === postFullname) || null;
  }
  return (records || []).find((record) => record?.record_type === "post") || null;
}

async function syncPosts({ context, records, capturedAt = new Date().toISOString() }) {
  const native = await nativeHostOperation("sync_posts", { context, records, capturedAt });
  if (native) return native;
  const posts = (records || []).filter((record) => record?.record_type === "post");
  const created = [];
  const existing = [];
  const skipped = [];
  for (const post of posts) {
    try {
      const target = await postOutput(context, post);
      const result = await ensurePostDocument(target, post, capturedAt);
      const summary = { fullname: post.fullname, title: post.title || target.urlSlug, relativePath: target.relativeDirectory };
      (result.created ? created : existing).push(summary);
    } catch (error) {
      skipped.push({
        fullname: post.fullname || null,
        title: post.title || "",
        code: error?.code || "POST_DIRECTORY_UNAVAILABLE",
        error: String(error?.message || error)
      });
    }
  }
  return {
    ok: true,
    status: "posts_synced",
    created_count: created.length,
    existing_count: existing.length,
    skipped_count: skipped.length,
    created,
    existing,
    skipped
  };
}

function commentSnapshot(records, postFullname) {
  const byFullname = new Map();
  for (const record of records || []) {
    if (record?.record_type !== "comment") continue;
    if (record.post_fullname !== postFullname) {
      throw outputError("COMMENT_POST_MISMATCH", "评论的 post_fullname 与当前帖子不一致，未写入任何评论。");
    }
    if (record.ownership_verified !== true) {
      throw outputError("COMMENT_OWNERSHIP_UNVERIFIED", "评论缺少当前帖子归属证据，未写入任何评论。");
    }
    if (record.parent_fullname === record.fullname) {
      throw outputError("COMMENT_SELF_PARENT", "评论父级不能指向自身，未写入任何评论。");
    }
    if (!record.fullname) {
      throw outputError("COMMENT_ID_UNAVAILABLE", "评论缺少 t1_* 身份，未写入任何评论。");
    }
    byFullname.set(record.fullname, record);
  }
  return [...byFullname.values()].sort((left, right) => {
    const leftTime = left.published_at || left.captured_at || "";
    const rightTime = right.published_at || right.captured_at || "";
    return leftTime.localeCompare(rightTime) || left.fullname.localeCompare(right.fullname);
  });
}

function sameCommentIds(left, right) {
  const leftIds = new Set((left || []).map((record) => record?.fullname).filter(Boolean));
  const rightIds = new Set((right || []).map((record) => record?.fullname).filter(Boolean));
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}

async function storeThread({ context, records, capture = {} }) {
  const native = await nativeHostOperation("store_thread", { context, records, capture });
  if (native) return native;
  const post = postRecordFor(records, context?.post_fullname);
  if (!post) throw outputError("THREAD_POST_UNAVAILABLE", "评论树中没有可写入的帖子记录。");
  if (context?.post_fullname && post.fullname !== context.post_fullname) {
    throw outputError("THREAD_POST_MISMATCH", "当前页面帖子与待写入帖子不一致，未写入任何评论。");
  }
  const target = await postOutput(context, post);
  const capturedAt = capture.captured_at || new Date().toISOString();
  const postResult = await ensurePostDocument(target, post, capturedAt);
  const existingComments = parseJsonLines(await readTextFile(target.directory, "comments.jsonl", { optional: true }) || "");
  const comments = commentSnapshot(records, post.fullname);
  const existingIds = new Set(existingComments.map((record) => record?.fullname).filter(Boolean));
  const newCommentCount = comments.filter((record) => !existingIds.has(record.fullname)).length;
  await writeTextFile(
    await target.directory.getFileHandle("comments.jsonl", { create: true }),
    serialiseJsonLines(comments),
    "OUTPUT_WRITE_FAILED",
    `${target.relativeDirectory}/comments.jsonl`
  );
  const persistedComments = parseJsonLines(await readTextFile(target.directory, "comments.jsonl") || "");
  if (!sameCommentIds(comments, persistedComments)) {
    throw outputError("COMMENT_SNAPSHOT_VERIFY_FAILED", "评论快照回读校验失败，未继续写入 thread.json。");
  }
  const captureRecord = makeCaptureRecord({
    captureId: capture.capture_id || timestampLabel(),
    capturedAt,
    sourceUrl: capture.source_url || context?.canonical_url || context?.source_url,
    postFullname: post.fullname,
    reportedCommentCount: capture.reported_comment_count,
    collectedCommentCount: comments.length,
    knownCommentCount: comments.length,
    newCommentCount,
    coverageStatus: capture.coverage_status,
    commentCountGap: capture.comment_count_gap,
    visibleCommentCount: capture.visible_comment_count,
    rejectedForeignCommentCount: capture.rejected_foreign_comment_count,
    settleWaitMs: capture.settle_wait_ms,
    navigationJitterMs: capture.navigation_jitter_ms,
    totalWaitMs: capture.total_wait_ms,
    zeroCommentRecheckCount: capture.zero_comment_recheck_count,
    pageEvents: capture.page_events,
    treeDiagnostics: capture.tree_diagnostics,
    quality: capture.quality,
    status: capture.status || "complete",
    error: capture.error
  });
  await appendTextFile(target.directory, "captures.jsonl", serialiseJsonLines([captureRecord]), `${target.relativeDirectory}/captures.jsonl`);
  const captures = parseJsonLines(await readTextFile(target.directory, "captures.jsonl", { optional: true }) || "");
  const thread = buildThreadDocument(postResult.document, comments, captures, capturedAt);
  await writeTextFile(
    await target.directory.getFileHandle("thread.json", { create: true }),
    `${JSON.stringify(thread, null, 2)}\n`,
    "OUTPUT_WRITE_FAILED",
    `${target.relativeDirectory}/thread.json`
  );
  return {
    ok: true,
    status: "thread_stored",
    relativePath: target.relativeDirectory,
    post_fullname: post.fullname,
    created_post_directory: postResult.created,
    collected_comment_count: comments.length,
    new_comment_count: newCommentCount,
    known_comment_count: comments.length,
    snapshot_replaced: true,
    capture: captureRecord
  };
}

async function recordThreadFailure({ context, target, capture = {} }) {
  const native = await nativeHostOperation("record_thread_failure", { context, target, capture });
  if (native) return native;
  const post = target?.post;
  if (!post) throw outputError("THREAD_POST_UNAVAILABLE", "失败任务缺少帖子元数据，未写入采集日志。");
  const output = await postOutput(context, post);
  const capturedAt = capture.captured_at || new Date().toISOString();
  const postResult = await ensurePostDocument(output, post, capturedAt);
  const existingComments = parseJsonLines(await readTextFile(output.directory, "comments.jsonl", { optional: true }) || "");
  const captureRecord = makeCaptureRecord({
    captureId: capture.capture_id || timestampLabel(),
    capturedAt,
    sourceUrl: capture.source_url || target.permalink || context?.canonical_url,
    postFullname: post.fullname,
    knownCommentCount: existingComments.length,
    coverageStatus: capture.coverage_status || "failed",
    commentCountGap: capture.comment_count_gap,
    visibleCommentCount: capture.visible_comment_count,
    rejectedForeignCommentCount: capture.rejected_foreign_comment_count,
    settleWaitMs: capture.settle_wait_ms,
    navigationJitterMs: capture.navigation_jitter_ms,
    totalWaitMs: capture.total_wait_ms,
    zeroCommentRecheckCount: capture.zero_comment_recheck_count,
    pageEvents: capture.page_events,
    treeDiagnostics: capture.tree_diagnostics,
    quality: capture.quality,
    status: capture.status || "failed",
    error: capture.error
  });
  await appendTextFile(output.directory, "captures.jsonl", serialiseJsonLines([captureRecord]), `${output.relativeDirectory}/captures.jsonl`);
  const captures = parseJsonLines(await readTextFile(output.directory, "captures.jsonl", { optional: true }) || "");
  const thread = buildThreadDocument(postResult.document, existingComments, captures, capturedAt);
  await writeTextFile(
    await output.directory.getFileHandle("thread.json", { create: true }),
    `${JSON.stringify(thread, null, 2)}\n`,
    "OUTPUT_WRITE_FAILED",
    `${output.relativeDirectory}/thread.json`
  );
  return { ok: true, status: "thread_failure_recorded", relativePath: output.relativeDirectory, capture: captureRecord };
}

async function postsInLayer(directory, output, context) {
  if (!directory) return [];
  const posts = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "directory") continue;
    const postDocument = await readJsonFile(handle, "post.json", { optional: true });
    if (!postDocument?.post?.fullname || postDocument.post.subreddit?.toLowerCase() !== context.subreddit?.toLowerCase()) continue;
    const thread = await readJsonFile(handle, "thread.json", { optional: true });
    posts.push({
      directory_name: name,
      relativePath: `${OUTPUT_LAYER}/${output.entry.slug}/${name}`,
      layer: OUTPUT_LAYER,
      post: postDocument.post,
      permalink: postDocument.post.canonical_url,
      captured_at: thread?.last_captured_at || null,
      known_comment_count: Array.isArray(thread?.comments) ? thread.comments.length : 0,
      capture_count: Number(thread?.capture_count) || 0,
      last_status: thread?.latest_capture?.status || null
    });
  }
  return posts;
}

async function listKnownPosts(context) {
  const native = await nativeHostOperation("list_known_posts", { context });
  if (native) return native;
  const output = await subredditOutput(context);
  const posts = await postsInLayer(output.directory, output, context);
  posts.sort((left, right) => (right.captured_at || "").localeCompare(left.captured_at || "") || String(left.post.title || "").localeCompare(String(right.post.title || "")));
  return { ok: true, status: "known_posts", subreddit: context.subreddit, posts };
}

async function listKnownPostFullnames(context) {
  const native = await nativeHostOperation("list_known_post_fullnames", { context });
  if (native) return native;
  const root = await loadWritableOutputRoot();
  const subreddit = normaliseSubredditName(context?.subreddit);
  if (!subreddit) throw outputError("SUBREDDIT_NAME_UNAVAILABLE", "当前页面没有可用 subreddit，未读取帖子目录。");
  const registryState = await readSubredditRegistry(root);
  const entry = registryState.parsed.entries.find((candidate) => candidate.canonicalName === subreddit.toLowerCase());
  if (!entry) return { ok: true, status: "known_post_fullnames", subreddit: context?.subreddit || subreddit, post_fullnames: [] };
  let directory;
  try {
    const layer = await root.getDirectoryHandle(OUTPUT_LAYER, { create: false });
    directory = await layer.getDirectoryHandle(entry.slug, { create: false });
  } catch (error) {
    if (error?.name === "NotFoundError") {
      return { ok: true, status: "known_post_fullnames", subreddit: context?.subreddit || subreddit, post_fullnames: [] };
    }
    throw outputError("OUTPUT_READ_FAILED", `无法读取 ${OUTPUT_LAYER}/${entry.slug}：${String(error?.message || error)}`);
  }
  const fullnames = new Set();
  for await (const [_name, handle] of directory.entries()) {
    if (handle.kind !== "directory") continue;
    const post = (await readJsonFile(handle, "post.json", { optional: true }))?.post;
    const fullname = String(post?.fullname || "").trim().toLowerCase();
    if (post?.subreddit?.toLowerCase() === subreddit.toLowerCase() && /^t3_[a-z0-9]+$/.test(fullname)) {
      fullnames.add(fullname);
    }
  }
  return { ok: true, status: "known_post_fullnames", subreddit: context?.subreddit || subreddit, post_fullnames: [...fullnames].sort() };
}

async function validateCommentOwners(context) {
  const native = await nativeHostOperation("validate_comment_owners", { context });
  if (native) return native;
  const output = await subredditOutput(context);
  const layer = await output.root.getDirectoryHandle(OUTPUT_LAYER, { create: false });
  const ownerByComment = new Map();
  let checkedComments = 0;
  let checkedSubreddits = 0;
  let selfParentCount = 0;
  let mismatchedPostCount = 0;
  const duplicateCommentIds = new Set();
  for await (const [subredditSlug, subredditHandle] of layer.entries()) {
    if (subredditSlug === "batches" || subredditHandle.kind !== "directory") continue;
    checkedSubreddits += 1;
    for await (const [directoryName, handle] of subredditHandle.entries()) {
      if (handle.kind !== "directory") continue;
      const postDocument = await readJsonFile(handle, "post.json", { optional: true });
      const postFullname = postDocument?.post?.fullname || null;
      const comments = parseJsonLines(await readTextFile(handle, "comments.jsonl", { optional: true }) || "");
      const location = `${subredditSlug}/${directoryName}`;
      for (const comment of comments) {
        if (comment?.record_type !== "comment" || !comment.fullname) continue;
        checkedComments += 1;
        if (!postFullname || comment.post_fullname !== postFullname) mismatchedPostCount += 1;
        if (comment.parent_fullname === comment.fullname) selfParentCount += 1;
        const prior = ownerByComment.get(comment.fullname);
        if (prior) duplicateCommentIds.add(comment.fullname);
        else ownerByComment.set(comment.fullname, location);
      }
    }
  }
  return {
    ok: true,
    status: "comment_owner_check",
    scope: OUTPUT_LAYER,
    checked_subreddit_count: checkedSubreddits,
    checked_comment_count: checkedComments,
    duplicate_comment_count: duplicateCommentIds.size,
    duplicate_comment_ids: [...duplicateCommentIds].slice(0, 20),
    self_parent_count: selfParentCount,
    mismatched_post_count: mismatchedPostCount
  };
}

function batchTargetSummary(target, status) {
  return {
    fullname: target?.fullname || target?.post?.fullname || null,
    title: target?.title || target?.post?.title || "",
    permalink: target?.permalink || null,
    attempts: Number(target?.attempts) || 0,
    rate_limit_failures: Number(target?.rate_limit_failures) || 0,
    navigation_failures: Number(target?.navigation_failures) || 0,
    last_failure: target?.last_failure || null,
    status,
    error: target?.error || target?.last_error || null,
    finished_at: target?.finished_at || null
  };
}

function batchManifest(batch) {
  const cancelled = Boolean(batch?.cancelled);
  return {
    schema: "reddit-rpa-batch-v1",
    batch_id: String(batch?.batch_id || ""),
    subreddit: batch?.context?.subreddit || null,
    started_at: batch?.started_at || null,
    completed_at: batch?.completed_at || null,
    active: Boolean(batch?.active),
    paused: Boolean(batch?.paused),
    cancelled,
    cancelled_at: batch?.cancelled_at || null,
    cancel_reason: batch?.cancel_reason || null,
    selected_count: Number(batch?.selected_count) || 0,
    selection_mode: batch?.selection_mode || "selected",
    config: batch?.config || {},
    rate_limit: batch?.rate_limit || null,
    navigation_failure: batch?.navigation_failure || null,
    recovery: batch?.recovery || null,
    targets: [
      ...(batch?.queue || []).map((target) => batchTargetSummary(target, cancelled ? "unprocessed" : "queued")),
      ...(batch?.current ? [batchTargetSummary(batch.current, cancelled ? "interrupted" : "running")] : []),
      ...(batch?.completed || []).map((target) => batchTargetSummary(target, "complete")),
      ...(batch?.tree_partial || []).map((target) => batchTargetSummary(target, "tree_partial")),
      ...(batch?.manual || []).map((target) => batchTargetSummary(target, "manual")),
      ...(batch?.failed || []).map((target) => batchTargetSummary(target, "failed"))
    ],
    integrity: batch?.integrity || null
  };
}

async function storeBatchManifest({ context, batch }) {
  const native = await nativeHostOperation("store_batch", { context, batch });
  if (native) return native;
  const output = await subredditOutput(context || batch?.context);
  const manifest = batchManifest(batch);
  if (!/^[A-Za-z0-9_.-]+$/.test(manifest.batch_id)) {
    throw outputError("BATCH_ID_INVALID", "批次 ID 无效，未写入批次清单。");
  }
  const layer = await output.root.getDirectoryHandle(OUTPUT_LAYER, { create: true });
  const batches = await layer.getDirectoryHandle("batches", { create: true });
  const relativePath = `${OUTPUT_LAYER}/batches/${manifest.batch_id}.json`;
  await writeTextFile(
    await batches.getFileHandle(`${manifest.batch_id}.json`, { create: true }),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "OUTPUT_WRITE_FAILED",
    relativePath
  );
  return { ok: true, status: "batch_manifest_stored", relativePath, manifest };
}

function validBatchId(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || ""));
}

function normaliseTreeDiagnostics(value) {
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

function validControlRequestId(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || ""));
}

function normaliseBatchEvent(event = {}) {
  const batchId = String(event.batch_id || "").trim();
  const eventName = String(event.event || "").trim();
  const sequence = Number(event.seq);
  if (!validBatchId(batchId)) throw outputError("BATCH_ID_INVALID", "批次事件缺少有效 batch_id，未写入事件日志。");
  if (!BATCH_EVENT_NAMES.has(eventName)) throw outputError("BATCH_EVENT_INVALID", "批次事件类型无效，未写入事件日志。");
  if (!Number.isInteger(sequence) || sequence < 1) throw outputError("BATCH_EVENT_INVALID", "批次事件缺少有效序号，未写入事件日志。");
  const postFullname = event.post_fullname == null ? null : String(event.post_fullname);
  if (postFullname && !/^t3_[A-Za-z0-9]+$/i.test(postFullname)) {
    throw outputError("BATCH_EVENT_INVALID", "批次事件的帖子代码无效，未写入事件日志。");
  }
  const navigationId = event.navigation_id == null ? null : String(event.navigation_id).trim();
  if (navigationId && !validNavigationId(navigationId)) {
    throw outputError("BATCH_EVENT_INVALID", "批次事件的导航标识无效，未写入事件日志。");
  }
  const failureKind = event.failure_kind == null ? null : String(event.failure_kind).trim();
  if (failureKind && !NAVIGATION_FAILURE_KINDS.has(failureKind)) {
    throw outputError("BATCH_EVENT_INVALID", "批次事件的失败分类无效，未写入事件日志。");
  }
  const evidenceSource = event.evidence_source == null ? null : String(event.evidence_source).trim();
  if (evidenceSource && !NAVIGATION_EVIDENCE_SOURCES.has(evidenceSource)) {
    throw outputError("BATCH_EVENT_INVALID", "批次事件的证据来源无效，未写入事件日志。");
  }
  const displayedHttpStatus = event.displayed_http_status == null ? null : Number(event.displayed_http_status);
  if (displayedHttpStatus != null && (!Number.isInteger(displayedHttpStatus) || displayedHttpStatus < 100 || displayedHttpStatus > 599)) {
    throw outputError("BATCH_EVENT_INVALID", "批次事件的 HTTP 状态无效，未写入事件日志。");
  }
  return {
    schema: BATCH_EVENT_SCHEMA,
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

async function storeBatchEvent({ event }) {
  const native = await nativeHostOperation("store_batch_event", { event });
  if (native) return native;
  const normalised = normaliseBatchEvent(event);
  const root = await loadWritableOutputRoot();
  const layer = await root.getDirectoryHandle(OUTPUT_LAYER, { create: true });
  const batches = await layer.getDirectoryHandle("batches", { create: true });
  const filename = `${normalised.batch_id}.events.jsonl`;
  await appendTextFile(batches, filename, serialiseJsonLines([normalised]), `${OUTPUT_LAYER}/batches/${filename}`);
  return { ok: true, status: "batch_event_stored", event: normalised };
}

function navigationEventConcludesLease(eventName) {
  return new Set([
    "page_ready", "capture_saved", "retry", "rate_limited", "navigation_error_observed",
    "navigation_timeout", "paused", "batch_finished", "cancelled"
  ]).has(eventName);
}

async function registerNavigationLease(message, sender) {
  const batchId = String(message?.batch_id || "").trim();
  const postFullname = String(message?.post_fullname || "").trim();
  const navigationId = String(message?.navigation_id || "").trim();
  const targetUrl = String(message?.target_url || "").trim();
  if (!validBatchId(batchId) || !validPostFullname(postFullname) || !validNavigationId(navigationId)) {
    throw outputError("NAVIGATION_LEASE_INVALID", "导航租约缺少有效的批次、帖子或导航标识。")
  }
  if (!isRedditTab({ url: targetUrl })) {
    throw outputError("NAVIGATION_LEASE_INVALID", "导航租约的目标不是 Reddit 帖子页面。")
  }
  const timeoutMs = navigationLeaseTimeoutMs({ navigationTimeoutMs: message?.timeout_ms });
  const startedAt = new Date().toISOString();
  const lease = {
    schema: "reddit-rpa-navigation-lease-v1",
    batch_id: batchId,
    worker_token: String(message?.worker_token || ""),
    tab_id: sender?.tab?.id ?? null,
    post_fullname: postFullname,
    navigation_id: navigationId,
    target_url: targetUrl,
    started_at: startedAt,
    deadline_at: new Date(Date.now() + timeoutMs).toISOString(),
    timeout_ms: timeoutMs,
    phase: "navigating"
  };
  return serialiseNavigationLease(async () => {
    const existing = await activeNavigationLease();
    if (existing && !navigationLeaseMatches(existing, lease)) {
      throw outputError("NAVIGATION_LEASE_ACTIVE", "上一条导航尚未得到终态，未开始新的工作页导航。")
    }
    await storeNavigationLease(lease);
    return { ok: true, status: "navigation_lease_started", lease };
  });
}

async function clearNavigationLeaseForEvent(event) {
  if (!navigationEventConcludesLease(event?.event) || !event?.navigation_id) return false;
  return serialiseNavigationLease(async () => {
    const lease = await activeNavigationLease();
    if (!navigationLeaseMatches(lease, event)) return false;
    await clearNavigationLease();
    return true;
  });
}

async function recordBackgroundNavigationFailure(lease, failure) {
  return serialiseNavigationLease(async () => {
    const activeLease = await activeNavigationLease();
    if (!navigationLeaseMatches(activeLease, lease) || activeLease.phase === "failure_recorded") {
      return { ok: true, status: "navigation_failure_already_recorded" };
    }
    const stored = await chrome.storage.local.get(CAPTURE_STATE_KEY);
    const state = stored?.[CAPTURE_STATE_KEY];
    const batch = state?.activeBatchJob;
    const target = batch?.current;
    if (!batch?.active || !target || String(batch.batch_id || "") !== lease.batch_id
      || String(target.post?.fullname || target.fullname || "").toLowerCase() !== lease.post_fullname.toLowerCase()) {
      await clearNavigationLease();
      return { ok: true, status: "navigation_lease_stale" };
    }

    const observedAt = new Date().toISOString();
    const failureRecord = navigationFailureRecord(lease, failure, observedAt);
    target.navigation_failures = (Number(target.navigation_failures) || 0) + 1;
    target.last_failure = failureRecord;
    target.last_error = failure.reason;
    batch.navigation_failure = {
      ...failureRecord,
      post_fullname: lease.post_fullname,
      reason: failure.reason
    };
    batch.paused = true;
    state.activeThreadJob = null;

    if (failure.rate_limited) {
      target.rate_limit_failures = (Number(target.rate_limit_failures) || 0) + 1;
      const cooldownMs = rateLimitCooldownMs(batch.config);
      failure.cooldown_ms = cooldownMs;
      batch.rate_limit = {
        post_fullname: lease.post_fullname,
        failure_count: target.rate_limit_failures,
        reason_code: failure.reason_code,
        reason: failure.reason,
        failure_kind: failure.failure_kind,
        evidence_source: failure.evidence_source,
        displayed_http_status: failure.displayed_http_status ?? null,
        cooldown_until: new Date(Date.now() + cooldownMs).toISOString(),
        outcome: "paused_for_observed_429"
      };
      if (target.rate_limit_failures >= 2) {
        const manual = {
          ...target,
          error: failure.reason,
          finished_at: observedAt
        };
        (batch.manual ||= []).push(manual);
        batch.current = null;
        batch.rate_limit.outcome = "manual";
      }
    }

    const event = navigationFailureEvent(batch, target, lease, failure, observedAt);
    state.lastResult = {
      ok: false,
      code: failure.reason_code,
      status: failure.rate_limited ? "batch_rate_limit_observed" : "batch_navigation_paused",
      error: failure.reason,
      batch: batchManifest(batch)
    };
    await chrome.storage.local.set({
      [CAPTURE_STATE_KEY]: state,
      [NAVIGATION_LEASE_KEY]: { ...activeLease, phase: "failure_recorded", failure: failureRecord }
    });

    let audit = null;
    try {
      audit = await recordThreadFailure({
        context: navigationFailureContext(batch, target),
        target,
        capture: {
          capture_id: timestampLabel(),
          captured_at: observedAt,
          source_url: target.permalink,
          coverage_status: failure.rate_limited ? "rate_limited" : "navigation_error",
          status: "manual",
          error: failure.reason
        }
      });
    } catch (error) {
      audit = { ok: false, error: String(error?.message || error) };
    }

    try {
      await storeBatchEvent({ event });
      await storeBatchManifest({ context: batch.context, batch });
    } catch (error) {
      state.lastResult = {
        ...state.lastResult,
        status: "batch_navigation_paused_persistence_failed",
        manifest_error: String(error?.message || error)
      };
      await chrome.storage.local.set({ [CAPTURE_STATE_KEY]: state });
    }
    await clearNavigationLease();
    return { ...state.lastResult, audit };
  });
}

async function processNavigationLease() {
  const lease = await activeNavigationLease();
  if (!lease || lease.phase === "failure_recorded") return { ok: true, status: "no_navigation_timeout" };
  const deadline = Date.parse(lease.deadline_at || "");
  if (!Number.isFinite(deadline) || deadline > Date.now()) return { ok: true, status: "navigation_pending" };
  return recordBackgroundNavigationFailure(lease, {
    failure_kind: "PAGE_NAVIGATION_TIMEOUT",
    reason_code: "PAGE_NAVIGATION_TIMEOUT",
    reason: "工作页在导航期限内未恢复为可采集的 Reddit 帖子页。",
    evidence_source: "background_watchdog",
    displayed_http_status: null,
    rate_limited: false
  });
}

async function observeNavigationTabUpdate(tabId, changeInfo, tab) {
  const lease = await activeNavigationLease();
  if (!lease || lease.phase === "failure_recorded" || Number(lease.tab_id) !== Number(tabId)) return null;
  const failure = navigationFailureFromTab(changeInfo, tab);
  if (!failure) return null;
  return recordBackgroundNavigationFailure(lease, failure);
}

function recoveryTargetFromManifest(target, subreddit) {
  const fullname = String(target?.fullname || "").trim();
  const permalink = String(target?.permalink || "").trim();
  if (!validPostFullname(fullname) || !permalink) return null;
  let url;
  try {
    url = new URL(permalink);
  } catch {
    return null;
  }
  const postId = fullname.replace(/^t3_/iu, "");
  const expectedSubreddit = normaliseSubredditName(subreddit);
  if (!expectedSubreddit || !isRedditTab({ url: url.href })
    || !new RegExp(`/r/${expectedSubreddit}/comments/${postId}(?:/|$)`, "iu").test(url.pathname)) return null;
  return {
    post: {
      record_type: "post",
      fullname,
      post_fullname: fullname,
      post_id: postId,
      subreddit: expectedSubreddit,
      title: String(target?.title || ""),
      canonical_url: url.href
    },
    permalink: url.href,
    attempts: 0,
    recovery_source_status: String(target?.status || "")
  };
}

function recoveryTargetsFromManifest(manifest, sourceBatchId) {
  if (!manifest || manifest.schema !== "reddit-rpa-batch-v1" || String(manifest.batch_id || "") !== String(sourceBatchId || "")) {
    throw outputError("RECOVERY_SOURCE_INVALID", "源批次清单无效，未创建补采批次。")
  }
  const subreddit = normaliseSubredditName(manifest.subreddit);
  if (!subreddit) throw outputError("RECOVERY_SOURCE_INVALID", "源批次缺少有效 subreddit，未创建补采批次。");
  const targets = (manifest.targets || [])
    .filter((target) => ["unprocessed", "interrupted"].includes(String(target?.status || "")))
    .map((target) => recoveryTargetFromManifest(target, subreddit))
    .filter(Boolean);
  const unique = new Map(targets.map((target) => [target.post.fullname.toLowerCase(), target]));
  return {
    ok: true,
    status: "recovery_targets_loaded",
    source_batch_id: String(sourceBatchId),
    subreddit,
    config: manifest.config && typeof manifest.config === "object" ? manifest.config : {},
    targets: [...unique.values()],
    recovery_count: unique.size
  };
}

async function loadRecoveryTargets(sourceBatchId) {
  if (!validBatchId(sourceBatchId)) {
    throw outputError("RECOVERY_SOURCE_INVALID", "源批次 ID 无效，未创建补采批次。");
  }
  const native = await nativeHostOperation("load_recovery_targets", { source_batch_id: sourceBatchId });
  if (native) return native;
  const root = await loadWritableOutputRoot();
  const layer = await root.getDirectoryHandle(OUTPUT_LAYER, { create: false });
  const batches = await layer.getDirectoryHandle("batches", { create: false });
  const manifest = await readJsonFile(batches, `${sourceBatchId}.json`);
  return recoveryTargetsFromManifest(manifest, sourceBatchId);
}

async function controlDirectories(root, { create = false } = {}) {
  const control = await root.getDirectoryHandle(CONTROL_DIRECTORY, { create });
  const requests = await control.getDirectoryHandle("requests", { create });
  const responses = await control.getDirectoryHandle("responses", { create });
  return { control, requests, responses };
}

async function controlResponseExists(responses, requestId) {
  try {
    await responses.getFileHandle(`${requestId}.json`, { create: false });
    return true;
  } catch (error) {
    if (error?.name === "NotFoundError") return false;
    throw error;
  }
}

function registeredControlSubreddit(value, registryState) {
  const subreddit = normaliseSubredditName(value);
  const entry = registryState.parsed.entries.find((candidate) => candidate.canonicalName === subreddit.toLowerCase());
  if (!entry) throw outputError("CONTROL_SUBREDDIT_UNKNOWN", "控制命令的 subreddit 不在登记表中，未执行。");
  return entry;
}

function normaliseControlRequest(request, registryState) {
  if (!request || request.schema !== CONTROL_REQUEST_SCHEMA) {
    throw outputError("CONTROL_REQUEST_INVALID", "控制请求格式无效，未执行。");
  }
  const requestId = String(request.request_id || "").trim();
  const command = String(request.command || "").trim();
  if (!validControlRequestId(requestId)) throw outputError("CONTROL_REQUEST_INVALID", "控制请求缺少有效 request_id，未执行。");
  if (!CONTROL_COMMANDS.has(command)) throw outputError("CONTROL_COMMAND_INVALID", "控制命令不受支持，未执行。");
  const normalised = {
    request_id: requestId,
    command,
    created_at: String(request.created_at || ""),
    batch_id: request.batch_id == null ? null : String(request.batch_id).trim(),
    source_batch_id: request.source_batch_id == null ? null : String(request.source_batch_id).trim(),
    subreddit: null,
    count: null,
    skip_existing: false
  };
  if (["prepare", "run", "retry_unfinished"].includes(command)) {
    normalised.subreddit = registeredControlSubreddit(request.subreddit, registryState).subreddit;
  }
  if (command === "run") {
    const count = Number(request.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw outputError("CONTROL_COUNT_INVALID", "控制采集数量必须是 1 到 50 之间的整数，未执行。");
    }
    normalised.count = count;
    if (request.skip_existing != null && typeof request.skip_existing !== "boolean") {
      throw outputError("CONTROL_SKIP_EXISTING_INVALID", "skip_existing 必须是布尔值，未执行。")
    }
    normalised.skip_existing = request.skip_existing === true;
  }
  if (["pause", "resume", "cancel"].includes(command) && !validBatchId(normalised.batch_id)) {
    throw outputError("CONTROL_BATCH_INVALID", "控制命令缺少有效 batch_id，未执行。");
  }
  if (command === "retry_unfinished" && !validBatchId(normalised.source_batch_id)) {
    throw outputError("RECOVERY_SOURCE_INVALID", "精确补采命令缺少有效源批次 ID，未执行。");
  }
  return normalised;
}

async function senderMayProcessControlRequest(sender) {
  if (!isRedditTab(sender?.tab)) throw outputError("REDDIT_PAGE_REQUIRED", "控制命令只能由 Reddit 工作页执行。");
  const lock = await activeWorkerLock();
  if (lock) {
    if (lock.tab_id === sender.tab.id) return { lock, orphaned: null };
    const tabs = await chrome.tabs.query({});
    if (tabs.some((tab) => tab.id === lock.tab_id)) {
      throw outputError("WORK_PAGE_REQUIRED", "当前标签页不是批量任务的唯一工作页，未执行控制命令。");
    }
    await chrome.storage.session.remove(WORKER_LOCK_KEY);
    return { lock: null, orphaned: lock };
  }
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTabs?.[0]?.id !== sender.tab.id) {
    throw outputError("WORK_PAGE_REQUIRED", "请在唯一、当前激活的 Reddit 工作页执行控制命令。");
  }
  return { lock: null, orphaned: null };
}

async function nextControlRequest(root) {
  const directories = await controlDirectories(root, { create: true });
  const files = [];
  for await (const [filename, handle] of directories.requests.entries()) {
    if (handle.kind === "file" && filename.endsWith(".json")) files.push(filename);
  }
  files.sort();
  for (const filename of files) {
    let request;
    try {
      request = JSON.parse(await (await directories.requests.getFileHandle(filename, { create: false })).getFile().then((file) => file.text()));
    } catch (error) {
      const requestId = filename.slice(0, -5);
      if (!validControlRequestId(requestId) || await controlResponseExists(directories.responses, requestId)) continue;
      return {
        directories,
        request: { request_id: requestId, command: "invalid" },
        error
      };
    }
    const requestId = String(request?.request_id || "").trim();
    if (!validControlRequestId(requestId)) continue;
    if (await controlResponseExists(directories.responses, requestId)) continue;
    return { directories, request, error: null };
  }
  return null;
}

async function writeControlResponse(responses, request, result) {
  const response = {
    schema: CONTROL_RESPONSE_SCHEMA,
    request_id: request.request_id,
    command: request.command,
    handled_at: new Date().toISOString(),
    ...result
  };
  await writeTextFile(
    await responses.getFileHandle(`${request.request_id}.json`, { create: true }),
    `${JSON.stringify(response, null, 2)}\n`,
    "CONTROL_RESPONSE_WRITE_FAILED",
    `${CONTROL_DIRECTORY}/responses/${request.request_id}.json`
  );
  return response;
}

function controlCommand(request) {
  const commands = {
    prepare: ["prepareControlPage", { subreddit: request.subreddit }],
    run: ["runControlledBatch", { subreddit: request.subreddit, count: request.count, skip_existing: request.skip_existing }],
    retry_unfinished: ["retryUnfinishedBatch", { source_batch_id: request.source_batch_id }],
    pause: ["pauseControlledBatch", { batch_id: request.batch_id }],
    resume: ["resumeControlledBatch", { batch_id: request.batch_id }],
    cancel: ["cancelControlledBatch", { batch_id: request.batch_id }]
  };
  const [command, payload] = commands[request.command] || [];
  if (!command) throw outputError("CONTROL_COMMAND_INVALID", "控制命令不受支持，未执行。");
  return { command, payload };
}

async function executeControlRequestForTab(tabId, request) {
  const { command, payload } = controlCommand(request);
  return sendToRedditTab(tabId, command, payload);
}

async function executeControlRequest(sender, request) {
  return executeControlRequestForTab(sender.tab.id, request);
}

async function processControlPoll(sender) {
  if (controlRequestInFlight) return { ok: true, status: "control_busy" };
  const native = await nativeHostOperation("status");
  if (native) {
    scheduleNativeControlLoop();
    void processNativeControlLoop();
    return { ok: true, status: "control_background_active", backend: "native" };
  }
  controlRequestInFlight = true;
  try {
    const worker = await senderMayProcessControlRequest(sender);
    const root = await loadWritableOutputRoot();
    if (worker.orphaned) await cancelOrphanedBatchManifest(root, worker.orphaned);
    const pending = await nextControlRequest(root);
    if (!pending) return { ok: true, status: "control_idle" };
    let result;
    if (pending.error) {
      result = { ok: false, code: pending.error?.code || "CONTROL_REQUEST_INVALID", error: String(pending.error?.message || pending.error) };
    } else {
      try {
        const registryState = await readSubredditRegistry(root);
        pending.request = normaliseControlRequest(pending.request, registryState);
        result = await executeControlRequest(sender, pending.request);
      } catch (error) {
        result = { ok: false, code: error?.code || "CONTROL_COMMAND_FAILED", error: String(error?.message || error) };
      }
    }
    const response = await writeControlResponse(pending.directories.responses, pending.request, result || { ok: false, code: "CONTROL_COMMAND_FAILED", error: "控制命令没有返回结果。" });
    return { ok: Boolean(response.ok), status: "control_request_processed", request_id: response.request_id, command: response.command };
  } catch (error) {
    return { ok: false, code: error?.code || "CONTROL_CHANNEL_UNAVAILABLE", error: String(error?.message || error) };
  } finally {
    controlRequestInFlight = false;
  }
}

function isRedditTab(tab) {
  try {
    const url = new URL(tab?.url || "");
    return (url.hostname === "www.reddit.com" || url.hostname === "reddit.com") && /^\/r\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function isMissingReceiver(error) {
  return /Receiving end does not exist|Could not establish connection|The message port closed before a response was received|Extension context invalidated/i.test(String(error?.message || error));
}

function expectedContentScriptVersion() {
  return String(chrome.runtime.getManifest().version || "");
}

async function injectCurrentContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
}

async function sendToRedditTab(tabId, command, payload) {
  const message = { command, ...(payload || {}) };
  try {
    const status = await chrome.tabs.sendMessage(tabId, { command: "status" });
    if (String(status?.version || "") !== expectedContentScriptVersion()) {
      await injectCurrentContentScript(tabId);
    }
  } catch (error) {
    if (!isMissingReceiver(error)) throw error;
    await injectCurrentContentScript(tabId);
  }
  return chrome.tabs.sendMessage(tabId, message);
}

async function controlTabFromId(tabs, tabId) {
  return Number.isInteger(tabId) ? tabs.find((tab) => tab.id === tabId && isRedditTab(tab)) || null : null;
}

async function ensureNativeControlWorkTab(request) {
  const tabs = await chrome.tabs.query({});
  const activeLock = await activeWorkerLock();
  let tab = await controlTabFromId(tabs, activeLock?.tab_id);
  if (!tab) tab = await controlTabFromId(tabs, await rememberedControlWorkTabId());
  if (!tab) {
    const redditTabs = tabs.filter(isRedditTab);
    if (redditTabs.length === 1) tab = redditTabs[0];
  }
  if (!tab && ["prepare", "run", "retry_unfinished"].includes(request.command)) {
    tab = await chrome.tabs.create({
      url: `https://www.reddit.com/r/${encodeURIComponent(request.subreddit)}/new/`,
      active: false
    });
  }
  if (!tab || !Number.isInteger(tab.id)) {
    throw outputError("WORK_PAGE_REQUIRED", "没有可用 Reddit 工作页；采集器未创建新工作页。")
  }
  return rememberControlWorkTab(tab);
}

async function writeNativeCollectorHeartbeat(collectorId, state = "ready", tab = null) {
  return nativeHostOperation("write_collector_heartbeat", {
    collector_id: collectorId,
    version: expectedContentScriptVersion(),
    state,
    work_tab_id: Number.isInteger(tab?.id) ? tab.id : null,
    work_url: isRedditTab(tab) ? tab.url : null
  });
}

async function processNativeControlLoop() {
  if (controlRequestInFlight) return { ok: true, status: "control_busy", backend: "native" };
  controlRequestInFlight = true;
  try {
    const collectorId = await nativeCollectorId();
    const rememberedTabId = await rememberedControlWorkTabId();
    const currentTabs = await chrome.tabs.query({});
    const currentTab = await controlTabFromId(currentTabs, rememberedTabId);
    const heartbeat = await writeNativeCollectorHeartbeat(collectorId, "ready", currentTab);
    if (!heartbeat) return { ok: false, code: "NATIVE_HOST_UNAVAILABLE", error: "Native Host 尚未安装或不可用。" };
    const pending = await nativeHostOperation("next_control_request", { collector_id: collectorId });
    if (!pending) return { ok: false, code: "NATIVE_HOST_UNAVAILABLE", error: "Native Host 在读取控制请求前断开。" };
    if (!pending.ok) throw outputError(pending.code || "NATIVE_HOST_FAILED", pending.error || "Native Host 无法读取控制请求。");
    if (pending.status === "control_idle") return { ok: true, status: "control_idle", backend: "native", collector_id: collectorId };
    const request = pending.request;
    let result;
    if (pending.validation_error) {
      result = { ok: false, code: pending.validation_error.code, error: pending.validation_error.error };
    } else {
      try {
        const tab = await ensureNativeControlWorkTab(request);
        await writeNativeCollectorHeartbeat(collectorId, "busy", tab);
        result = await executeControlRequestForTab(tab.id, request);
        await writeNativeCollectorHeartbeat(collectorId, "ready", tab);
      } catch (error) {
        result = { ok: false, code: error?.code || "CONTROL_COMMAND_FAILED", error: String(error?.message || error) };
      }
    }
    const written = await nativeHostOperation("write_control_response", { request, result });
    if (!written) return { ok: false, code: "NATIVE_HOST_UNAVAILABLE", error: "Native Host 在写入控制响应前断开。" };
    return written.response || result;
  } catch (error) {
    return { ok: false, code: error?.code || "NATIVE_CONTROL_FAILED", error: String(error?.message || error) };
  } finally {
    controlRequestInFlight = false;
  }
}

function scheduleNativeControlLoop() {
  if (!chrome?.alarms?.create) return;
  chrome.alarms.create(NATIVE_CONTROL_ALARM, { periodInMinutes: NATIVE_CONTROL_PERIOD_MINUTES });
}

function scheduleNavigationWatchdog() {
  if (!chrome?.alarms?.create) return;
  chrome.alarms.create(NAVIGATION_WATCHDOG_ALARM, { periodInMinutes: NAVIGATION_WATCHDOG_PERIOD_MINUTES });
  void processNavigationLease();
}

function startNativeControlLoop() {
  scheduleNativeControlLoop();
  scheduleNavigationWatchdog();
  void processNativeControlLoop();
}

if (chrome?.runtime?.onInstalled?.addListener) chrome.runtime.onInstalled.addListener(startNativeControlLoop);
if (chrome?.runtime?.onStartup?.addListener) chrome.runtime.onStartup.addListener(startNativeControlLoop);
scheduleNavigationWatchdog();
if (chrome?.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === NATIVE_CONTROL_ALARM) void processNativeControlLoop();
    if (alarm?.name === NAVIGATION_WATCHDOG_ALARM) void processNavigationLease();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "reddit-rpa-claim-worker") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面启动批量采集。" });
      return undefined;
    }
    claimWorker(sender, message.batch_id, message.expected_tab_id).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "WORKER_CLAIM_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-restore-worker") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面恢复批量工作状态。" });
      return undefined;
    }
    restoreWorker(sender, message.batch_id, message.expected_tab_id).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "WORKER_RESTORE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-worker-status") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面检查批量工作状态。" });
      return undefined;
    }
    workerStatus(sender, message.worker_token).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "WORKER_STATUS_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-release-worker") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面释放批量工作状态。" });
      return undefined;
    }
    releaseWorker(sender, message.worker_token).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "WORKER_RELEASE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-sync-posts") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面同步帖子目录。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token).then(() => syncPosts(message)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_WRITE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-store-thread") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 帖子页写入评论树。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token).then(() => storeThread(message)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_WRITE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-record-thread-failure") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 帖子页写入失败采集状态。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token).then(() => recordThreadFailure(message)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_WRITE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-list-known-posts") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面读取帖子目录。" });
      return undefined;
    }
    listKnownPosts(message.context).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_READ_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-list-known-post-fullnames") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面读取已有帖子代码。" });
      return undefined;
    }
    listKnownPostFullnames(message.context).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_READ_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-store-batch") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面写入批次清单。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token).then(() => storeBatchManifest(message)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_WRITE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-navigation-started") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 工作页登记导航租约。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token).then(() => registerNavigationLease(message, sender)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "NAVIGATION_LEASE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-store-batch-event") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面写入批次事件。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token)
      .then(async () => {
        const result = await storeBatchEvent(message);
        await clearNavigationLeaseForEvent(result?.event || message.event);
        return result;
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_WRITE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-load-recovery-targets") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 工作页读取精确补采目标。" });
      return undefined;
    }
    loadRecoveryTargets(String(message.source_batch_id || "")).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "RECOVERY_SOURCE_UNAVAILABLE", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-control-poll") {
    processControlPoll(sender).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "CONTROL_CHANNEL_UNAVAILABLE", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-validate-comment-owners") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面核验评论归属。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token).then(() => validateCommentOwners(message.context)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_READ_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-output-root-status") {
    nativeHostOperation("status")
      .then((native) => native || outputRootStatus())
      .then(sendResponse)
      .catch((error) => sendResponse({ configured: false, permission: "unknown", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-output-root-preflight") {
    nativeHostOperation("status")
      .then((native) => native || loadWritableOutputRoot().then((root) => ({ ok: true, status: "output_root_writable", name: root.name, backend: "filesystem-access" })))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_ROOT_UNAVAILABLE", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-command") {
    sendToRedditTab(message.tabId, message.command, message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, code: "CONTENT_SCRIPT_UNAVAILABLE", error: String(error?.message || error) }));
    return true;
  }

  return undefined;
});
