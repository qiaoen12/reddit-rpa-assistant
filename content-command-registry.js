(() => {
  function create(entries = []) {
    const commands = new Map();
    for (const [name, handler, options = {}] of entries) {
      const command = String(name || "").trim();
      if (!command || typeof handler !== "function" || commands.has(command)) {
        throw new Error("内容脚本命令登记表无效。");
      }
      commands.set(command, {
        handler,
        captureFailure: options.captureFailure === true
      });
    }

    return Object.freeze({
      execute(message = {}) {
        const entry = commands.get(String(message?.command || ""));
        return entry
          ? entry.handler(message)
          : { ok: false, code: "UNKNOWN_COMMAND", error: "未知 Reddit RPA 命令。" };
      },
      capturesFailure(message = {}) {
        return commands.get(String(message?.command || ""))?.captureFailure === true;
      },
      names() {
        return [...commands.keys()];
      }
    });
  }

  // 该模块不读取 DOM、不调用 Chrome API；它只维护内容脚本命令的声明式契约。
  globalThis.RedditRpaCommandRegistry = Object.freeze({ create });
})();
