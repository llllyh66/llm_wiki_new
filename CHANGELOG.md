# 更新日志

## [Unreleased] - 2026-08-05

### Writer 页面写入与大上下文恢复

- 新增服务端持久化的页面 manifest 和 draft shard 流程。
- Writer 在生成页面前即可获得单次最多 50 个 patch 的硬限制。
- 每个 shard 最多包含 6 个 canonical page path；每次最多返回 4 个待处理 shard。
- shard 成功写入后立即保存 `draft_shard_ids`，Writer 重启或上下文压缩后从第一个未完成 shard 继续。
- final projection 必须完成全部 shard 后才能确认，不会因旧页面已有 coverage 而跳过语义重写。
- 大型页面计划只返回分片上下文，避免一次性生成 50+ 页面后重新生成前半部分。
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
- 全量测试通过：Core 35 项、MCP Server 12 项、CLI 1 项。

