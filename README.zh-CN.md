# llm_wiki 中文使用说明

[English README](README.md)

`llm_wiki` 是一个无桌面端、Agent-first 的本地知识库引擎。Claude Code、
Codex 或 OpenCode 使用当前会话模型理解文档；不调用模型的 Core 负责
原文归档、去重、任务恢复、引用校验、安全写入和检索索引。

用户无需启动桌面应用、HTTP 服务或配置额外的模型 API Key。

## 可以生成什么

完成构建后，可在当前工作区中得到：

```text
wiki/
├── index.md                 # 总索引
├── overview.md              # 知识库概览
├── log.md                   # 构建和更新记录
├── sources/                 # 来源页面
├── entities/                # 人物、组织、产品、系统等实体
├── concepts/                # 术语、定义、方法和业务概念
├── topics/                  # 跨来源的综合主题
├── comparisons/             # 方案、版本和观点对比
├── queries/                 # 待研究问题
├── synthesis/               # 跨来源综述与结论
└── ...                      # finding、methodology、project、chapter 等丰富页型
```

Core 会同时创建 `.llm-wiki/` 运行状态目录，保存受管理的原文、任务、
索引、锁和事务日志。

页面规划会把每个重要实体、概念和 Agent 提议页转成
`page_requirements`。Writer 完成投影前必须逐项覆盖，所以不会再因
`candidatePages` 过少而静默丢失实体或概念页。Core 会统一补齐
`type/title/tags/related/created/updated/sources/covers/summary` frontmatter，
将可解析的 Related 关系变成双向链接，生成包含摘要、关键实体与
来源诉源的丰富来源页，并按页面类型重建 `index.md` 和知识地图式
`overview.md`。

Related 的 canonical 格式是 frontmatter 中的 `collection/slug`，以及正文中的
`[[collection/slug]]`。Core 兼容 Related 章节中的旧式 `wiki/collection/slug.md`
路径和指向 Wiki 页面的 Markdown 链接，写盘时会统一两处格式；普通叙述中的
“Related to”不会被猜测成链接。

## 支持的文件

- Markdown：`.md`、`.markdown`
- UTF-8 文本：`.txt`
- HTML：`.html`、`.htm`，包括表格
- Word：`.docx`，保留表头、行列和合并单元格元数据
- Excel：`.xlsx`，保留工作表名、A1 范围、合并单元格、隐藏行列、
  日期和公式缓存结果
- PDF：带文本层的 `.pdf`，保留页码

当前不支持老式 `.xls`、含宏 `.xlsm`、PPTX、图片、音频和扫描版 PDF OCR。
请先将 `.xls` 另存为 `.xlsx`。Excel 公式不会被执行，Core 只读取文件中
已保存的缓存结果，也不会访问外部链接。

## 新电脑安装

### 1. 安装基础环境

需要：

- Git
- Node.js 20 或更高版本
- Claude Code、Codex 或 OpenCode 之一

检查 Node.js：

```bash
node -v
npm -v
```

macOS、Linux 或 WSL 安装 Claude Code：

```bash
curl -fsSL https://claude.ai/install.sh | bash -s stable
```

### 2. 下载和构建

```bash
git clone git@github.com:llllyh66/llm_wiki_new.git
cd llm_wiki_new
npm ci
npm run build
npm test
```

不要从旧电脑复制 `node_modules/` 或 `packages/mcp-server/dist/`，在新电脑重新构建。

## Claude Code 配置

### 1. 必须从项目根目录启动

```bash
cd /path/to/llm_wiki_new
claude
```

根目录的 `.mcp.json` 会使用 `CLAUDE_PROJECT_DIR` 锁定服务器脚本和工作区路径，
并让这个 14 工具的服务器在会话期间保持加载。第一次打开项目时，Claude Code
会请求批准项目 MCP，请确认批准。

### 2. 检查 MCP

在终端执行：

```bash
claude mcp list
```

正常状态应为：

```text
llm-wiki: node packages/mcp-server/dist/index.js --workspace . - Connected
```

进入 Claude Code 后执行：

```text
/mcp
```

`llm-wiki` 应显示 `Connected` 和 16 个工具。

页面规划上下文会自动分页，Skill 会持续读取到 `next_cursor` 为空；大请求和大结果
也有明确预算，超过限制时会返回可恢复错误，而不是关闭 MCP 连接。

项目中的 `.claude/settings.json` 已为主 Agent 和所有后台 Agent 预先允许
`llm-wiki-builder`、全部 `llm-wiki` MCP 工具以及只读文件工具，并使用
`dontAsk` 模式。抽取所需调用不会再弹出权限确认；工作流不需要的 Shell、任意
文件写入和外部网络工具会直接拒绝而不是询问。修改配置后需完全退出并重新启动
Claude Code。

多批次任务默认按 `parallel_extraction.recommended_workers` 启动后台抽取
Agent，当前最多 4 个；大型 Schema 也不再降为 2 个，因为每个 worker 只获取服务端选中的
相关类型。每个 Agent 使用固定 `worker_id` 租约不同批次，Core
串行保护同一任务的状态提交，因此不会抢同一批次或覆盖其他 Agent 的结果。
主 Agent 只负责轻量的 page-plan 编排、启动后台 Agent 和校验 receipt；它不生成页面，也不调用
`llm_wiki_get_staged_page_drafts` 或 `llm_wiki_commit_pages`。后台抽取 Agent 与 page drafter
形成流水线，每新增 4 个 batch 或等待满 30 秒后增量更新受影响页面。
每个增量 projection 最多租约 8 个 batch，一次 Writer 后台调用最多连续处理 6 个
projection。协调器投影 loop 只读取 compact manifest；Core 按
`patch_scaffold.path` 分成互斥 shard，最多使用 4 个仅具备 page-plan/staging MCP 权限的 page drafter
并行生成语义正文并暂存，再由唯一稳定 Writer 使用
`staged_draft_shard_ids + patches=[]` 在服务端校验并提交。小计划也由一个 drafter 或稳定 Writer
串行 fallback 处理，不把提交转移给主 Agent。Core 只负责
校验 SourceRef、页面结构、哈希和事务，不自动替代 Agent 写作。
任一 `commit_analysis` 使投影就绪时，该 extractor 会立即返回
`writer_required: true`，而不是继续领取 batch；主 Agent 随即启动
协调器投影编排，收到 drafter receipt 后立即启动或恢复稳定 Writer，再按需补充 extractor。抽取与写入重叠时使用总计 4 个后台
Agent 的预算，通常保留 2 个 extractor 和 2 个 page drafter；投影提交后恢复完整
extractor 数量。`status.next_action` 也会在投影就绪时
优先指向 `llm_wiki_get_page_plan_context`，因此不需要等用户追问才生成页面。
项目级 `.claude/agents/llm-wiki-extractor.md` 会显式复用项目的
`llm-wiki` MCP 连接，并通过 `disallowedTools` 禁用 Shell、任意写入、网络和
嵌套 Agent。它不再用 `tools: Read, mcp__llm-wiki__*` 作为严格白名单，避免
某些 Claude Code 版本未展开 MCP 通配符后只剩 Read 工具。启动 worker 池前，
主 Agent 在协调器中直接调用一次 `llm_wiki_status`，不再为探测创建临时子 Agent
或 Team。Worker 的第一次 `get_batch` 同时验证它自身的 MCP 继承。Team 初始化
警告不代表 MCP 成功或失败；如果宿主已明确返回 worker 启动成功，主 Agent 不会再
在协调器中重复抽取。
首次启动和补位都必须显式使用项目 Agent 类型 `llm-wiki-extractor`，不能改用
`general-purpose`、动态“Worker N”或 Agent Team teammate，因为它们不会加载该
Agent 文件的 `mcpServers` 配置。项目同时显式允许 16 个 MCP 工具名，每个工具
都发布 `anthropic/alwaysLoad` 元数据；如果宿主仍延迟加载，Worker 会先使用
ToolSearch 发现工具，而不是直接判定 MCP 不可用。
`.claude/agents/llm-wiki-writer.md` 使用同样的 MCP 复用方式，且每个任务同时
只允许一个 `wiki-writer-1` 租约，避免页面冲突。

新版 extractor 每次后台调用最多连续处理 6 个 batch，但每个 batch 都单独提交落盘；
主 Agent 再用稳定 `worker_id` 启动下一个有界任务。这样减少反复启动 Agent 和加载 Skill
的开销，同时不依赖长时间跨 turn 存活的子 Agent。后续 turn 先调用 `llm_wiki_status`，
`worker_recovery.leases` 会返回已持久化的 worker 和 batch 租约。使用相同
`worker_id` 启动新子 Agent，即可通过新 MCP 客户端继续同一 batch。
因此旧后台 Agent 消失不等于 MCP 断开，也不会丢失进度。

`worker_recovery.leases` 表示持久化的 batch 预留，不表示 SubAgent 进程仍在运行。
主 Agent 会另外维护 `running_worker_ids`。任何 extractor 发出完成通知后，
应立即释放它的执行槽位：如果该 ID 仍有租约，立即使用相同 ID 恢复；
如果租约已消失但 batch 尚未全部完成，立即用该 ID 领取下一批。
不会再因为“两个 lease 都 active”而等待另一个 Agent 完成。

### 3. 检查 Skill

项目必须存在真实文件：

```text
.claude/skills/llm-wiki-builder/SKILL.md
```

可以在终端验证：

```bash
test -f .claude/skills/llm-wiki-builder/SKILL.md
```

进入 Claude Code 后执行：

```text
/skills
```

应当可以看到 `llm-wiki-builder`。

## 快速使用

### 拖入或附加文档

将文档拖入 Agent 会话，然后输入：

```text
使用 llm-wiki-builder，把这些文档构建成一个中文知识库。
```

### 使用本地路径

```text
/llm-wiki-builder 把 ./docs 中的文档构建成知识库。
```

导入 Excel：

```text
/llm-wiki-builder 导入 ./data/客户清单.xlsx，分析每个工作表，
识别实体、概念、指标和关系，并生成结构化知识页面。
```

### 增量更新

```text
/llm-wiki-builder 把 ./docs/需求-v2.docx 增量更新到现有知识库，
优先更新已有的规范页面，不要创建重复概念。
```

相同内容会按 SHA-256 自动去重；同名文件内容改变后会被当作新版本处理。

## 按领域 Schema 抽取

仓库根目录的 `llm-wiki.domain-schema.json` 是当前默认领域 Schema。
导入时 Core 会先校验它，再把一份不可变快照保存到当前任务中；
因此任务进行期间修改原 Schema 不会改变已创建任务的抽取契约。
Schema 最大可为 5 MiB。抽取热路径上超过 8 KiB 时不会塞进 `get_batch`
的主响应，Core
只返回摘要。抽取 Worker 会优先调用 `llm_wiki_get_domain_schema`
的 `search` 模式，由服务端根据当前 batch 术语选出少量相关类型，并返回这些
类型的完整属性和关系定义。分类仍有歧义时，再用有界的 `catalog` 摘要和
`types` 精确查询；不再让 Agent 逐页重建数 MiB Schema。Core 仍使用任务的完整
Schema 快照校验，因此不会降低约束强度。

`get_batch` 还会返回可直接填充的 `analysis_scaffold` 和服务端生成的
`evidence_catalog`。后者已经包含逐行或逐段的精确 quote 以及正确的 Excel
定位信息；Worker 只需在实体和关系中填写 `evidence_index`，不再复制 quote、
读取原文件或拼写 `sheetName` / `cellRange`。Core 会在提交时解析索引、只保存
实际使用的完整 SourceRef。旧式完整 SourceRef 仍兼容；弯引号、Markdown 强调
标记等轻微差异仅在能唯一匹配原文时自动还原为精确 quote。

为了降低每个 batch 的延迟，`get_batch` 会直接用 batch 原文匹配 Schema 中的类型 ID、
名称、别名和属性名，并内联少量相关类型的完整抽取约束（省略冗长描述）。大多数 batch 不再需要
额外调用 Schema 工具。抽取热路径也默认不做 BM25/Embedding 检索，因为当前
batch 已是完整证据，最终 Wiki 投影会统一合并跨 batch 重复。这不会关闭用户查询的
BM25 + Embedding + Wiki 多路召回；只是不再为每次抽取强制支付该开销。

直接告诉 Claude：

```text
/llm-wiki-builder 按 ./llm-wiki.domain-schema.json 的领域模型，
从 ./data/业务记录.xlsx 抽取业务主体、业务对象、业务事件及关系，并生成 Wiki。
```

Agent 在 `entities` 中提交 `entityTypeId` 和 `properties`，在
`relations` 中提交 `relationTypeId`、`sourceEntityLocalId` 和
`targetEntityLocalId`。`compatible` 模式允许 Agent 使用中文名称或别名，
Core 会将它们规范化为 Schema 中的稳定 ID。
允许使用 `"relationTypes": []`；这表示不启用领域级关系约束，Agent 仍按通用
AnalysisEnvelope 抽取并保存关系，不检查关系类型、端点类型或关系属性。
`entityTypes` 仍必须至少包含一个实体类型。只有 `relationTypes` 非空时，Core
才执行领域关系校验。

抽取采用 Schema-first：Agent 在生成候选时先选择 Schema 类型，再抽取允许的
属性和有原文证据的必填值，不应先生成不合规候选再依赖 Core 丢弃。即使
`validationFailurePolicy` 为 `drop-invalid`，默认提交也会在持久化前返回可
恢复的 `INVALID_DOMAIN_ANALYSIS`，让后台 Agent 修正同一批次，不会静默丢失。

只有用户明确接受数据损失并在提交中设置
`accept_dropped_candidates: true` 时，`drop-invalid` 才执行：

- 缺少必填属性、属性类型错误或使用未知类型的实体会被丢弃；
- 指向已丢弃实体或端点类型不合法的关系会被丢弃；
- 批次仍可成功提交，返回的 `domain_validation` 会列出原因和丢弃数量。

必填值在源文档中缺失时，Agent 不应编造。默认模板使用
`"validationFailurePolicy": "reject-batch"`；该策略始终以
可恢复的 `accepted: false` 返回，不会断开 MCP。

也可显式指定其他 Schema：

```bash
npm run cli -- import ./data/业务记录.xlsx \
  --domain-schema ./schemas/telecom.json --workspace .
```

### 恢复中断任务

```text
恢复最近一个未完成的 llm_wiki 任务。
```

Skill 会先调用 `llm_wiki_list_tasks` 和 `llm_wiki_status`，然后按 `next_action`
继续执行。

### 使用已生成的 Wiki

可直接向主 Agent 提问，Skill 会使用 `llm_wiki_retrieve_context` 召回证据；
也可以明确让 Agent 综合 `wiki/`：

```text
阅读 wiki/，总结系统中的核心实体、关键概念以及它们的关系。
```

### BM25 + Embedding + Wiki 多路召回

页面生成使用“微批次投影”：

- 新增 4 个已抽取 batch、最旧未投影 batch 等待超过 30 秒，或全部 batch
  完成时，Core 会开放一个 Wiki 投影窗口。
- 每个增量 projection 最多包含 8 个 batch；积压时 Writer 一次最多连续处理 6 个 projection。
- 增量投影只更新受当前 batch 影响的页面，并标记为 provisional。
- Writer 使用已验证分析、服务端保存的精确 SourceRef 和 `page_requirement + patch_scaffold`
  生成语义页面；大型 Schema 只以元数据形式提供给 Writer。
- 页面数达到 4 个时按 canonical path 分片，最多 4 个 drafter 并行生成；同一路径
  不跨 shard，drafter 不调用 MCP，唯一 Writer 统一校验和原子提交。
- provisional 页面在所有未完成任务的检索中都被排除，不会污染用户问答。
- 超大页面计划可在同一租约下分多次提交，每次最多 50 个 PagePatch。
- 全部抽取完成后必须进行一次全局去重、矛盾合并和 provisional 复核；
  在此之前 `finalize` 会被可恢复地拒绝。

`llm_wiki_retrieve_context` 会并行考虑受管理的源文档块、已提交分析和 Wiki
页面分段。任务构建期间默认先用 BM25 + Embedding 并以 RRF 融合，主 Agent
无需等待 Wiki 完成即可回答问题；`finalize` 完成后，同一个无 `channels` 调用
会自动切换为 BM25 + Embedding + Wiki 标题/路径/双向链接图三路 RRF。
`retrieval_phase` 会明确返回 `building` 或 `knowledge-base-complete`。构建期
回答可能不完整，主 Agent 应向用户保留这一状态。大型语料采用公平、有上限
的候选集，返回值中的
`corpus.truncated`、`corpus.max_documents` 和 `channel_status` 会说明是否截断
或降级。
已完成的旧 Wiki 页在新任务构建期仍可通过 BM25/Embedding 召回；只有
未完成投影生成的 provisional 路径会被排除。

Embedding 默认关闭；此时该通道自动使用本地 feature-hash 后备，不影响 BM25
与 Wiki 通道。配置 OpenAI-compatible 服务：

```bash
export LLM_WIKI_EMBEDDING_PROVIDER=openai-compatible
export LLM_WIKI_EMBEDDING_MODEL=你的向量模型
export LLM_WIKI_EMBEDDING_URL=http://127.0.0.1:8000/v1/embeddings
export LLM_WIKI_EMBEDDING_API_KEY=运行时密钥  # 服务不要求时可省略
```

使用 Ollama 时将 Provider 设为 `ollama` 并设置模型；默认地址为
`http://127.0.0.1:11434/api/embed`。请求会分批、超时控制，并按内容哈希缓存到
`.llm-wiki/indexes/embeddings/` 的分片目录。端点超时、断开或返回畸形向量时，
工具会自动降级并保持 MCP 连接可用。可在 `.llm-wiki/config.json` 的
`retrieval` 中调整 `maxDocuments`、`rrfK`，以及 Embedding 的 `batchSize`、
`timeoutMs`、`totalTimeoutMs`、`maxInputChars` 和 `maxDocuments`；不要把 API
Key 写入该文件。

## CLI 用法

CLI 适合初始化、预处理、查询状态、校验和恢复，不负责语义分析：

```bash
npm run cli -- init --workspace .
npm run cli -- import ./document.md --workspace .
npm run cli -- import ./data/客户清单.xlsx --workspace .
npm run cli -- import ./data/客户清单.xlsx --domain-schema ./schemas/customer.json --workspace .
npm run cli -- status --workspace .
npm run cli -- status <task-id> --workspace .
npm run cli -- lint --workspace .
npm run cli -- abort <task-id> --workspace .
npm run cli -- delete wiki --confirm-delete-knowledge-base --workspace .
npm run cli -- delete knowledge_base --confirm-delete-knowledge-base --workspace .
npm run cli -- migrate-legacy raw/sources --workspace .
```

`import` 只创建待 Agent 分析的持久化任务，不会自动调用模型完成页面生成。

### 删除知识库

MCP 工具 `llm_wiki_delete_knowledge_base` 和 CLI 都要求显式确认标识
`DELETE KNOWLEDGE BASE`。`wiki` 只删除 Wiki 页面和检索索引，保留原始来源与任务历史；`knowledge_base` 还会删除托管原文、任务状态、事务日志和导入暂存，但保留工作区配置与 Schema。有活跃任务时必须先完成或取消。

## 迁移现有知识库

如果要在新电脑继续更新现有知识库，必须一起复制：

```text
wiki/
.llm-wiki/
```

- `wiki/` 是可读的 Markdown 知识页面。
- `.llm-wiki/` 包含原始来源、任务状态、索引和恢复信息。
- `.llm-wiki/` 默认被 Git 忽略，因此仅执行 `git clone` 不会迁移运行状态。
- `.llm-wiki/` 可能含有敏感原始文档，请使用加密压缩包或受信任的备份方式迁移。

如果准备从原始文档重新构建，只需克隆代码并重新导入文档，无需复制
上述目录。

## 常见问题

### MCP 显示 `Pending approval`

```bash
cd /path/to/llm_wiki_new
claude mcp reset-project-choices
claude
```

重新启动后批准 `llm-wiki`，然后用 `/mcp` 检查。`Connected` 只表示进程
已连接；项目 MCP 未批准时，工具仍不会对会话可用。

### `Unknown skill: llm-wiki-builder`

先检查：

```bash
test -f .claude/skills/llm-wiki-builder/SKILL.md
```

如果文件存在，完全退出 Claude Code，再从项目根目录运行 `claude`。
不要把 `llm-wiki-builder` 目录替换成符号链接。

### MCP 已连接，但工具无法调用

1. 在 Claude Code 中运行 `/mcp`，确认已批准且工具数为 16。
2. 运行 `npm run build`，然后重启 Claude Code。
3. 确保是从项目根目录启动。
4. 显式测试：

   ```text
   请调用 llm-wiki MCP 的 llm_wiki_list_tasks 工具列出当前任务，
   不要使用 shell。
   ```

如果主 Agent 可以调用，但后台 Agent 报告“只有 Read 工具”，说明当前会话仍
加载了旧的子代理定义。确认两个 `.claude/agents/llm-wiki-*.md` 都包含
`mcpServers: - llm-wiki`（YAML 分行形式）且没有 `tools:` 字段，然后完全退出
Claude Code 并从项目根目录重新启动。新版会先做子代理能力探测；探测失败只
回退一次到主 Agent，不会继续启动 `general-purpose` worker。

### Agent 提示“MCP 工具在跨 turn 时不可靠”

这不是 llm_wiki Core 或 MCP Server 返回的错误，不能仅因为旧后台
Agent 没有继续运行就判定 MCP 断开。让主 Agent 先调用：

```text
请直接调用 llm_wiki_status 检查原任务，不要推测跨 turn 断连。
按 worker_recovery.leases 使用相同 worker_id 恢复单 batch worker。
```

如果 `status` 成功，当前 turn 的 MCP 就是可用的。新 worker 使用相同
`worker_id` 会继续原租约，不需要 `/mcp`。只有 `status` 本身出现真实
transport/closed connection 错误时，才需要重连。

### 任何 llm_wiki 工具报错后 MCP 断开

先确认另一台电脑没有继续运行旧的 `dist`。`dist/` 不提交到 Git，单独执行
`git pull` 不会刷新 MCP 实际运行的 JavaScript；而 `/mcp` 重启只会重新启动
当前磁盘上的构建产物。

```bash
cd /path/to/llm_wiki_new
git pull --ff-only
npm ci
npm run build
npm test
```

然后完全退出 Claude Code，从该项目根目录重新运行 `claude`，批准项目 MCP，
并用 `/mcp` 确认 `llm-wiki` 为 `Connected` 且有 16 个工具。最新版包含连续
`INVALID_ANALYSIS`、错误 SourceRef 和畸形重试后保持同一 STDIO 连接存活的
回归测试。现在 16 个工具的所有异常都作为普通工具结果返回，不再进入
MCP `isError` 通道。失败结果包含 `ok: false`、`accepted: false`、
`error`、`next_action` 和 `mcp_connection_usable: true`。Agent 应按
`next_action` 修正或恢复，不需要执行 `/mcp`。

若是在长时间没有工具调用、后台 Agent 仍在工作时断开，查看 MCP stderr：服务默认每
5 分钟发送一次带 30 秒预算的标准 ping；心跳失败只记录日志，不会因为一次失败主动
断开。`stdin-closed`、`stdout-closed` 或 `transport-closed` 表示宿主已经关闭了管道，
需要让 Claude 重新启动 MCP。调试时可用环境变量
`LLM_WIKI_MCP_KEEPALIVE_MS` 和 `LLM_WIKI_MCP_KEEPALIVE_TIMEOUT_MS` 缩短心跳周期，
但生产环境建议保持默认值。

### 已完成多个 batch，但没有生成 Wiki 页面

运行 `llm_wiki_status`。当 `wiki_projection.ready` 为 `true` 时，最新版会让
`next_action.tool` 直接返回 `llm_wiki_get_page_plan_context`，并带上固定的
`writer_id: wiki-writer-1`。主协调器读取 compact manifest 后启动 page drafter，
再将 receipt 交给稳定 Writer 提交语义页面。
后台 extractor 也会停止并向主 Agent 返回
`writer_required: true`，从而触发 Writer；不要继续等待更多 batch，也不要启动
第二个 projection 提交者。主协调器启动的 `llm-wiki-page-drafter` 只生成互斥
页面草稿，不持有提交权，也不属于第二个 Writer；稳定后台 Writer 始终是唯一提交者，
无法启动 drafter 时由它执行串行回退，主协调器也不能代替提交。

页面规划不会内联完整 Schema。即使领域 Schema 接近 5 MiB，
传统 `llm_wiki_get_page_plan_context` 也只返回 Schema ID、版本、哈希和大小元数据，
并将页面规划正文按约 40K 字符分页。Writer 应沿 `next_cursor` 读取完所有页面，
不能以“忽略 Schema”或“忽略截断响应”的方式继续。如果旧任务显示
`wiki_projection.in_progress: true`，使用相同的 `wiki-writer-1` 恢复该租约。
传统 Writer 流程已有积压时，每次提交返回的 `writer_next_action` 会直接指向下一个页面规划，
Writer 在自己的有界 quantum 内直接继续，不需要等待主 Agent 再次询问状态。

若行为仍与上述不符，说明另一台电脑还在运行旧的构建产物；执行
`npm run build` 后完全退出并重新启动 Claude Code。

### 超大文件的 `llm_wiki_get_batch` 报错

旧版本不会拆分超大 Markdown/HTML/DOCX 表格和代码块，单个 chunk 可能
突破 batch 和 MCP 输出限制。新版本会：

- 把所有超大文本块拆分到 Agent 传输硬上限 3,000 字符以内；
- 即使工作区或旧任务把限制改得更大，每个 batch 也不会超过 9,000 正文字符；
- 每个 batch 的序列化 chunk 载荷不超过 24 KiB，避免“文本不大但表格元数据很大”；
- 同时按文字数和序列化字节数限制 batch；
- 压缩包含超长单元格/表格字符串的 `structuredData`，避免 MCP JSON 出现 81K 单行；
- 单个 chunk 同时服从 chunk 上限和 batch 上限，不会在每次调用时重复拆分；
- `get_batch` 始终返回完整批次，并在 `batch_limits` 中报告实际大小；
- 自动原地重建尚未完成的旧版超大 batch，保留原 batch ID 和 worker 租约，已提交的批次不受影响。

并行抽取时，`get_batch` 会按 `worker_id` 租约批次，多个后台 Agent 不会拿到
同一批。如果报“单行 81,073 字符”，不需要等租约过期；构建新版服务后，
使用原 `task_id + batch_id + worker_id` 再调用一次 `get_batch` 即会修复并继续。

`max_chars` 现在是安全的未完成批次重分片目标，不会截断或丢弃内容；
原 batch 的第一个分片保留 batch ID 和 worker 租约。Builder 使用服务端返回的
`recommended_batch_chars`：小任务为 6,000，大任务为 9,000；单 chunk 仍不超过
3,000 字符，序列化 chunk 载荷仍不超过 24 KiB。

`get_batch` 现在还约束完整工具响应，不再只统计正文：它不向抽取
Worker 重复传输 Wiki 页面 Schema，Analysis Schema 改为紧凑契约，大型领域
Schema 只返回当前 batch 命中的紧凑定义。`batch_limits` 会同时报告 chunk
载荷和完整响应字节数，目标上限为 40 KiB。

大文件的内部处理也做了专项优化：任务 batch 只保留抽取必需的表格定位
元数据，不再重复保存整份表格结构；已验证的 batch 边界和 `batches.json`
会被缓存，同一 Worker 连续处理时不会反复扫描和重写全部 batch。大型
Schema 匹配使用一次构建的多模式索引，不再对每个类型、属性和别名逐个
扫描 batch 文本。每次提交的幂等结果按 key 分片保存，避免 batch 越多时
反复读写一个持续膨胀的 JSON。同一任务还有跨 MCP 进程的短时文件锁，
多个后台 Worker 可以并行分析，又不会在租约或提交状态上互相覆盖。
不需要 Wiki revision 的工具不再每次哈希整个 Wiki；查询也不再连续计算
两次相同 revision。Writer 获得协调器已返回的 `next_action` 时直接执行，
不再额外调用一次 status。

### PagePatch 的 SourceRef 校验失败

新版不再要求 Writer 复制完整 SourceRef。直接复制
`page_requirement.patch_scaffold`，添加 `content` 后提交即可：

```json
{
  "patchId": "patch-page-...",
  "path": "wiki/entities/zhang-san.md",
  "operation": "create",
  "title": "张三",
  "pageKind": "entity",
  "covers": ["page-..."],
  "sourceRefs": ["page-..."],
  "content": "# 张三\n\n...",
  "rationale": "Materialize page requirement page-..."
}
```

Core 会将 requirement ID 解析为任务中已验证的精确 quote 和 locator。旧版
完整 SourceRef 仍可使用；仅有 Markdown 加粗、Unicode 引号或空白差异时，
服务端会在唯一安全匹配后自动修复，不会让 Writer 重新生成整批页面。

### `sourceRefs` 或 `reviewItems` 校验失败

新任务直接复制 `analysis_scaffold`：其中 `sourceRefMode` 为
`batch-evidence-index`，顶层 `sourceRefs` 已预填证据目录编号。实体、概念、
声明、关系、矛盾、候选页面和 review item 直接引用 `evidence_catalog` 中的
`evidence_index`，Core 会解析并压缩成实际使用的完整 SourceRef：

```json
{
  "sourceRefMode": "batch-evidence-index",
  "sourceRefs": [0, 1, 2],
  "entities": [{ "name": "Ping时延", "sourceRefs": [1] }],
  "reviewItems": [{ "content": "部分指标计算公式为空", "sourceRefs": [2] }]
}
```

所有索引必须来自当前 batch 的 `evidence_catalog`。完整对象形式仍向后兼容；
不要把 `reviewItems` 写成字符串数组。无法从目录中的精确证据支持的问题应放入
`unresolvedQuestions`，不要重新读取源文件猜 quote。

标题引用不能支撑整张表的详细结论。`claims`、`relations`、
`contradictions` 和 `reviewItems` 的 quote 必须包含该条目的关键术语；大型
表格应按行或主题建立多个 SourceRef。单个 SourceRef 最多支撑 8 个候选条目，
超过时 `commit_analysis` 会返回可恢复的 `accepted: false`。

### Excel 无法导入

- 确认文件后缀是 `.xlsx`，不是 `.xls` 或 `.xlsm`。
- 先运行 `npm run build` 并重启 Agent，避免 MCP 使用旧构建产物。
- 确认工作簿不是损坏的 ZIP/OOXML 文件。
- 如果公式单元格没有结果，请在 Excel 中重新计算并保存后再导入。

### PDF 没有提取到文字

当前只支持带文本层的 PDF。扫描件需要先使用 OCR 工具转换为可搜索 PDF
或 UTF-8 文本。

## 安全边界

- 文档内容被当作不可信数据，不会当作操作指令执行。
- 原始文档导入后复制到 `.llm-wiki/sources/objects/<sha256>/`。
- Agent 只能通过 MCP 向允许的 `wiki/` 目录提交页面。
- 每个重要事实都应关联有效 SourceRef。
- 写入经过路径、文件哈希、Wiki 修订、锁、暂存和回滚校验。

## 开发与验证

```bash
npm ci
npm run build
npm test
```

测试不调用真实模型，也不需要桌面程序或 HTTP 服务。
