# 架构说明

## 1. 系统边界

Reddit RPA Assistant 是一个“浏览器页面采集器 + 本地文件写入器 + 离线处理脚本”的组合。浏览器扩展是唯一能够读取 Reddit DOM 的组件；Native Host 和 CLI/MCP 都不浏览网页。

~~~mermaid
flowchart LR
    UI["Chrome 扩展弹窗"] --> CS["content.js\n唯一 DOM 采集器"]
    CS --> SW["service-worker.js\n批次、锁、重试、消息路由"]
    SW --> FSA["File System Access\n人工选择的集合根目录"]
    SW --> NH["Native Messaging Host\n可选固定根目录"]
    MCP["CLI / stdio MCP"] --> CTRL[".reddit-rpa-control/\n请求/响应/心跳"]
    NH --> CTRL
    CTRL --> SW
    SW --> CS
    CS --> REDDIT["已打开的 Reddit 页面"]
    RAW["raw/ 快照"] --> OFFLINE["离线处理脚本"]
    OFFLINE --> CLEAN["clean/、translated/、质量队列"]
~~~

数据流是单向的：页面 DOM 经过身份/归属校验后进入最新快照；离线脚本读取快照并生成派生文件。分析和翻译不会反向修改采集快照。

## 2. 组件职责

| 组件 | 主要文件 | 允许做的事 | 明确不负责的事 |
| --- | --- | --- | --- |
| 扩展 UI | popup.html、popup.js、popup.css、collector-config.js | 启动同步/采集、显示批次状态、请求目录授权 | 直接解析全页 DOM、调用 Reddit 网络接口 |
| 内容脚本 | content.js、collector-config.js、content-page-context.js、content-record-extractor.js、content-command-registry.js、reddit-model.js、reddit-dom-selectors.js | 读取当前页面已渲染节点、展开控件、证明 Post/Comment 归属、提交结构化消息 | 直接写任意本地路径、读取凭据、并行控制多个工作页 |
| 后台 Service Worker | service-worker.js、native-host-client.mjs、navigation-lease.mjs、batch-event-contract.mjs、batch-queue.js | 单工作页锁、队列、导航租约、重试、权限预检、写入路由、Native Host 桥接 | 通过 fetch 访问 Reddit API、读取错误页正文、猜测缺失评论 |
| 浏览器回退写入 | output-store.js、output-paths.mjs、post-storage.mjs | 使用用户授予的目录句柄、校验安全目录名、原子落盘 | 选择用户未授权的目录、访问冻结层 |
| Native Host | native-host/reddit_rpa_native_host.py | 校验请求、固定集合根目录、原子写入、维护控制信箱 | 接收任意扩展传入的路径、打开网页、启动 HTTP 服务 |
| 控制面 | scripts/reddit_rpa_control.py、scripts/reddit_rpa_mcp.py | 读取心跳/状态、写入结构化控制请求、返回结构化错误 | 直接驱动 DOM、改写帖子/评论或伪造完成状态 |
| 离线处理 | scripts/*.py 中的合并/翻译/质量脚本 | 显式输入到显式输出、保留来源 ID/永久链接 | 联网采集、修改 raw/（迁移脚本除外且需显式确认） |

### 2.1 细化模块边界

`collector-config.js` 是 classic content script 与 popup 都能加载的只读默认参数契约。因为 content script 不能直接复用 ES module 导出，它用受控的 `globalThis.RedditRpaCollectorConfig` 暴露；该全局只包含冻结的默认值，不读取页面/Chrome 状态。内容脚本和 Service Worker 仍分别对跨边界传入的超时、冷却等参数做范围校验，这是刻意保留的防御性重复校验。

`content-command-registry.js` 只维护“命令名 → 处理器 → 是否需要采集失败审计”的声明式登记表，不读取 DOM、不访问 Chrome API，也不持有采集状态。`content.js` 保留生命周期、DOM 采集和批次状态机。这样新增命令只需在一个登记表中声明其处理器和失败语义，避免分派 `switch` 与错误处理名单发生漂移。

`content-page-context.js` 把 URL 规范化、当前页面上下文、批量目标上下文与轻量 DOM 取值规则集中为可注入的纯工厂。它不持有采集状态、不调用 Chrome API；`content.js` 仅在启动时注入页面依赖并继续负责 DOM 遍历和生命周期。这使页面身份规则能独立测试，也避免同一 URL 语义散落在采集状态机中。

`content-record-extractor.js` 只把页面上已渲染的 DOM 节点转换成 Post/Comment 记录，并在输出前验证 fullname、永久链接、评论归属与父级证据。它不读写扩展状态、不调度导航；`content.js` 继续决定何时展开、重试、持久化或推进批次。因此 DOM 演进可以在单一模块和夹具测试中审计，不会混入批次编排。

`native-host-client.mjs` 只负责 Native Messaging 连接复用、请求 ID 关联、超时和断连回收；Service Worker 仍决定何时调用 Host、如何解释业务响应及何时回退到 File System Access。这样本机高权限传输与采集编排的审计边界保持清晰。

`navigation-lease.mjs` 只维护可单测的导航规则：租约 ID/Post ID 校验、超时范围、浏览器错误页的低归因失败分类，以及失败事件/审计记录的字段组装。它不访问 `chrome`、不写存储，也不决定暂停、重试或落盘；这些副作用仍由 `service-worker.js` 编排。

`batch-event-contract.mjs` 只定义批次事件可接受的字段、枚举值与归一化结果。Worker 和 Native Host 在各自信任边界都继续执行独立校验；此模块只让 Worker 侧的 schema 演进和单元测试有一个明确入口。

## 3. 批次控制时序

~~~mermaid
sequenceDiagram
    participant A as Agent/CLI
    participant H as Native Host
    participant W as Service Worker
    participant P as Reddit 工作页
    participant D as 集合根目录

    A->>H: health / prepare / run 请求
    H->>D: 读取心跳并原子 claim 请求
    H-->>W: Native Messaging 响应
    W->>P: 复用或创建唯一工作页
    P->>W: 页面就绪、批次进度、质量状态
    W->>H: 结构化写入请求
    H->>D: 校验路径并原子写入 raw
    W->>D: File System Access 回退路径（无 Host 时）
    W-->>A: status / tail / verify 可读状态
~~~

CLI/MCP 的请求不会直接传给 Reddit 页面。Native Host 以租约/claim 方式消费一个控制请求，扩展后台以 alarm 轮询；内容脚本仍是唯一的 DOM 执行者。

## 4. 写入与一致性

- Post 目录由安全 subreddit slug、稳定 Post ID 和 URL slug 组成；标题变化不应重命名同一 Post 目录。
- comments.jsonl 是当前采集修订的完整快照；写入前会按 fullname 去重，写入后重建 thread.json。
- captures.jsonl 和批次事件日志只追加，用于解释等待、展开、重试、缺口和失败原因。
- 写入先生成临时文件，再用原子替换；控制请求/响应也使用固定目录和安全 ID。
- 单工作页锁、防旧脚本接管和批次 token 用于避免扩展重载后两个控制器同时写入。
- 取消只标记未处理目标，不删除已经写入的帖子或评论。
- `run` 的 `skip_existing` 补采模式只读取活跃 `raw/` 的 Post ID，在当前 `/new/` 中筛选未见 `t3_*` 后才建批次；冻结层不参与差集。
- 每次批量目标导航在跳转前由内容脚本向后台登记 `navigation_id` 租约。内容脚本在成功进入页面后以 `page_ready` 结束租约；若错误页不匹配 Reddit content script，后台只依据 tab 标题/URL 或超时 watchdog 写入 `navigation_error_observed` / `navigation_timeout`，并暂停该批次。
- `retry_unfinished` 从历史 manifest 精确读取 `unprocessed` / `interrupted` 目标，建立含 `recovery` 血缘的新批次；它不是 `/new/` 差集扫描，也不会修改源批次。

## 5. 状态语义

| 状态 | 含义 | Agent/人工动作 |
| --- | --- | --- |
| complete | 当前页面范围内评论数量和归属均验证通过 | 可进入后续清洁/分析 |
| complete_with_reported_count_gap | 评论已验证，但 Reddit 头部计数仍有差异 | 保留审计，按需人工抽样 |
| tree_partial | 数量基本可用，但部分父级路径不能证明完整 | 平面分析可继续；回复链分析先复核 |
| manual | 页面、展开控件、权限或数量缺口需要人工处理 | 查看永久链接和 capture，禁止直接升级 |
| failed | 页面受控重试后仍失败 | 检查登录、限流、工作页和页面错误 |
| interrupted | 浏览器/扩展/工作页在批次中断 | 保留已完成目标，确认后恢复或重新执行 |

“完成”是页面可验证性的结论，不是 Reddit 服务器数据完整性的承诺。

导航失败还会带有独立分类：`HTTP_429_ERROR_PAGE_OBSERVED` 表示浏览器曾显示 429，`REDDIT_RATE_LIMIT_PAGE` 表示内容脚本在 Reddit DOM 中识别到限流文案，`CLIENT_BLOCKED` 表示浏览器/客户端阻断，`NAVIGATION_ERROR_PAGE` 表示其他错误页，`PAGE_NAVIGATION_TIMEOUT` 表示租约到期。前两者的证据来源和归因强度不同；页面级 429 不是 Reddit 服务端限流的确认。

## 6. 评审重点

- 任何新增浏览器网络调用都必须被视为权限边界变化。
- 任何新增可写路径都必须检查路径穿越、根目录逃逸和历史层污染。
- 任何把 manual、failed、tree_partial 改成 complete 的逻辑都必须有数量、归属和测试依据。
- 任何 schema/状态变更都要同步更新 docs/DATA_CONTRACT.md 与测试。
