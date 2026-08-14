# llm_wiki 中文使用说明

[English README](README.md)

`llm_wiki` 是一个无桌面端、Agent-first 的本地知识库引擎。Claude Code、
Codex 或 OpenCode 使用当前会话模型理解文档；不调用模型的 Core 负责
原文归档、去重、任务恢复、引用校验、安全写入和检索索引。

用户无需启动桌面应用、手工管理 HTTP 服务或配置额外的模型 API Key。

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

使用领域 Schema 时，实体或概念页面还会显示其领域分类。例如实体页面会在
frontmatter 中加入 Schema 快照、分类状态、Domain、ABE、BE 和完整路径，
正文中同步生成“领域分类”章节。分类由 Core 根据已校验的分析结果
和任务 Schema 快照确定，Writer 不能自行修改。

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
- PDF：`.pdf`，优先读取文本层，扫描页自动 OCR，保留页码
- PowerPoint：`.pptx`、`.pptm`，提取幻灯片文本、表格，并对内嵌图片做 OCR
- 图片：`.png`、`.jpg`、`.jpeg`、`.webp`、`.bmp`、`.tif`、`.tiff`，
  使用离线中英文 OCR

当前不支持老式 `.xls`、`.ppt`、含宏 `.xlsm`、音频和视频。
请先将 `.xls` 另存为 `.xlsx`，将 `.ppt` 另存为 `.pptx`。Excel 公式和
PowerPoint 宏都不会被执行，Core 也不会访问外链接。OCR 使用随包
安装的简体中文和英文模型，不依赖运行时网络。

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

根目录的 `.mcp.json` 会连接项目本地的 Streamable HTTP MCP。
`.claude/settings.json` 中的 `SessionStart` hook 使用 `CLAUDE_PROJECT_DIR`
和无 shell 的跨平台 `command + args` 形式幂等启动 supervisor；Windows 下
后台 Node 进程会隐藏控制台窗口。worker 崩溃后 supervisor 指数退避重启，Claude Code
2.1.121 及以上会自动重连 HTTP MCP。服务器共 18 个工具并保持
`alwaysLoad`。这些配置会随仓库同步：每台设备都在自己的 clone 内启动
localhost daemon，PID 和日志只写入该 clone 的 `.llm-wiki/`。第一次打开
项目时，请批准项目 MCP 和 hook。

### 2. 检查 MCP

在终端执行：

```bash
claude mcp list
```

正常状态应为：

```text
llm-wiki: http://127.0.0.1:31982/mcp (HTTP) - Connected
```

进入 Claude Code 后执行：

```text
/mcp
```

`llm-wiki` 应显示 `Connected` 和 18 个工具。

页面规划上下文会自动分页，Skill 会持续读取到 `next_cursor` 为空；大请求和大结果
也有明确预算，超过限制时会返回可恢复错误，而不是关闭 MCP 连接。

项目中的 `.claude/settings.json` 已为主 Agent 和所有后台 Agent 预先允许
`llm-wiki-builder`、全部 `llm-wiki` MCP 工具以及只读文件工具，并使用
`dontAsk` 模式。抽取所需调用不会再弹出权限确认；工作流不需要的 Shell、任意
文件写入和外部网络工具会直接拒绝而不是询问。修改配置后需完全退出并重新启动
Claude Code。

项目会显式关闭实验性的 Agent Teams；抽取 worker 是独立的命名后台 subagent，
这样其 Agent 定义中的 MCP 和 Skill 才会正常预加载。如果旧会话出现
`Team "wiki-build" does not exist`，拉取最新配置后应完全退出并重新启动 Claude
Code。协调器必须省略 `team_name`，而不是创建 `wiki-build` Team。
宿主返回 `Backgrounded agent` 就表示 subagent 已成功启动；协调器必须在同一轮
立即启动初始 wave 中的其余 worker，不能等待 extractor-1 完成，也不能只启动一个
worker 后先输出导入摘要并结束当前轮次。

## CAC 配置

项目同时为支持 Claude Code 兼容项目配置的 CAC 客户端提供实体目录 `.cac/`，其 `settings.json`、三个 Agent 和
`llm-wiki-builder` Skill 与 `.claude/` 一一对应，仅将 Claude 标识、路径和
`CLAUDE_PROJECT_DIR` 替换为 CAC、`.cac` 和 `CAC_PROJECT_DIR`。两套配置共享
根目录 `.mcp.json`、同一个 localhost HTTP MCP daemon 和规范工作流
`.agents/skills/llm-wiki-builder/`。实体文件而非符号链接可确保 GitHub ZIP、
Windows 和多设备克隆均能直接发现配置。

CAC 客户端必须明确支持这些项目级 settings、hook 和 `CAC_PROJECT_DIR` 占位符；
仅能读取根目录 `.mcp.json` 并不代表其命令行程序一定名为 `cac`。在每台设备完成
`npm ci` 和 `npm run build` 后，从项目根目录打开 CAC 客户端，首次
使用时批准项目 MCP 和 hook。若此前已经打开该项目，请完全退出并重新启动 CAC，
再在 MCP 页面确认 `llm-wiki` 为 `Connected` 且包含 18 个工具。

多批次任务默认按 `parallel_extraction.recommended_workers` 启动后台抽取
Agent，当前最多 4 个；`get_batch` 不内联大型 Schema，worker 会按三级 disclosure
显式读取所选 Domain、ABE 和完整 ABE JSON。每个 Agent 使用固定 `worker_id` 租约不同批次，Core
串行保护同一任务的状态提交，因此不会抢同一批次或覆盖其他 Agent 的结果。
主 Agent 只负责轻量的 page-plan 编排、启动后台 Agent 和校验 receipt；它不生成页面，也不调用
`llm_wiki_get_staged_page_drafts` 或 `llm_wiki_commit_pages`。后台抽取 Agent 与 page drafter
形成流水线，每新增 4 个 batch 或等待满 30 秒后增量更新受影响页面。
每个增量 projection 最多租约 8 个 batch，一次协调器编排最多连续处理 6 个
projection。协调器投影 loop 只读取 compact manifest；Core 按
`patch_scaffold.path` 分成互斥 shard，最多使用 4 个仅具备 page-plan/staging MCP 权限的 page drafter
并行生成语义正文并暂存；协调器收到 `{shard_id, draft_hash}` receipt 后才启动唯一稳定 Writer，使用
`staged_draft_receipts + patches=[]` 在服务端校验并提交。小计划也由一个 drafter
处理。正常流程中的 Writer 不读取 manifest/draft-shard，也不启动 drafter；只有
协调器在 drafter 创建明确失败后才能显式启用 Writer 串行 fallback。Core 只负责
校验 SourceRef、页面结构、哈希和事务，不自动替代 Agent 写作。
任一 `commit_analysis` 使投影就绪时，该 extractor 会立即返回
`writer_required: true`，而不是继续领取 batch；主 Agent 随即启动
协调器投影编排，并在 overlap 上限允许时同步以同一 worker ID 零延迟补位；收到
drafter receipt 后才启动稳定 Writer。抽取与写入重叠时使用总计 4 个后台
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
Agent 文件的 `mcpServers` 配置。项目同时显式允许 18 个 MCP 工具名，每个工具
都发布 `anthropic/alwaysLoad` 元数据；如果宿主仍延迟加载，Worker 会先使用
ToolSearch 发现工具，而不是直接判定 MCP 不可用。
`.claude/agents/llm-wiki-writer.md` 使用同样的 MCP 复用方式，且每个任务同时
只允许一个 `wiki-writer-1` 租约，避免页面冲突。

新版 extractor 每次后台调用最多连续处理 6 个 batch，但每个 batch 都单独提交落盘；
主 Agent 再用稳定 `worker_id` 启动下一个有界任务。这样减少反复启动 Agent 和加载 Skill
的开销，同时不依赖长时间跨 turn 存活的子 Agent。后续 turn 先调用 `llm_wiki_status`，
`worker_recovery.leases` 会返回已持久化的 worker 和 batch 租约。使用相同
`worker_id` 启动新子 Agent，即可通过新 MCP 客户端继续同一 batch。
只要仍有待抽取 batch，协调器会零延迟补位同一个 worker ID；即使该 invocation
因验证重试耗尽而返回，也不会等待 lease 超时。因此旧后台 Agent 消失不等于 MCP
断开，也不会丢失进度。

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

### 目录型渐进式披露 Schema（V2）

这是唯一支持的 Domain Schema 格式。默认读取 workspace 根目录的
`llm-wiki.domain-schema/`，也可通过 `options.domain_schema_path` 指定其他目录。
不支持单个 Schema JSON 文件或内联 Schema 对象：

```text
schemas/customer/
├── all_domains.json
├── customer/
│   ├── customer_domain.json
│   └── customer_management.json
└── product/
    ├── product_domain.json
    └── product_design.json
```

JSON 内部字段名和嵌套结构不做业务限制，只要是合法 JSON。抽取 Worker 会按
`all_domains.json → <domain>/<domain>_domain.json → <domain>/<abe>.json`
逐级读取；最后一个 ABE JSON 会完整暴露给模型，由模型选择 BE，并在实体或概念上
返回可直接复制的 `classification_scaffold` 和 `be_pointer_hints`。模型提交
`schemaClassification` 和 JSON Pointer；Core 接受 `/...` 与 `#/...`，规范化唯一的
Domain/ABE/BE 引用，并从 Pointer 指向的 Schema 节点补齐 BE key/name。
Schema JSON 的业务字段和嵌套结构不受限制。分类有歧义时保留候选并标记
`unresolved`，不会静默丢失知识。

Wiki 页面会生成 `Domain → ABE → BE` 的“领域分类”区块，并把快照哈希、分类状态、
Domain/ABE/BE key 和路径写入 frontmatter 与检索索引。

`llm_wiki_get_domain_schema` 的 V2 调用方式为：

```json
{ "task_id": "task-xxx", "level": "domains" }
{ "task_id": "task-xxx", "level": "domain", "domain_folder": "customer" }
{ "task_id": "task-xxx", "level": "abe", "domain_folder": "customer", "abe_file": "customer_management.json" }
```

导入时会把整个目录快照到任务目录中，外部 Schema 后续变化不会影响任务。暴露文件会
原样读取并返回（单文件安全上限为 5 MiB），整个快照默认不能超过 20 MiB，超限时导入失败而不截断。


### 恢复中断任务

```text
恢复最近一个未完成的 llm_wiki 任务。
```

Skill 会先调用 `llm_wiki_list_tasks` 和 `llm_wiki_status`，然后按 `next_action`
继续执行。

### 使用已生成的 Wiki

可直接向主 Agent 提问。凡是答案可能存在于已导入文档或生成的 Wiki 中，
Skill 都会在回答前调用 `llm_wiki_retrieve_context` 召回证据，不会只凭对话记忆
作答。普通全任务问答不传 `batch_id`；任务仍在构建时，回答会明确保留
`retrieval_phase: building` 的不完整性提示。
也可以明确让 Agent 综合 `wiki/`：

```text
阅读 wiki/，总结系统中的核心实体、关键概念以及它们的关系。
```

### BM25 + Embedding + Wiki 多路召回

页面生成使用“微批次投影”：

- 新增 4 个已抽取 batch 或最旧未投影 batch 等待超过 30 秒时，
  Core 会开放增量 Wiki 投影窗口；全部 batch 完成时只先排空未投影积压。
- 每个增量 projection 最多包含 8 个 batch；积压时 Writer 一次最多连续处理 6 个 projection。
- 增量投影只更新受当前 batch 影响的页面，并标记为 provisional。
- Writer 使用已验证分析、服务端保存的精确 SourceRef 和 `page_requirement + patch_scaffold`
  生成语义页面；大型 Schema 只以元数据形式提供给 Writer。
- 页面数达到 4 个时按 canonical path 分片，最多 4 个 drafter 并行生成；同一路径
  不跨 shard；drafter 通过 MCP 只读取自己的有界上下文并暂存 receipt，唯一 Writer 统一校验和原子提交。
- provisional 页面在所有未完成任务的检索中都被排除，不会污染用户问答。
- 超大页面计划可在同一租约下分多次提交，每次最多 50 个 PagePatch。
- 全部抽取和增量 catch-up 完成后，先直接调用 `finalize`。Core 会审计
  batch 投影、requirement 完整性/唯一性、矛盾与待复核项、页面 hash、任务提交归属
  和精确 SourceRef；通过时直接将已有页面转为正式页面，不再重写全文。
- 审计不通过时 `FINAL_PROJECTION_REQUIRED` 会返回精确语义投影动作；失败原因会
  持久化，后续 status 不会重复尝试快速 `finalize`。

`llm_wiki_retrieve_context` 会并行考虑受管理的源文档块、已提交分析和 Wiki
页面分段。任务构建期间，每个 source 解析完就原子发布 task-local BM25；
真实 Embedding 在后台异步追赶，不阻塞首次查询。因此主 Agent 无需等待慢速
Wiki 构建就可先用已就绪的 BM25 + Embedding 召回；`finalize` 完成后再加入 Wiki
标题/路径/双向链接图通道。响应会明确返回耐久阶段、逐 source 就绪度、
请求通道、实际活跃通道与降级通道。持久索引不会因固定 10,000 候选上限
静默遗漏后续 Chunk；输出本身仍有有界大小。
已完成的旧 Wiki 页在新任务构建期仍可通过 BM25/Embedding 召回；只有
未完成投影生成的 provisional 路径会被排除。

`llm_wiki_query_domain_pages` 提供 Domain Schema 元数据的精确查询：
`action: "inspect"` 可反查指定 Wiki 页面所属的 Schema snapshot 及
Domain → ABE → BE 分类链；`action: "search"` 可按 `domain_schema_id`、
`snapshot_hash`、Domain、ABE、BE、分类状态或路径前缀组合过滤全部已分类页面。
搜索结果只返回路径、标题、摘要和分类元数据，并通过 `next_cursor` 分页，不批量返回页面正文。

Embedding 默认关闭；此时本地 feature-hash 作为独立降级通道显式标记，
不会冒充真实 Embedding，也不影响 BM25 与 Wiki 通道。配置 OpenAI-compatible 服务：

```bash
export LLM_WIKI_EMBEDDING_PROVIDER=openai-compatible
export LLM_WIKI_EMBEDDING_MODEL=你的向量模型
export LLM_WIKI_EMBEDDING_URL=http://127.0.0.1:8000/v1/embeddings
export LLM_WIKI_EMBEDDING_API_KEY=运行时密钥  # 服务不要求时可省略
```

使用 Ollama 时将 Provider 设为 `ollama` 并设置模型；默认地址为
`http://127.0.0.1:11434/api/embed`。在线查询只生成有界 query vector，文档向量由后台生成并以
generation-scoped float32 产物发布。端点超时、断开或返回畸形向量时，工具
会显式降级并保持 MCP 连接可用。可在 `.llm-wiki/config.json` 的 `retrieval`
中调整 `rrfK`，以及 Embedding 的 `batchSize`、`timeoutMs`、`totalTimeoutMs`和
`maxInputChars`；不要把 API Key 写入该文件。

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

1. 在 Claude Code 中运行 `/mcp`，确认已批准且工具数为 18。
2. 运行 `npm run build`，然后重启 Claude Code。
3. 确保是从项目根目录启动。
4. 显式测试：

   ```text
   请调用 llm-wiki MCP 的 llm_wiki_list_tasks 工具列出当前任务，
   不要使用 shell。
   ```

如果主 Agent 可以调用，但后台 Agent 报告“只有 Read 工具”，说明当前会话仍
加载了旧的子代理定义。确认三个 `.claude/agents/llm-wiki-*.md` 都包含
`mcpServers: - llm-wiki`（YAML 分行形式）且没有 `tools:` 字段，然后完全退出
Claude Code 并从项目根目录重新启动。新版由协调器先直接调用 status 验证连接，
再启动具名项目 Agent；不会创建探测 Agent，也不会改用 `general-purpose` worker。

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

然后完全退出 Claude Code，从该项目根目录重新运行 `claude`，批准项目 MCP 和 hook，
并用 `/mcp` 确认 `llm-wiki` 为 `Connected` 且有 18 个工具。最新版包含空闲
心跳、worker 崩溃重启和新 HTTP 会话恢复 18 个工具的回归测试。现在
18 个工具的所有异常都作为普通工具结果返回，不再进入
MCP `isError` 通道。失败结果包含 `ok: false`、`accepted: false`、
`error`、`next_action` 和 `mcp_connection_usable: true`。Agent 应按
`next_action` 修正或恢复，不需要执行 `/mcp`。

若是在长时间没有工具调用、后台 Agent 仍在工作时断开，先查看
`.llm-wiki/logs/mcp-daemon.log` 中的 `worker-exit`、`worker-retry` 和新
`worker-start`，再查看 `.llm-wiki/logs/mcp-runtime.jsonl`。HTTP 每 10 秒
发送 keep-alive frame，每 1 分钟发送标准 ping；连续 3 次 ping 失败会清理失效
会话，让重连客户端建立新会话，同时服务器最多保留 128 个并发会话。
worker 退出后 supervisor 会自动拉起新 PID，Claude 会对 HTTP MCP 自动重连。
默认端口 `31982` 冲突时，在该设备启动 Claude 前设置
`LLM_WIKI_MCP_HTTP_PORT`。

### 已完成多个 batch，但没有生成 Wiki 页面

运行 `llm_wiki_status`。当 `wiki_projection.ready` 为 `true` 时，最新版会让
`next_action.tool` 直接返回 `llm_wiki_get_page_plan_context`，并带上固定的
`writer_id: wiki-writer-1`。主协调器读取 compact manifest 后启动 page drafter，
再将 receipt 交给稳定 Writer 提交语义页面；没有 receipt 时不启动 Writer。
后台 extractor 也会停止并向主 Agent 返回
`writer_required: true`，从而触发 Writer；不要继续等待更多 batch，也不要启动
第二个 projection 提交者。主协调器启动的 `llm-wiki-page-drafter` 只生成互斥
页面草稿，不持有提交权，也不属于第二个 Writer；稳定后台 Writer 始终是唯一提交者，
无法启动 drafter 时，协调器必须显式标注
`explicit-serial-writer-fallback-only` 才能让 Writer 执行一个 shard 的串行回退；
Writer 本身永远不启动 drafter，主协调器也不能代替提交。

页面规划不会内联完整 Schema。即使领域 Schema 接近 5 MiB，
传统 `llm_wiki_get_page_plan_context` 也只返回 Schema ID、版本、哈希和大小元数据，
并将页面规划正文按约 40K 字符分页。Writer 应沿 `next_cursor` 读取完所有页面，
不能以“忽略 Schema”或“忽略截断响应”的方式继续。如果旧任务显示
`wiki_projection.in_progress: true`，使用相同的 `wiki-writer-1` 恢复该租约。
已有积压时，每次 staged commit 返回 `coordinator_next_action`。Writer 在一个
receipt wave 提交后立即停止；主协调器继续获取 manifest、启动下一批 drafter，
新 receipt 到达后再启动 Writer，不需要等待用户再次询问状态。

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
`contradictions` 和 `reviewItems` 使用字段感知的 Grounding Quality Gate。
关系的 `content` 保存原文直接支持的陈述，规范化结构放在
`sourceEntityLocalId`、`predicate`、`targetEntityLocalId`；谓词必须独立获得
证据支持，不能依靠主客体重合通过。标识符、数字、单位和否定极性发生变化会
被拒绝。单个 SourceRef 被大量复用时返回 warning，每个候选仍独立校验。
门禁拒绝时读取 `grounding_diagnostics` 的 `path`、`reason_code` 和 `field`，
在同一 worker/lease 中只修复对应字段，并保留所有未报错候选。不要通过删除
规范化字段或缩小整个 analysis 来盲目重试。

### Excel 无法导入

- 确认文件后缀是 `.xlsx`，不是 `.xls` 或 `.xlsm`。
- 先运行 `npm run build` 并重启 Agent，避免 MCP 使用旧构建产物。
- 确认工作簿不是损坏的 ZIP/OOXML 文件。
- 如果公式单元格没有结果，请在 Excel 中重新计算并保存后再导入。

### PDF 没有提取到文字

- 带文本层的页会直接提取，没有有效文本层的页会自动 OCR。
- 默认识别简体中文和英文；手写、低分辨率、大角度旋转或严重压缩图像
  仍可能识别不完整。
- 查看提取后 `document.json` 的 `metadata.ocrPages`，可确认哪些页使用了 OCR。

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
