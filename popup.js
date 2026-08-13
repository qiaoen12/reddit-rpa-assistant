import "./collector-config.js";
import {
  requestOutputRootPermission,
  saveOutputRoot,
  validateCollectionDataRoot
} from "./output-store.js";

const collectorConfig = globalThis.RedditRpaCollectorConfig;
if (!collectorConfig?.DEFAULT_CONFIG) throw new Error("Reddit RPA 默认采集配置未加载。");
const { DEFAULT_CONFIG } = collectorConfig;

const ACTION_BUTTONS = [
  "chooseOutputRoot", "reconnectOutputRoot", "probe", "captureListing", "runListing",
  "captureThread", "syncAndStartBatch", "startLatestBatch", "loadTargets", "selectAllTargets",
  "selectNoTargets", "startBatch", "clearLocal"
];

let knownPosts = [];
let selectedFullnames = new Set();
let isBusy = false;
let activeBatch = null;
let freshListingReady = false;
let settingsChanged = false;
let currentStatus = null;
let activityItems = [];
let outputRootConfigured = false;
let outputRootPermission = "none";
let outputBackend = "filesystem-access";

function element(id) {
  return document.getElementById(id);
}

function positiveInputValue(id, fallback) {
  const value = Number(element(id).value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function config() {
  return {
    listingSteps: positiveInputValue("listingSteps", DEFAULT_CONFIG.listingSteps),
    targetPostCount: positiveInputValue("targetPostCount", DEFAULT_CONFIG.targetPostCount),
    maxPosts: positiveInputValue("maxPosts", DEFAULT_CONFIG.maxPosts),
    scrollPercent: positiveInputValue("scrollPercent", DEFAULT_CONFIG.scrollPercent),
    waitMs: positiveInputValue("waitMs", DEFAULT_CONFIG.waitMs),
    expansionPasses: positiveInputValue("expansionPasses", DEFAULT_CONFIG.expansionPasses)
  };
}

function targetCount() {
  const current = config();
  return Math.min(500, Math.max(1, Math.min(current.targetPostCount, current.maxPosts)));
}

function syncedPostCount() {
  const count = Number(currentStatus?.record_count ?? currentStatus?.last_result?.records);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function batchProgressText(batch) {
  if (!batch) return "没有正在运行的批次。";
  const total = Number(batch.selected_count) || 0;
  const completed = Number(batch.completed_count) || 0;
  const partial = Number(batch.tree_partial_count) || 0;
  const manual = Number(batch.manual_count) || 0;
  const failed = Number(batch.failed_count) || 0;
  const done = completed + partial + manual + failed;
  const unprocessed = Number(batch.unprocessed_count) || 0;
  const current = batch.current?.title ? `，正在处理「${batch.current.title}」` : "";
  if (batch.cancelled) return `已结束：保留已处理 ${done}/${total} 帖，${unprocessed} 帖未执行；现在可新建任务。`;
  if (batch.paused) return `已暂停：已处理 ${done}/${total} 帖${current}`;
  if (batch.active) return `正在采集：已处理 ${done}/${total} 帖${current}`;
  if (manual || failed) return `批次结束：${completed} 完整、${partial} 树不完整、${manual} 待人工、${failed} 失败。`;
  return partial ? `批次结束：${completed} 帖完整，${partial} 帖评论可用但回复树不完整。` : `批次完成：${completed}/${total} 帖已采集。`;
}

function resultPresentation(value) {
  if (typeof value === "string") return { kind: "neutral", label: "提示", message: value };
  if (!value) return { kind: "neutral", label: "等待操作", message: "打开一个 subreddit 列表页后，从步骤 1 开始。" };
  const status = value.status || "completed";
  const batch = value.batch || value.active_batch_job;
  if (status === "batch_cancelled_worker_release_failed") {
    return { kind: "error", label: "结束未完全释放", message: "批次已停止，但工作页锁未能释放；请重载扩展后再新建任务。" };
  }
  if (status === "batch_paused_output_permission_required") {
    return { kind: "warn", label: "需要恢复授权", message: "VR-XR 写入授权已失效。请点击顶部“恢复授权”，成功后再点击“继续当前批次”。" };
  }
  if (status === "batch_rate_limited") {
    const until = value.cooldown_until || batch?.rate_limit?.cooldown_until;
    return { kind: "warn", label: "正在冷却", message: until ? `Reddit 可能限流；将在 ${until} 后只恢复当前帖子。` : "Reddit 可能限流；当前批次仅会恢复当前帖子。" };
  }
  if (status === "batch_rate_limited_manual_review") {
    return { kind: "warn", label: "限流待复核", message: "同一帖子在冷却后再次失败，已标为 manual 并暂停批次。" };
  }
  if (status === "batch_rate_limit_observed") {
    return { kind: "warn", label: "观察到 429 页面", message: "浏览器工作页显示 HTTP 429，扩展未断言其服务端来源；批次已暂停，冷却后仅恢复当前帖子。" };
  }
  if (status === "batch_navigation_paused") {
    const failure = batch?.navigation_failure || value.navigation_failure || {};
    const label = failure.failure_kind === "CLIENT_BLOCKED" ? "客户端拦截" : "工作页导航异常";
    return { kind: "warn", label, message: "当前帖子已暂停并保留队列；请恢复正常工作页后再继续。" };
  }
  if (["batch_manual_review_required", "manual_review_required"].includes(status)) {
    return { kind: "warn", label: "待人工复核", message: batchProgressText(batch) };
  }
  if (value.ok === false || value.error) return { kind: "error", label: "需要处理", message: String(value.error || "页面采集命令失败。") };

  const records = Number(value.records) || 0;
  if (status === "completed" && value.mode === "listing_sync") {
    return { kind: "ok", label: "步骤 1 已完成", message: `已同步并自动保存 ${records} 帖。现在可以执行步骤 2。` };
  }
  if (status === "posts_synced") {
    return { kind: "ok", label: "列表已保存", message: `已保存当前已加载的 ${records} 帖；日常采集建议使用步骤 1 的完整同步。` };
  }
  if (["batch_started", "navigating_batch_post", "batch_running", "thread_running"].includes(status)) {
    return { kind: "ok", label: "正在采集", message: batchProgressText(batch) };
  }
  if (["batch_paused", "batch_pause_requested", "batch_paused_output_permission_required"].includes(status)) {
    return { kind: "warn", label: "批次已暂停", message: batchProgressText(batch) };
  }
  if (status === "batch_cancelled") return { kind: "warn", label: "批次已结束", message: batchProgressText(batch) };
  if (status === "batch_completed") return { kind: "ok", label: "批次完成", message: batchProgressText(batch) };
  if (status === "batch_completed_with_tree_partial") return { kind: "warn", label: "批次完成", message: batchProgressText(batch) };
  if (status === "completed_with_tree_partial") {
    return { kind: "warn", label: "树结构不完整", message: "评论数量和归属已对齐，但部分回复父级无法确认；已安全标记为 tree_partial。" };
  }
  if (status === "completed") return { kind: "ok", label: "已完成", message: "当前操作已完成并自动保存。" };
  return { kind: "neutral", label: "已更新", message: "状态已更新；可查看技术日志了解详细字段。" };
}

function statusClass(kind) {
  return kind === "ok" ? "status ok" : kind === "warn" ? "status warn" : kind === "error" ? "status error" : "status neutral";
}

function activityTime() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function renderActivityLog() {
  const list = element("activityLog");
  list.replaceChildren();
  for (const item of activityItems) {
    const row = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = item.time;
    const message = document.createElement("span");
    message.textContent = item.message;
    row.append(time, message);
    list.append(row);
  }
}

function setResult(value, { log = true } = {}) {
  const presentation = resultPresentation(value);
  const output = element("result");
  output.textContent = presentation.message;
  output.className = `result ${presentation.kind}`;
  const status = element("resultStatus");
  status.textContent = presentation.label;
  status.className = statusClass(presentation.kind);
  element("resultDetails").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (log) {
    activityItems = [{ time: activityTime(), message: presentation.message }, ...activityItems].slice(0, 4);
    renderActivityLog();
  }
}

function setRootStatus(root) {
  const configured = Boolean(root?.configured);
  const granted = configured && root.permission === "granted";
  outputRootConfigured = configured;
  outputRootPermission = configured ? String(root?.permission || "unknown") : "none";
  outputBackend = String(root?.backend || "filesystem-access");
  const text = !configured ? "未设置" : granted
    ? outputBackend === "native" ? `已连接（Native Host）：${root.name}` : `已连接：${root.name}`
    : `需授权：${root.name}`;
  const className = granted ? "status ok" : configured ? "status warn" : "status neutral";
  const target = element("rootStatus");
  target.textContent = text;
  target.className = className;
}

function setTargetSummary() {
  const target = element("targetSummary");
  if (!knownPosts.length) {
    target.textContent = "未读取";
    target.className = "status neutral";
    return;
  }
  target.textContent = `已选 ${selectedFullnames.size}/${knownPosts.length}`;
  target.className = "status ok";
}

function postMatchesFilter(post, value) {
  const filter = String(value || "").trim().toLowerCase();
  if (!filter) return true;
  return [post?.post?.title, post?.post?.fullname, post?.directory_name, post?.permalink]
    .some((candidate) => String(candidate || "").toLowerCase().includes(filter));
}

function renderTargets() {
  const list = element("targetList");
  const filter = element("targetFilter").value;
  list.replaceChildren();
  for (const item of knownPosts.filter((post) => postMatchesFilter(post, filter))) {
    const fullname = item.post?.fullname;
    if (!fullname) continue;
    const label = document.createElement("label");
    label.className = "target-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedFullnames.has(fullname);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedFullnames.add(fullname);
      else selectedFullnames.delete(fullname);
      setTargetSummary();
    });
    const content = document.createElement("span");
    content.className = "target-content";
    const title = document.createElement("strong");
    title.textContent = item.post?.title || item.directory_name;
    const meta = document.createElement("small");
    meta.textContent = `${fullname} · 已存 ${item.known_comment_count || 0} 条评论 · ${item.last_status || "未采集"}`;
    content.append(title, meta);
    label.append(checkbox, content);
    list.append(label);
  }
  if (!list.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "target-empty";
    empty.textContent = knownPosts.length ? "没有匹配的帖子" : "仅在精确补采时读取历史目标";
    list.append(empty);
  }
  setTargetSummary();
}

function isFreshListing(status) {
  const context = status?.context;
  const result = status?.last_result;
  return Boolean(
    context?.page_type === "listing"
      && result?.mode === "listing_sync"
      && Number(status?.record_count) > 0
      && !settingsChanged
      && !activeBatch?.active
  );
}

function updateWorkflowLabels() {
  const requested = targetCount();
  const readyCount = freshListingReady ? syncedPostCount() : 0;
  const count = readyCount || requested;
  element("runListing").textContent = `同步并保存前 ${requested} 帖`;
  element("startLatestBatch").textContent = `开始采集 ${count} 帖`;
}

function updateButtonStates() {
  const batchRunning = Boolean(activeBatch?.active);
  const batchPaused = batchRunning && Boolean(activeBatch?.paused);
  const outputRootWritable = outputRootConfigured && outputRootPermission === "granted";
  for (const id of ACTION_BUTTONS) {
    const button = element(id);
    if (button) button.disabled = isBusy || batchRunning;
  }
  element("reconnectOutputRoot").disabled = isBusy || !outputRootConfigured || (batchRunning && !batchPaused);
  element("startLatestBatch").disabled = isBusy || batchRunning || !freshListingReady;
  element("pauseBatch").disabled = isBusy || !batchRunning || batchPaused;
  element("resumeBatch").disabled = isBusy || !batchPaused || !outputRootWritable;
  element("cancelBatch").disabled = isBusy || !batchRunning;
}

function updateWorkflowState() {
  const context = currentStatus?.context;
  const onListing = context?.page_type === "listing";
  const batchRunning = Boolean(activeBatch?.active);
  const batchNeedsAuthorization = batchRunning && Boolean(activeBatch?.paused) && outputRootConfigured && outputRootPermission !== "granted";
  const listingStatus = element("listingStatus");
  const batchStatus = element("batchStatus");
  const workflowBadge = element("workflowBadge");

  if (batchRunning) {
    workflowBadge.textContent = batchNeedsAuthorization ? "需恢复授权" : activeBatch.paused ? "批次已暂停" : "批次运行中";
    workflowBadge.className = activeBatch.paused ? "status warn" : "status ok";
    listingStatus.textContent = "已锁定本批列表";
    listingStatus.className = "step-state ready";
    batchStatus.textContent = batchNeedsAuthorization ? "需恢复授权" : activeBatch.paused ? "已暂停" : "正在采集";
    batchStatus.className = activeBatch.paused ? "step-state warn" : "step-state running";
    element("batchHint").textContent = batchNeedsAuthorization
      ? "写入授权已失效：先点击顶部“恢复授权”，成功后再点击“继续当前批次”。"
      : "正在按固定顺序采集；不要切换到其他 Reddit 标签页。";
    element("batchProgress").textContent = batchProgressText(activeBatch);
  } else {
    element("batchProgress").textContent = activeBatch ? batchProgressText(activeBatch) : "当前没有正在运行的批次。";
    if (freshListingReady) {
      const synced = syncedPostCount();
      workflowBadge.textContent = "可以开始采集";
      workflowBadge.className = "status ok";
      listingStatus.textContent = `已保存 ${synced} 帖`;
      listingStatus.className = "step-state ready";
      batchStatus.textContent = "可以开始";
      batchStatus.className = "step-state ready";
      element("listingHint").textContent = `已同步并保存 ${synced} 帖；无需再读取目录或勾选。`;
      element("batchHint").textContent = "只会采集刚同步的这批帖子，并自动保存帖子与评论。";
    } else if (!onListing) {
      workflowBadge.textContent = "请打开列表页";
      workflowBadge.className = "status neutral";
      listingStatus.textContent = "需要列表页";
      listingStatus.className = "step-state";
      batchStatus.textContent = "等待步骤 1";
      batchStatus.className = "step-state";
      element("listingHint").textContent = "请先打开 r/<subreddit> 的列表页，建议使用 /new/。";
      element("batchHint").textContent = "完成步骤 1 后自动启用；不需要读取目录或勾选帖子。";
    } else if (settingsChanged) {
      workflowBadge.textContent = "需重新同步";
      workflowBadge.className = "status warn";
      listingStatus.textContent = "参数已修改";
      listingStatus.className = "step-state warn";
      batchStatus.textContent = "等待步骤 1";
      batchStatus.className = "step-state";
      element("listingHint").textContent = "参数已调整；重新执行步骤 1 后会自动应用。";
      element("batchHint").textContent = "为保证目标固定，修改参数后必须先重新同步列表。";
    } else {
      workflowBadge.textContent = "等待步骤 1";
      workflowBadge.className = "status neutral";
      listingStatus.textContent = "未完成";
      listingStatus.className = "step-state";
      batchStatus.textContent = "等待步骤 1";
      batchStatus.className = "step-state";
      element("listingHint").textContent = "自动滚动、去重并保存目标帖子。";
      element("batchHint").textContent = "步骤 1 完成后启用；只采集刚同步的这批帖子。";
    }
  }
  updateWorkflowLabels();
  updateButtonStates();
}

function setBusy(busy) {
  isBusy = busy;
  updateButtonStates();
}

async function activeRedditTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab?.url || "");
  if (!tab?.id || !["www.reddit.com", "reddit.com"].includes(url.hostname) || !/^\/r\//i.test(url.pathname)) {
    throw new Error("请先在当前标签页打开 Reddit 的 r/<subreddit> 列表页或帖子页。");
  }
  return tab;
}

async function command(commandName, payload = {}) {
  const tab = await activeRedditTab();
  const response = await chrome.runtime.sendMessage({
    type: "reddit-rpa-command",
    tabId: tab.id,
    command: commandName,
    payload
  });
  const reviewRequired = ["manual_review_required", "batch_manual_review_required", "batch_paused_output_permission_required", "batch_rate_limited", "batch_rate_limited_manual_review"]
    .includes(response?.status);
  if (!response?.ok && !reviewRequired) throw new Error(response?.error || "页面采集命令失败。");
  return response;
}

async function refresh() {
  const root = await chrome.runtime.sendMessage({ type: "reddit-rpa-output-root-status" });
  setRootStatus(root || {});
  try {
    const status = await command("status");
    currentStatus = status;
    activeBatch = status.active_batch_job || null;
    freshListingReady = isFreshListing(status);
    const context = status.context;
    element("pageContext").textContent = context?.subreddit
      ? `当前：r/${context.subreddit} · ${context.page_type === "thread" ? "帖子页" : "列表页"} · 本页缓存 ${status.record_count} 条`
      : "请打开 Reddit r/<subreddit> 的列表页或帖子页";
    updateWorkflowState();
    if (activeBatch?.active) {
      setResult({ ok: true, status: activeBatch.paused ? "batch_paused" : "batch_running", batch: activeBatch }, { log: false });
    } else if (!activityItems.length && status.last_result) {
      setResult(status.last_result, { log: false });
    }
  } catch (error) {
    currentStatus = null;
    activeBatch = null;
    freshListingReady = false;
    element("pageContext").textContent = String(error?.message || error);
    updateWorkflowState();
  }
}

async function chooseOutputRoot() {
  const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "documents" });
  await validateCollectionDataRoot(directoryHandle);
  await saveOutputRoot(directoryHandle);
  setResult({ ok: true, status: "output_root_configured", name: directoryHandle.name });
}

async function reconnectOutputRoot() {
  const result = await ensureOutputRootWritable();
  const repair = await command("repairCancelledBatch");
  setResult(repair?.status === "batch_cancelled"
    ? repair
    : { ok: true, status: "output_root_permission_restored", name: result.name });
}

async function ensureOutputRootWritable() {
  const nativeWriter = await chrome.runtime.sendMessage({ type: "reddit-rpa-output-root-preflight" });
  if (nativeWriter?.ok && nativeWriter.backend === "native") {
    setRootStatus({ configured: true, name: nativeWriter.name, permission: "granted", backend: "native" });
    return nativeWriter;
  }
  const result = await requestOutputRootPermission();
  if (!result.configured) throw new Error("请先选择 VR-XR 集合目录。");
  if (result.permission !== "granted") throw new Error("目录授权未获得，请再次选择 VR-XR 集合目录。");
  const writer = await chrome.runtime.sendMessage({ type: "reddit-rpa-output-root-preflight" });
  if (!writer?.ok) throw new Error(writer?.error || "后台无法使用 VR-XR 写入授权，请再次选择目录。");
  setRootStatus({ configured: true, name: result.name, permission: "granted" });
  return result;
}

async function writableCommand(commandName, payload = {}) {
  await ensureOutputRootWritable();
  return command(commandName, payload);
}

async function runDailyListing() {
  const result = await writableCommand("runListing", { config: config() });
  currentStatus = { ...(currentStatus || {}), context: { ...(currentStatus?.context || {}), page_type: "listing" }, record_count: result.records, last_result: result };
  settingsChanged = false;
  freshListingReady = Number(result.records) > 0;
  setResult(result);
  updateWorkflowState();
}

async function startLatestBatch() {
  const result = await writableCommand("startLatestListingBatch", { config: config() });
  freshListingReady = false;
  activeBatch = result.batch || null;
  setResult(result);
  updateWorkflowState();
}

async function loadTargets() {
  const result = await command("listThreadTargets");
  knownPosts = result.posts || [];
  selectedFullnames.clear();
  renderTargets();
  setResult(result);
}

async function startBatch() {
  const result = await writableCommand("startBatch", {
    config: config(),
    selectedFullnames: [...selectedFullnames]
  });
  setResult(result);
}

async function syncAndStartBatch() {
  const result = await writableCommand("syncAndStartBatch", { config: config() });
  knownPosts = [];
  selectedFullnames.clear();
  renderTargets();
  setResult(result);
}

async function clearLocal() {
  const result = await command("clearLocal");
  knownPosts = [];
  selectedFullnames.clear();
  freshListingReady = false;
  renderTargets();
  setResult(result);
}

async function run(action) {
  setBusy(true);
  try {
    await action();
  } catch (error) {
    setResult({ ok: false, error: String(error?.message || error) });
  } finally {
    setBusy(false);
    await refresh();
  }
}

element("chooseOutputRoot").addEventListener("click", () => run(chooseOutputRoot));
element("reconnectOutputRoot").addEventListener("click", () => run(reconnectOutputRoot));
element("runListing").addEventListener("click", () => run(runDailyListing));
element("startLatestBatch").addEventListener("click", () => run(startLatestBatch));
element("pauseBatch").addEventListener("click", () => run(async () => setResult(await command("pauseBatch"))));
element("resumeBatch").addEventListener("click", () => run(async () => {
  await ensureOutputRootWritable();
  setResult(await command("resumeBatch"));
}));
element("cancelBatch").addEventListener("click", () => run(async () => setResult(await command("cancelBatch"))));
element("probe").addEventListener("click", () => run(async () => setResult(await command("probe"))));
element("captureListing").addEventListener("click", () => run(async () => setResult(await writableCommand("captureListing", { config: config() }))));
element("captureThread").addEventListener("click", () => run(async () => setResult(await writableCommand("captureThread", { config: config() }))));
element("syncAndStartBatch").addEventListener("click", () => run(syncAndStartBatch));
element("loadTargets").addEventListener("click", () => run(loadTargets));
element("selectAllTargets").addEventListener("click", () => {
  selectedFullnames = new Set(knownPosts.map((item) => item.post?.fullname).filter(Boolean));
  renderTargets();
});
element("selectNoTargets").addEventListener("click", () => {
  selectedFullnames.clear();
  renderTargets();
});
element("startBatch").addEventListener("click", () => run(startBatch));
element("clearLocal").addEventListener("click", () => run(clearLocal));
element("targetFilter").addEventListener("input", renderTargets);
for (const id of ["listingSteps", "targetPostCount", "maxPosts", "scrollPercent", "waitMs", "expansionPasses"]) {
  element(id).addEventListener("input", () => {
    settingsChanged = true;
    freshListingReady = false;
    updateWorkflowState();
  });
}

renderTargets();
updateWorkflowLabels();
updateWorkflowState();
refresh().catch((error) => setResult({ ok: false, error: String(error?.message || error) }));
