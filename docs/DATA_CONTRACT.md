# 数据契约

本文只描述工具读写的本地文件格式。真实 Reddit 数据不属于代码仓库；示例和测试夹具均为合成内容。

## 1. 集合根目录

扩展的目标是集合根目录 <collection-root>，不是 raw/ 子目录。最小前置结构：

~~~text
<collection-root>/
├── raw/                              # 旧数据层；只读保留
└── rules/subreddit_registry.json    # 允许的 subreddit 与安全目录 slug
~~~

工具在首次写入时创建：

~~~text
<collection-root>/
├── raw-v2/
│   ├── batches/
│   └── <subreddit-slug>/<post-id>--<url-slug>/
└── .reddit-rpa-control/
    ├── collectors/
    ├── requests/
    └── responses/
~~~

rules/subreddit_registry.json 由集合维护者提供。工具只在页面能可靠读到 subreddit 名称、且新名称不产生 slug 冲突时受控追加；不会把本仓库的真实 watchlist 或历史 registry 复制进来。

## 2. Schema 清单

| 文件/消息 | schema | 语义 |
| --- | --- | --- |
| Post 文档 | reddit-rpa-post-v1 | 已验证的单个 Post 身份、正文和永久链接 |
| 评论快照 | JSONL 行记录 | 当前修订下的唯一 Comment 记录集合 |
| Thread 文档 | reddit-rpa-thread-v1 | Post + 当前评论快照 + 最新质量状态 |
| Capture 审计 | reddit-rpa-thread-capture-v1 | 一次进入页面、等待、展开、识别和质量判断 |
| 批次清单 | reddit-rpa-batch-v1 | 固定目标、已完成/未处理目标和批次终态 |
| 批次事件 | reddit-rpa-batch-event-v1 | 批次导航、写入、重试、暂停/恢复和结束事件 |
| 控制请求 | reddit-rpa-control-request-v1 | CLI/MCP 到采集器的受控命令 |
| 控制响应 | reddit-rpa-control-response-v1 | Native Host/扩展返回的结构化结果 |
| 采集器心跳 | reddit-rpa-collector-v1 | 当前扩展/工作页的可用性与租约 |

未知 schema、错误的 Post ID、错误的 subreddit slug 或不一致的永久链接必须拒收，而不是“尽量保存”。

## 3. Post 与 Comment 记录

工具只使用两种 record_type：

- record_type: "post"：顶层 Reddit Post。
- `record_type: "comment"`：Post 下的评论或回复。

回复不是第三种记录类型。回复仍然是 record_type: "comment"，通过以下字段表达层级：

- post_fullname：所属 Post 的 t3_... fullname。
- parent_fullname：已验证的直接父级 t3_... 或 t1_... fullname。
- depth：由当前已验证父级重建的深度。
- fullname：评论自身稳定的 t1_... fullname。

无法从评论 permalink、Post 属性或当前页面结构证明归属时，parent_fullname 必须清空并记录诊断；猜测的父级不得成为 `record_type` 或树结构事实。

## 4. Post 目录与快照文件

~~~text
raw-v2/<subreddit-slug>/<post-id>--<url-slug>/
├── post.json
├── comments.jsonl
├── thread.json
└── captures.jsonl
~~~

### post.json

保存已验证的 Post 文档。目录中的 post_id、post_fullname、canonical permalink 与正文身份必须相互一致。目录标题段只是可读 URL slug；标题修改不能自动造成同 ID 目录重命名。

### comments.jsonl

保存当前采集修订的完整评论快照，每行一个 Comment JSON 对象。它按稳定 fullname 去重，不能把历史 raw/ 评论盲目追加进去，也不能用同一行承载无法证明归属的多个候选。

### thread.json

由当前 post.json、comments.jsonl 和 capture 审计重建的可读文档。它是派生的当前视图，不应被当作独立事实源；重新构建必须保留来源 ID、永久链接和最新质量状态。

### captures.jsonl

只追加一次采集审计。可能包括：

- Reddit 页头报告评论数与实际识别数；
- 可见原生评论数、数量差和 coverage/status；
- 展开控件、继续讨论串、首次稳定等待和 0/0 复读；
- 拒收候选、删除/移除占位符、无法证明的父级；
- 限流、权限、页面错误和受控重试原因。

审计字段可以说明“为什么不完整”，不能把不完整内容补成正文。

## 5. 批次与控制信箱

raw-v2/batches/<batch-id>.json 固定本次目标 Post 的 t3_... 身份；批次事件文件只追加。CLI/MCP 只在以下目录写入控制面：

~~~text
<collection-root>/.reddit-rpa-control/
├── collectors/<collector-id>.json
├── requests/<request-id>.json
└── responses/<request-id>.json
~~~

控制请求不应包含正文、Cookie、账号、截图或浏览器令牌。状态读取是只读的；cancel 只标记尚未执行的目标，不删除现有数据。

## 6. 不可变性与血缘

清洁、翻译、汇总和质量队列必须保留：

- 原始记录 fullname / id；
- Reddit canonical permalink；
- 来源文件或来源路径；
- 采集时间/发布日期（若页面提供）；
- 可用的 schema、质量状态和错误原因。

历史 raw/ 层不由正常采集流程改写。旧 runs/ 的迁移是唯一例外，必须先演练、再显式传入 --apply；如果使用 --trash-runs，报告应保留迁移来源、目标和校验信息。

## 7. 发布隔离

仓库不包含任何 raw/、raw-v2/、clean/、translated/ 或控制信箱文件。即使这些文件是 JSON/JSONL，也属于数据资产，不是测试 fixture。提交前应同时检查：

~~~zsh
git ls-files
git ls-files | rg '(^|/)(raw|raw-v2|clean|translated|\.reddit-rpa-control)($|/)|\.jsonl$'
~~~

第二条只允许命中明确的合成测试夹具或源码中的格式样例；真实帖子、评论、批次和事件必须为零。
