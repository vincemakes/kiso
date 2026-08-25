# kiso

```
█ █ ▀█▀ █▀▀ █▀█
█▀▄  █  ▀▀█ █ █   the coding agent that survives kill -9
▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀   v0.15.5
```

(上面的块状字母是 `assets/logo.svg` 的像素形态——一个 8×8 的 K,底行是这个框架得名的基岩基础。)

[English edition](README.md)

**kiso code = 挺得过 `kill -9` 的编码 Agent。** 被打断的执行会得到人类裁决,审批跨进程持久,每个事件都可审计、可重放——完整轨迹就在磁盘上,`kiso resume` 精确续上它。证明是脚本化的:`scripts/demo-kill9.sh` 在工具执行中途 SIGKILL 掉 Agent 的整个进程组,然后干净地恢复会话,连跑两次——与下方 kill -9 一节在 `apps/cli/tests/kill9.test.ts` 里端到端自动化的是同一个故事。

**kiso 是一个持久化 TypeScript Agent 框架,用于构建可以暂停、崩溃、恢复并保持正确的编码 Agent。** 一个小内核拥有真正重复的部分;包在它之上无限制生长。面向想要真正 Agent 框架的 TypeScript 开发者——事件溯源会话、持久化人工审批、带持久化回执与显式不确定性消解的崩溃一致工具执行——而不要一个 5 万行的运行时。

**数字,同一个模型、同一批任务**(2026-08-16 三方对照,成本加权输入):T3 跨文件重命名所需输入 token **比 pi 少 2.55×、比 Claude Code 少 32×**,任务产出完全相同。完整表格与诚实脚注在[对比一节](#对比)。

**内核 2,000 行、由 CI 强制**——不能超过 2,000 行;超过就生长一个包。见[规则](#规则)。

**持久执行契约已冻结、由门禁强制**——会话格式与恢复语义冻结为契约;每条不变量都有可执行门禁,跑在 `npm run check` 里。见[持久执行契约](#持久执行契约)。

从源码层面研读 Claude Code、[pi](https://github.com/badlogic/pi-mono) 与 [oh-my-pi](https://github.com/can1357/oh-my-pi) 蒸馏而来——并在其已验证的前身(mauri,Python)上把三个 Agent 产品跑进生产。

每个设计决策都随附一份 ADR,解释**为什么**,以及**何时推翻它**。

## 为什么持久——持久化运行时

> **Agent 会崩溃。副作用不会回滚。Kiso 让执行持久化。**

编码 Agent 是一个经由会犯错的模型驱动副作用——文件编辑、shell 命令、远端调用——的进程。把 Agent 当作"一定能存活"是把演示变成工具;把崩溃当作"一切都会回滚"是把恢复变成猜测。Kiso 的全部设计是第三条路:轨迹本身就是持久化工件,所以一个被杀掉的进程只损失进程本身。

- **事件溯源会话。** 每次运行都是 `$KISO_HOME/sessions` 下带 `seq` 编号的追加式 JSONL 流。模型看到的消息是日志的纯函数(ADR-0002)——会话是一个可读、可重放、可审计的文件,而不是随进程消亡的运行时状态。`kiso resume <id>` 在新进程里连续地续上被打断的轨迹。
- **持久化人工审批。** 裁决——allow、deny、rerun、abandon——是持久化事实,并记录是谁作出的(ADR-0024)。杀掉进程后,已裁决的调用永远不会被重问:恢复应用持久化裁决,策略的 `decide` 不会为已裁决的调用重跑。
- **崩溃一致执行。** 工具调用携带以 `executionId` 为键的持久化回执(ADR-0025)。已确认的成功永不重跑;启动过但从未上报的执行是 `uncertain`,阻塞到人类裁决——对"副作用到底落没落地?"的唯一诚实回答。随后原始运行完成;它不重放。

后果:会话、裁决与副作用的真相在崩溃前就已落盘——下一次 `kiso resume` 只问崩溃窗口使其不可知的东西。下方 kill -9 一节展示脚本化证明。

## 持久执行契约

**会话格式是冻结契约、由门禁强制**——不是可以漂移的版本化 API。冻结(ADR-0051,2026-08-12 经评审裁决)给每种落盘事件形状归类,并把下列不变量钉进跑在 `npm run check` 里的可执行门禁。规范名(canon)在 ADR-0047 §7 / ADR-0051 §7;本 README 使用下面的公开名(public names)。

| 公开名 | 保证 |
| --- | --- |
| **Prefix-Complete Recovery**(前缀完备恢复) | 会话总能从其持久前缀恢复——真实发布 bin 写出的每个前缀都能加载、校验、投影、推导出恢复计划(代际门禁,≥4 个真实代际) |
| **Ambiguity Never Auto-Repeats**(歧义永不自动重跑) | 已启动但从未上报的执行保持为人类裁决——永不自动重跑,永不静默重问 |
| **Turn Commit**(回合落定) | 一个模型回合只有在其流干净耗尽、且恰好带一个结构兼容的 stop 时才算数——收到 stop 不等于落定,能改变你世界的处理器绝不在该边界之前启动,而抢在边界之前跑完的无害调用也永远不能让一个无效回合变得有效(ADR-0052) |
| **Committed Intent Before Effect**(意图先于副作用落定) | 工具调用在任何副作用之前先被裁决并持久化;审批是持久事实,不是记忆 |
| **Durable Start Before Side Effect**(持久 STARTED 先于副作用) | 处理器在其 STARTED 回执持久化之前绝不运行——崩溃不会留下未上报的副作用 |
| **Stable Intent Identity**(意图身份稳定) | 三种身份(callId / invocationSeq / executionId)绝不混同;派生状态永不持久化 |
| **Single Durable Truth**(唯一持久真相) | 事件流是唯一真相;其余全部由它派生,每个事件都归内核所有 |
| same-facts-same-projection(同事实同投影) | 同一前缀在任一版本内投影出同一字节(提示词缓存字节纪律);模型请求面只经声明式 supersession 演化(ADR-0051 Amendment 3) |
| exactly-one-terminal(恰一个终态) | 每次运行收敛于恰一个终态——即它的最后一条事件 |

契约的 ask 语义:**一个待决 ask 存活,当且仅当其调用未被作废、且推导仍能执行它**——审批裁决是持久的,无论由人类直接裁决,还是由人类安装的策略代为裁决(ADR-0051 §8)。

Turn Commit 自身的证明是两个崩溃前缀的字节比对,二者恰好相差一条持久 stop:没有它的那个在恢复时永不执行,有它的那个恰好执行一次。

## 规则

> 内核永远不会超过 **2,000 行**。任何把它推超的 PR 都会被关掉,无论特性多好。CI 在安装任何依赖之前强制执行。
>
> 需要更多,就生长一个包。这就是重点。
>
> 门禁是快照纪律,不是自我调节的棘轮:重新校准只发生在经裁决的裁定、且只为规范强制的增长——常设逃生舱是抽取(EXTRACTION)(ADR-0043)。

```
$ npm run size

core:
  packages/core/src/kernel/loop.ts    742
  packages/core/src/protocol/events.ts 438
  packages/core/src/kernel/project.ts 353
  ...
  total                               1971  / 2000
  ✓ 29 lines of headroom remaining.

cli:
  apps/cli/src/chat.ts  478
  apps/cli/src/index.ts 382
  ...
  total                 1870  / 1920
  ✓ 50 lines of headroom remaining.

tui:
  packages/tui/src/compositor.ts 986
  packages/tui/src/editor.ts     535
  ...
  total                          1761  / 2400
  ✓ 639 lines of headroom remaining.

tui-cells:
  packages/tui-cells/src/components.ts 618
  ...
  total                                1116  / 1280
  ✓ 164 lines of headroom remaining.
```

(上方规则约束的是**内核**——2,000 硬线就是设计本身,不动。产品面自 ADR-0043 Amendment 8 起走另一套制度:cli/tui/tui-cells 的数字是**参考数字**,每次 check 照常打印(可见性保留)但永不拦截——它们的保护移交给架构红线(TUI 永不拥有持久真相、TUI 状态可丢、交互必有 PTY 证明、公开面有 surface 门)与每个 UX 轮 spec 必答的四问门:是否减少人的摩擦 · 是否保全真相语义 · 是否新增需先测量的租金 · 能否确定性 PTY 测试。修正案史——抽取逃生舱、历次重校准——在 ADR-0043。)

注释不计入。自由解释;精简实现。

## 这是什么

两层框架:

| 层 | 拥有 |
|---|---|
| **core**(`@vincemakes/kiso-core`,≤ 2,000 行) | L1 协议(带 `seq` 的事件和类型 · 消息联合 · 适配器契约)· L2 内核(循环 · 钩子 · 压缩 · 模式 · 权限)· L3 工具(契约 · 注册表 · 真实 JSON Schema 校验)· L7 评估钩子(交付真相) |
| **packages**(无上限) | `@vincemakes/kiso-evals`(faux provider · 事故夹具 · 契约测试)· `@vincemakes/kiso-provider-anthropic` · `@vincemakes/kiso-provider-openai` · `@vincemakes/kiso-runtime`(持久会话、审批)· `@vincemakes/kiso-tools-node`(文件/搜索/编辑/shell)· `@vincemakes/kiso-tui`(纯终端层——单元格渲染器、坞、原始编辑器、diff;零运行时依赖,输入即数据 / 输出即字节——可独立复用,API 仍为 0.x 语义)· `@vincemakes/kiso-tui-cells`(从 tui 抽取出的组件单元格渲染器——ADR-0041 逃生舱)· 四个官方扩展(`@vincemakes/kiso-mcp-ext` · `@vincemakes/kiso-skills-ext` · `@vincemakes/kiso-subagent-ext` · `@vincemakes/kiso-task-ext`——前三者内置在 CLI,task 为 opt-in,见扩展)· `@vincemakes/kiso-code`(旗舰编码 Agent) |

内核保持内核:它不为跨产品重复的东西作决定。其上的框架才是产品形态能力生长的地方——这个生长是重点,不是违规。包经由事件流与钩子对话,绝不经过中央枢纽。见 ADR-0021。

每一层免费获得两个属性:

- **可重放轨迹**——每个事件携带单调 `seq`;一次运行是 `seq` 0..N 的重放。会话恢复、评估夹具、增量 UI 与技能蒸馏消费同一条流。见 ADR-0002。
- **诚实终点**——每次运行恰好以一个 `Terminal` 事件结束;API 错误永远不会顶着 `completed` 的理由。见 ADR-0004。

## 核心不是什么

循环*业务逻辑*。UI。权限策略。计费。技能内容。检索。这些不是核心的职责——它们住在包里,2,000 行上限在那里不约束它们。替你决定这些的核心是一坨泥球,而泥球是你最终要与之搏斗的东西。

## 环境要求

- **Node ≥ 22**(各包的 engines)。
- **python3**——运行时会话存储用一个极小的 `python3` kernel-flock 助手保持跨进程单写锁(POSIX 建议锁;macOS/Linux)。已知债务,来自外部评审:Node 侧锁可以去掉该依赖——store 级 Lock Adapter 注入是 1.0 前置(见 `TODO.md` 与 `docs/reviews/2026-08-06-external.md`)。

## 使用

```ts
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
import Anthropic from "@anthropic-ai/sdk";

const agent = createAgent({
  model: "claude-sonnet-5",
  tools: [
    defineTool({
      name: "add",
      description: "Add two numbers",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      execute: async ({ a, b }) => ({ content: String(a + b), isError: false }),
    }),
  ],
  store: new SessionStore("./sessions"),          // append-only JSONL
  adapter: createAnthropicAdapter(new Anthropic()),
});

const session = await agent.session({ id: "demo" });
for await (const ev of session.run("What is 2+3?")) {
  switch (ev.type) {
    case "text_delta": process.stdout.write(ev.text); break;
    case "terminal": console.log("\n", ev.outcome.kind); break;
  }
}
```

这就是 `examples/hello-agent.mjs`(那里是 faux 适配器——零密钥),消费者冒烟测试在干净工程里对着打包 tarball 逐字运行它。

- 包构建为纯 ESM JavaScript + `.d.ts`——安装后的产物跑在任意 Node 工程上,无 tsx、无源码访问(`scripts/smoke.mjs` 每次 check 在干净临时工程里证明)。
- `npm run demo` 跑原始循环 REPL;旗舰编码 Agent 是 CLI。
- `@vincemakes/kiso-evals` 里的每个夹具都是真实生产事故(uooki,2026);循环对它们得到证明,而不只是快乐路径——且夹具跑在真实会话运行时上,而不是测试套件。

## 支持

Node **>= 22**(OpenAI 兼容 provider 与 CLI 在 `engines` 声明)。

## CLI——旗舰编码 Agent

CLI 是一个真正的 npm 包——全局安装,或直接运行:

```
npm install -g @vincemakes/kiso-code
kiso chat          # 全局安装后,命令就是 `kiso`
npx @vincemakes/kiso-code chat   # 或不安装直接跑
```

(仓库内,`npm run cli` 运行同一二进制。)命令集:

```
kiso [sessionId]               interactive session (default command)
kiso chat [sessionId]          same as above
kiso resume                    pick a session to continue (the picker)
kiso resume <id> [prompt]      continue a session in a new process
kiso sessions                  list durable sessions, with their state
kiso help                      this help
```

- **导航(0.10.0)。** 不带 id 的 `kiso resume` 会打开一个选择器:每个会话一行,
  `↑↓` 走动、输入即过滤、`⏎` 续上、`esc` 离开。每行都带一枚**持久性徽章**——
  它是 kiso 真正会恢复进去的状态,只从该会话自己的持久日志读出:

  | 徽章 | 含义 | `kiso resume` 会做什么 |
  |---|---|---|
  | `✓` | 运行干净结束 | 从一个已了结的会话继续 |
  | `✗` | 运行以别的方式结束(错误、中止、超轮次) | 从它停下的地方继续 |
  | `▌` | **没有 terminal 事件——运行中途被打断** | 从持久前缀精确续上该轨迹 |
  | `?` | uncertain 账本非空 | 先请你对被打断的副作用作出裁决 |
  | `◌` | 有没人回答的审批请求 | 把那个问题重新摆到你面前 |

  `kiso sessions` 在终端上打印同样的行(它的**管道**输出不变——那是机器接口)。
  不带参数的 `/model` 会在你配置的 profile 上打开同一类选择器。
- 工具:读文件 · 列目录 · 搜索文本 · 写/编辑文件 · shell。写与 shell 在审批策略之后:运行**暂停**,询问,持久化裁决,恢复同一运行(ADR-0024)。
- **审批是选择,不是填表(0.12.0)。** 暂停时展示完整调用——完整命令、完整 diff,永不截断——外加一个带高亮条的列表。高亮条默认停在 **Yes, run it** 上,所以最短路径是*看一眼,按回车*:一个键,零打字。`↑↓` 移动高亮条,**点击某一行即选中该行**,数字键直接选中对应行,`esc` 取消。打字只存在于一个选项之后——*No, let me tell it what to do instead*——你写的内容会发给模型,由模型提出新的调用。选项 2 授予该工具的**持久**免问规则:它写出一个人类可读、人类可删的扩展文件,删除该文件即撤销路径。鼠标上报仅在列表打开期间启用,并在每条退出路径上复位——包括启动时的防御性复位,因为被杀死时面板仍打开的进程无法自我清理。
- **按需要更安全的方案(0.12.0)。** 选项 3 向模型索取两到三个更收敛的替代调用,以同样的列表形式呈现,每条带一行理由。选中其一即"带指示地拒绝"原调用,模型据此提出新调用,面板以 `(amended)` 标记重新呈现。代价是**按下才发的一次请求**——从不询问的会话不会产生任何此类请求,而真正发出的那一次在 trace 中可见(`purpose: "safer-options"`,并带自己的 run id),因此成本可审计而非口头承诺。它不发送任何工具、不发送对话历史:租金仅为它自己的短提示词。若答复无法解析,它只说一行,所有原始选项照旧——绝不编造替代方案。
- **不可逆删除会明说。** 四类命令各带一行黄字,点名被删对象:`rm -rf`(列出目标)、`git checkout --`、`git reset --hard`、`git clean -f`。其余命令一律不提示——对每条危险命令都告警,只会训练眼睛跳过告警。
- **范围化读取(0.1.27,token 轮):** 读取可设范围——`read_file` 接受 `offset`/`limit`(1 基行),大文件默认只返回头部 200 行,`search_text` 上限 50 条摘录,`list_dir` 上限 200 条。每次截断都带可执行的续读提示(`… N more lines (call again with offset=…)`、`… +N more matches (narrow the pattern)`)——模型总有确定性路径拿到完整内容。系统提示引导在一轮内批量独立调用(并行执行让它很快)、先定位再读、永不重读未变的文件。
- 会话是 `$KISO_HOME/sessions` 下的追加式 JSONL——退出、重启、`kiso resume <id>`,对话以连续 seq 继续。
- 开箱即有无密钥 faux 模式;`ANTHROPIC_API_KEY`(或 `OPENAI_API_KEY` + `OPENAI_BASE_URL`)切换真实 provider。
- 被打断的副作用在恢复时浮出(`⚠ interrupted execution`)并阻塞到人类消解——已确认的成功永不重跑。

### 模型配置(`~/.kiso/config.json`,0.1.23)

配置面(ADR-0045)持有命名模型 profile——schema v1,凭据永不入内(profile 只点名持有密钥的 env 变量)。优先级:**flags > env > 工程 config > 用户 config > 默认**;损坏的配置文件响亮失败并点名文件。

```jsonc
// ~/.kiso/config.json
{
  "model": "deepseek",                       // the startup profile
  "models": {
    "deepseek": {
      "kind": "openai-compat",               // or "anthropic"
      "model": "deepseek-v4-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY",       // the key's env var — never the key
      "baseUrl": "https://api.deepseek.com"  // optional
    },
    "claude": { "kind": "anthropic", "model": "claude-sonnet-5", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "mode": "default",                         // manual/default/accept-edits/plan/bypass
  "contextWindow": 160000,                   // tokens
  "autoCompact": { "thresholdRatio": 0.8 },  // opt-in, env KISO_AUTO_COMPACT wins
  "projectTrust": "ask"                      // "ask" | "never" — no "always"
}
```

- `kiso --model deepseek chat`——flag 胜过一切;`provider/model` 直写也可(`--model openai-compat/gpt-4o`)。
- 会话内 `/model` 列出各 profile(每个标注可用 / 不可用——未设置的 apiKeyEnv 永不崩溃),并切换会话后续回合的适配器(由 NoticeCell 记录)。
- env 变量未设置的 profile 在切换时被响亮拒绝——config 永不存密钥,所以缺失 env 是诚实的"未配置"。
- 工程自身的 `.kiso/config.json` 乘 E3 信任门:已授予工程的 config 生效,未信任的永不读取(其摘要覆盖 config 文件)。
- **从 kiso-ds wrapper 模式迁移**(导出 `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` 的 shell wrapper):wrapper 仍可用——env 层在链上第二位——但上面的 config profile 是替代形态(类型化、运行时可切换、密钥任然留在你的环境)。wrapper 模式是遗留,受支持。

### `kill -9` 测试

这是产品的脚本化证明,在 `apps/cli/tests/kill9.test.ts` 端到端自动化(真实 PTY、真实进程、真实 SIGKILL——无 mock、无信号模拟)。它正是 `kill -9` 用户经历的:

```
$ kiso chat k9                        # faux trajectory: edit f1.txt → slow
                                      # shell (sleep 30 && touch marker.txt)
                                      # → edit f3.txt; approve both tools
...                                   # the shell is mid-execution...
$ kill -9 -PGID                       # the agent's whole process group —
                                      # and the shell's own detached group
$ kiso resume k9
⚠ interrupted execution: shell (ex-12) — rerun it? (y)es / (n)o y
  rerun
→ edit_file({"path":"f3.txt",...})    # the ORIGINAL trajectory continues
```

测试在 phase 1(kill)之后对磁盘与文件系统的断言:

- 事件流无损坏加载;
- **恰好一个**执行是 `uncertain`——shell 启动了、从未上报;
- `marker.txt` 不存在;`f1.txt` 在 kill 前被编辑;没有 terminal 写入。

phase 2(恢复,新进程,零人工输入)之后:

- 呈现不确定裁决问题,注入 `rerun`;
- 第三次编辑发生——轨迹继续,不重放;
- terminal 落地且持久;`marker.txt` 仍不存在;
- 磁盘上恰好一条 `tool_execution_resolved`。

同一故事作为脚本化演示:`scripts/demo-kill9.sh` 对着发布二进制运行——连跑两次,每次全新 `KISO_HOME`,全绿。

## MicroCompact——零 API 上下文缓解

**CLI 默认开启**:阈值 = 模型窗口一半(`KISO_CONTEXT_WINDOW` 覆盖也可——200k 窗口 → 100k token)。库用户用 `createAgent` 里的 `microcompact: { thresholdTokens }` 选择开启。当会话的投影上下文越过阈值,循环向流里追加**一个** `microcompacted` 边界事件——绝不是逐回合渐进清除。投影随后确定性推导压缩视图:比边界旧、且工具在白名单(`read_file`、`list_dir`、`search_text`、`shell`)里的工具结果,替换为固定占位符 `[old tool output cleared: <tool> <arg>]`。write/edit 输出永不触碰;带 `do-not-compact` 标签的结果永不触碰;近期回合原样保留。

决策是持久化事实,不是运行时状态:同一批事件总是推导出相同的消息——崩溃/恢复重放边界,落在逐字节相同的投影上(见下方字节纪律)。无计数 API、无价目表、压缩本身不花 token。

**模型摘要层(`/compact`,ADR-0044)**:机械清除只作用于工具结果——对话本身仍会长。`/compact`(把较早的对话总结掉以释放上下文)把覆盖回合——最近 4 个回合之前的全部、从上次摘要点起——经由会话自身适配器的循环外调用,压进一个持久化 `summarized` 事件。投影把覆盖范围替换为一条助手摘要消息;原始事件永远留在磁盘(原始日志、/last、/think 仍可达);持久化前的崩溃是"什么都没发生",之后恢复则投影压缩视图。经典自动压缩(`config.compaction` + `compacted` 事件)被 ADR-0044 退役进边界——带 `compacted` 事件的旧日志永远原样重放。(矩阵注:上下文经济 ◐→●——◐ 是纯机械清除,0.1.19;● 加上模型摘要,0.1.20。)

端到端接线并有测试验证:真实运行时上跑的会话把边界记录到磁盘,重载会话投影占位符(`packages/runtime/tests/microcompact-e2e.test.ts`);CLI 用极小窗口恢复超阈值会话,边界落地(`apps/cli/tests/microcompact-cli.test.ts`)。

## 提示词缓存字节纪律

契约:同一事件流前缀投影出**逐字节相同**的消息前缀(`JSON.stringify`,逐元素)。新事件只在尾部改变投影——唯一例外是 `microcompacted` 边界,它本身是持久化事实,其重放每次推导同一投影。契约由三个回归测试钉死(`packages/core/tests/prompt-cache.test.ts`):① 同一日志两次投影相同,② 追加一个回合后旧前缀逐字节不变,③ microcompact 边界经 JSON 往返(崩溃 + 恢复形态)后逐字节重放相同。

## 扩展——超越人类的审批策略

**四个官方扩展内置在 CLI**:`mcp`、`skills`、`subagent`(0.1.45+)在启动时经模块导入注册——全新安装零磁盘设置即拥有这三个;**`ask`**(KC3.5)在交互式终端上加入它们,横幅显示 `[4 extensions: built-in: mcp, skills, subagent, ask]`。管道或无头会话没有人能回答问题,因此根本不加载 `ask`:横幅仍是 `[3 extensions: built-in: mcp, skills, subagent]`,工具表里也永远没有 `ask_user`——没人为一个无法被回答的问题付提示词租金。

第四个官方扩展 **task**(耐久长程工作记忆)自 **0.3.0 起为 opt-in**:13 个连续真 provider 会话上它每请求付租却一次未调用——连规划指南自家设计的触发场景都没激活(实测死重,finding E5-F1/E5-F2)。能力保留:按下方 Task 一节安装即可。

内置之上,经典层仍按级联顺序加载:**内置 → 用户 → 工程**。扩展是一个普通 `.mjs` 文件——无 SDK、无构建步骤。kiso 启动时扫描 `~/.kiso/extensions/*.mjs`(`KISO_EXTENSIONS_DIR` 可覆盖),并在启动横幅中点名加载了什么。加载是**响亮**的:坏文件或重名扩展在启动时点名文件失败进程——无法加载的扩展绝不能静默改变行为。

- **用户扩展可以按名 shadow 内置**——响亮地:内置离开已加载集合,横幅丢弃它(`[extensions] user extension "mcp" shadows the built-in — the built-in is not loaded`)。你的副本,你的规则。
- **工程扩展不可 shadow 内置**——与内置同名的工程扩展被响亮拒绝:你克隆的仓库绝不能静默替换 CLI 自身的行为。

契约是纯类型(`packages/core/src/protocol/extension.ts`):每个文件的默认导出就是扩展,或返回扩展的工厂。

```ts
export default {
  name: "safe-defaults",              // unique per installation
  hooks: { /* ... */ },               // optional — compose AFTER the harness's
  tools: [ /* ... */ ],               // optional — merged into the registry
  approvals: [{ decide(call, ctx) { /* ... */ } }], // optional — the policy chain
  compaction: { thresholdTokens: 50_000 }, // optional — supplies the loop's
                                        // microcompact params when the
                                        // session sets none
  systemPrompt: { append: "..." },   // optional — EXTEND the system prompt
};
```

`systemPrompt.append` 追加到会话自身系统提示的末尾(`\n\n` 连接,按加载顺序)——只追加、绝不替换:加扩展永远不会移除既有指引(与审批链和否决短路相同的单调性)。组合是确定性的——同一扩展列表总是逐字节组装出同一提示。

策略的 `decide` 返回 `{ action: "allow" }`、`{ action: "deny", reason }` 或 `{ action: "ask" }`。链在**人类审批流之前**运行,并跨所有已加载策略组合:

- **deny > ask > allow**——任一 deny 胜出(第一个 deny 的理由到达模型);否则任一 ask 直接进入人类审批暂停(CLI 提示 `approve ...? (y/n)`——绝不经过静态策略钩子,它不能替人类作答;ruling A,E1 ask 语义修复);只有**全 allow** 链自动放行。
- 抛异常的策略计为 **ask**;没有配置审批通道(无 `resolveApproval`)的 `ask` 降级为诚实拒绝——按通道的存在与否判定,而非钩子。
- allow/deny 以 `permission_decided` + `decidedBy: <extension>` 持久记录——绝不是人类暂停。策略裁决是像任何人类决定一样的持久化事实:`kill -9` 掉 Agent,已裁决的调用永不重问——新进程恢复应用持久化裁决,策略的 `decide` 不再为它们重跑。

### safe-defaults——教程

`examples/extensions/safe-defaults.mjs` 是参考扩展:直接放行廉价的只读工具,拒绝最危险的 shell 命令,其余都问人类。一行安装:

```
mkdir -p ~/.kiso/extensions && cp examples/extensions/safe-defaults.mjs ~/.kiso/extensions/
kiso chat     # → [4 extensions: built-in: mcp, skills, subagent · safe-defaults]
```

现在每个 `read_file`/`list_dir`/`search_text` 自动放行(无提示);匹配 `\bgit\s+(stash|reset|checkout\s+--)|rm\s+-rf` 的 `shell` 命令被拒绝,理由回喂给模型;每次写入与其余每个 shell 命令仍问人类。门禁在 `apps/cli/tests/extensions-e2e.test.ts` 自动化——真实 PTY 会话、真实 `kill -9`:读自动放行、写被问、破坏性 shell 被拒,恢复只重呈唯一未决的请求,而扩展自身的调用日志(每次 `decide` 调用写一个标记文件)证明策略跨 kill 永不重跑。

## 模式——五级内置审批档

`/mode` 切换整个会话的审批姿态。五级,构建在**上面的扩展链之上**——内核不动:每级是进程内 `mode:<name>` 扩展(链头),所以其自动化裁决记录 `decidedBy: "mode:<name>"`——审计轨迹点名作裁决的档位,正如点名扩展。

| 档位 | 语义 |
|---|---|
| `default` | 读放行;write/edit/shell 问人类;扩展工具是扩展自己的事(本档不干预) |
| `manual` | 每个工具都问人类 |
| `accept-edits` | `default` + write_file/edit_file 放行 |
| `plan` | read/list/search/read_skill 放行;其余全部以 `plan mode: read-only` 拒绝(拒绝理由引导模型输出计划;启动提示加计划指令) |
| `bypass` | 全部放行——但用户扩展的 `deny` 仍胜(链的 deny>ask>allow 单调性;bypass 不能覆盖扩展) |

- `/mode` 打印当前档位与列表;`/mode <name>` 立即切换(变更作用于下一个工具调用),在会话正文留一条 notice 行。启动:`--mode <name>` 或 `KISO_MODE=<name>`;默认 `default`。
- 状态栏在暗色状态行里直接写出当前档位——`plan` 显示为 `plan (read-only)`,约束是写出来的,不是编码进色相的(KC3:身份是单色的)。
- 这是 kiso 对 Claude Code 权限模式的回答:CLI 侧、架在同一扩展审批链上的策略层——用户扩展对每个调用保留投票权,其 deny 永远胜。

## MCP——通过 MCP 桥接外部工具

**内置在 CLI**——每个 `kiso chat` 都已加载 `mcp__` 桥,无安装步骤。`extensions/mcp` 是官方扩展的源码:自托管或定制,构建并把 `dist/kiso-mcp.mjs` 复制进 `~/.kiso/extensions/`(用户副本响亮地 shadow 内置)。桥是普通扩展——自包含单文件(MCP SDK 内联)——四个内核包不动:

```
cd extensions/mcp && npm install && npm run build   # 仅为自托管/定制
cp dist/kiso-mcp.mjs ~/.kiso/extensions/
```

配置:`$KISO_MCP_CONFIG`(默认 `~/.kiso/mcp.json`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": { "SOME_VAR": "1" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    },
    "legacy": { "command": "node", "args": ["server.js"], "disabled": true }
  }
}
```

- 每个 MCP 工具都变成名为 `mcp__<server>__<tool>` 的 kiso 工具;输入 schema 原样透传。`mcp__status`(零参数)报告每个 server 的连接状态与错误——连接是加载时事实,CLI 没有新 UI,所以工具自己呈现。
- 连接失败的 server 是软失败:其错误落在 `mcp__status`,其余 server 继续工作。缺失配置文件 = 无 server(绝不是错误);损坏配置在启动时响亮抛出(E1 加载器约定)。
- stdio 子进程被剥掉 provider 凭据(与 shell 工具同一清单——`ANTHROPIC_/OPENAI_` KEY/BASE_URL/MODEL 加每个 `*_API_KEY`/`*_AUTH_TOKEN`)加上配置的 `env`——显式 env 胜出,可故意重新加回变量。
- 调用携带运行的 abort 信号与 60s 超时——被打断的调用返回错误,绝不挂起。
- **审批:无自动放行。** `mcp__` 工具落在 ask 档——外部工具必须先过人类评审。写自己的策略扩展放行特定的:

```ts
export default {
  name: "allow-my-mcp",
  approvals: [{
    decide: (call) => call.name === "mcp__filesystem__read_text_file"
      ? { action: "allow" } : { action: "ask" },
  }],
};
```

仅工具:MCP resources/prompts 与 OAuth 本轮不桥接。

## 子代理——委派给子 kiso 进程

**内置在 CLI**——`delegate` 工具启动即加载,无安装步骤。`extensions/subagent` 是官方扩展的源码:自托管或定制,把 `dist/kiso-subagent.mjs` 复制进 `~/.kiso/extensions/`(用户副本响亮地 shadow 内置)。扩展是零依赖单文件——无 SDK,复制之外无构建:

```
cd extensions/subagent && npm install && npm run build   # 仅为自托管/定制
cp dist/kiso-subagent.mjs ~/.kiso/extensions/
```

扩展只加一个工具 `delegate`,在子 kiso 进程(同一二进制)里跑 1-8 个子代理任务,最多 4 个并发:

| 角色 | 允许的工具 | cwd | 隔离 |
|---|---|---|---|
| explorer | read/list/search | 父的 cwd | 角色策略 |
| reviewer | read/list/search | 父的 cwd | 角色策略 |
| tester | 全部六种 | 父的 cwd | 角色策略 |
| implementer | 全部六种 | 分离的 `git worktree` | diff 回来 |

- **角色策略按子进程生成**(临时扩展目录):只 allow/deny——绝不 ask(无头子进程无法回答审批提示)。Explorer/reviewer 只能读;implementer/tester 可以改。
- **implementer 隔离**:子进程在分离的 `git worktree` 工作(父必须是 git 仓库——否则任务诚实失败);子进程退出后,`git diff`(带 `--stat` 头)随结果回来。有改动的 worktree 保留并返回其路径;干净的删除。
- **结果来自子进程自己的会话 JSONL**——终态、最终助手文本、工具调用计数——绝不来自 stdout(stdout 仅在子进程非零退出或 JSONL 缺失时作为诊断随行)。子进程落在普通会话目录(`sub-<parent>-<n>-<role>`):持久、可审计、即使父进程被杀也可 `kiso resume`——子代理卖点。
- **深度守卫**:`KISO_SUBAGENT_DEPTH ≥ 1`(每个子进程都设)让工厂返回空工具——子代理永不嵌套。
- **超时**:每个子进程默认 10 分钟(`KISO_SUBAGENT_TIMEOUT_MS` 覆盖);超时或父运行中止 SIGKILL 整个子进程组。
- **provider 凭据随父环境刻意下传**——与 shell 工具(#7)的区别:shell 跑任意命令(默认剥离);delegate 是刚经人类批准的可控 spawn。
- **审批:无自动放行。** `delegate` 落在 ask 档——人类看到每次委派并可拒绝。

## 技能——两级渐进式技能加载

**内置在 CLI**——技能启动即加载,无安装步骤。`extensions/skills` 是官方扩展的源码:自托管或定制,把 `dist/kiso-skills.mjs` 复制进 `~/.kiso/extensions/`(用户副本响亮地 shadow 内置):

```
cd extensions/skills && npm install && npm run build   # 仅为自托管/定制
cp dist/kiso-skills.mjs ~/.kiso/extensions/
```

技能是 `$KISO_SKILLS_DIR`(默认 `~/.kiso/skills`)下带 `SKILL.md` 的目录,如 `~/.kiso/skills/review/SKILL.md`:

```markdown
---
name: review
description: a review checklist for pull requests
---

# Review checklist

... the skill body ...
```

- **第 1 级——驻留索引。** 每个技能的前置元数据(`---` 包裹的 YAML 子集;只读 `name`/`description`——无依赖、无解析器)成为系统提示的一行,按目录名排序:`Available skills (load with read_skill):` 加每个技能一行 `- <name>: <description>`。无前置元数据的 `SKILL.md` 在索引尾部带警告行跳过——软失败,像 MCP 桥。无/空技能目录 → 空扩展,绝不是错误。
- **第 2 级——按需。** `read_skill` 工具返回完整 `SKILL.md`(上限 32KB,带截断注);未知名是诚实、可操作的错误,列出已装技能。
- **第 3 级——渐进,零新机制。** `SKILL.md` 之外的文件不自动加载:技能正文用相对路径告诉模型按需 `read_file`。
- **Claude Code 兼容。** CC 技能用相同前置元数据形态;name/description 子集原样解析——把 CC 技能目录丢进 `~/.kiso/skills/` 即可用。
- **审批:** `read_skill` 读用户本机安装的文档——safe-defaults 例子放行它(read_file 信任);技能其余一切是既有策略管辖的普通文件访问。

## 提问——模型把真正的选择交给你

**内置在 CLI,仅限交互式终端。** 模型可以不再猜:`ask_user` 一次调用携带 1-4 个问题,每题 2-4 个选项(可带一行说明),单选或多选。

```text
│ which bundler? ‹ 1/2 ›
│ bundler
─ pick one ─
│  1 ◉ vite — fast dev server
│  2   esbuild — one binary
│  t   type your own answer
│ 1-4 pick · t type · esc decline
└
```

- **按键。** 数字键选择(单选题选中即前进,多选题切换后等 enter),空格在光标处选中但不提交,↑↓ 移动光标,← 退回上一题,`t` 打开自由作答行,esc 谢绝。
- **谢绝是一种结果,不是沉默。** 结果会列出每一个未作答的问题连同其选项——模型知道你选择了不选,而这与"没被问过"不同。
- **答案是持久事实。** 它们乘着一次普通工具调用的普通 `tool_result`,所以**已回答的问题永不再问——`kill -9` 之后也一样**。在你作答前被打断的问题,会在下一次 `kiso resume` 时浮出来请你明确决定是否重问(`an unanswered question was interrupted — ask it again? — 1 re-ask · 3 drop`),因为一个没被回答的问题不是"可能已经生效"的副作用。
- **零新持久机制。** 没有新事件种类,没有逐键持久化:崩溃后重现的是整次调用,而不是半张填了一半的表。
- **审批:** `ask_user` 由 ask 扩展自己放行——要求先审批"能不能问你",等于为一个决定摆两块面板,而面板本身已经可以谢绝。用户扩展的 deny 与 plan 模式的只读拒绝依然胜出。

## 可见性——会话自己说出它在做什么

六件会话本来就知道、却从未说出口的事。全部零租金:不多发一次请求,不多写一个事件,不把估算当成测量。

- **卡片自己说出它的键。** 折叠起来、藏了东西的工具卡会说清藏了多少、怎么看——`· 22 lines · ctrl+r expands`;展开的块以 `└ ctrl+r collapses` 收尾。输出本来就整个在屏上的卡什么都不说,因为这句提示本身是"有东西被藏起来了"的陈述。后缀吃的是剩下的宽度,不够就降级(`· N lines · ctrl+r`,再降 `· ctrl+r`,再降为无),绝不去切那行本来要报出的路径。
- **探索会并成一行。** 连续的只读调用(`read_file` / `list_dir` / `search_text`)折成一行——`✓ explored 8 files · 14 searches (3.2s) · ctrl+r lists them`——ctrl+r 按工具逐行列出,重复的对象带次数。写入、编辑、shell 与扩展工具**永不**并组:一串副作用是"发生过什么"的清单,每一行都有意义。并组纯属显示层投影——durable 日志逐字节不变,`/last` 依然拿得到完整输出。
- **运行中的命令长出实时尾巴。** 长命令过去只会在整个运行期间说 "waiting for output";现在它把最新几行随到随显,住在同一个固定三行窗口里,底部是 `└ live tail · esc stop · alt+⏎ redirect`。它乘的是一个只作观测用的 sidecar 文件(在系统临时目录):从不是持久状态,settle 即删;万一 `kill -9` 留下一个,读取侧也会按时间戳把它当作幽灵忽略。
- **`?` 打开键位表。** 一屏,仅在输入为空时触发(句子中间的 `?` 就是问号),任意键关闭。表格由"按键唯一登记表"生成,所以键位表不可能与真实按键脱节。
- **`/context` 说清上下文去哪了。** 上一次请求的租金账,以"各部分加起来等于总数"的归因呈现:system prompt(基座 + 扩展追加)、tool table、skills index、envelope、messages、free。它读的是 trace sidecar——观测面,正确性永不读取它;还没调用过模型的会话会如实说明,而不是画一条看起来像"测得为零"的空进度条。
- **状态行带上仪表。** `CH 92% · $0.0042`——缓存命中率(分母是模型实际收到的总量)与 canonical 成本。定价表里没有该路由费率的,就不记成本;没有成本就不显示数字。kiso 不编造价格。

```text
  ✓ explored 8 files · 14 searches (3.2s) · ctrl+r lists them
  ▖ shell npm test (12s)
  │ packages/runtime  ✓ 184 tests
  │ packages/tui      ⠸ 88/120
  └ live tail · esc stop · alt+⏎ redirect
▸ default · /mode to switch · deepseek-v4-flash · CH 92% · $0.0042 · ctx left ~74%
```

**键位:** `enter` 发送 · `ctrl+j / shift+⏎` 换行 · `@` 文件 · `esc` 停止 · `alt+⏎ / ctrl+⏎` 改道 · `/` 命令 · `↑↓` 历史 / 取回排队 · `ctrl+r` 展开卡片 · `tab` 补全 · `?` 本表。面板内:数字键选择 · 空格切换 · `t` 自由作答。

## 任务——持久化长期工作记忆

**自 0.3.0 起为 opt-in**(0.1.45–0.2.2 内置;13 个连续真 provider 会话上每请求付租却一次未调用——连规划指南自家设计的触发场景都没激活,finding E5-F1/E5-F2——故退出默认组合)。`extensions/task` 是官方扩展的源码(`src/kiso-task.mjs`——源码即产品,无构建步骤);安装或定制,复制进 `~/.kiso/extensions/`(普通用户扩展——task 不再是内置,无 shadow 对象):

带 plan 的会话在新默认组合下 resume 仍读到耐久 plan——plan 活在日志里,不在扩展里。边界:扩展缺席时没有 `task_set` 可**更新** plan;opt-in 即可恢复。

```
cp extensions/task/src/kiso-task.mjs ~/.kiso/extensions/
```

`task_set` 工具是整表替换(CC TodoWrite 形态):模型每次发送完整当前列表,最多一个 `active` 项(第二个 active 被响亮拒绝——CC 纪律)。结果回显规范化列表,带 `do-not-compact` 标签。回显在终端渲染为清单单元格(□ 待办 / ▖ 进行中 / ▣ 完成,brick 家族),系统提示获得克制的规划纪律(3+ 步 → 先计划并带验证步骤;开始前标 active;完成后立即标 done)。

卖点是和 Claude Code 的 TodoWrite 的对比:CC 的列表是**运行时状态**——随进程消亡。kiso 的列表是**持久化事件**——回显是会话日志里的工具结果消息,所以挺得过 kill -9(恢复从日志重建投影)和 /compact(do-not-compact 标签让摘要层的边界在轮到它之前收手——最新列表绝不丢给摘要)。

## 项目级 `.kiso`——按内容摘要信任,而非按目录

仓库自身的 `.kiso` 目录是能力面:克隆的代码在你运行 `kiso chat` 那一刻就在你机器上执行。那里识别三种工件——`extensions/*.mjs`、`mcp.json`、`skills/<name>/SKILL.md`——共享一个信任门(ADR-0037):

- **首次发现。** CLI 列出每个工件(文件名 + 摘要短前缀)并问一次:`trust this project's .kiso? (y/n)`。裁决记录在 `~/.kiso/trust.jsonl`(追加式,`KISO_HOME` 感知)。
- **授予**——工程扩展加载(横幅里标 `project:`:`[5 extensions: built-in: mcp, skills, subagent · safe-defaults · project: lint-rules, mcp]`),其 `mcp.json` 与你的用户配置合并(两边同名的 server 是响亮启动错误),其技能并入技能扫描(两边同名的技能:工程胜,一条 stderr 注)。与内置同名的工程扩展被响亮拒绝——克隆的仓库绝不能静默替换 CLI 自身的行为。
- **拒绝**——什么都不加载,且拒绝是粘性的:永不重问。删除该工程的 `trust.jsonl` 行,或改动工件文件,重新评估。
- **信任随文件而亡。** 摘要是按排序的工件路径与内容的 sha256——改变 `.kiso` 的 `git pull` 让你再决定一次。同一工程、同一文件、同一裁决:门禁永不重问。
- **非 TTY(CI、管道)。** 永不问、永不加载——一条 stderr 说明。为 CI 预授权,在该仓库里交互跑一次 `kiso chat`,或自己写记录:`trust.jsonl` 一行 `{"root": "<realpath of <repo>/.kiso>", "digest": "<bundle sha256>", "decision": "granted", "ts": "..."}`。刻意没有 `KISO_TRUST` 式跳过问询的环境变量——门禁不是开关。
- **你的家目录永不是工程。** 在家目录跑 kiso 时,`<cwd>/.kiso` 就是你的用户级配置目录——发现返回空,门禁永不运行(discovery#10)。对家目录的陈旧 `trust.jsonl` 授权是惰性的,可以不管。

## 对比

bench(`bench/`,同一模型、同一任务、三个 Agent)度量小任务上的效率——那里的能力是相等的。下面的能力矩阵是 kiso 自己交付的,每一行由本仓库的门禁证明;旁边的数字是 bench 的,诚实脚注照旧。

| 能力 | 交付 | 证明于 |
|---|---|---|
| 挺得过 `kill -9` | 事件溯源会话;恢复续上被打断的运行 | `apps/cli/tests/kill9.test.ts` |
| 持久化人工审批 | 暂停跨进程持久;裁决永不丢失 | `packages/runtime/tests/approvals.test.ts` |
| 崩溃一致执行 | 以 `executionId` 为键的持久化回执;已确认的成功永不重跑(框架自身窗口内的恰好一次——其余是显式的人类消解的不确定性) | `packages/core/tests/execution-gate.test.ts` |
| 扩展 | 策略 / 工具 / 钩子 / systemPrompt / dispose | `packages/runtime/tests/extensions.test.ts` |
| 内置扩展层 | 三个默认官方扩展启动时进程内加载(E5:task 为 opt-in);用户副本响亮 shadow | `apps/cli/tests/builtin-layer.test.ts` |
| MCP 桥 | 官方扩展——0.1.44 起内置,内核不动 | `extensions/mcp/tests` |
| 子代理 | 官方扩展——0.1.44 起内置,角色策略子进程 | `extensions/subagent/tests` |
| 技能 | 官方扩展——0.1.44 起内置,两级渐进 | `extensions/skills/tests` |
| 任务 | 官方扩展——0.3.0 起 opt-in(0.1.44–0.2.2 内置),持久化长期工作记忆(task_set) | `extensions/task/tests`, `apps/cli/tests/task-e2e.test.ts` |
| 上下文经济 ● | microcompact + /compact(模型摘要)+ 提示词缓存纪律 | `packages/core/tests/prompt-cache.test.ts`, `summarize.test.ts` |
| 工程 `.kiso` 信任 | 内容摘要门禁,问一次,粘性拒绝 | `apps/cli/tests/project-trust.test.ts` |
| 黑白纪律下的 markdown | 手搓零依赖渲染器,以 BLOCK-FREEZE 流式渲染 assistant 正文——完结块落进 scrollback 后永不重渲,只有未闭合的尾块住在 live 区;属性优先于颜色,零语法高亮,管道仍吐原始 markdown 字节 | `packages/tui-cells/tests/tui2-md-*.test.ts`, `packages/tui/tests/tui2-md-compositor.test.ts`, `apps/cli/tests/tui2-md-benchmark.test.ts` |

bench,一个夹具、一个模型(deepseek-v4-flash),同日串行运行、每轮轮换次序——2026-08-16 三方对照(kiso 0.4.0,经 npx 的已发布产物 · pi 0.84.2 · Claude Code 2.1.233 经 DeepSeek 的 Anthropic 兼容端点)。中位数:T3 每工具 n=3,T5 每工具 n=2:

| task | tool | fresh in | cached in | total in | cost-wtd | out | reqs | wall |
|------|------|--------:|--------:|--------:|--------:|----:|----:|----:|
| T3 cross-file rename | **kiso** | 711 | 11,392 | **12,138** | **1,885** | 750 | **5.0** | **10s** |
| | pi | 3,494 | 18,176 | 20,247 | 4,800 | 1,184 | 6.0 | 12s |
| | claude | 38,591 | 222,592 | 261,392 | 61,059 | 2,069 | 15.0 | 30s |
| T5 8-turn session | **kiso** | 7,844 | 130,048 | **137,892** | **20,849** | 5,386 | 32.5 | **72s** |
| | pi | 6,190 | 279,424 | 285,614 | 34,133 | 7,282 | 35.0 | 92s |
| | claude | 303,406 | 1,464,640 | 1,768,046 | 449,870 | 16,530 | 54.0 | 259s |

**头条。** 在 **T3**,最难的小任务,**成本加权输入**(fresh + 0.1×cached——DeepSeek 缓存命中价格比,见 `bench/README.md`):kiso 1,885 vs pi 4,800 = **2.55×**,vs Claude Code 61,059 = **32×**,九次 T3 运行全部 verify-pass、任务产出相同。**T5** 八回合会话:kiso 20,849 vs pi 34,133 = **1.64×**,vs Claude Code 449,870 = **21.6×**——在一个会话长度上测得。T5 的诚实归因:kiso 自身成本与前一记录持平(20,849 vs 19,941——在历史带内);T5 比值拉大主要来自对手侧变动(pi 23,660 → 34,133;Claude Code 在新版本上 120,440 → 449,870、30 → 54 轮)。T3 的改善是 kiso 自己挣的(2,211 → 1,885,E5 默认组合削减落地)。

**此前的记录在 git 历史与 `bench/README.md`。** 2026-08-12 轮(kiso 0.2.0 · pi 0.84.1 · CC 2.1.227:T3 2.1×/19×,T5 1.2×/6.0×)是同协议的上一记录;2026-08-10 对照(11× 与 66×)出自更早的协议世代——其 kiso 单元格在 0.1.41 上测得,早于 0.1.45+ 内置扩展层与信任面(同一套协议文件自 0.1.48 重新基线以来产出的 kiso T3 单元格约在 1,900–2,400 带内)。2026-08-16 运行在 `bench/runs/`(gitignored——本表与本 README 的数字是提交记录);旧表留在本 README 的 git 历史里,协议变更记录在 `bench/README.md`。

诚实脚注(来自 `bench/README.md`):这些任务都很小——Claude Code 的大系统提示买到真实产品能力(任务跟踪、更丰富的探索),在复杂工作上才回报,而本任务不锻炼它;Claude Code 跑在非官方形态(DeepSeek 端点),其提示为 Claude 模型调优;运行是**串行**的——每个后续运行乘 provider 服务端热缓存,所以 fresh 列是不稳定的;T3 每工具 n=3、T5 每工具 n=2,每任务一个夹具,一个模型,token 记账按各 provider 惯例归一(kiso 的输入总量**包含**缓存命中输入;pi 与 Claude Code 只报 fresh);kiso 是我们自己的工具——自己复现,一切所需都在 `bench/`。

**不做增长断言。** 这些是一个或两个会话长度上的点测量;本 README 刻意不宣称比率随会话长度如何缩放。kiso 自身长会话数据所显示的东西,诚实记录在 `bench/README.md`(包括专门的长期会话发散研究)——不在这里外推。

## 状态

**持久执行契约已冻结**(ADR-0051,0.2.x 线):会话格式与其恢复语义是契约,每条不变量由下面的门禁强制。契约冻结是技术事实、与版本号无关——版本线现为 0.2.x,真 1.0 由 owner 裁定(ADR-0051 Amendment 2)。来路:reliable-session alpha 含四个加固轮(areas 1-7、A-F、one through nine、第四对抗轮——见 `docs/plans/2026-08-03-reliable-session-alpha.md`),**kiso code** 轮(编码 Agent:kill -9 门禁、microcompact、字节纪律——`docs/plans/2026-08-04-kiso-code.md`),**extensions** 轮(E1:审批策略扩展系统;E2:压缩参数与 systemPrompt append 面——`docs/plans/2026-08-04-extensions-e1.md`),以及持久化线 R-E→R-H(straddle 裁决、恢复即投影、死者接管、冻结本身)。下面每一条都由 `npm run check` 里的门禁证明:

- **core**(1,971/2,000 行)——协议、循环(单一诚实终点;缺失/重复 stop 与无调用的 tool_use 是结构化错误;只在任何内容流出前重试;一个 abort 信号到达退避、审批等待、每个待决工具与 SDK)、钩子、ModeProfile、权限、microcompact(`microcompacted` 边界是持久化事实——投影确定性推导压缩视图;白名单 read/list/search/shell,`do-not-compact` 受尊重,近期回合原样)、扩展策略链(E1:deny > ask > allow 组合在人类流之前裁决——allow/deny 以 `decidedBy` 持久记录,抛异常的策略计为 ask,持久化裁决挺得过 kill -9,策略永不重跑)、交付真相、无损事件日志投影(消息是日志的纯函数,ADR-0002——以及提示词缓存字节纪律:同一事件前缀投影同一消息前缀,逐字节,三个回归测试钉死)、以框架 `executionId` 为键的执行账本(ADR-0025):已确认的成功永不重跑,新的逻辑调用总是运行,而不确定性只属于崩溃窗口——启动过却从未上报的那一个(ADR-0038;有回执的失败是干净失败,其结果带诚实的部分副作用注,重试重过审批链)。
- **runtime**——`createAgent` / 持久多回合会话 / 崩溃安全 JSONL 存储(内核 flock 跨进程写锁下的 torn-tail 修复——升级需要 QUARANTINE:启动新版本前停掉每个旧格式进程;pidfile 守卫是尽力而为,不是无缝滚动升级(第五轮 P1-4)、严格加载、连续 seq 校验)/ `session.resume()` 跨进程续上被打断的运行:应用持久化审批(原始调用执行一次,拒绝写入其结果),补齐缺失回执,原始运行完成——无发明回合 / `loadExtensions(dir)`:每个 *.mjs 默认导出(或工厂),坏文件或重名响亮启动失败;扩展工具并入注册表(内置冲突 = 启动错误),钩子在 harness 自身之后组合(existing-first),审批进入策略链。
- **cli**(1,870/1,920 行)——编码 Agent:裸 `kiso` 进聊天;启动扩展扫描——先内置层(三个默认官方扩展经模块导入进程内加载:mcp、skills、subagent;E5:task 为 opt-in——用户副本响亮 shadow,工程副本被拒),再 `~/.kiso/extensions/*.mjs`(横幅 `[3 extensions: built-in: mcp, skills, subagent]`,用户名单裸追加,工程名标 `project:`);系统提示(编码 Agent 纪律:先读后改、小心 shell)由常量组成,注入 AGENTS.md/CLAUDE.md 并截断至 8KB;每次调用一行工具摘要(`✓ edit src/foo.ts (+12 -3)` / `✗ shell npm test (exit 1)`)、状态行(`[turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]`——只用 usage 事件,未知字段整体省略,faux 模式显示 `[turn N · faux]`)、`/last` 直接从事件流打印最近一次工具调用的完整输入/输出。首跑脚手架(0.1.45):信任裁决是全新 home 的**首次**任何访问——只有授予之后配置面才物化(`config.json` + 哨兵),静默,带哨兵的 home 永不重搭脚手架、永不覆盖你的配置。v2a/v5/KC3——**身份是单色的**:黑白深浅承载整个界面,颜色只留给三件真正有含义的事。亮白 BOLD(SGR 1)是重音(you> 提示、横幅标语、✓ 标记、命令名、用户块 ▍ rail、输入 brick);助手文本中反引号片段用浅灰行内代码色(256 色 252);元数据用暗色。TUI2-MD——**assistant 正文渲染 markdown**,同一纪律:标题剥掉 `#` 号后加粗、编号保留;`**bold**` 亮白加粗;`*italic*` 用 SGR 3(属性而非颜色——本轮唯一新增的字母,终端不支持时无害降级);反引号片段沿用既有代码色;围栏块给一条暗 `│` 边沟加暗语言标签,**零语法高亮**;列表归一为 `•` 并**悬挂缩进**,折行对齐到文字列;表格用暗色线,宽度不够时降级为每行一张记录卡而不是硬截断;引用块给暗 `▏`;链接是亮文本加暗 `(url)`;`~~删除线~~` 保留字面标记(SGR 9 的终端支持面太碎,不值得承诺)。CJK 逐字可断,所以无空格的长串会正确折行而不是溢出。流式走 BLOCK-FREEZE:完结的块落进原生 scrollback 后永不重渲,所以无论消息多长,live 区只住一个块。管道仍拿到模型自己的 markdown 字节,原样不动;`/think` 与 `/last` 保持生字符。功能色是界面里仅剩的颜色——审批 diff 增行绿、错误红;黄色按同一规则留给警告(当前调色板里还没有黄色项)。其余全素;`NO_COLOR` 或管道全部禁用(管道零 ANSI);键入输入由 readline 自己回显,绝不渲染两次;请求与首个 delta 之间 spinner 字形显示活性。v2b:思考块折叠为每块一条暗线(前 100 字符 + ` (… /think shows full)`、`/think` 打印最后完整块),`[result]` 回显截断至 160 字符 + ` (/last for full)`——内容策略管道里相同;彩色 TTY 上 UI 坞到底部(ADR-0039):四行钉住——上暗分隔线、`▌` 输入行、下分隔线、LIVE 状态栏(idle `▸ <mode> · /mode to switch · …` 右对齐暗 `/ commands · ↑ history` 提示——窗口窄时先切;running `▖ working Ns · esc stop · alt+⏎ redirect · …`);正文以真实 LF 滚进原生 scrollback(v2d-B,ADR-0040——无滚动区);审批/不确定/信任问题占据状态位,在输入行作答;SIGWINCH 重应用区域,底部重绘包裹在 CSI 2026 同步输出里,每个退出路径在 finally 里重置终端(`\x1b[r`)——`kill -9` 可能卡住底行,终端 `reset` 命令可救。v2c:TTY 路径自绘输入行(ADR-0039 Amendment 2)——零依赖 raw 模式编辑器(显示宽光标数学——CJK 宽字符落在右列,硬验收——bracketed paste,水平滚动带暗 … 标记)配 kiso brick 母题:粗体半块 ▌you> 行与暗点线 ╌ 分隔;发送的行恰好一次渲染进正文,另一回合运行中提交的回合带 LIVE `+N queued` 状态排队,Esc 中止。KC3:**`@` 打开模糊文件选择器**——在词边界键入才生效(词中间不触发,所以邮箱地址仍是地址),在输入框上方列出工程文件:对完整相对路径做大小写不敏感的子序列匹配,按最长连续段、再按最短路径排序,命中字符加粗,一次五行并带 `(n/total)` 计数行(列表被截断时它会说出来)。↑↓ 选择,Tab 或 Enter 接受,Esc 关闭且不动你已经写下的句子。接受后插入的是**规范路径本身,别无他物**——绝不插入文件内容:模型拿到的是一个它可以自己决定要不要读的引用,所以一次 `@` 只花一条路径的代价,真正的字节由 `read_file` 按需支付。列表在仓库里取自 `git ls-files`(已跟踪 + 未跟踪,减去所有被忽略的),仓库之外走有界遍历,并且每次打开时现算——无索引、无常驻进程、无监听。已知限制:emoji ZWJ 簇宽度不完美。管道保持 readline 逐字节。v2d(ADR-0040):正文变成单元格渲染器——一个写者拥有滚动区(事件处理器只改单元格,交错按构造不可能);完成的单元格冻结一次,未完成的在区底部活动尾部渲染并原地重绘;工具的生命是一行(`→ name summary` → ⏸ → 运行 spinner + Ns → `✓ name (summary, 1.2s)`),`[result]` 不再流进流(`/last` 持有它);管道字节保持逐字节相同。`resume` 是恢复流(不确定执行裁决 rerun/abandon——不确定性只属于崩溃窗口,ADR-0038;有回执的失败是干净失败,其结果带诚实的部分副作用注,重试重过审批链);编码工具绑在工作区根(绝对路径、`..`、symlink 逃逸被拒);审批提示显示完整 shell 命令与完整路径。**kill -9 门禁**(`apps/cli/tests/kill9.test.ts`)在执行中途 SIGKILL 真实聊天并在新进程恢复——见上方一节。
- **workspace**——可发布 monorepo(core、evals、runtime、tools-node、provider-anthropic、provider-openai、tui、tui-cells、四个官方扩展包、cli——13 个 npm 面),ESM + d.ts,精确 pin 的内部版本(各包独立计数器,每次发布时 pin);CI 是干净签出 `npm ci` + 完整门禁。

`npm run check` = 构建 → 类型检查(packages + 根脚本 + 测试)→ 测试 → 大小门禁(core 2,000 + cli 1,920 + tui 2,400 + tui-cells 1,280)→ pack 门禁(每个 tarball 里有 dist + README + LICENSE)→ 空白门禁(无尾随空白,每文件以换行结束)→ CJK 门禁(被跟踪树保持 CJK-free——`README.zh.md` 是唯一豁免)→ `git diff --check`(工作树与索引)→ 消费者冒烟级(runtime、NESTED 安装、providers、CLI、带真实 Anthropic/OpenAI env 的嵌套 CLI)→ 演示起止门禁。**918 个测试全绿(128 个文件)**。38 份 ADR(索引:`docs/adrs/README.md`)。6 个事故夹具跑在真实运行时上。

## 为什么还要做一个

因为每个 Agent 框架都给你代码和 API 文档,没有一个给你**推理**。下个季度模型变了、某个设计决策不再划算时,文档没法告诉你该拔哪一根。ADR 能。

## 许可证

MIT
