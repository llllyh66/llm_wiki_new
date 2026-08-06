# 更新日志

## [Unreleased] - 2026-08-06

### Writer 并行草稿流水线

- 页面 manifest 现在明确声明 `coordinator-owned-parallel-drafters` 执行模式：主协调器必须为互不重叠的 shard 启动最多 4 个 `llm-wiki-page-drafter`。
- 保留单一 Writer 提交者、路径不可分割约束和原子提交，避免为了提速引入同路径冲突、重复 coverage 或 Related 页面竞争。
- 串行 `llm-wiki-writer` 明确降级为无法启动 drafter 时的 fallback，不再被误当作默认并行 Writer。
- 补充 MCP 合约测试，防止后续提示词或工具描述回退到串行页面生成。

### 后台 Agent 优先调度

- `parallel_extraction` 对单 batch 任务也保持 `background-agent-first`，主 Agent 不再因文件较小而直接执行抽取。
- Skill 明确禁止主 Agent 在启动 worker 前调用 `get_batch` 或 `commit_analysis`；只有实际 worker 创建失败、工具缺失或 MCP 传输错误时才允许前台兜底。
- import 工具和状态响应增加 `required`、`mode`、`single_batch_background` 调度提示，并补充单 batch 回归测试和 MCP 合约检查。

### MCP 长连接与 STDIO 生命周期修复

- 心跳改用带独立超时预算的标准 `ping` 请求，避免 SDK 默认请求长期挂起后阻塞后续心跳。
- 移除心跳定时器的 `unref`，保证长时间没有工具调用时 MCP 进程仍保持存活；生产默认仍为每 5 分钟一次。
- 监听 STDIO 输入/输出的 `end`、`close` 和 `error`，对端退出时主动关闭协议并清理资源，避免出现“Claude 已断开但 Node 进程仍在”的僵尸连接。
- 未捕获的进程级异常现在会记录后优雅退出并交还给宿主重启；普通工具校验错误仍由路由器转换为可恢复的结构化结果。
- 增加短周期心跳的真实 STDIO 回归测试，验证连续 ping/pong 后仍可正常调用 `listTools`。

### 技术文档与运维说明

- 技术文档新增 MCP 长连接诊断 Runbook，说明 `ready`、`keepalive`、`shutdown-requested` 和 STDIO 管道关闭日志的含义及恢复动作。
- 记录 `LLM_WIKI_MCP_KEEPALIVE_MS`、`LLM_WIKI_MCP_KEEPALIVE_TIMEOUT_MS` 的默认值与边界，避免误把心跳失败、宿主关闭管道和普通工具校验错误混为同一类问题。
- 补充升级后的 `npm run build`、`npm test` 和 Claude `/mcp` 重启步骤，明确 `dist/` 不纳入 Git。

### 第二轮隐性 Bug 修复

- 强制 draft shard 按 cursor 顺序读取；跳过前置上下文的提交会返回可恢复的 `PAGE_PLAN_CURSOR_MISMATCH`，避免伪造“已完整读取”并绕过语义重写。
- 校验 OpenAI-compatible Embedding 返回的向量索引必须完整、唯一且在请求范围内，防止异常响应造成文档与向量错配；异常继续降级到本地特征哈希召回。
- 允许显式删除已失败任务遗留的知识库数据；仍阻止 importing、extracting、planning、committing、finalizing 等活动任务期间的删除。
- 复核 Schema/XLSX 边界处理，并补充 draft cursor、Embedding 异常索引和失败任务清理回归测试。

### Writer 页面写入与大上下文恢复

- 新增服务端持久化的页面 manifest 和 draft shard 流程。
- Writer 在生成页面前即可获得单次最多 50 个 patch 的硬限制。
- 每个 shard 最多包含 6 个 canonical page path；每次最多返回 4 个待处理 shard。
- shard 成功写入后立即保存 `draft_shard_ids`，Writer 重启或上下文压缩后从第一个未完成 shard 继续。
- final projection 必须完成全部 shard 后才能确认，不会因旧页面已有 coverage 而跳过语义重写。
- 大型页面计划只返回分片上下文，避免一次性生成 50+ 页面后重新生成前半部分。
- drafter 生成的 PagePatch 现在只写入任务级临时 staging；主协调器和 Writer 只传递 receipt/hash，Writer 通过 `staged_draft_shard_ids` 在服务端原子提交。
- draft-shard 响应强制限制在约 40K 字符，并对既有大页面发送确定性的头尾摘要；完整页面正文保留在服务端，避免上下文压缩或超限。
- 保留 `view=plan` 作为旧版 page-plan cursor 流程的兼容入口。

### 抽取与 MCP 稳定性

- 缩小 `get_batch` 锁范围，提升多 Worker 并行租约吞吐。
- 防止 Worker 之间重新分区正在使用的 batch；修复超大单行 batch 的安全切分偏移。
- 增加精确幂等重放和活动 lease 校验，减少验证失败后的重复计算。
- 缓存并发读取中的领域 Schema、分析结果、page-plan 和 shard 上下文。
- 所有页面 shard 未完成、patch 超限、coverage 不完整等错误均返回可恢复 MCP 结果，不触发连接断开。
- 分析 envelope 在生成前返回实体、关系、证据和 reviewItems 的数量限制。
- 取消任务时清理未完成 projection 的快照和缓存。

### 文档与测试

- 更新 Skill、Writer Agent、恢复指南和技术文档，统一采用 manifest → shard → durable commit 流程。
- 新增 50+ 页面分片写入、提前 finalize 拒绝、上下文恢复和 MCP 错误恢复测试。
- 全量测试通过：Core 38 项、MCP Server 13 项、CLI 1 项。
