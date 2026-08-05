# llm-wiki 知识库构建技术说明

本文档说明本项目如何把文档构建为可检索、可追溯、可增量更新的 Wiki 知识库，以及 MCP 工具、Agent 和错误恢复机制的职责。

## 1. 总体架构

```text
Claude / Codex / OpenCode
        │  Skill + MCP STDIO
        ▼
MCP Server（packages/mcp-server）
        │  工具路由、错误封装、传输保护
        ▼
Headless Core（packages/core）
        │
        ├─ Source Store：来源文件、解析结果、chunk、batch
        ├─ Analysis Store：每个 batch 的结构化抽取结果
        ├─ Wiki Store：实体、概念、主题、来源和汇总页面
        └─ Indexes：BM25、Embedding、Wiki/关系索引
```

Core 不调用大模型。语义抽取和页面写作由宿主 Agent 完成，Core 负责解析、分批、证据索引、Schema 校验、持久化、检索和事务提交。

## 2. 知识库构建流程

### 2.1 导入文件

Agent 调用 `llm_wiki_import_files`：

1. 检查文件是否位于 Agent 可访问范围；
2. 将文件复制到当前 workspace 的受管 Source Store；
3. 解析 Markdown、TXT、XLSX、PDF、DOCX 等支持格式；
4. 生成 source、chunk 和 bounded batch；
5. 创建可恢复的 `task_id`。

导入时可以传入领域 Schema：

```json
{
  "options": {
    "domain_schema_path": "./domain-schema.json",
    "target_language": "zh-CN",
    "max_batch_chars": 9000
  }
}
```

领域 Schema 会被校验并快照到任务中。之后即使外部 Schema 文件改变，本次任务仍使用原快照。

### 2.2 分批和并行抽取

Agent 通过 `llm_wiki_get_batch` 获取一个批次。Core 会：

- 给 batch 加 worker 租约，避免多个 worker 抢同一批次；
- 返回服务端生成的 exact evidence catalog；
- 返回按当前 batch 内容筛选的 Schema 类型；
- 对超大单行或旧 batch 尝试安全重分区；
- 保留原始 batch ID、worker 租约和恢复信息。

每个 extractor 使用稳定的 `worker_id`。Agent 进程退出后，可以使用同一个 worker ID 继续原租约，不依赖原来的子 Agent 或 MCP 客户端仍然存活。

### 2.3 Schema-first 分析

Agent 根据 batch 和 Schema 生成 `AnalysisEnvelope`，然后调用 `llm_wiki_commit_analysis`。

提交前后会执行：

1. 校验 envelope、task、batch 和 schemaVersion；
2. 解析 `sourceRefs` 索引；
3. 校验 sourceRef 是否指向真实 chunk；
4. 校验 quote、locator 和证据质量；
5. 校验实体类型、属性和关系类型；
6. 校验 reviewItems、claims、relations 等集合结构；
7. 通过后将分析结果写入 Analysis Store，并标记 batch 完成。

Schema 的抽取策略是“抽取时约束”，不是先随意抽取后再静默丢弃。默认遇到不符合 Schema 的候选会返回可修正错误；只有显式设置 `accept_dropped_candidates=true` 才允许破坏性 drop-invalid 行为。

### 2.4 增量 Wiki 投影

当完成的 batch 达到投影条件后，Core 会创建一个 Writer projection，交给 Agent Wiki Writer：

- 结构化实体和属性；
- 已验证的 claims；
- 关系和 Related 链接；
- 精确证据引用；
- 原子事务和目标页面 hash 校验。

主协调器中的 Writer loop 会读取完整的 page plan，生成有标题、概述、关键事实、关系、Related 链接和来源证据的语义页面。页面数达到 4 个后，主协调器按精确的 `patch_scaffold.path` 将页面分成互不重叠的 shard，最多启动 4 个无 MCP 权限的 page drafter 并行生成正文；同一路径的全部 requirement 始终留在一个 shard。主协调器仍是唯一提交者，会校验路径唯一性、coverage、scaffold、hash 和 SourceRef 后再原子提交，因此并行生成不会引入 revision 冲突。增量 projection 的页面可能先标记为 provisional，最终 projection 会重新综合所有 batch 并清除 provisional 状态。

抽取与页面生成同时进行时，协调器使用 4 个后台 Agent 的共享预算，通常分配为 2 个 extractor + 2 个 page drafter；不会中断正在处理 batch 的 extractor，而是在 worker quantum 结束后调整补位。抽取完成后可将 4 个槽位全部用于页面分片。这样可避免 extractor 持续占满并发槽导致 writer backlog 无限增长。

### 2.5 最终语义重写

所有 batch 完成后，Core 会创建 final projection，交给同一个 Wiki Writer 做完整语义协调：

1. `llm_wiki_get_page_plan_context` 按 cursor 分页返回稳定的完整 page plan；
2. Writer 必须读取所有 cursor，直到 `page_plan_complete=true` 且 `next_cursor=null`；
3. Writer 综合所有 batch 的实体、声明、关系、冲突和现有页面正文；
4. Writer 可让多个 page drafter 并行重写互斥页面的概述、关键事实、关系和 Related 链接，但仍由唯一 Writer 统一提交；
5. 原始 chunk 只放在简洁的来源证据区；
6. 页面 patch 按最多 50 个一组原子提交，失败时修正整个被拒绝集合后重试；
7. 最终 projection 完成后，由 Finalize 更新 `index.md` 和 `overview.md` 等全局汇总页。

如果 Writer 在某个 cursor 处中断，恢复时必须使用同一 projection ID 和准确 cursor 继续读取；不能在 page plan 未完成前提交页面。`llm_wiki_apply_projection` 只是兼容入口，会转交传统 page-plan Writer 流程，不会自动渲染页面。

### 2.6 Related 关系生成

Related 不是在单一阶段一次性生成，而是分三步完成：

1. 抽取阶段：Extractor 将有证据支持的实体关系写入 `AnalysisEnvelope.relations`；
2. 投影阶段：Core 根据关系两端的 requirement，生成 `related_requirement_ids`，并在页面 patch 的 `related`、正文关系段落和 Wiki 链接中写入；
3. Finalize 阶段：Core 扫描页面 frontmatter 与正文 Wiki 链接，补齐双向 Related 关系。

因此，增量页面可以先看到部分 Related；全部 batch 和语义分片完成后，Finalize 才是最终一致的双向关系结果。

### 2.7 Finalize

`llm_wiki_finalize` 完成 Core 拥有的收尾工作：

- 生成或更新 source 页面；
- 更新 `index.md`、`overview.md`、`log.md`；
- 更新确定性索引，并对 Related 关系进行双向补全；
- 执行 Wiki lint；
- 将任务标记为 completed。

## 3. 多路检索

`llm_wiki_retrieve_context` 默认使用 RRF（Reciprocal Rank Fusion）融合：

- BM25：传统词法检索；
- Embedding：语义向量检索；
- Wiki：已生成页面、标题、路径和双向链接检索；
- vector/graph：兼容旧调用的别名或扩展通道。

知识库构建中，查询优先返回 BM25 和 Embedding 结果；Wiki 投影完成后，Wiki 通道自动加入召回。Embedding 不可用时会降级，不会导致 MCP 断开。

Embedding 配置位于 `.llm-wiki/config.json` 的 `retrieval.embedding`，包括 provider、model、endpoint、batchSize、timeoutMs 和 totalTimeoutMs。

## 4. MCP 工具清单

| 工具 | 用途 |
| --- | --- |
| `llm_wiki_import_files` | 导入文件、解析并创建任务 |
| `llm_wiki_get_batch` | 获取并租约一个抽取 batch |
| `llm_wiki_get_domain_schema` | 分页、搜索或按类型读取领域 Schema |
| `llm_wiki_retrieve_context` | BM25 + Embedding + Wiki 多路召回 |
| `llm_wiki_commit_analysis` | 校验并持久化一个 batch 的结构化分析 |
| `llm_wiki_get_page_plan_context` | 分页读取页面计划和最终 Writer 上下文 |
| `llm_wiki_apply_projection` | 兼容入口：转交传统 Wiki Writer 的 page-plan 流程，不自动写页面 |
| `llm_wiki_commit_pages` | 原子提交页面 patch |
| `llm_wiki_finalize` | 生成索引、来源页并完成任务 |
| `llm_wiki_status` | 查看任务、租约、并行建议和下一步动作 |
| `llm_wiki_list_tasks` | 列出当前 workspace 的任务 |
| `llm_wiki_delete_knowledge_base` | 删除 Wiki 或完整知识库 |
| `llm_wiki_abort` | 终止未完成任务并清理 staging |
| `llm_wiki_lint` | 执行结构和引用校验 |

## 5. MCP 稳定性和错误恢复

MCP Server 是 STDIO 长连接适配器。工具业务错误不会使用 MCP `isError` 通道，而会返回结构化结果，例如：

```json
{
  "accepted": false,
  "rejected": true,
  "error": { "code": "INVALID_SOURCE_REF", "retryable": true },
  "next_action": { "tool": "llm_wiki_commit_analysis" },
  "mcp_connection_usable": true
}
```

稳定性措施包括：

- 工具路由统一捕获 Core 异常；
- MCP handler 最外层兜底；
- `uncaughtException` 和 `unhandledRejection` 日志保护；
- 输入 12 MB、输出 6 MB、STDIO buffer 32 MB 的边界保护；
- 大结果使用分页而不是一次性返回；
- 每 5 分钟发送一次标准协议 ping，避免宿主 idle timeout；
- batch、page plan、worker lease 和任务状态持久化，可跨 turn 恢复；
- 页面提交使用幂等键、revision 和目标文件 hash。

如果仍然显示断开，应检查 MCP stderr 中的 `transport-error`、`protocol-error`、`uncaught-exception`、`unhandled-rejection` 和 `keepalive` 日志。

## 6. 删除知识库

调用 `llm_wiki_delete_knowledge_base` 时必须显式确认：

```json
{
  "scope": "wiki",
  "confirmation": "DELETE KNOWLEDGE BASE"
}
```

`scope=wiki`：删除生成页面和检索索引，保留来源文件与任务历史。

`scope=knowledge_base`：删除来源、任务、分析、索引、Wiki 和 staging，但保留 workspace 配置与 Schema 配置。

存在活动任务时删除会被拒绝，避免破坏正在运行的抽取。

## 7. Claude 配置和基本用法

项目根目录 `.mcp.json` 注册 MCP Server，`.claude/settings.json` 允许主 Agent、extractor 和 writer 使用 Skill 及 14 个 MCP 工具。

首次配置后：

```bash
npm install
npm run build
```

在 Claude 中确认项目 MCP 为 Connected，然后提出类似请求：

```text
把这些文档构建成知识库。使用 ./domain-schema.json 作为领域 Schema，完成抽取、Wiki 页面、索引和最终总结。
```

常用恢复方式：

1. 先调用 `llm_wiki_status`；
2. 按返回的 `next_action` 继续；
3. worker 消失时使用原 worker_id 重新启动；
4. `get_page_plan_context` 必须按 cursor 顺序读到 `next_cursor=null`；
5. 原子提交失败时修复整个被拒绝 patch 集合后，用新的 idempotency key 重试；
6. 代码更新后重新 `npm run build` 并重启 Claude MCP，避免继续使用旧 dist。

## 8. 关键数据目录

所有数据都限定在 MCP 启动的 workspace 内，常见目录包括：

```text
.llm-wiki/
  sources/       # 受管来源和 manifest
  tasks/         # 任务、batch 租约、分析和提交日志
  indexes/       # BM25、Embedding 和 Wiki 检索索引
  staging/       # 导入和临时数据
wiki/            # 最终生成的 Markdown 知识库
```

不要复制 `node_modules/` 或旧的 `packages/mcp-server/dist/` 到新电脑；在新环境重新安装依赖并构建即可。
