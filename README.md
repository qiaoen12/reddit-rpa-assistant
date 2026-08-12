# Reddit RPA Assistant

一个本地运行的 Chrome Manifest V3 Reddit 页面采集与离线处理工具。当前发布快照为 `0.8.2`。

它读取用户已经打开、已经渲染的 Reddit 页面，只保存能够证明属于当前帖子的 Post 和 Comment。它不调用 Reddit API，不读取 Cookie、Local Storage 或登录令牌，也不执行发帖、投票、评论、关注等 Reddit 写操作。

> 这是一个面向本地研究/数据治理的工具，不是 Reddit 客户端、爬虫服务或云端数据平台。

## 给评审者的最短路径

如果你是人类或 AI 代码评审者，按以下顺序阅读：

1. [AI 评审指南](docs/AI_REVIEW.md)：范围、信任边界、风险和验收清单。
2. [架构说明](docs/ARCHITECTURE.md)：浏览器、Native Host、CLI/MCP 和文件层之间的调用关系。
3. [数据契约](docs/DATA_CONTRACT.md)：目录、记录类型、快照语义和不可变字段。
4. `service-worker.js`、`content.js`、`native-host/reddit_rpa_native_host.py`：核心写入与采集边界。
5. `tests/`：不依赖本地真实数据的 Node/Python 合成测试。

## 能做什么

- 在一个 Reddit 工作页中同步 `/new/` 列表，并顺序采集固定数量的帖子。
- 展开英文/中文的更多评论、回复和 `Continue this thread`，生成可审计的评论树快照。
- 在 `raw/` 中按 subreddit 和稳定的 Reddit Post ID 保存 `post.json`、`comments.jsonl`、`thread.json` 与 `captures.jsonl`。
- 通过可选 Native Messaging Host 提供固定集合根目录的原子落盘和批次控制。
- 通过 CLI 或 stdio MCP 控制已连接的扩展，并返回可供 Agent 分支处理的结构化状态。
- 将 `thread.json` 合并、清洁、翻译分块，并生成评论树质量复核队列。

## 明确不做什么

- 不访问 Reddit API、RSS、Cookie、Local Storage、登录令牌或浏览器密码。
- 不绕过登录、MFA、验证码、权限、封禁、限流或删除状态；这些情况需要人工恢复。
- 不把广告、猜测的评论、无法证明归属的回复或未加载内容写入有效快照。
- 不读取或改写集合的 `frozen/` 历史层；冻结层与活跃采集层严格隔离。
- 不上传真实采集数据、控制信箱、截图、历史报告或运行缓存。

## 仓库发布边界

本仓库根目录只包含可复现的工具源码、合成测试夹具和文档。以下内容必须留在本地集合或冻结区，不应提交：

```text
<collection-root>/raw/                 # 活跃采集数据、批次和事件
<collection-root>/frozen/              # 只读历史冻结层
<collection-root>/clean/               # 清洁/分析产物
<collection-root>/translated/          # 翻译产物
<collection-root>/.reddit-rpa-control/ # Native Host 控制信箱
tools/frozen/                          # 可见的本地缓存和元数据冻结区（仓库外）
__pycache__/、*.pyc、.DS_Store          # 生成物
```

仓库内的 `.gitignore` 是第二道防线；发布前仍必须用 `git ls-files` 检查提交清单。

## 目录结构

```text
.
├── manifest.json                 # Chrome MV3 权限和入口
├── popup.html / popup.js / popup.css
├── content.js                    # 唯一 DOM 采集控制器
├── service-worker.js             # 状态、写入、批次与 Native Host 桥接
├── reddit-model.js               # Post/Comment 识别、归属和父级校验
├── post-storage.mjs              # post/thread/capture 数据契约
├── output-paths.mjs              # 安全目录名与路径边界
├── output-store.js               # File System Access 目录授权回退
├── subreddit-registry.mjs        # subreddit 登记表校验与受控追加
├── native-host/
│   ├── reddit_rpa_native_host.py
│   └── com.openai.reddit_rpa.json.template
├── scripts/                      # CLI、MCP、合并/翻译/质量脚本
├── tests/                        # Node/Python 合成测试与 fixtures
└── docs/                         # AI 评审、架构和数据契约
```

## 快速安装

### 1. 准备集合目录

扩展写入的是一个集合根目录，而不是 `raw/` 子目录。至少需要：

```text
<collection-root>/
├── raw/
└── rules/subreddit_registry.json
```

`subreddit_registry.json` 的格式可参考 [数据契约](docs/DATA_CONTRACT.md)。真实集合文件不在本仓库中。

### 2. 加载 Chrome 扩展

1. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本仓库目录。
3. 打开 Reddit 的 subreddit 列表页或帖子页，点击扩展图标。
4. 未安装 Native Host 时，在弹窗中选择 `<collection-root>`；目录必须包含 `raw/` 和 `rules/subreddit_registry.json`。

### 3. （可选）安装 Native Messaging Host

Native Host 适合需要 CLI/MCP 控制或长批次运行的场景。先从 `chrome://extensions` 复制扩展 ID，再在本仓库根目录执行：

```zsh
python3 scripts/install_native_host.py --extension-id <chrome-extension-id>
```

安装器只写入当前用户的 Chrome `NativeMessagingHosts` 配置，并把允许来源限制为这一个扩展 ID。当前 Native Host 的默认部署布局是本地数据工作区中的：

```text
<workspace>/
├── tools/reddit-rpa-assistant/  # 本仓库
└── VR-XR/                       # 集合根目录
```

如果只需要脚本处理或 CLI 读写控制，可以始终显式传入 `--root <collection-root>`；Native Host 的固定根目录耦合见 [AI 评审指南](docs/AI_REVIEW.md) 的已知限制。

## 日常采集流程

在扩展弹窗中：

1. 点击“同步当前列表”，保存当前 subreddit 的目标清单。
2. 点击“开始采集 N 帖”，顺序导航同一个 Reddit 工作页并保存快照。
3. 批次结束后，只对 `manual`、`failed` 和需要完整回复树的 `tree_partial` 项人工复核。

批量导航期间，后台会为每个目标登记限时租约。若浏览器工作页显示 `HTTP ERROR 429`、`ERR_BLOCKED_BY_CLIENT`、其他错误页，或在期限内没有恢复为可采集的 Reddit 帖子页，批次会暂停并写入结构化事件，而不会静默悬挂。`HTTP ERROR 429` 只表示浏览器页面曾显示 429；工具不会将它断言为已验证的 Reddit 服务端限流。

写入完成后，数据形态为：

```text
<collection-root>/raw/
├── batches/<batch-id>.json
├── batches/<batch-id>.events.jsonl
└── <subreddit-slug>/<post-id>--<url-slug>/
    ├── post.json
    ├── comments.jsonl
    ├── thread.json
    └── captures.jsonl
```

`comments.jsonl` 是本次修订的完整评论快照，不是对旧评论的盲目追加；`thread.json` 由当前快照重建；`captures.jsonl` 只追加质量审计。详细语义见 [数据契约](docs/DATA_CONTRACT.md)。

## CLI / MCP 控制

控制面先读取 Native Host 的在线心跳，再写入集合根目录下的 `.reddit-rpa-control/requests/`。它不修改帖子、评论或 `batch.json`：

```zsh
python3 scripts/reddit_rpa_control.py --root <collection-root> health
python3 scripts/reddit_rpa_control.py --root <collection-root> --timeout 60 prepare --subreddit SteamVR
python3 scripts/reddit_rpa_control.py --root <collection-root> --timeout 60 run --subreddit SteamVR --count 25
python3 scripts/reddit_rpa_control.py --root <collection-root> --timeout 60 run --subreddit SteamVR --count 25 --skip-existing
python3 scripts/reddit_rpa_control.py --root <collection-root> --timeout 60 retry-unfinished --batch <source-batch-id>
python3 scripts/reddit_rpa_control.py --root <collection-root> status --batch <batch-id>
python3 scripts/reddit_rpa_control.py --root <collection-root> tail --batch <batch-id>
python3 scripts/reddit_rpa_control.py --root <collection-root> verify --batch <batch-id>
```

`run --skip-existing`（MCP：`skip_existing: true`）用于高频补采：先只读 `raw/<slug>/*/post.json` 中已有的 `t3_*`，从当前 `/new/` 继续滚动查找，最多检查 500 个候选，直到找到 `count` 个未见帖子；只有同步时新建目录的帖子才会入队。当前列表没有未见帖子时返回 `no_unseen_posts`，不会创建空批次。此选项默认关闭；需要重新采集旧帖的最新评论时，不要传它。

`retry-unfinished --batch <source-batch-id>`（MCP：`reddit_rpa_retry_unfinished`）是精确补采：只读取该历史 `batch.json` 中状态为 `unprocessed` 或 `interrupted` 的 fullname 与 permalink，建立带来源批次血缘的新批次。它不扫描当前 `/new/`，不使用 `skip_existing` 的差集，也不改写源批次；`manual`、`failed` 与 `tree_partial` 仍需按其审计原因处理。

暂停、继续和取消需要显式 `--batch`。MCP stdio 入口为 `scripts/reddit_rpa_mcp.py`，工具名和参数与 CLI 对齐：`reddit_rpa_health`、`reddit_rpa_prepare`、`reddit_rpa_run`、`reddit_rpa_retry_unfinished`、`reddit_rpa_pause`、`reddit_rpa_resume`、`reddit_rpa_cancel`、`reddit_rpa_status`、`reddit_rpa_tail`、`reddit_rpa_verify`。

## 离线处理脚本

处理脚本不需要联网；输入和输出路径都应显式传入：

```zsh
python3 scripts/merge_and_summarize.py \
  --input <collection-root>/raw/virtualreality \
  --out <collection-root>/clean/virtualreality/merge

python3 scripts/build_final_documents.py \
  --input <collection-root>/clean/virtualreality/merge/reddit_records_merged.jsonl \
  --raw-out <collection-root>/clean/virtualreality/reddit_original.ndjson \
  --clean-out <collection-root>/clean/virtualreality/reddit_clean_for_ai.jsonl \
  --collection-name VR-XR \
  --subreddit virtualreality

python3 scripts/build_translation_documents.py prepare \
  --input <collection-root>/clean/virtualreality/reddit_clean_for_ai.jsonl \
  --chunks-out <collection-root>/translated/virtualreality/chunks

python3 scripts/build_comment_tree_review_queue.py \
  --root <collection-root> \
  --scope <collection-root>/rules/collection_scope.json

python3 scripts/verify_collection_scope.py \
  --root <collection-root> \
  --scope <collection-root>/rules/collection_scope.json
```

迁移旧 `runs/` 时先不带 `--apply` 演练；`--trash-runs` 会把已校验的旧批次移入系统废纸篓：

```zsh
python3 scripts/migrate_runs_to_post_folders.py --root <collection-root>
python3 scripts/migrate_runs_to_post_folders.py --root <collection-root> --apply --trash-runs
```

## 验证

仓库只使用 Node/Python 标准库，不需要安装第三方依赖：

```zsh
npm run check
npm test
git diff --check
```

其中 `npm test` 当前包含 39 个 Node 测试和 28 个 Python 测试；测试夹具是合成内容，不读取本地 `VR-XR` 数据。浏览器真实 Reddit 页面、登录状态、MFA、限流和 DOM 变化仍需单独人工验收。

## 已知限制与风险

- Reddit 页面结构和评论加载策略会变化；“完成”只代表本页面可验证范围内完成，不代表服务器全量可见。
- Native Host 为本地高权限边界，当前默认绑定本地 `VR-XR` 集合布局；应审查 manifest 路径、扩展 ID 白名单和集合根目录权限。
- `unlimitedStorage`、`nativeMessaging` 和 Reddit host permissions 都是有意配置，但扩大了浏览器扩展的权限面；不要在不理解代码时加载陌生构建物。
- 删除/折叠父级、未展开控件、0/0 初次渲染和数量差异会写入质量字段，不能静默升级为 `complete`。
- 页面级 `HTTP ERROR 429`、浏览器错误页与客户端拦截可由后台观察并暂停批次，但扩展不读取错误页正文，也不能确认 429 一定来自 Reddit 服务端；应以 `failure_kind`、`evidence_source` 和后续可复现实验判断。
- 本仓库没有云端服务、CI 浏览器 E2E 或自动化账号；任何真实采集结果都必须在本地数据层审计。

## 版本与发布

Chrome 扩展版本在 `manifest.json`，脚本/MCP 服务信息在 `scripts/reddit_rpa_mcp.py`，当前均为 `0.8.2`。发布前检查：

```zsh
git status --short
git ls-files | rg '(^|/)(raw|frozen|clean|translated|\.reddit-rpa-control|__pycache__)($|/)|\.pyc$|\.jsonl$'
npm run check && npm test
```

最后一条搜索应只匹配测试夹具或源码中必要的 schema 说明，不应匹配真实帖子数据。变更 schema、路径或权限时，必须同步更新 `docs/` 和测试。
