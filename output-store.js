const DATABASE_NAME = "reddit-rpa-output-root";
const DATABASE_VERSION = 1;
const STORE_NAME = "settings";
const ROOT_KEY = "collection-data-root";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开导出目录设置。"));
  });
}

async function withStore(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法保存导出目录设置。"));
    });
  } finally {
    database.close();
  }
}

function outputRootName(directoryHandle) {
  return directoryHandle?.name || "已选目录";
}

function outputRootError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function loadOutputRoot() {
  return withStore("readonly", (store) => store.get(ROOT_KEY));
}

export async function saveOutputRoot(directoryHandle) {
  await withStore("readwrite", (store) => store.put(directoryHandle, ROOT_KEY));
}

export async function clearOutputRoot() {
  await withStore("readwrite", (store) => store.delete(ROOT_KEY));
}

export async function validateCollectionDataRoot(directoryHandle) {
  try {
    await directoryHandle.getDirectoryHandle("raw", { create: false });
    const rules = await directoryHandle.getDirectoryHandle("rules", { create: false });
    await rules.getFileHandle("subreddit_registry.json", { create: false });
  } catch {
    throw new Error("请选择 VR-XR 集合目录（其中应包含 raw/ 和 rules/subreddit_registry.json），不要选择 Downloads 或 raw/ 本身。");
  }
}

export async function outputRootStatus() {
  const directoryHandle = await loadOutputRoot();
  if (!directoryHandle) return { configured: false, name: null, permission: "none" };
  let permission = "unknown";
  try {
    permission = await directoryHandle.queryPermission({ mode: "readwrite" });
  } catch {
    permission = "unknown";
  }
  return { configured: true, name: outputRootName(directoryHandle), permission };
}

export async function requestOutputRootPermission() {
  const directoryHandle = await loadOutputRoot();
  if (!directoryHandle) return { configured: false, name: null, permission: "none" };
  let permission;
  try {
    permission = await directoryHandle.requestPermission({ mode: "readwrite" });
  } catch (error) {
    throw outputRootError(
      "OUTPUT_PERMISSION_REQUEST_FAILED",
      `无法恢复“${outputRootName(directoryHandle)}”的写入授权：${String(error?.message || error)}`
    );
  }
  if (permission === "granted") {
    await validateCollectionDataRoot(directoryHandle);
    await saveOutputRoot(directoryHandle);
  }
  return { configured: true, name: outputRootName(directoryHandle), permission };
}

export async function loadWritableOutputRoot() {
  const directoryHandle = await loadOutputRoot();
  if (!directoryHandle) {
    throw outputRootError("OUTPUT_ROOT_REQUIRED", "尚未设置 VR-XR 集合目录，请先选择集合目录。");
  }
  let permission;
  try {
    permission = await directoryHandle.queryPermission({ mode: "readwrite" });
  } catch {
    throw outputRootError(
      "OUTPUT_PERMISSION_UNKNOWN",
      `无法确认“${outputRootName(directoryHandle)}”的写入授权，请在扩展弹窗点击“恢复目录授权”。`
    );
  }
  if (permission !== "granted") {
    throw outputRootError(
      "OUTPUT_PERMISSION_REQUIRED",
      `“${outputRootName(directoryHandle)}”当前没有有效的写入授权，请在扩展弹窗点击“恢复目录授权”。`
    );
  }
  return directoryHandle;
}
