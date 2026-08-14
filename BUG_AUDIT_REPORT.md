# llm_wiki 1.0.8 全量 Bug 审计与修复闭环报告

> 审计日期：2026-08-14
>
> 审计基线：`main` / `cd0531a`；修复分支：`codex/fix-1.0.8`
>
> 版本：1.0.8
>
> 状态：二次审计通过（Release Ready）
>
> 后续方案：[BUG_FIX_PLAN.md](BUG_FIX_PLAN.md)

## 1. 执行摘要

本轮审计覆盖 Skill 提示词、新旧流程边界、多 Agent 协作、租约、解析和 Chunk、构建中召回、构建完成后召回、Embedding/BM25、投影、Finalize、generation 发布、OCR/PPTX 新改造及恢复协议。

首轮审计共记录 35 项必须修复的问题；1.0.8 已完成生产代码、测试、
Skill/Agent 合约和文档同步修复。二次审计结论为 35/35 闭环，无未解决的
P0/P1 发布阻断项。下文 Bug 章节保留修复前根因和影响，用于追溯。

| 级别 | 数量 | 定义 |
|---|---:|---|
| P0 | 3 | 可造成静默数据丢失或 Finalize 发布未物化的必要知识 |
| P1 | 19 | 可造成明确漏召回、未发布数据暴露、任务阻断、资源失控或新流程无法在目标宿主执行 |
| P2 | 12 | 规模、性能、恢复、索引一致性、可观测性或内容完整性问题 |
| P3 | 1 | 版本和诊断元数据错误 |

其中 `AUD-001`、`AUD-002`、`AUD-003`、`AUD-004` 和 `AUD-014` 由隔离最小复现确认；
构建期快速召回另增加了“第二个文件仍在导入时，第一个 source 已可通过 BM25
命中”和“超过 10,000 Chunk 的尾部词法目标仍可召回”回归测试。

## 2. 1.0.8 二次审计闭环矩阵

| Bug | 状态 | 1.0.8 修复证据 |
|---|---|---|
| AUD-001 | 已修复 | 截断页默认 `merge`，section 更新保留未读正文 |
| AUD-002 | 已修复 | claim/relation/contradiction/review/unresolved 均生成独立 requirement |
| AUD-003 | 已修复 | Finalize 每次重算 coverage，不再用 `finalCompleted` 跳过审计 |
| AUD-004 | 已修复 | 移除 1,000/2,000 候选上限，真实 Embedding 尾部召回通过 |
| AUD-005 | 已修复 | 移除 10,000 语料裁剪，>10K 尾部 Chunk 回归通过 |
| AUD-006 | 已修复 | Domain Query 与公开召回统一读 active generation |
| AUD-007 | 已修复 | 页面/索引/lint/manifest 在 staging generation 完成后原子切 pointer |
| AUD-008 | 已修复 | host capability 返回 total/coordinator/background 容量并按可用槽位计算 |
| AUD-009 | 已修复 | 新增 `.agents/agents` 通用 Extractor/Drafter/Writer 角色合约 |
| AUD-010 | 已修复 | 新增有界 `llm_wiki_renew_lease`，覆盖 extraction/projection |
| AUD-011 | 已修复 | extraction commit/renew 强制校验 opaque token + epoch |
| AUD-012 | 已修复 | 并行协议要求显式 worker/writer ID，不共享默认身份 |
| AUD-013 | 已修复 | Skill/MCP/Agent 仅保留 manifest→draft-shard→receipt→Writer→Finalize |
| AUD-014 | 已修复 | 无标题页使用 relative basename 安全回退 |
| AUD-015 | 已修复 | section-aware Chunk 加 12% overlap、parent 信息与 content-hash 去重 |
| AUD-016 | 已修复 | schema 3 持久 BM25 postings/TF/DF 被查询路径实际消费 |
| AUD-017 | 已修复 | generation-scoped JSON metadata + contiguous float32 向量产物及 hash 校验 |
| AUD-018 | 已修复 | per-path cap 提高并按 section/content hash 去重，不再固定 2 条 |
| AUD-019 | 已修复 | provisional owner/task 状态损坏时 fail-closed |
| AUD-020 | 已修复 | 单次 import 共享 OCR session/worker，不按文件重建 |
| AUD-021 | 已修复 | PDF 页数/OCR/时间/文本/像素预算与 AbortSignal 向下传递 |
| AUD-022 | 已修复 | PNG/JPEG/WebP/BMP/TIFF 解码前头部尺寸校验与多帧拒绝 |
| AUD-023 | 已修复 | 英文/简中语言包入依赖，无注入真实 OCR Worker 测试通过 |
| AUD-024 | 已修复 | PPTX 按 presentation relationship 权威顺序解析并保留 slide locator |
| AUD-025 | 已修复 | Chart/SmartArt/embedded workbook 抽取，不支持对象进 review metadata |
| AUD-026 | 已修复 | 过期 projection plan/draft 移入 orphan quarantine，projection ID 作围栏 |
| AUD-027 | 已修复 | busy 结果返回精确原操作重试 action |
| AUD-028 | 已修复 | Root/Core/MCP/CLI/lock/protocol 版本统一为 1.0.8 |
| AUD-029 | 已修复 | Finalize created/updated 由完整 generation diff 派生 |
| AUD-030 | 已修复 | progressive import 立即返回 task，每 source 原子更新任务索引 |
| AUD-031 | 已修复 | requested/active/effective/fallback 通道分开，feature_hash 不冒充 Embedding |
| AUD-032 | 已修复 | 在线仅请求 query vector，文档向量后台预热 |
| AUD-033 | 已修复 | 构建期 task source/analysis 优先，stable Wiki 不挤占新 source 配额 |
| AUD-034 | 已修复 | importing/source-ready/degraded/knowledge-base-complete 由耐久就绪度派生 |
| AUD-035 | 已修复 | import/status/retrieve 共享逐 source/逐 channel readiness 合约 |

## 3. 审计方法与证据

### 2.1 执行的验证

- Core：72/72 通过。
- MCP：23/23 通过。其中两项回环网络用例在沙箱中因 `EPERM` 失败，允许本机回环后通过。
- CLI：3/3 通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- Core/MCP/CLI 的 `npm pack --dry-run` 全部通过，新 OCR/PPTX 源文件与 MCP dist 已进入打包清单。
- 完成长页面、空最终投影、无标题页面和 Embedding 上限四组隔离复现。
- 真实 OCR Worker 在无注入模式下识别测试图片成功，且语言包已进生产依赖。

### 2.2 证据等级

- **CONFIRMED**：已有可重复最小复现、现有测试失败或确定的运行时证据。
- **STATIC-CERTAIN**：控制流和数据流直接证明了结果，但本轮没有再做故障注入。
- **STRESS-RISK**：需要超大输入、长时运行、多协调器或进程级故障才会触发，必须在修复时加压力/故障注入测试。

## 4. 修复前召回和发布模型

修复前默认路由如下：

```text
构建中：BM25 + Embedding -> RRF
完成后：BM25 + Embedding + Wiki title/path/link graph -> RRF
```

路由标签本身正确，但修复前不等于全量可召回：总语料、Embedding 候选和实际向量化存在静默上限，最终生成的 BM25/vector 文件也没有被查询路径消费。

修复前 `retrieve_context` 通过 `current-generation.json` 读取已发布 Wiki，但 `queryDomainPages` 直接读工作树 Wiki，导致两条读路径对“已发布”定义不一致。

### 3.1 构建期“上传后快速可召回”专项结论

设计方向正确，但当前实现只满足“`import_files` 完整返回后，所有 source chunk 可参与 BM25/Embedding 路由”，不满足“文件上传后很快可召回”。实际时间线是：

```text
T0 调用 import_files
  -> 持有 workspace 写锁
  -> 所有文件串行复制、解析/OCR、切 Chunk、写 artifact
T1 全部可导入文件处理结束
  -> 此时才 createTask 并返回 task_id
  -> source chunk 才能被 retrieve_context 搜索
T2 Analysis 逐批提交
  -> 已完成 analysis 渐进加入召回语料
T3 task.status=completed
  -> 默认标签从 BM25+Embedding 切到 BM25+Embedding+Wiki
```

因此，纯文本小文件在 `import_files` 返回后确实能立即检索；但扫描 PDF、大 PPTX、多文件批量导入期间没有 task ID、没有增量可见 chunk，也没有可查询索引。构建期可用性还存在四个放大问题：默认 `embedding.provider=none`、feature-hash 被伪装成 Embedding、真实 Embedding 首查现场补算文档向量、旧 Wiki/analysis 可挤占新上传 source 的候选预算。

现有垂直切片测试只在 `importFiles` 完成且 `analyzeAll` 之后断言 `retrieval_phase=building` 和两路标签；它没有验证 Analysis 前命中 source，更没有把后续文件/parser 阻塞住后验证首个 chunk 已可搜。格式测试则只断言 `corpus.truncated=true` 和 feature-hash fallback，等于确认降级存在，并未证明快速召回或召回完整性。

目标协议应改为：先持久登记 source/task 并立即返回 task ID；每个可验证 chunk 落盘后原子加入 task-local BM25；Embedding 后台异步追赶；查询绝不等待批量补向量，而是在响应中精确声明每个 source/channel 的可用覆盖率。Wiki 构建完成后，再以 generation manifest 原子发布全量 BM25、Embedding、Wiki/graph 多路索引。

## 5. 修复前 Bug 根因清单

### AUD-001：长页面只提供头尾节选，却使用权威 `replace`

- **级别/证据**：P0 / CONFIRMED。
- **位置**：`packages/core/src/core.js:4419`、`4825-4852`。
- **复现**：41,485 字符现有页面仅向 Drafter 返回 24,065 字符，`content_truncated=true`，中间标记不可见，但 scaffold 仍为 `operation=replace`。
- **根因**：上下文预算与页面写入语义分离；Core 知道全文被截断，但没有限制权威替换。
- **影响**：增量或最终投影可静默删除页面中间的已根据事实。
- **必修**：截断上下文不得生成 Agent 权威 `replace`；改用服务端 section patch/三方合并，或为当前目标提供完整可分页原文。

### AUD-002：矛盾、复核项和独立 Claim 不会生成强制页面需求

- **级别/证据**：P0 / CONFIRMED。
- **位置**：`packages/core/src/core.js:4320-4397`。
- **复现**：仅包含 `contradictions` 和 `reviewItems` 的已根据 Analysis 产生 0 requirement、0 shard，内容未出现在 Wiki。
- **根因**：`derivePageRequirements` 仅处理 entities、concepts 和 candidatePages。
- **影响**：关键冲突、风险和待复核信息可在最终知识库中完全消失。
- **必修**：建立全语义类型 Requirement/Coverage Ledger，每个必要项要么被页面物化，要么被显式解决并保留可验证决议。

### AUD-003：空最终投影可设置 `finalCompleted` 并绕过 Finalize 审计

- **级别/证据**：P0 / CONFIRMED。
- **位置**：`packages/core/src/core.js:2884-2916`及 projection completion 路径。
- **复现**：第一次 Finalize 返回 `FINAL_PROJECTION_REQUIRED`；最终 manifest 仍为 0 shard；提交空 `projection_complete=true` 后 `finalCompleted=true`，第二次 Finalize 成功，但 review/矛盾文本未物化。
- **根因**：Finalize 仅在 `!finalCompleted || lease || provisionalPaths` 时运行 fast audit；“已走过投影流程”被误当成“语义覆盖已完成”。
- **影响**：Finalize 可发布明知不完整的知识库。
- **必修**：Finalize 每次发布前都必须验证完整 Coverage Ledger；`finalCompleted` 只能是审计结果，不能是跳过审计的条件。

### AUD-004：Embedding 候选 2,000/默认向量 1,000 上限导致确定性漏召回

- **级别/证据**：P1 / CONFIRMED。
- **位置**：`packages/core/src/retrieval.js:317-329`，`packages/core/src/embedding.js:36-87`。
- **复现**：1,101 文档语料中，伪 Embedding 服务确认 query 与第 1,051 个文档语义等价；该文档在默认上限外时无法召回，移到第 51 个时立即命中。
- **根因**：用 BM25/Wiki 前置粗筛代替全量语义索引，而无词法重叠的目标无法进入候选。
- **影响**：语义改写、同义词和跨语言查询可静默漏结果；构建期未传 `batch_id` 的普通问答尤其可能让新上传 chunk 落在候选上限之外。
- **必修**：构建时索引全量可召回文档，查询走持久向量索引/ANN；任何部分索引必须 fail-closed 或执行全量二次扫描。

### AUD-005：召回语料硬上限 10,000 且无可继续分片

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/retrieval.js:11`、`109-174`。
- **根因**：`fairTake` 在单次内存语料构造中直接裁剪。
- **影响**：超过上限的后续 Wiki/analysis/source chunk 永久不参与该次查询；`corpus.truncated` 仅是提示，不是召回保障，也不能保证刚上传的 source 获得优先配额。
- **必修**：改为全量持久索引和分片查询；不能达到全量索引时明确阻断“知识库已可完整查询”状态。

### AUD-006：`queryDomainPages` 绕过 generation 与 provisional 隔离

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/core.js:726-759`。
- **根因**：search 和 inspect 都从 `workspace.paths.wiki` 读当前工作树，而非 active generation，且没有跨任务 provisional 排除。
- **影响**：未 Finalize 的领域页可被提前查询；与 `retrieve_context` 看到的发布版本不一致。
- **必修**：所有用户可见读路径共用 `activeGenerationRoot`；构建期需读工作树时必须显式传 task ID 并应用一致的 provisional 过滤。

### AUD-007：Finalize 在 lint/pointer gate 前改写工作 Wiki 和兼容索引

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/core.js:2931-3010`。
- **根因**：Finalize 先写 source/index/overview/log、构建 generation，再写 V1.0.1 固定路径索引，最后才根据 lint 决定是否发布 pointer。
- **影响**：官方 generation pointer 仍可指向旧版，但工作树、Domain Query 和旧 reader 已看到失败版，形成双重真相。
- **必修**：在独立 generation staging 目录完成页面、索引、lint 和 manifest，全部通过后仅原子更新 pointer；移除当前路径的兼容写入。

### AUD-008：Skill/Server 的后台 Agent 容量模型与 Codex 宿主不兼容

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`.agents/skills/llm-wiki-builder/SKILL.md:149-175`、`563-564`；`packages/core/src/core.js:430-490`。
- **根因**：Skill 要求精确启动 `recommended_workers`，并计划 2 Extractor + 2 Drafter；当前 Codex 最多 4 个总并发槽，其中包含主协调器。
- **影响**：服务端推荐 4 个工作 Agent 时无法完整启动；部分 spawn 成功后的 fallback 语义不清晰，可触发重复工作。
- **必修**：引入 host capability handshake，返回 `max_total_agents`、`coordinator_slots`、`max_background_agents`；计算 `effective_workers=min(recommended, available)`，并定义部分启动失败时的确定恢复规则。

### AUD-009：当前仓库没有 Codex 可用的命名项目 Agent 定义

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`.claude/agents/*`、`.cac/agents/*`；无 `.agents/agents/*` 或可由当前 Codex 调用的对等定义。
- **根因**：Skill 把 Claude/CAC 的 `subagent_type` 机制当成通用宿主协议。
- **影响**：`llm-wiki-extractor`、`page-drafter`、`writer` 在 Codex 中不能被字面启动，Skill 指令不可执行。
- **必修**：将角色合约与宿主 spawn API 解耦；为支持的宿主提供实际可调用的角色配置，其他宿主使用带签名 role contract 的通用 Agent，不再硬编码 Claude 参数。

### AUD-010：Extraction/Projection 租约没有心跳或显式续租

- **级别/证据**：P1 / STRESS-RISK。
- **位置**：`packages/core/src/core.js:78-79`及 lease 校验路径。
- **根因**：分析租约固定 30 分钟、投影租约固定 60 分钟，只在调用边界延长，模型思考/生成期间无心跳。
- **影响**：长文档或慢宿主上，原 Agent 仍在工作时租约可过期，其他 Agent 重复处理。提交校验通常阻止覆盖，但会浪费成本并引入非确定性。
- **必修**：实现带 fencing token 的 bounded renewal API，只允许当前 owner/epoch 在最长任务时间内续租。

### AUD-011：相同 `worker_id` 缺少 coordinator epoch/fencing

- **级别/证据**：P1 / STRESS-RISK。
- **位置**：`packages/core/src/core.js:519-568`、`812-824`。
- **根因**：身份只有稳定 worker ID，无协调器会话或 lease generation。
- **影响**：两个协调器误用相同 ID 时可同时读取同一批次并做重复语义工作；首次提交通常获胜，但没有严格的旧持有者隔离。
- **必修**：租约返回不透明 `lease_token`/`epoch`，commit 和 renew 必须携带；旧 token 在重新授权后永久失效。

### AUD-012：`worker_id`/`writer_id` 在 Core 中可缺省为共享默认值

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：`packages/core/src/core.js:3431-3437`及 tool schema。
- **根因**：新流程要求稳定显式 ID，Core 却仍保留 `worker-default`。
- **影响**：客户端漏传 ID 时多 Agent 会意外共享同一租约身份。
- **必修**：当 `parallel_extraction.required` 或投影新流程启用时将 ID 改为必填；迁移客户端只能经显式的版本化桥接进入。

### AUD-013：当前 Skill、MCP 和存储仍混合旧流程

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：Skill 中 old server/legacy SourceRef/locator/投影分支；`llm_wiki_apply_projection`；`view=plan`；裸 `staged_draft_shard_ids`；`vector/graph` alias；V1.0.1 固定路径索引；CLI `migrate-legacy`。
- **根因**：迁移逻辑没有与当前运行时协议隔离。
- **影响**：728 行核心 Skill 同时教导新旧分支，Agent 容易选错路径；服务端存在多个等价入口和双重索引真相。
- **必修**：当前 Skill/MCP 仅保留一条 manifest → draft-shard → staged receipt → single writer → audited Finalize 流程；迁移放入独立一次性工具和版本化文档，不参与新任务提示词。

### AUD-014：无标题 Wiki 页使 Page Plan 抛 `ReferenceError`

- **级别/证据**：P1 / CONFIRMED。
- **位置**：`packages/core/src/core.js:973-976`。
- **复现**：Wiki 中存在无 frontmatter title 且无 H1 的 Markdown 时，`getPagePlanContext` 抛 `ReferenceError: file is not defined`。
- **根因**：循环只解构 `{content, relative, parsed}`，回退标题却引用不在作用域的 `file`。
- **影响**：一个手工或损坏页面可阻断整个任务投影。
- **必修**：使用 `path.posix.basename(relative, ".md")` 或在 snapshot 中保留 file，并增加无标题/损坏 frontmatter 测试。

### AUD-015：Source/Analysis/Wiki 分块无 overlap，跨边界事实可漏召回

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/parser.js:544-578`，`packages/core/src/retrieval.js:9-10`及 `splitSections`。
- **根因**：每个 cut 从下一位置继续，没有句子窗口或 parent-child 回溯。
- **影响**：关系两端、否定词与结论、表头与跨页行可分居两个 chunk，BM25 无法共现，Embedding 也不能看到完整语义；构建期尚无 Wiki 聚合页补偿时影响更明显。
- **必修**：句子/表行感知切分 + 10%–15% overlap，保留 parent ID 和精确 evidence offset，召回时按 parent/引用去重。

### AUD-016：`bm25.json` 不是可查询 BM25 索引

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：`packages/core/src/retrieval.js:28-30`、`506-515`。
- **根因**：生成物只存 id/path/title/hash/token length，没有 term dictionary/postings/TF/DF；查询每次重新 tokenize 整个内存语料。
- **影响**：Finalize 产物与运行时行为名不副实，大知识库查询成本随语料线性增长；构建期也没有“chunk 一落盘即可查询”的增量倒排索引。
- **必修**：生成分词版本化的倒排索引并让查询实际读取；增量构建期对 source/analysis 使用同一索引格式。

### AUD-017：`vector.json` 和真实 Embedding 缓存没有可查询向量存储协议

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：`packages/core/src/retrieval.js:517-553`，`packages/core/src/embedding.js`。
- **根因**：`vector.json` 是 256 维 feature-hash fallback 且查询不读取；真实向量以 content hash 零散 JSON 存储，没有 doc ID manifest、tombstone、generation 或 ANN。
- **影响**：向量文件数量高、GC 和 generation 一致性难以证明，无法规模化近邻检索；Finalize 完成后也没有真正切换到持久多路向量查询。
- **必修**：建立 generation-scoped vector manifest + 紧凑向量文件/SQLite-HNSW 等本地存储，使用 doc ID/hash 校验并实际参与查询。

### AUD-018：每条 Wiki path 最多返回两个 section

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：`packages/core/src/retrieval.js:69-91`。
- **根因**：固定 `pathCount >= 2` 过滤，不考虑查询是否命中多个独立 section。
- **影响**：长页面第三个相关 section 可被抑制。
- **必修**：改为 MMR/相似度去重和可配置 per-path cap；若多个 section 提供不同证据，允许全部进入限额。

### AUD-019：跨任务 provisional 状态读取失败时 fail-open

- **级别/证据**：P2 / STRESS-RISK。
- **位置**：`packages/core/src/retrieval.js:178-199`。
- **根因**：某个 task record 损坏/替换时 catch 错误并把其页面当成普通稳定页排名。
- **影响**：与发布隔离目标相反；在 active generation 回退到工作树或特殊读路径上可暴露未发布页。
- **必修**：默认只读 active generation；必须读工作树时，任何 owner 状态不可验证都应 fail-closed 或排除受影响路径。

### AUD-020：多文件导入为每个文件重新创建 OCR Worker

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/source-store.js:20-40`，`packages/core/src/parser.js:31-40`、`92-94`。
- **根因**：`importSources` 串行调用 `importOne`，未共享 parser 已支持的 `ocrSession`。
- **影响**：批量图片/扫描 PDF 会重复准备语言包、创建和终止 Tesseract Worker，导入耗时和内存峰值明显增加。
- **必修**：每个 import operation 创建一个受控 OCR session pool，传递给所有 parser，在整个操作结束时统一释放。

### AUD-021：PDF OCR 没有页数、总耗时、总像素或取消预算

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/parser.js:250-285`及 Core import cancellation 路径。
- **根因**：对 `document.numPages` 全量循环，每个低文本页都可 OCR；AbortSignal 未传入 parser/OCR 循环。
- **影响**：大扫描 PDF 可占用工作区写锁很长时间，宿主取消后后台工作仍继续。
- **必修**：引入 max pages/max OCR pages/max rendered pixels/max OCR chars/wall-clock budget，每页和每次 recognize 前检查 AbortSignal。

### AUD-022：PDF 像素上限计算失效，独立图片无解压后尺寸防护

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/parser.js:307-316`、image OCR 路径。
- **根因**：`Math.max(1, calculatedScale)` 阻止超大 PDF 页缩小到 scale < 1；图片只有文件字节上限，没有 width/height/pixel/frame 上限。
- **影响**：巨型页面或解压炸弹图片可触发过量内存分配或进程崩溃。
- **必修**：允许 scale < 1 并在 canvas 创建前硬校验实际像素；对图片先读 metadata，限制维度、总像素、帧数和解码后字节。

### AUD-023：现有 OCR 测试未运行真实 Worker，当前安装无法完成真实 OCR

- **级别/证据**：P1 / CONFIRMED（当前工作树）。
- **位置**：`packages/core/test/formats.test.js`、`packages/core/src/ocr.js`、`packages/core/package.json`。
- **证据**：格式测试注入 `ocrRecognize` 假函数；真实 smoke 因当前 `node_modules` 缺失 `@tesseract.js-data/eng`/`chi_sim` 失败。package.json/lock 已声明依赖，因此也是安装/发布门禁缺口。
- **影响**：CI 可全绿但实际图片导入在用户机器上首次启动即失败。
- **必修**：fresh `npm ci` 后运行一张中英文 fixture 的真实 OCR，验证离线语言包解析和打包产物。

### AUD-024：PPTX 按 `slideN.xml` 文件名而非权威关系顺序解析

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：`packages/core/src/pptx.js:14-32`。
- **根因**：仅枚举 `ppt/slides/slide\d+.xml` 并按数字排序，未读 `presentation.xml` 与 rels 的 slide ID 顺序。
- **影响**：重排、复制或从其他文稿合并的演示文稿可产生错误页序和错误 `locator.slide`。
- **必修**：按 `p:sldIdLst` 顺序解析 relationship target，用展示顺序作为 locator，保留内部 part 名作诊断元数据。

### AUD-025：PPTX 常见 Chart/SmartArt/内嵌工作簿内容不可召回

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：`packages/core/src/pptx.js`的 slide XML/text/table/image 路径。
- **根因**：仅提取原生段落、表格和关联图片 OCR，未遍历 chart data、diagram data 和 embedded workbook。
- **影响**：数值型汇报的关键事实可被完全遗漏，却不一定有显式 review warning。
- **必修**：提取受支持的 chart/SmartArt/workbook 数据；无法安全提取的 object 必须生成可见 review item，不得静默跳过。

### AUD-026：投影租约过期只清内存状态，旧 plan/draft 文件可残留

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：`packages/core/src/core.js:3561-3566`及 page-plan/page-drafts 清理路径。
- **根因**：`pageProjectionStatus` 把过期 lease 设为 null，但不实时清理该 projection 的 plan 和 staged draft artifacts。
- **影响**：长期中断/重试会累积磁盘垃圾并增加恢复诊断混淆。
- **必修**：过期时原子地将 artifact 移入带 retention 的 orphan/quarantine，新 projection 不得读取旧 projection ID 的任何文件。

### AUD-027：`MCP_BUSY/TASK_BUSY` 的最终恢复动作与 Skill “重试原操作”不一致

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：MCP router busy 处理、Skill backpressure 段落。
- **根因**：路由器内部有限次重试原操作，耗尽后的 `next_action` 却可转向 status/list_tasks，丢失原请求标识。
- **影响**：Agent 可在背压后停留于状态轮询，而不是使用相同幂等键重试原操作。
- **必修**：busy 结果返回有界的 `retry_action`/opaque request token，与 Skill 统一为等待 `retry_after_ms` 后重试精确原操作。

### AUD-028：MCP 协议服务版本仍为 `1.0.6-1`

- **级别/证据**：P3 / STATIC-CERTAIN。
- **位置**：`packages/mcp-server/src/protocol-server.js:28`。
- **影响**：诊断、宿主缓存和问题报告会把 1.0.7 服务识别为旧版。
- **必修**：从 package metadata/build-info 单一来源生成协议版本，增加一致性测试。

### AUD-029：Finalize 结果的 created/updated pages 不包含确定性生成页

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：Finalize result 构建与 `#writeSourcePages`/index/overview/log 路径。
- **根因**：结果计数主要基于 task page transaction records，Core 直接生成或更新的 source/index/overview/log 没有统一记录。
- **影响**：用户报告、发布审计和增量变更清单不完整。
- **必修**：generation manifest 对所有页面记录 origin、old/new hash 和 disposition，Finalize result 由 manifest diff 统一生成。

### AUD-030：完整导入结束后才创建 task，上传期间无法提前召回

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/core.js:377-432`，`packages/core/src/source-store.js:20-40`。
- **根因**：`importFiles` 持有 workspace 写锁并同步等待 `importSources`；所有文件串行完成复制、解析/OCR、Chunk 和 artifact 写入后才调用 `createTask`。
- **影响**：慢 PDF/OCR/PPTX 或批量文件处理期间没有 task ID 和 task-local 召回视图；“上传后很快可用”实际退化为“全部解析完才可用”。
- **必修**：拆成 source 注册、task 创建、渐进解析/索引三阶段；先返回可恢复 task ID，每个完整校验的 chunk 批次以原子小 generation 发布给 task-local 检索，剩余文件继续后台构建。

### AUD-031：feature-hash 降级被宣称为真实 Embedding 路由

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/workspace.js:122-147`，`packages/core/src/retrieval.js:39-59`、`93-104`。
- **根因**：默认 `embedding.provider=none`；Embedding 不可用时生成字符/token feature-hash 排名，但仍写入 `rankings.embedding`，因此 `available_channels` 继续返回 Embedding。
- **影响**：默认所谓“两路召回”其实是两个高度相关的词法/字符特征路由，不具备语义改写保障；RRF 还会把相关性很强的两路当成独立证据重复加权。
- **必修**：区分 requested/active/effective channel；真实模型不可用时返回独立 `feature_hash` degraded channel，不得标为 Embedding。若产品承诺始终两路，必须随包提供可工作的本地 Embedding 或在初始化时强制完成 provider 配置。

### AUD-032：真实 Embedding 在首次查询现场补算，快速召回可阻塞数分钟

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/retrieval.js:39-42`，`packages/core/src/embedding.js:12-13`、`61-100`。
- **根因**：source/analysis 没有导入期主动向量构建；首次查询对缓存缺失候选发起批量外部 Embedding，请求默认总预算 600,000ms。
- **影响**：启用真实模型后，用户第一次问答可能等待最多 1,000 个文档的向量化；完成后的 source/analysis 也可能继续发生相同首查成本。
- **必修**：chunk 可见后后台增量 Embedding；查询只读取已发布向量快照并受严格在线延迟预算约束，绝不在请求路径批量补文档向量。Embedding 未追平时立即用 BM25 返回并显式报告覆盖率。

### AUD-033：构建期语料混合使旧 Wiki 挤占新上传 source 的候选预算

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/retrieval.js:32-40`、`109-174`、`317-329`。
- **根因**：普通问答没有 `currentBatchId` 时，语料以 `wiki/analyses/sources` 公平轮转；请求 Embedding 还会无条件计算 Wiki ranking，并把 Wiki top-250 加入仅 2,000 个候选。
- **影响**：构建期本应优先服务的新上传 source 可能被旧 stable Wiki、历史 analysis 和语料上限挤掉，导致“文件已导入但问不到”。
- **必修**：建立阶段化检索域和配额：构建期先查 task-local source/analysis，source freshness 有保底；上一代 stable Wiki 作为显式 `stable_wiki` 辅助通道，单独打分、单独配额，不得暗中占用 source Embedding 预算。

### AUD-034：召回阶段只看 `task.status`，不看真实索引/发布就绪状态

- **级别/证据**：P1 / STATIC-CERTAIN。
- **位置**：`packages/core/src/retrieval.js:14-19`、`95-104`。
- **根因**：`status === completed` 是两路/多路切换的唯一条件，没有读取 source 解析进度、BM25/向量 manifest 完整性或 active generation pointer。
- **影响**：崩溃恢复、部分索引、Finalize/pointer 窗口中，响应可能宣称错误阶段或错误可用通道；也无法表达“部分 source 已可用、其余仍导入”。
- **必修**：阶段由耐久 retrieval manifest 和 publication pointer 派生，至少区分 `importing`、`source-ready`、`analyzing`、`wiki-staging`、`published`；通道选择只依据实际 ready/complete 状态。

### AUD-035：缺少逐 source/逐通道召回就绪度契约

- **级别/证据**：P2 / STATIC-CERTAIN。
- **位置**：`packages/core/src/retrieval.js:93-106`及 import/status 响应。
- **根因**：响应只有粗粒度 phase、channel status 和 corpus truncation，没有 accepted/parsed/indexed/failed source 数、BM25/Embedding 覆盖率及本次答案的语料范围。
- **影响**：用户和 Agent 无法判断刚上传的哪个文件已经可搜，也无法区分“没答案”和“目标文件尚未完成索引”。
- **必修**：返回 task/source/channel readiness：`accepted/parsed/bm25_indexed/embedding_indexed/failed`、`indexed/total/complete/degraded`、`answer_scope` 和 manifest generation；状态变化必须可轮询且崩溃恢复后一致。

## 5. 已验证为健康的部分

以下能力没有在本轮发现覆盖或丢失型 bug，修复时必须保持：

- 不同显式 worker ID 在有效租约期间不会获取同一 batch。
- 同一 worker ID 可在断线后续取持久租约的批次。
- Analysis commit 和 Page commit 有任务锁、证据校验、hash 约束和幂等记录。
- 并行 Drafter 的 staged receipt 是 hash-bound，只有单 Writer 执行持久页面提交。
- path-disjoint shard、分波提交、cursor replay、staged receipt 恢复的现有测试通过。
- `retrieve_context` 已根据 task status 选择构建中两路与完成后三路的默认标签；该机制可保留为兼容显示，但必须由 AUD-031/AUD-034 的真实通道就绪状态取代其决策权。
- generation pointer 的正常发布和两个已有崩溃恢复用例通过。
- 长块 offset 精确分片、Unicode locator、oversized batch repair 的新测试通过。
- PPTX 有 ZIP entry、声明展开字节、XML、slide 数、OCR image 数和 image 字节上限，且不跟随外部链接/不执行宏。
- 当前 production dependency audit 为 0 个 high/critical。

## 6. 旧版审计处置

本文已取代原 V1.0.1 审计。旧报告中已修复的 MCP 输出 OOM、display name parser spoof、长块 locator、generation 基础发布等问题不再继续作为当前待修项。所有当前待修项均以 `AUD-001`–`AUD-035` 为唯一编号。

## 8. 发布决策

二次审计已确认以下发布条件：

1. `AUD-001`–`AUD-035` 全部达到 [BUG_FIX_PLAN.md](BUG_FIX_PLAN.md) 的完成标准，无“暂缓”或“接受风险”项。
2. 长页面、全语义 Coverage Ledger、空最终投影和召回上限的先失败测试在旧实现失败、新实现通过。
3. 上传期间首个完整 chunk 可在全文件导入结束前通过 BM25 命中；超过 10,000 文档的 lexical-only、semantic-only、cross-boundary 和跨语言召回测试不得静默漏目标。
4. 构建期和完成后所有用户可见读路径仅看到允许的 generation/task scope。
5. Codex、Claude/CAC 各至少完成一次真实多 Agent 容量、租约续租、Agent 丢失恢复和单 Writer 压力测试。
6. fresh install 后真实中英 OCR、扫描 PDF、重排 PPTX、chart/SmartArt fixture 的集成测试通过。
7. Core/MCP/CLI 全套测试为 72/72、23/23、3/3，构建、Skill 官方校验与 `git diff --check` 通过。

结论：代码与协议层面可发布 1.0.8。跨操作系统 CI 和远端注册表发布属后续发行
环境任务，不影响本次 Git 分支与标签发布。
