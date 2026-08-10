# llm-wiki 知识库构建技术说明

本文档说明本项目如何把文档构建为可检索、可追溯、可增量更新的 Wiki 知识库，以及 MCP 工具、Agent 和错误恢复机制的职责。

## 1. 总体架构

```text
Claude / Codex / OpenCode
        │  Skill + MCP（Claude: Streamable HTTP；Codex/OpenCode: STDIO）
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
    "domain_schema_path": "./domain-schema",
    "target_language": "zh-CN",
    "max_batch_chars": 9000
  }
}
```

领域 Schema 目录会被校验并快照到任务中。之后即使外部 Schema 文件改变，
本次任务仍使用原快照。只支持目录型渐进式披露 Schema：根目录包含
`all_domains.json`，每个 Domain
目录包含 `<domain>_domain.json` 和多个 ABE JSON。JSON 内部字段不做固定约束；Agent
按 Domain → ABE → BE 逐级读取，最后一个 ABE 文件完整暴露给 Agent，并在实体/概念上
提交 `schemaClassification` 与 JSON Pointer。ABE 响应同时返回 canonical
`classification_scaffold` 与 `be_pointer_hints`，避免 Agent 猜测目录名、文件名或数组
位置。Core 接受 `/...` 与 `#/...`，规范化唯一引用，并从 Pointer 指向的节点补齐
BE key/name 后再持久化。
单文件安全上限为 5 MiB，整个快照默认上限为 20 MiB；低于上限的 ABE JSON 始终原样暴露，不做截断或字段重写。

### 2.2a 页面领域分类投影

分析结果中实体和概念的 `schemaClassification` 会在 page requirement
阶段解析为稳定的 Domain → ABE → BE 分类：

```yaml
schema_layout: "progressive-directory-v2"
schema_classification_status: "classified"
schema_domain_keys: ["customer"]
schema_abe_keys: ["customer_management"]
schema_be_keys: ["individual_customer"]
```

Core 将同样的信息写入正文的“领域分类”章节。分类路径来自任务 Schema
快照，不来自 Writer 自由生成的字段。

页面重写和 staged PagePatch 提交时，Core 会根据 `covers` 重新计算领域分类，
避免 Writer 漏填、伪造或在跨 batch 合并时覆盖类型。已完成任务可使用
`llm_wiki_finalize({task_id, refresh_page_metadata: true})` 对已有页面执行幂等
元数据刷新；刷新不重新调用模型，只更新 frontmatter、分类章节和检索索引。

### 2.2 分批和并行抽取

导入后主 Agent 只负责读取一次状态并启动后台 `llm-wiki-extractor`。即使文件只形成一个 batch，也保持后台 Agent-first 模式；主 Agent 只有在明确记录了 worker 创建失败、worker MCP 工具缺失或真实 MCP 传输错误后，才允许前台兜底处理。Agent 通过 `llm_wiki_get_batch` 获取一个批次。Core 会：

- 给 batch 加 worker 租约，避免多个 worker 抢同一批次；
- 返回服务端生成的 exact evidence catalog；
- 返回 Domain Schema 快照身份和三级披露指令；
- 对超大单行或旧 batch 尝试安全重分区；
- 保留原始 batch ID、worker 租约和恢复信息。

每个 extractor 使用稳定的 `worker_id`。Agent invocation 一结束，只要仍有抽取工作且未超过当前 pipeline 并发上限，协调器会零延迟以同一 worker ID 补位：有租约则立即续做原 batch，否则领取下一 batch；验证失败也不等待租约过期。

### 2.3 Schema-first 分析

Agent 根据 batch 和 Schema 生成 `AnalysisEnvelope`，然后调用 `llm_wiki_commit_analysis`。

提交前后会执行：

1. 校验 envelope、task、batch 和 schemaVersion；
2. 解析 `sourceRefs` 索引；
3. 校验 sourceRef 是否指向真实 chunk；
4. 校验 quote、locator 和证据质量；
5. 规范化并校验实体和概念的 Domain → ABE → BE 文件链与 JSON Pointer，从目标 Schema 节点补齐 BE key/name；
6. 校验 reviewItems、claims、relations 等集合结构；
7. 通过后将分析结果写入 Analysis Store，并标记 batch 完成。

Schema 分类不合法时，Core 在持久化前返回可修正错误，不会静默丢弃候选。

### 2.4 增量 Wiki 投影

当完成的 batch 达到投影条件后，Core 会创建一个 Writer projection，交给 Agent Wiki Writer：

- 结构化实体和属性；
- 已验证的 claims；
- 关系和 Related 链接；
- 精确证据引用；
- 原子事务和目标页面 hash 校验。

主协调器的投影编排 loop 只请求服务端持久化的 compact manifest、启动 page drafter 并校验 receipt；它不调用 `llm_wiki_get_staged_page_drafts` 或 `llm_wiki_commit_pages`。manifest 在生成正文之前明确返回“单次最多 50 个 patch”的硬限制，并按精确的 `patch_scaffold.path` 预先分成最多 6 个路径的 shard；同一路径的全部 requirement 始终留在一个 shard。稳定 Writer 是唯一提交者，每次通过服务端暂存处理一个 bounded wave，不再把整个 page plan 和几百个 patch 放入模型上下文。已接受的 shard 是恢复检查点，即使 context compaction 或 Writer 重启，也会从第一个未覆盖 shard 继续，不重做前 50 页。

页面 drafter 不把 PagePatch 正文返回给主协调器：它通过 `llm_wiki_stage_page_drafts` 将一个路径互斥的 shard 写入任务级临时 staging，只返回 `{shard_id, draft_hash}`、数量和字符数等 receipt。主协调器收到 hash-bound receipt 后只负责启动或恢复稳定 Writer。稳定 Writer 通过 `llm_wiki_get_staged_page_drafts(draft_receipts)` 获取元数据，再用 `llm_wiki_commit_pages(staged_draft_receipts, patches=[])` 让 Core 校验 receipt hash、读取暂存正文并原子提交；该形式不需要调用方携带实际 PagePatch。提交成功并完成任务状态持久化后，Core 才删除暂存文件。

draft-shard 的服务端响应硬上限约为 40K 字符；对既有超大页面只提供确定性的头尾摘要并保留 hash，完整正文不离开服务端。这样即使调用方误传 200K 的旧 `max_chars`，也不会把大页面或整批 patch 带入主 Agent 上下文。

抽取与页面生成同时进行时，协调器使用 4 个后台 Agent 的共享预算，通常分配为 2 个 extractor + 2 个 page drafter；不会中断正在处理 batch 的 extractor，而是在 worker quantum 结束后调整补位。抽取完成后可将 4 个槽位全部用于页面分片。这样可避免 extractor 持续占满并发槽导致 writer backlog 无限增长。

### 2.5 最终语义重写

所有 batch 完成后，Core 会创建 final projection，交给同一个 Wiki Writer 做完整语义协调：

1. `llm_wiki_get_page_plan_context(view="manifest")` 在服务端冻结完整计划，只返回紧凑分片清单和提交限制；
2. 每个 page drafter 按自己的 `draft_action` 读取一个 `view="draft-shard"`，仅在分片内综合相关 batch 的实体、声明、关系、冲突和现有页面，然后调用 `llm_wiki_stage_page_drafts`；
3. Writer 用 `llm_wiki_get_staged_page_drafts(draft_receipts)` 检查 `{shard_id, draft_hash}` receipt，并让 Core 通过 `staged_draft_receipts` 统一、原子提交；页面正文不经过主 Agent；
4. 原始 chunk 只放在简洁的来源证据区；
5. 每个小 wave 以 `projection_complete=false` 原子提交，并回传服务端给出的 `committed_staged_draft_receipts`；这些持久化的 ID + hash 证明 final Writer 确实处理了该 shard，不会因旧页已有 coverage 而跳过语义重写。成功后立即丢弃该分片上下文；所有 shard 处理后用空 patch 和 `projection_complete=true` 完成最终覆盖审计；
6. 最终 projection 完成后，由 Finalize 更新 `index.md` 和 `overview.md` 等全局汇总页。

如果 Drafter 在 shard cursor 处中断，协调器使用同一 projection ID、shard ID 和准确 cursor 重启该 Drafter；如果 Writer 在 receipt 提交处中断，则重放相同 `{shard_id, draft_hash}` receipt 与幂等键。上下文压缩后直接按状态返回的未覆盖 shard 恢复，无需重放已接受页面。`llm_wiki_apply_projection` 只是兼容入口，会返回同一 compact manifest，不会自动渲染页面。

### 2.6 Related 关系生成

Related 不是在单一阶段一次性生成，而是分三步完成：

1. 抽取阶段：Extractor 将有证据支持的实体关系写入 `AnalysisEnvelope.relations`；
2. 投影阶段：Core 根据关系两端的 requirement，生成 `related_requirement_ids`，并在页面 patch 的 `related`、正文关系段落和 Wiki 链接中写入；同 batch localId 优先，跨 batch localId 只在全局唯一时解析，并可安全回退到唯一页面名称；
3. 写盘阶段：Core 合并 frontmatter、`patch.related` 和正文中的 `[[...]]`、指向 Wiki 页面的 Markdown 链接、`## Related` 下的 `wiki/...md` 旧路径，统一输出为 frontmatter canonical slug 与正文 `[[collection/slug]]`；
4. Finalize 阶段：Core 扫描统一后的关联并补齐双向 Related 关系。

因此，增量页面可以先看到部分 Related；全部 batch 和语义分片完成后，Finalize 才是最终一致的双向关系结果。普通叙述中的“Related to”不会被自动猜测为页面链接，必须由结构化 relation 或明确的 canonical Wiki 链接支持。

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
| `llm_wiki_get_domain_schema` | 按 Domain → ABE → BE 逐级读取完整 JSON |
| `llm_wiki_retrieve_context` | BM25 + Embedding + Wiki 多路召回 |
| `llm_wiki_commit_analysis` | 校验并持久化一个 batch 的结构化分析 |
| `llm_wiki_get_page_plan_context` | 返回服务端 manifest 或有界 draft shard，传统 plan cursor 仅作兼容 |
| `llm_wiki_apply_projection` | 兼容入口：获取 compact manifest，不自动写页面 |
| `llm_wiki_stage_page_drafts` | 将单个 drafter 的完整 shard 暂存在服务端，只返回 receipt |
| `llm_wiki_get_staged_page_drafts` | 读取暂存 shard 的元数据，不返回页面正文 |
| `llm_wiki_commit_pages` | 原子提交页面 patch，或通过 hash-bound `staged_draft_receipts` 提交服务端暂存 shard |
| `llm_wiki_finalize` | 生成索引、来源页并完成任务 |
| `llm_wiki_status` | 查看任务、租约、并行建议和下一步动作 |
| `llm_wiki_list_tasks` | 列出当前 workspace 的任务 |
| `llm_wiki_delete_knowledge_base` | 删除 Wiki 或完整知识库 |
| `llm_wiki_abort` | 终止未完成任务并清理 staging |
| `llm_wiki_lint` | 执行结构和引用校验 |

## 5. MCP 稳定性和错误恢复

MCP Server 同时提供两种适配器：Claude Code 的项目配置使用受监控的
loopback Streamable HTTP，Codex 和 OpenCode 保留 STDIO。两者共享同一 Core
和工具路由。工具业务错误不会使用 MCP `isError` 通道，而会返回结构化结果，例如：

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
- HTTP worker 的 `uncaughtException` 会让 worker 退出并由 supervisor 指数退避重启；`unhandledRejection` 只记录并标记 degraded；
- 输入 12 MB、输出约 450 KiB、STDIO buffer 32 MB 的边界保护；工具元数据额外声明 80–120 KiB 的宿主结果建议；
- 全局最多 8 个、单任务最多 4 个活动工具调用；超限返回 `MCP_BUSY`/`TASK_BUSY` 和 `retry_after_ms`，宿主取消的排队请求返回 `MCP_REQUEST_CANCELLED`；
- Schema、analysis、batch、page-plan 和 draft-shard 缓存按条数与字节双重淘汰，避免大型任务通过重复快照耗尽 Node 堆；
- `.llm-wiki/logs/mcp-runtime.jsonl` 持久化记录 request ID、字节数、活跃调用、内存、构建提交、心跳和退出原因；`dist/build-info.json` 用于确认实际运行构建；
- 大结果使用分页而不是一次性返回；
- HTTP 每 10 秒发送 SSE keep-alive comment frame，每 1 分钟发送标准协议 ping；STDIO 也每 1 分钟 ping；
- 项目 `SessionStart` hook 幂等拉起 supervisor，worker 崩溃后最多 5 秒退避重启；Claude Code 对 HTTP 连接原生自动重连；
- 仅对 `MCP_BUSY`、`TASK_BUSY` 和 `WORKSPACE_LOCKED` 执行最多 3 次有界重试，业务校验错误不自动重放；
- 监听 STDIO 的 `end`、`close` 和 `error`，对端退出时主动关闭协议并清理定时器，避免留下“进程仍在但 MCP 已死”的僵尸连接；
- batch、page plan、worker lease 和任务状态持久化，可跨 turn 恢复；
- 页面提交使用幂等键、revision 和目标文件 hash。

如果 Claude 仍显示断开，先检查 `.llm-wiki/logs/mcp-daemon.log` 中的
`worker-exit`、`worker-retry` 和新 `worker-start`，再检查
`.llm-wiki/logs/mcp-runtime.jsonl` 中的 `transport-error`、`protocol-error`、
`uncaught-exception`、`unhandled-rejection` 和 `keepalive`。`keepalive.status=failed`
只是当次 pong 超时，不会单独关闭连接。默认 HTTP keep-alive 为 10 秒，
协议 ping 为 1 分钟。

### 5.1 长连接诊断 Runbook

服务启动后的 `ready` 日志会记录 `keepaliveMs`、`keepaliveTimeoutMs` 和 `maxBufferBytes`，可以先确认 Claude 实际启动的是哪一个构建产物。当前默认值和允许范围如下：

| 配置 | 默认值 | 允许范围 | 用途 |
| --- | ---: | ---: | --- |
| `LLM_WIKI_MCP_HTTP_PORT` | `31982` | `1024`–`65535` | 当前设备的 loopback 端口；需在启动 Claude 前设置 |
| `LLM_WIKI_MCP_HTTP_KEEPALIVE_MS` | `10000` ms | `1000`–`60000` ms | HTTP/SSE keep-alive frame 间隔 |
| `LLM_WIKI_MCP_KEEPALIVE_MS` | `60000` ms | `1000`–`1800000` ms | 两次协议 ping 的间隔 |
| `LLM_WIKI_MCP_KEEPALIVE_TIMEOUT_MS` | HTTP `15000` ms，STDIO `30000` ms | `250`–`60000` ms | 单次 ping 等待 pong 的预算 |
| `LLM_WIKI_MCP_MAX_RETRIES` | `3` | `0`–`5` | 可重试瞬时工具错误的最大重试次数 |
| `LLM_WIKI_MCP_RETRY_BASE_MS` | `250` ms | `50`–`5000` ms | 工具重试的基础退避 |

定位断开时按以下顺序判断：

1. `tool-call` 后仍能看到 `keepalive.status=ok`：MCP 会话仍然存活，问题更可能在宿主 Agent 的 worker 生命周期或跨 turn 调度，不需要重启 MCP。
2. 出现 `keepalive.status=failed` 但之后仍能调用工具：这是一次宿主 pong 延迟或丢失，只记录诊断，不会触发断开；继续观察下一次心跳。
3. 出现 `uncaught-exception`：HTTP worker 会退出，supervisor 写入 `worker-retry` 后拉起新 PID；Claude 在 `/mcp` 中短暂显示 pending 后自动重连。
4. 只出现 `unhandled-rejection`：运行时进入 degraded 但不主动断开；先继续调用 `llm_wiki_status`。

升级代码后必须重新生成实际运行的 `dist`：

```bash
npm run build
npm test
```

然后完全重启 Claude。`SessionStart` hook 会运行
`packages/mcp-server/dist/ensure-daemon.js`，`dist/` 不提交到 Git；只执行
`git pull` 不会生成新 dist。重新 build 后，hook 会比对 `/health` 和
`dist/build-info.json`，自动替换旧 daemon。如果默认端口被占用，在当前设备启动 Claude 前设置
`LLM_WIKI_MCP_HTTP_PORT`；`.mcp.json` 和 hook 会使用同一变量。

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

项目根目录 `.mcp.json` 注册 MCP Server，`.claude/settings.json` 允许主 Agent、extractor、drafter 和 writer 使用 Skill 及 17 个 MCP 工具。

首次配置后：

```bash
npm install
npm run build
```

在 Claude 中确认项目 MCP 为 Connected，然后提出类似请求：

```text
把这些文档构建成知识库。使用 ./domain-schema/ 作为领域 Schema，完成抽取、Wiki 页面、索引和最终总结。
```

常用恢复方式：

1. 先调用 `llm_wiki_status`；
2. 按返回的 `next_action` 继续；
3. worker 消失时使用原 worker_id 重新启动；
4. 主协调器先取 manifest，并把每个 draft-shard action 交给一个 page drafter；
   Writer 只接收已暂存的 `{shard_id, draft_hash}` receipt。若 drafter 创建明确失败，才显式让 Writer
   以 `explicit-serial-writer-fallback-only` 模式读取一个 shard；
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
