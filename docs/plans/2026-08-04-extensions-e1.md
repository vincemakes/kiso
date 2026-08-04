# Extensions E1 — the approval-policy extension system

> Date: 2026-08-04
> Status: complete — spec sections 1-7 delivered, acceptance gate green
> Authority: direction ruling 2026-08-04 (user): the E1 spec. Extensions
> carry approval policies, tools, and hooks; the CLI scans a directory at
> startup; the whole story is proven end to end through the CLI's topmost
> entry with a real kill -9.

## 1. Goal

An extension is a plain `.mjs` file — no SDK, no build step. Its approval
policies run BEFORE the human flow (deny > ask > allow), its allow/deny
verdicts are PERSISTED FACTS recorded with `decidedBy`, and a kill -9 never
re-asks an already-decided call nor re-runs the policy. Tools merge into
the registry; hooks compose after the harness's own.

## 2. Non-goals (violations counted as scope creep)

- No registerCommand / shortcuts / renderers / sendMessage-like APIs.
- No project-level extensions; no MCP; no subagents.
- No compaction parameter surface (that is E2).
- No new npm dependencies; the core 2,000-line cap is immutable (176 lines
  of headroom at ruling time; 95 at completion).

## 3. Baseline (recorded before starting)

- core: 1,824/2,000 lines (176 headroom) — the whole E1 core surface had to
  fit inside (ended at 1,905/2,000).
- cli: 699/1,200 lines (ended at 713).
- 355 tests green (ended at 372).

## 4. Delivery areas (with the evidence discipline: commit + file:line + test + red→green)

### a. core — protocol/extension.ts (pure types), decidedBy, the policy chain

- `packages/core/src/protocol/extension.ts` — `KisoExtension{name,
  hooks?, tools?, approvals?}`, `PolicyVerdict{allow|deny+reason|ask}`,
  `ApprovalPolicy.decide(call, ctx)` — types only, no runtime.
- `packages/core/src/protocol/events.ts:286-297` — `permission_decided`
  gains optional `decidedBy?: string` (absent = human; old logs compatible);
  deep validation at `events.ts:693-698`.
- `packages/core/src/kernel/loop.ts:703-767` — the policy chain in
  `executeOne`, before the human flow: any deny wins (the FIRST denial's
  reason), else any ask falls into the existing flow, all allow
  auto-approves — recorded durably with `decidedBy`, never a human pause; a
  throwing policy counts as ask; ask with no flow configured degrades to an
  honest denial. The durable check (`loop.ts:715-725`) keys on the SAME
  logical call — callId + identical input + decidedBy set — so a re-issued
  call with different arguments is a new call and re-decided (同构
  alreadyReplaced: the persisted fact speaks for the call).
- Tests `packages/core/tests/extensions.test.ts` (7) — red first:
  `expected [] to have a length of 1 but got +0` → green after the chain
  landed: ① deny outranks ask and allow (first reason, decidedBy, no pause)
  — `deny outranks ask and allow — the FIRST denial's reason, decidedBy
  recorded, no human pause`; ② ask outranks allow (human flow, no decidedBy)
  — `ask outranks allow — the existing human flow pauses, decided WITHOUT
  decidedBy`; ③ all allow (auto-approve, hook never ran) — `all allow —
  auto-approved with the extension's name, never a human pause`; ④ throw =
  ask — `a policy that throws counts as ask — the human flow decides`; ⑤
  ask with no flow = honest denial — `ask with no approval flow configured
  degrades to an honest denial`; ⑥⑦ resume durability with a decide-call
  counter — `a durable APPROVAL executes the call with the policy called
  ZERO times` / `a durable DENIAL emits the denial result with the policy
  called ZERO times`. Deep validation synced at
  `packages/core/tests/event-schema.test.ts` (decidedBy accepted / rejected).

### b. runtime — loadExtensions + AgentSession integration

- `packages/runtime/src/extensions.ts:19-48` — `loadExtensions(dir)`: native
  `import()` of every *.mjs default export (or factory); absent dir = [];
  a bad file or a duplicate name throws with the file name(s) — loud
  startup failure.
- `packages/runtime/src/agent.ts:57-62` — `AgentDefinition.extensions`:
  tools merge into the registry at agent creation — a built-in name
  collision is a loud startup error.
- `packages/runtime/src/session.ts:114-131` — `SessionConfig.extensions`:
  tools join the registry idempotently; hooks compose AFTER the existing
  ones (`composeHooks`, `session.ts:992-1058` — 既有先行: observers all
  run; onUserMessage is a PIPE with veto short-circuit (复审 E1-P2: each
  handler sees the message the previous one left, a null veto ends the
  chain immediately — a later rewrite can never swallow an earlier veto,
  so adding an extension never makes the chain MORE permissive; single
  handler preserved); onPreTool first-decisive-wins; onPostTool folds);
  approvals enter the loop's policy chain (`session.ts:546-549`).
- Tests `packages/runtime/tests/extensions.test.ts` (9) — red first (9
  failures) → green: loader (absent dir, sorted load, factory, bad file,
  syntax error, duplicate name), tools merge + collision, hooks 合成序
  (`extension hooks compose AFTER the agent's own (既有先行)`), approvals →
  chain with decidedBy.

### c. CLI — startup scan + banner + the e2e gate

- `apps/cli/src/index.ts:53-61` — `extensionsDir()`: KISO_EXTENSIONS_DIR
  override, default `~/.kiso/extensions`; scan in `makeAgent`
  (`index.ts:155-157`) — a broken extension fails the process loudly; the
  banner (`index.ts:62-71`) prints `[N extensions: name, ...]`.
- `examples/extensions/safe-defaults.mjs` — the reference extension: allow
  read/list/search, deny `\bgit\s+(stash|reset|checkout\s+--)|rm\s+-rf`
  shell commands with a reason, ask the rest.
- E2E `apps/cli/tests/extensions-e2e.test.ts` — real PTY, real processes,
  real SIGKILL through the CLI's topmost entry (red→green: the extension
  surface was absent, so the driver's needles never appeared). Phase 1: the
  read is auto-allowed (`read_file needs approval` never appears), the
  write IS asked (y injected), the destructive shell is denied (`[Permission
  denied]` reaches the model), and the process is SIGKILLed while a SECOND
  write's pause is pending (a pause is a stable kill point). Phase 2: a
  fresh process resumes — exactly the ONE undecided request is re-presented
  (`(out2.match(/approve write_file/g)).length === 1`), the already-decided
  calls are never re-asked, no uncertain executions, the trajectory
  completes (`done`), both writes landed, and the extension's marker file
  (one line per decide() call, across processes) proves the policy never
  re-runs after the kill.

## 5. Acceptance

1. Core single-turn tests: composition order (deny>ask>allow, ask>allow,
   all allow), throw=ask, decidedBy persisted, resume durability with a
   decide-call counter = 0.
2. Runtime tests: loader loud failure, duplicate failure, tools merge,
   hooks composition order.
3. CLI e2e through the topmost entry with a real kill -9: read auto-allows,
   dangerous shell denied, write still asked; resume never re-asks the
   decided and the policy never re-runs (marker proof).
4. `npm run check` all green — byte discipline / microcompact / kill -9
   gates unregressed (372 tests, core 1,905/2,000, cli 713/1,200).
5. Commit discipline: small commits, English messages; push allowed after
   green; no npm publish (release is the user's decision).

## 6. E2 (2026-08-04, 收尾) — the remaining extension surfaces

- **compaction parameter surface** — landed by 自举 #4 (dogfood), commit
  `679bfa2`: `KisoExtension.compaction?: { thresholdTokens?, keepResults? }`
  supplies the loop's microcompact params when the session sets none
  (`packages/runtime/src/session.ts` `microcompactFor`).
- **systemPrompt append surface** — this round: `KisoExtension.
  systemPrompt?: { append: string }` (`packages/core/src/protocol/
  extension.ts:50-56`) — append-only, never replace (monotonicity: adding
  an extension never removes existing guidance). The session's own prompt
  comes first, then each extension's append in load order,

-joined —
  deterministic (same extensions → same prompt), no appends → byte-
  identical to the extension-less run (`packages/runtime/src/session.ts:996-1002` `composeSystemPrompt`, wired at `session.ts:539-540`).
- Tests `packages/runtime/tests/extensions.test.ts` (red→green, E2-1/E2-2
  failed `"BASE PROMPT"` vs the appended prompt → 17/17): ① `E2-1: a single
  extension's append lands at the END — the session's own prompt FIRST`
  (`BASE PROMPT

EXT APPEND`); ② `E2-2: two extensions join in LOAD
  order, \n\n-separated`; ③ `E2-3: no appends — byte-identical to the
  extension-less prompt`. The "topmost entry" acceptance lands at the
  runtime layer (a real AgentSession + a faux adapter capturing the
  request) — the system prompt is invisible in CLI output, so the CLI e2e
  has nothing to assert; this is the spec's stated deviation, not a missed
  test.
- `npm run check` all green (376+3 tests; core 1,907/2,000, cli 713/1,200).

## 7. 裁决 A (2026-08-04) — E1 ask 语义修正 (core 唯一许可 diff)

**冲突**: ③ MCP 桥的 e2e 要求 mcp__ 工具出现审批提问(ask 档),但 E1 已落地的 ask
路径路由进 `hooks.onPreTool`——CLI 的静态自动策略(`PERMISSION_POLICY` 对无规则
工具 default deny)代答了人,模型收到拒绝,无提问;四包零改动条款下无任何配置面
能改变这一点。

**三方案**: A) core 一处改 ask 路径直达人类暂停(permission_requested +
resolveApproval),绕过 hook; B) 零内核改动,e2e 改断言为"不自动放行"(人根本
见不到外部工具,"必须人工过目"落空); C) CLI 默认 deny→defer(产品级安全行为
变化)。

**裁决: A** — 定性为修正 E1 的 ask 语义,不是给 MCP 开例外: ask 的本义是"必须
由人决定",路由进 onPreTool 让静态自动策略代答了人,语义错在 E1。

**落地** (`packages/core/src/kernel/loop.ts`, core 允许且仅允许此一处 diff;
runtime/cli/tools-node 零改动):
- ask 分支直达人类暂停(`awaitHumanApproval`, 原 defer 暂停机制提取为共享
  helper): `loop.ts:769-787`; hook 门改为 `chainVerdict === undefined`(ask 已
  由人类暂停解决,静态 hook 不再发言,也不二次暂停): `loop.ts:789-808`。
- "ask 无人类流=诚实拒绝"判据由 hooks.onPreTool 改为 resolveApproval。
- 回归钉死: 无扩展场景未知工具仍被 CLI 静态策略 default deny
  (`packages/runtime/tests/extensions.test.ts` — `the CLI's static default
  deny for unknown tools is untouched — denial, never a pause`); ask + hook
  在场但无通道 → 诚实拒绝、hook 零调用 (`packages/core/tests/
  extensions.test.ts` — `裁决 A: ask with a hook but NO approval channel
  still degrades — the static hook never speaks for an ask`)。
- E1 既有测试逐个核对: 全部按新路由成立、零改动 ("ask outranks allow — the
  existing human flow pauses, decided WITHOUT decidedBy" 等; 实施中途曾出现
  双暂停 (d-3+d-5), 系 ask 放行后落入 hook 块二次暂停的实现 bug, 以 hook 门
  修正, 非测试改动)。
- 无扩展时全部行为逐字节不变 (回归测试 + 全量套件 136 core / 122 runtime /
  32 cli 全绿)。

## ③ MCP 桥 (2026-08-04) — 官方扩展,内核零改动

- 新 workspace `extensions/mcp`(private,不发 npm):`@modelcontextprotocol/sdk`
  运行依赖 + esbuild devDep;`npm run build` 产出自包含单文件
  `dist/kiso-mcp.mjs`(SDK 内联,`createRequire` banner 解决 cross-spawn 的
  CJS 动态 require)。core/runtime/cli/tools-node 四包零改动(裁决 A 之外的
  唯一 core diff 即 裁决 A 本身);E1 loader 不改。
- 行为: 工厂读 `${KISO_MCP_CONFIG:-~/.kiso/mcp.json}`;stdio/url 双传输
  (SDK 1.30,headers 经 requestInit);连接失败=软失败,错误聚合进
  `mcp__status`(零参工具,连接态是运行时信息、CLI 无新 UI,用工具自身呈现);
  工具映射 `mcp__<server>__<tool>`(description 原样、parameters 原样、
  text 直通/其他块显式 `[MCP <type> content: <mimeType|kind>]` 文本行、
  isError→isError、callTool 异常→isError+errorKind:"fatal");ctx.signal →
  callTool 的 signal + CALL_TIMEOUT_MS=60s;stdio env 剥离 provider 凭据
  (复制 tools-node #7 清单,注明保持同步)后叠加配置 env(显式优先)。
- 测试: 仓库内 fake MCP server(`tests/fake-server.mjs`,McpServer + stdio,
  echo/env_probe/fail/slow 四工具;注: SDK 1.30 的 registerTool 要 Zod raw
  shape,JSON schema 会被拒);单测 9 个(①schema 原样 ②echo 往返 ③fail→
  isError ④剥离+env 叠加 ⑤坏 JSON/结构非法 throw ⑥缺席配置→仅
  mcp__status ⑦不可达 server 软失败、其余可用 ⑧slow+立即 abort 及时
  isError + ⑤b)—— 红→绿: 首跑 6 失败(connect 崩,根因: Server 类无
  registerTool 需 McpServer + Zod 形状),修复后 9/9;CLI e2e 1 个(真进程,
  穿最上层入口: bundle+safe-defaults 进 KISO_EXTENSIONS_DIR,faux 调
  mcp__fake__echo —— 横幅 `[2 extensions: mcp, safe-defaults]`、ask 档经
  裁决 A 直达人类暂停出现审批提问、y 注入、echo 结果回模型、done)—— 首跑
  红(CLI 路径层级错,`../../` 只到 extensions/),修复后绿。根 `npm run
  check` 已纳入 mcp 的 build+typecheck+test(build 在七包之后;pack/size
  门禁不涉及)。
- 文档: README 新增 MCP 段(stdio/url 配置示例各一、命名空间、审批默认
  ask + 自写 policy 放行示例、软失败语义、mcp__status、构建安装两步、仅
  tools);本 plan 记录 ③。

## ④ subagent (2026-08-04) — 官方扩展,内核零改动

- 新 workspace `extensions/subagent`(private,不发 npm):**零运行依赖**
  (child_process/fs 均内建)——不需要 esbuild,`src/kiso-subagent.mjs` 即最终
  产物,build 仅拷贝到 dist/(与 mcp 消费方式对齐)。四包 + E1 loader 零改动。
- `delegate` 工具: 参数 schema { tasks: [{role: explorer|implementer|
  reviewer|tester, task(minLength 1)}] },1..8 项,并发上限 4(runLimited);
  KISO_SUBAGENT_DEPTH>=1 时工厂返回 {name:"subagent",tools:[]}(深度护栏,
  禁嵌套)。每任务 spawn 子 kiso: process.execPath + (KISO_SUBAGENT_BIN ??
  process.argv[1]);子 session id = sub-<父sessionId>-<序号>-<role>(父 id 由
  KISO_SESSION_ID 或 sessions 目录最新 mtime 发现,兜底 "parent");stdin 写
  "任务文本\nexit\n" 后关闭;超时默认 10 分钟(KISO_SUBAGENT_TIMEOUT_MS 可
  覆盖),超时或 ctx.signal abort → SIGKILL 子进程组(detached)。
- 子进程 env 显式构造 {...process.env, KISO_SUBAGENT_DEPTH: +1,
  KISO_EXTENSIONS_DIR: 角色策略临时目录}——provider 凭据随 process.env 显式
  下传(注释写明与 #7 的区别: shell=任意命令默认剥离;delegate=人工 ask 批准
  的受控 spawn)。角色策略(临时 .mjs,子进程专用): explorer/reviewer →
  read/list/search allow 其余 deny(带 reason);implementer/tester → 六件套
  allow;只 allow/deny 永不 ask(headless 死锁,注释写明);临时目录进程退出后
  清理。
- implementer 隔离: `git worktree add --detach`(系统临时目录),子进程 cwd=
  worktree;退出后 `git -C <worktree> add -N . && git diff`(含 --stat 头,
  add -N 让新文件进 diff)收进结果;有 diff 保留并回传路径、无 diff 删除;
  非 git 仓库 → 诚实失败。explorer/reviewer/tester cwd=父 cwd。
- 结果提取(硬条款): 子进程退出后从子 session JSONL 提取(store 记录
  {runId,ts,event} 解包 + 短暂重试,因 exit 事件可能早于终笔写入一拍)——terminal
  outcome、最终 assistant 文本(投影等价解析)、工具调用计数;stdout 仅作诊断
  (非零退出或 JSONL 缺失时附上)。content=逐任务小节,部分失败不整体失败,
  全失败 → isError:true。审批零放行——delegate 落 ask 档(裁决 A 后真到人)。
- 测试(红→绿): 单测 7 个(①深度护栏 ②角色策略生成物 explorer deny write/
  allow read + 全文无 "ask" ③JSONL 提取(伪造完成子 session)④慢子任务+短
  超时→及时 isError+子进程组已死 ⑤6 任务并发峰值 ≤4(探针)⑥implementer
  worktree 有 diff 保留/无 diff 删除 ⑦非 git 诚实失败)——首跑 4 失败,根因:
  runProcess 的 try/finally 立即清定时器、提取未解包 store 包装、测试断言
  过严;修复后 7/7。CLI e2e(真进程穿最上层入口): 父 kiso(faux 脚本调
  delegate 一个 explorer 任务)+ 扩展目录含 subagent+safe-defaults → 横幅
  [2 extensions: safe-defaults, subagent]、delegate 审批提问出现(ask 档,
  裁决 A)、y 注入、子任务跑完、JSONL 结果小节回模型、done;子 session JSONL
  存在且有 terminal(durable 卖点钉死)。深度 e2e: 子进程(faux 脚本调
  delegate)→ "Unknown tool: delegate"(护栏在子进程生效)。根 check 纳入
  subagent build+typecheck+test。
- 文档: README 新 Subagent 段(角色表、并发/超时、worktree 语义、深度护栏、
  durable 子 session 卖点、凭据下传与 #7 区别、安装两步);本 plan 记录 ④。

## ⑤ skills (2026-08-04) — 官方扩展,内核零改动

- 新 workspace `extensions/skills`(private,不发 npm,零运行依赖,源即产物
  build 仅拷贝——subagent 同款)。工厂扫 `${KISO_SKILLS_DIR:-~/.kiso/skills}/
  <name>/SKILL.md`:frontmatter(--- 包围的 YAML 子集,只认 name/description,
  手写解析 ≤20 行,零依赖);name 缺省用目录名;description 必需且 ≤200 字符
  (超长截断加注);无/空目录 → {name:"skills",tools:[]} 不报错;损坏(无
  frontmatter)→ 跳过 + 索引尾部警告行(软失败,与 mcp 同哲学)。
- tier 1(常驻):systemPrompt.append = "Available skills (load with
  read_skill):" + 逐行 "- <name>: <description>",按目录名排序,确定性。
  tier 2(按需):read_skill {name} → SKILL.md 全文(≤32KB 截断加注);未知名 →
  isError + 现有名单(诚实错误可行动);skill 目录其他文件不自动加载——正文
  让模型用 read_file 按相对路径取(渐进第三层,零新机制,README 说明)。
  发现#8:无持久资源,dispose 显式一行说明不需要。
- safe-defaults 更新(本轮唯一 extensions/ 外改动):read_skill 入 allow
  清单(读用户自装本地文档,信任级别同 read_file)。
- 测试(红→绿,进根 check):①索引入 systemPrompt(两 skill 排序确定)
  ②read_skill 往返全文 ③未知名诚实错误含名单 ④损坏 SKILL.md 软失败+警告
  行 ⑤description 超长截断 ⑥空/缺目录零 skill 不报错——7 单测 + 1 CLI e2e
  (真进程:两 skill,faux 调 read_skill → safe-defaults 自动放行(无审批提
  问)、正文回模型、done;横幅 [2 extensions: safe-defaults, skills])——首跑
  即绿;safe-defaults 测试 import 示例断言 read_skill allow。
- 文档:README Skills 段(SKILL.md 格式、两层渐进+第三层 read_file 约定、
  CC skills 兼容性——frontmatter name/description 子集兼容,CC skill 可直接
  放入)+ Comparison 段(能力矩阵与 bench 数字并排,诚实脚注保持);
  plan 记录 ⑤。范围外:allowed-tools/model 字段、skill 市场/安装命令、
  bench 新任务(T4 另轮)、会话树。

## 8. What was NOT done (explicitly out of scope)

- registerCommand / shortcuts / renderers / sendMessage-like APIs;
- project-level extensions; MCP; subagents;
- systemPrompt replace / any template engine;
- any new npm dependency; any change to the core line cap.
