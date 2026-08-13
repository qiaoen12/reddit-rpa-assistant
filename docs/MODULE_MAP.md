# 模块地图与变更规则

本文是人工与 AI 的快速审计入口；字段语义仍以 [数据契约](DATA_CONTRACT.md) 为准，安全边界仍以 [AI 评审指南](AI_REVIEW.md) 为准。

## 1. 最短阅读路径

| 目标 | 先读 | 再读 | 不应跳过的验证 |
| --- | --- | --- | --- |
| 理解扩展入口与权限 | `manifest.json` | `popup.js`、`collector-config.js` | `tests/test_extension_contract.py` |
| 新增或修改页面命令 | `content-command-registry.js` | `content.js`、`tests/content_command_registry.test.cjs` | 命令分派与采集失败审计测试 |
| 修改页面 URL / 上下文 | `content-page-context.js`、`reddit-model.js` | `content.js`、`tests/content_page_context.test.cjs` | URL、上下文与批量目标测试 |
| 修改 Post / Comment DOM 提取 | `content-record-extractor.js`、`reddit-dom-selectors.js`、`reddit-model.js` | `content.js`、`tests/content_record_extractor.test.cjs` | DOM 夹具、归属与父级验证测试 |
| 修改 DOM 采集 | `reddit-dom-selectors.js`、`reddit-model.js` | `content.js`、`tests/reddit_dom_contract.test.cjs` | 合成 DOM 夹具与人工页面验收 |
| 修改批量导航/错误恢复 | `navigation-lease.mjs` | `service-worker.js`、`tests/navigation_lease.test.mjs` | `tests/worker_navigation_watchdog_runtime.test.mjs` |
| 修改批次事件字段 | `batch-event-contract.mjs` | Native Host 的同名校验、`docs/DATA_CONTRACT.md` | Node + Python 契约测试 |
| 修改本机写入或控制信箱 | `native-host-client.mjs` | `native-host/reddit_rpa_native_host.py`、`scripts/reddit_rpa_control.py` | Native Host / 控制面测试 |
| 修改文件结构或记录格式 | `output-paths.mjs`、`post-storage.mjs` | `docs/DATA_CONTRACT.md` | Node + Python 路径、存储测试 |

## 2. 当前依赖边界

~~~mermaid
flowchart LR
    P["popup.js"] --> C["collector-config.js"]
    P --> M["Chrome runtime message"]
    C --> S["content.js"]
    X["content-page-context.js"] --> S
    X2["content-record-extractor.js"] --> S
    R["content-command-registry.js"] --> S
    D["DOM selectors + model + queue"] --> S
    S --> M
    M --> W["service-worker.js"]
    W --> N["navigation-lease.mjs"]
    W --> E["batch-event-contract.mjs"]
    W --> H["native-host-client.mjs"]
    H --> NH["Native Host (Python)"]
    W --> F["FSA output modules"]
    F --> O["collection root"]
    NH --> O
~~~

- 内容脚本层是唯一读取 Reddit DOM 的组件；它不直接写本机路径。
- `content-page-context.js` 只维护可注入的页面 URL、采集上下文与轻量 DOM 取值规则；它不持有采集状态或 Chrome API。
- `content-record-extractor.js` 只把 DOM 变成已验证记录；它不持有采集/批次状态，也不调度导航。
- `service-worker.js` 编排状态和副作用；纯规则分别放在导航租约、事件契约和 Native Messaging 客户端模块。
- Native Host 与 Worker 都校验跨进程输入。它们看似相似的校验不能合并成跨语言“共享代码”，否则会削弱各自边界。
- `collector-config.js` 只承载冻结的默认值；内容脚本和后台仍应各自限制收到的数值范围。

## 3. 新功能落点

| 需求 | 必须修改 | 常见遗漏 |
| --- | --- | --- |
| 新增采集参数 | `collector-config.js`、popup 表单、内容脚本的使用点 | 未补默认值、未限制边界、未写入 batch config |
| 新增内容脚本命令 | 命令登记表、处理器、消息结果测试 | 忘记标记 `captureFailure`，导致失败未审计 |
| 新增导航失败类别 | `navigation-lease.mjs`、`batch-event-contract.mjs`、Native Host、数据契约 | 把浏览器观察结果误写成 Reddit 服务端事实 |
| 新增批次事件 | JS/Python 两侧的事件白名单、数据契约、测试 | Worker 通过但 Native Host 拒收（或反之） |
| 新增控制面命令 | CLI、MCP、Worker 请求归一化、内容脚本处理器 | 跳过控制信箱 claim/响应协议 |
| 新增写入文件 | `post-storage.mjs` / Native Host、数据契约、迁移策略 | 绕开安全目录/原子替换或污染 `frozen/` |

## 4. 维护性约束

- `scripts/migrate_runs_to_post_folders.py` 是一次性历史迁移工具，不属于正常采集路径；默认演练，实际写入必须显式 `--apply`。
- 真实 Reddit 页面、登录、MFA、限流与 DOM 演进不在合成测试覆盖范围内。代码变更通过测试后，仍需在人工验收环境确认。
- 如果修改 schema、状态含义或权限，请同时更新 `docs/DATA_CONTRACT.md`、`docs/ARCHITECTURE.md` 和相应 Node/Python 测试；不要只修改字符串契约测试。
