# AI 评审指南

这份文档把一次代码审查需要回答的问题固定下来，避免把“测试通过”误读成“真实 Reddit 数据完整”。

## 1. 评审结论应覆盖的范围

评审者应分别回答：

1. **权限**：扩展申请的权限是否与功能匹配，是否新增了网络、凭据或外部写入能力？
2. **采集边界**：Post/Comment 是否只来自当前已打开页面，归属和父级是否有证据？
3. **文件边界**：路径是否限制在集合根目录，是否可能穿越到工作区、用户目录或历史层？
4. **一致性**：批次、单工作页锁、重试、取消、扩展重载和原子写入是否能避免重复或半写入？
5. **质量语义**：数量差、删除父级、未展开控件和加载失败是否被保留为审计，而不是被静默视为完成？
6. **可复现性**：测试是否只依赖仓库内合成 fixture，文档命令是否不要求上传真实数据？
7. **隐私**：日志、控制请求、测试 fixture 和错误消息是否意外含有账号、令牌、正文或本机绝对路径？

## 2. 推荐阅读顺序

| 顺序 | 文件 | 关注问题 |
| --- | --- | --- |
| 1 | manifest.json | host permissions、nativeMessaging、unlimitedStorage 和入口 |
| 2 | content.js | DOM 读取、控件展开、工作页控制、错误/重试状态 |
| 3 | reddit-model.js | Post/Comment 识别、永久链接、父级和自指循环 |
| 4 | service-worker.js | 单工作页锁、目录授权、批次写入、扩展重载恢复 |
| 5 | native-host/reddit_rpa_native_host.py | 固定根目录、请求校验、原子写入和 Native Messaging 协议 |
| 6 | output-paths.mjs、post-storage.mjs | 路径与 schema 不变量 |
| 7 | scripts/reddit_rpa_control.py、scripts/reddit_rpa_mcp.py | 控制信箱和结构化错误 |
| 8 | tests/ 与 docs/DATA_CONTRACT.md | 不变量是否被测试和文档共同锁定 |

## 3. 信任边界与威胁模型

### 输入

- Reddit 页面 DOM：可能缺节点、重复节点、延迟加载、删除占位符或页面结构变化。
- 用户选定的集合目录：可能包含旧数据、缺失规则或错误权限。
- CLI/MCP 参数和控制信箱文件：可能损坏、过期、重复或被其他本地进程写入。
- Chrome 扩展生命周期：Service Worker 可能休眠，页面脚本可能来自旧版本。

### 保护目标

- 不读取浏览器凭据，不发起未经声明的网络调用。
- 不把错误页面内容写进合法 Post 目录。
- 不让输入路径逃出集合根目录。
- 不让过期的工作页、旧脚本或重复控制器继续写批次。
- 保留足够审计字段，使 Agent 能区分可继续、需复核和已失败。

### 需要重点攻击性检查的边界

| 边界 | 典型问题 | 应看到的防线 |
| --- | --- | --- |
| Reddit DOM → Content Script | 错帖、广告、伪造 permalink、无法证明父级 | t3/t1 fullname、canonical permalink、Post 归属和父级校验 |
| Content Script → Service Worker | 旧脚本、重复消息、回调超时 | controller token、worker lock、版本检查、结构化消息 |
| Worker → File System Access | 授权失效、错误目录、半写入 | root preflight、raw/rules 目录检查、临时文件/原子替换 |
| Worker ↔ Native Host | 任意路径、未授权扩展、重复 claim | manifest allowed origins、固定 root、ID 正则、claim lease |
| CLI/MCP → Control inbox | 命令伪造、重放、数据面误写 | schema/ID 校验、在线 collector 选择、只写 request |
| raw-v2 → 派生层 | 误删或覆盖原始快照 | 显式输入/输出、快照替换语义、迁移需 --apply |

## 4. 状态审查规则

以下结果不能直接当作“数据完整”：

- manual：必须保留 capture 和错误原因，人工检查后才可重采。
- failed：受控重试已无法完成；应查登录、限流、工作页和页面错误。
- tree_partial：数量可能可用，但回复树不完整；平面分析和树分析的可用性不同。
- complete_with_reported_count_gap：页面报告计数与已验证数量不一致，必须保留 gap。
- interrupted：只代表批次中断，不代表未处理目标为空。

评审者应特别寻找把 0/0、缺父级、未展开控件或 Reddit 头部计数差异直接映射为 complete 的代码路径。

## 5. 本地验证

在仓库根目录运行：

~~~zsh
npm run check
npm test
git diff --check
~~~

发布前再检查内容边界：

~~~zsh
git status --short
git ls-files
git ls-files | rg '(^|/)(raw|raw-v2|clean|translated|\.reddit-rpa-control|__pycache__)($|/)|\.pyc$|\.jsonl$'
~~~

对于真实环境，额外需要人工验证：

- Chrome 加载已解压扩展、扩展重载与 Service Worker 休眠/恢复；
- Reddit 登录、MFA、权限受限、限流、删除/折叠评论；
- File System Access 首次授权、授权失效和 Native Host 连接；
- 真实页面 DOM 更新后，拒收/重试/人工复核是否符合预期。

仓库没有浏览器真实页面 E2E，也没有云端 CI 账号；不能用合成测试替代这些验收。

## 6. 当前已知风险

1. **DOM 依赖**：Reddit 页面结构变化可能造成漏采或误报；选择器测试只能保护已知契约。
2. **Native Host 权限**：Native Host 运行在本机用户权限下，固定根目录降低了范围，但不等于沙箱。应审查安装 manifest 的路径和 allowed_origins。
3. **集合耦合**：当前 Native Host 默认使用本地工作区的 VR-XR 布局；CLI/离线脚本支持显式 --root，但泛化 Native Host 仍是后续工作。
4. **权限面**：nativeMessaging、unlimitedStorage 和 Reddit host permissions 是有意能力，但会提高加载未知构建物的风险。
5. **数据合规**：工具能保存 Reddit 页面公开可见内容，不代表这些内容可任意再分发；使用者仍需自行判断平台规则、隐私和研究伦理。

## 7. 评审通过标准

一次可接受的评审至少应确认：

- 发布清单没有真实数据、历史报告、缓存、密钥或本机绝对路径；
- manifest、README、数据契约和实际代码对权限/写入边界的描述一致；
- Node/Python 测试与语法检查全部通过；
- 失败、部分完成和中断状态仍可追踪，不会被无声吞掉；
- 对 Native Host、DOM 变化和真实页面 E2E 的剩余风险有明确记录；
- 任何后续改动都能沿 docs/、测试和 schema 变更追溯。
