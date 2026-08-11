# Reddit RPA Assistant：AI 评审约定

本仓库只维护工具源码、测试夹具和说明文档。真实 Reddit 采集数据、运行信箱、账号状态、截图、历史报告和 Python 缓存属于本地数据层或冻结区，不得提交。

## 评审入口

1. 先读 `README.md`，确认产品边界与部署布局。
2. 再读 `docs/AI_REVIEW.md`、`docs/ARCHITECTURE.md` 和 `docs/DATA_CONTRACT.md`。
3. 代码变更后运行 `npm run check`、`npm test`，并检查 `git diff --check`。

## 不可破坏的约束

- Chrome 扩展只能读取当前已打开 Reddit 页面中已经渲染且能证明归属的内容。
- 不调用 Reddit API，不读取 Cookie、Local Storage 或登录令牌，不执行发帖、投票、评论、关注等写操作。
- Native Messaging Host 只能访问配置的集合根目录，并通过原子写入落盘；它不是浏览器自动化器。
- `raw/` 历史数据不回写；新的评论快照写入 `raw-v2/`，并保留永久链接、来源 ID 和质量审计字段。
- 不把不确定的评论父级、广告或猜测内容提升成有效记录。
- 处理脚本必须从显式输入读取，并把派生文件写到显式输出路径。

## 修改习惯

- 优先做局部、可验证的修改，不顺手重构采集链路。
- 任何 schema、路径或状态变化都要同时更新测试与 `docs/`。
- 新增 fixture 必须是合成数据，不能复制本地真实帖子或评论。
- 发布前用 `git status --short`、`git diff --cached --stat` 和 `git ls-files` 检查没有数据、密钥或缓存。
