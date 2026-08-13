function hostError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 隔离 Chrome Native Messaging 的连接与请求关联；它不理解采集数据、业务命令
 * 或响应语义，避免高权限传输细节渗入 Service Worker 编排逻辑。
 */
export function createNativeHostClient({ hostName, timeoutMs = 10000, runtimeApi = null } = {}) {
  let port = null;
  let requestSequence = 0;
  const pendingRequests = new Map();

  function runtime() {
    return runtimeApi || globalThis.chrome?.runtime || null;
  }

  function rejectPending(error) {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingRequests.clear();
  }

  function connect() {
    if (port) return port;
    const chromeRuntime = runtime();
    if (typeof chromeRuntime?.connectNative !== "function") {
      throw hostError("NATIVE_HOST_UNAVAILABLE", "Chrome Native Messaging Host 尚未安装。");
    }
    const connected = chromeRuntime.connectNative(hostName);
    connected.onMessage.addListener((response) => {
      const requestId = String(response?.request_id || "");
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    });
    connected.onDisconnect.addListener(() => {
      const message = runtime()?.lastError?.message || "Chrome Native Messaging Host 不可用。";
      if (port === connected) port = null;
      rejectPending(hostError("NATIVE_HOST_UNAVAILABLE", message));
    });
    port = connected;
    return port;
  }

  function request(operation, payload = {}) {
    let connected;
    try {
      connected = connect();
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = `${Date.now()}-${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(hostError("NATIVE_HOST_TIMEOUT", `Native Host 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果。`));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timer });
      try {
        connected.postMessage({ request_id: requestId, operation, payload });
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(hostError("NATIVE_HOST_UNAVAILABLE", String(error?.message || error)));
      }
    });
  }

  async function operation(name, payload = {}) {
    try {
      const response = await request(name, payload);
      const { request_id: _requestId, ...result } = response || {};
      return result;
    } catch (error) {
      if (error?.code === "NATIVE_HOST_UNAVAILABLE") return null;
      throw error;
    }
  }

  return Object.freeze({ operation });
}
