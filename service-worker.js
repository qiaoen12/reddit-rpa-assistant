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

const OUTPUT_LAYER = "raw-v2";
const LEGACY_OUTPUT_LAYER = "raw";
const WORKER_LOCK_KEY = "reddit-rpa-active-worker-v1";
const CONTENT_SCRIPT_FILES = ["reddit-dom-selectors.js", "reddit-model.js", "batch-queue.js", "content.js"];
const BATCH_EVENT_SCHEMA = "reddit-rpa-batch-event-v1";
const CONTROL_DIRECTORY = ".reddit-rpa-control";
const CONTROL_REQUEST_SCHEMA = "reddit-rpa-control-request-v1";
const CONTROL_RESPONSE_SCHEMA = "reddit-rpa-control-response-v1";
const CONTROL_COMMANDS = new Set(["prepare", "run", "pause", "resume", "cancel"]);
const NATIVE_HOST_NAME = "com.openai.reddit_rpa";
const NATIVE_REQUEST_TIMEOUT_MS = 10000;
const COLLECTOR_ID_KEY = "reddit-rpa-native-collector-id-v1";
const CONTROL_WORK_TAB_KEY = "reddit-rpa-native-control-work-tab-v1";
const NATIVE_CONTROL_ALARM = "reddit-rpa-native-control-v1";
const NATIVE_CONTROL_PERIOD_MINUTES = 0.5;
const BATCH_EVENT_NAMES = new Set([
  "batch_started", "post_navigation_started", "page_ready", "capture_saved",
  "retry", "paused", "resumed", "rate_limited", "rate_limit_cooldown_complete",
  "permission_required", "batch_finished", "cancelled"
]);
let controlRequestInFlight = false;
let nativePort = null;
let nativeRequestSequence = 0;
const nativePendingRequests = new Map();

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
  }).catch(() => { /* 关闭标签页时不影响其他扩展功能。 */ });
});

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
    return { root, entry, directory, autoRegistered, layer: OUTPUT_LAYER };
  } catch (error) {
    throw outputError("OUTPUT_DIRECTORY_UNAVAILABLE", `无法创建修订版 subreddit 目录：${String(error?.message || error)}`);
  }
}

async function postOutput(context, post) {
  const subreddit = await subredditOutput(context);
  let location;
  try {
    location = postDirectory(subreddit.entry, post, { layer: subreddit.layer });
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

async function existingSubredditDirectory(root, layerName, slug) {
  try {
    const layer = await root.getDirectoryHandle(layerName, { create: false });
    return await layer.getDirectoryHandle(slug, { create: false });
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw outputError("OUTPUT_READ_FAILED", `无法读取 ${layerName}/${slug}：${String(error?.message || error)}`);
  }
}

async function postsInLayer(directory, layerName, output, context) {
  if (!directory) return [];
  const posts = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "directory") continue;
    const postDocument = await readJsonFile(handle, "post.json", { optional: true });
    if (!postDocument?.post?.fullname || postDocument.post.subreddit?.toLowerCase() !== context.subreddit?.toLowerCase()) continue;
    const thread = await readJsonFile(handle, "thread.json", { optional: true });
    posts.push({
      directory_name: name,
      relativePath: `${layerName}/${output.entry.slug}/${name}`,
      layer: layerName,
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
  const legacyDirectory = await existingSubredditDirectory(output.root, LEGACY_OUTPUT_LAYER, output.entry.slug);
  const [legacyPosts, revisedPosts] = await Promise.all([
    postsInLayer(legacyDirectory, LEGACY_OUTPUT_LAYER, output, context),
    postsInLayer(output.directory, OUTPUT_LAYER, output, context)
  ]);
  const byFullname = new Map();
  for (const post of legacyPosts) byFullname.set(post.post.fullname.toLowerCase(), post);
  for (const post of revisedPosts) byFullname.set(post.post.fullname.toLowerCase(), post);
  const posts = [...byFullname.values()];
  posts.sort((left, right) => (right.captured_at || "").localeCompare(left.captured_at || "") || String(left.post.title || "").localeCompare(String(right.post.title || "")));
  return { ok: true, status: "known_posts", subreddit: context.subreddit, posts };
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
    tree_diagnostics: normaliseTreeDiagnostics(event.tree_diagnostics)
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
    subreddit: null,
    count: null
  };
  if (["prepare", "run"].includes(command)) {
    normalised.subreddit = registeredControlSubreddit(request.subreddit, registryState).subreddit;
  }
  if (command === "run") {
    const count = Number(request.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw outputError("CONTROL_COUNT_INVALID", "控制采集数量必须是 1 到 50 之间的整数，未执行。");
    }
    normalised.count = count;
  }
  if (["pause", "resume", "cancel"].includes(command) && !validBatchId(normalised.batch_id)) {
    throw outputError("CONTROL_BATCH_INVALID", "控制命令缺少有效 batch_id，未执行。");
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
    run: ["runControlledBatch", { subreddit: request.subreddit, count: request.count }],
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
  if (!tab && ["prepare", "run"].includes(request.command)) {
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

function startNativeControlLoop() {
  scheduleNativeControlLoop();
  void processNativeControlLoop();
}

if (chrome?.runtime?.onInstalled?.addListener) chrome.runtime.onInstalled.addListener(startNativeControlLoop);
if (chrome?.runtime?.onStartup?.addListener) chrome.runtime.onStartup.addListener(startNativeControlLoop);
if (chrome?.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === NATIVE_CONTROL_ALARM) void processNativeControlLoop();
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

  if (message?.type === "reddit-rpa-store-batch") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面写入批次清单。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token).then(() => storeBatchManifest(message)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_WRITE_FAILED", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "reddit-rpa-store-batch-event") {
    if (!isRedditTab(sender?.tab)) {
      sendResponse({ ok: false, code: "REDDIT_PAGE_REQUIRED", error: "只能从 Reddit 页面写入批次事件。" });
      return undefined;
    }
    requireWriteWorker(sender, message.worker_token).then(() => storeBatchEvent(message)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: error?.code || "OUTPUT_WRITE_FAILED", error: String(error?.message || error) }));
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
