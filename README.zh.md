<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.png"><img src="assets/hero.png" width="100%" alt="kiso — the durable runtime for AI agents"></picture></p>

<p align="center"><b>v0.33.0</b> · MIT · Node ≥ 22 · <a href="https://kiso.work">kiso.work</a> · <a href="README.md">English edition</a></p>

**kiso** 是一个可靠续跑的 AI agent 运行时。每一次审批、每一个工具结果、每一条事件都在发生的当下写进磁盘,所以一个被打断、崩溃或被强杀的 agent 会从停下的那一步原样接着跑,审批还在、结果还在。内核是 2,200 行 TypeScript,事件溯源,每个设计决策都随附一份 ADR,写明为什么,以及何时推翻它。

**kiso-code** 是跑在它上面的编程 agent:日常工具,也是活证明。编辑到一半 `kill -9`,再 `kiso resume`,它会在新进程里接着走完被打断的轨迹。下面的一切从它开始;[SDK](#使用) 那一节是运行时归你用的地方。

[快速开始](#快速开始) · [登录](#登录) · [模型与 effort](#模型与-effort) · [会话](#会话) · [模式](#模式) · [交互界面](#交互界面) · [验证到哪一步](#验证到哪一步) · [持久执行](#持久执行一屏讲完) · [已交付什么](#已交付什么) · [扩展 kiso](#扩展-kiso) · [SDK](#使用) · [文档](#文档)

## 快速开始

Node >= 22,macOS 或 Linux。Windows 不支持也未测试——shell 工具的进程组、会话锁的存活探测与 PTY 套件都是 POSIX-only。

```bash
npm install -g @vincemakes/kiso-code
kiso                              # 交互会话
```

也可以不安装直接跑:`npx @vincemakes/kiso-code`。

有新版本时,每次启动都会在横幅下方提示;`kiso update` 装上它(就是同一条 `npm install -g`,没有别的)。

**首次运行不需要任何密钥。** kiso 会进入无密钥的 faux 模式——一段脚本化的四轮轨迹,让你在花钱之前先看清形状。脚本跑完后会话以非零码退出并提示设置密钥:那个退出是设计,不是崩溃。[登录](#登录)接到真实模型。

然后就跟它说话。模型拿到六个工具——读文件、列目录、搜文本、写文件、改文件、shell——其中写入与 shell 位于审批策略之后:运行会**暂停**、发问、持久化裁决,然后续跑同一次运行(ADR-0024)。其余能力由[扩展](#扩展-kiso)补齐。

五分钟走查在 [docs/cli-quickstart.md](docs/cli-quickstart.md);完整命令面在 [docs/cli.md](docs/cli.md)。

## 登录

`kiso login <provider>` 把凭据存进 `~/.kiso/auth.json`(权限 0600)——`anthropic` / `openai` / `deepseek` / `zai` 存 API key,`chatgpt` 存订阅的 OAuth 登录:

```bash
kiso login chatgpt      # 订阅:浏览器往返一次,不用 key
kiso login deepseek     # 厂商 key,只输一次并存下
kiso auth               # 列出已存的(已遮蔽)
kiso logout deepseek    # 删除
```

**已存凭据「拥有」它的 provider。** 存了但不可用就是响亮报错,绝不静默退回环境变量——你用什么登录的,跑的就是什么。没存凭据时 env 层照常工作:单独一个 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 就够(两个都导出时 OpenAI 胜出),`OPENAI_BASE_URL` 可重定向到任意兼容端点。

## 模型与 effort

`/model` 列出你的 profile,逐条标注可用 / 不可用,并为之后的回合切换会话的适配器;不带参数时打开选择器。每个 profile 的合法 effort 档位都会显示,端点没有的档位在 `/model` 和 run 侧都按名拒绝。

Profile 存在 `~/.kiso/config.json`(ADR-0045)。**凭据永远不在里面**——profile 只**命名**持有密钥的环境变量,或者交给 `kiso login`。优先级:**flag > env > 项目配置 > 用户配置 > 默认**;配置文件坏掉会响亮失败并指名文件。

```jsonc
{
  "model": "deepseek",                       // 启动 profile
  "models": {
    "deepseek": {
      "kind": "openai-compat",               // "openai-compat" | "anthropic" | "openai-responses"
      "model": "deepseek-v4-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY",       // 密钥的 env 变量名——不是密钥本身
      "baseUrl": "https://api.deepseek.com"
    },
    "claude": {
      "kind": "anthropic",
      "model": "claude-opus-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "promptCaching": false                 // 默认关,opt-in;见 configuration.md
    },
    // 订阅:不设 apiKeyEnv——由 `kiso login chatgpt` 拥有
    "chatgpt": { "kind": "openai-responses", "model": "gpt-5.5", "baseUrl": "https://chatgpt.com/backend-api" }
  },
  "mode": "default"                          // manual/default/accept-edits/plan/bypass
}
```

`kiso --model deepseek` 压过一切,`--model anthropic/claude-sonnet-5` 这类直写也可以。完整参考——带日期与来源的注册表行、提示词缓存、思考模式、自动压缩、项目配置的信任门——在 [docs/configuration.md](docs/configuration.md)。

## 会话

会话是 `$KISO_HOME/sessions` 下的追加式 JSONL。退出、重启、`kiso resume <id>`,对话以连续的 seq 续上。

```
kiso [sessionId]               交互会话(默认命令;`kiso chat` 等同)
kiso resume                    挑一个会话续跑(选择器)
kiso resume <id> [prompt]      在新进程里续跑某个会话
kiso sessions                  列出持久会话及其状态
```

`kiso resume` 不带 id 时打开选择器:一行一个会话,方向键走,输入即筛选,回车续跑。每行带一个**持久性徽章**——kiso 真正会恢复进入的状态,只读自会话自己的持久日志:

| 徽章 | 含义 | `kiso resume` 会做什么 |
|---|---|---|
| `✓` | 运行干净结束 | 从已结算的会话续上 |
| `✗` | 以别的方式结束(错误、中止、超turn) | 从停下的地方续上 |
| `▌` | **没有 terminal 事件——运行中途被打断** | 从持久前缀精确恢复轨迹 |
| `?` | uncertain 账本非空 | 先请你对被打断的副作用作出裁决 |
| `◌` | 有没人回答的权限请求 | 把问题重新摆回你面前 |

**上下文缓解默认开启。** 越过模型窗口的一半后,会追加一个 `microcompacted` 边界事件,投影据此推导压缩视图——旧的 read/list/search/shell 输出变成固定占位符,写入与编辑永远不变。`/compact` 把更早的**对话**压缩成一条持久摘要。两者都是持久化事实,所以崩溃后恢复会落在字节一致的投影上——见 [docs/context.md](docs/context.md)。

## 模式

`/mode` 切换整个会话的审批姿态。五个档位建在扩展链**之上**,内核不变:每档是一个进程内的 `mode:<name>` 扩展,其自动裁决记为 `decidedBy: "mode:<name>"`,审计轨迹会指名是哪一档决定的。

| 档位 | 语义 |
|---|---|
| `default` | 读放行;write/edit/shell 问人;扩展工具归扩展自己管 |
| `manual` | **每个**工具都问人 |
| `accept-edits` | `default` 加上 write_file/edit_file 放行 |
| `plan` | read/list/search/read_skill 放行;其余一律以 `plan mode: read-only` 拒绝 |
| `bypass` | 全部放行——但用户扩展的 `deny` 依然胜出 |

启动时:`--mode <name>` 或 `KISO_MODE=<name>`。状态栏写出当前档位,约束是看得见的,而不是编码在色相里。

## 交互界面

```text
  read  suite.sh · 7 lines · 0.0s · ctrl+o expands

● shell ./suite.sh; echo "exit=$?"
  └ packages/core      ok  184 tests
    packages/runtime   ok  221 tests
    packages/tui       ok  120 tests
    1s · esc stops · alt+⏎ redirects
✦ working 19s ↓ 94 tokens · 186 tok/s · esc stop · alt+⏎ redirect · ctx left ~98%
```

回合结束之后,同一次调用:

```text
  shell ./suite.sh; echo "exit=$?"
  └ packages/core      ok  184 tests
    packages/runtime   ok  221 tests
    packages/tui       ok  120 tests
    exit=0
    exit 0 · 4 lines · 2.6s

✦ took 22s · in 175 out 54 · cache 97% · ctx left ~98%
▸ bypass · /mode to switch · deepseek-v…s-on-0910 · CH 97% · ctx left ~98% · 186 tok/s
```

两段都是从真实的 100 列屏幕上取下来的行,不是手写的:一次调用运行时带着自己的
输出,结束后沉淀成对它的记录。这个会话在 `bypass` 模式,所以命令没有停在下面
那条「审批」讲的那一步。`186 tok/s` 是最后一次可测量的调用的解码速率;模型名
从中间缩短是因为这一行的宽度不够了 —— 事实永远不会被缩。

**键位**(`?` 显示的整张表): `enter` 发送 · `ctrl+j / shift+⏎` 换行 · `@` 文件 · `esc` 停 · `alt+⏎ / ctrl+⏎` 改道 · `/` 命令 · `↑↓` 历史 / 弹出队列 · `ctrl+o` 展开单元 · `ctrl+r` transcript · `tab` 补全 · `?` 这张表 · `alt+←→ / ctrl+←→` 按词移动 · `alt+⌫ / alt+d` 删词 · `ctrl+x` 复制上一条回答 · `ctrl+z / ctrl+y` 撤销 / 重做 · `ctrl+v` 贴剪贴板里的图。面板里,用产品自己的话:`panels: ↑↓ move · ⏎ confirms · digits act on their row · t types`;空格只在光标处选中,永远不提交,所以误按一下不会替你回答。

- **审批是一次选择,不是一张表单。** 暂停时展示完整的调用——整条命令、整份 diff,永不截断——高亮条已经停在 *Yes, run it* 上:看一眼,回车。其中一项授予该工具**持久的**「别再问了」规则,做法是写一个人可读、人可删的扩展文件,删掉那个文件就是撤销路径。另一项让模型给出两三个更窄的版本,代价是一次请求,且只在你按下时才发生。
- **不可逆的删除会自己说出来。** 四条命令带一行黄色提示,写明什么会没:`rm -rf`(列出目标)、`git checkout --`、`git reset --hard`、`git clean -f`。别的都不带——给每条危险命令都加警告,只会教会眼睛跳过警告。
- **界面是单色的**——颜色只留给三件有意义的事:diff 的新增用绿、错误用红、警告用黄。`NO_COLOR` 或管道会把这一切关掉,管道里零 ANSI。

这些都不花 token:折叠汇总、shell 实时尾巴、`/context` 的租金账本、状态栏的表,读的都是会话本来就知道的东西——没有额外请求,也没有把估算当成测量。完整的面——每条命令、有界读取规则、每一项可见性机制——在 [docs/cli.md](docs/cli.md)。

## 验证到哪一步

支持程度由背后的证据陈述,而不是由「代码存在」陈述。

| provider | 登录方式 | 状态 |
|---|---|---|
| DeepSeek 及其他 OpenAI 兼容端点 | `kiso login deepseek`,或 env 里放 key | **有真实厂商腿。** 凭据存储路径于 2026-09-08 对着厂商跑过,bench 的任务腿跑在 `deepseek-v4-flash` 上。 |
| Anthropic | `kiso login anthropic`——只有 API key | **只有 API key**:厂商禁止第三方订阅登录。当前型号线已登记,带日期与来源的上下文窗口、effort 档位、思考模式与价格(2026-09-07 读取)。发现 MG1-F1:签名与脱敏的思考块重放,是通过 OpenRouter 的 Anthropic 格式端点按字节一致验证的,不是对着首方 beta 面。 |
| OpenAI Responses(首方) | `kiso login openai`——API key | **离线验证通过;真实接入待验收。** 对着录制的字节 rig 得到证明;在真腿落地前,包内 README 的支持级表写 `unrun`。 |
| ChatGPT 订阅 | `kiso login chatgpt`——OAuth | **真腿 2026-09-09**,在 owner 的订阅上:存储的登录驱动了工具调用与续轮、effort 透传(`xhigh` 接受、`none` 按名拒绝)、中途取消带 durable 作废、厂商错误映射(`400 invalid_request`)且会话存活。订阅跑的费用记为 `null`(订阅不按 token 计费),上下文按预设的 272,000 度量。 |
| GLM 走 OpenRouter | env 里放 key(`OPENROUTER_API_KEY`);暂无 `kiso login` 对应 provider | **真腿 2026-09-09**(`z-ai/glm-5.3-flash`,兼容表第二行):env key 驱动了流式且思考可见、一次工具调用与其后一轮、`/model glm high` 接受而 `xhigh` 按名拒绝(`native: low/medium/high`)、中途 esc 记为 `aborted by user`、错误型号映射成 `invalid_request 400` 且会话存活。顺手修了三个缺陷:适配器丢掉 OpenRouter 的 `reasoning` 思考流(GLM-F1)、把被取消的流当成厂商错误(COMPAT-F1,DeepSeek 同样中招)、把传输层断流记成不可重试(COMPAT-F2)。当晚上游切断过一次长回答,重试恢复。价格取自 OpenRouter 的 models API(2026-09-09)。 |

Anthropic profile 的提示词缓存**默认关闭**:打开它会改变请求字节与账单,默认值只有在一条真实腿上的配对 bench 证明省钱之后才会翻转。效率数字——同一个模型、同一批任务、三个 Agent,连同协议与每一条诚实脚注——见 [bench/README.md](bench/README.md)。这里不摘录其中任何数字。

## 持久执行,一屏讲完

> **Agent 会崩溃。副作用不会回滚。kiso 让执行持久化。**

轨迹本身就是持久化工件,所以被杀掉的进程只损失进程本身。崩溃之前,三件事已经在磁盘上:

- **会话。** 每次运行都是带 `seq` 编号的追加式 JSONL 流,模型看到的消息是该日志的纯函数(ADR-0002)——一个可读、可重放、可审计的文件。
- **裁决。** 一次审批是持久化事实,并记录是谁作出的(ADR-0024),无论那是你还是你安装的策略。已裁决的调用永不重问,策略的 `decide` 也不会为它重跑。
- **回执。** 工具调用携带以 `executionId` 为键的持久化回执(ADR-0025)。已确认的成功永不重跑;启动过却从未上报的执行是 `uncertain`,阻塞到人类裁决——这是对「副作用到底落没落地?」唯一诚实的回答。

于是下一次 `kiso resume` 只问崩溃窗口让人无从得知的那部分:

```
$ kiso chat k9                        # edit f1.txt → slow shell → edit f3.txt
$ kill -9 -PGID                       # mid-shell: the whole process group
$ kiso resume k9
interrupted execution: shell (ex-12) — rerun it? (y)es / (n)o y
  rerun
→ edit_file({"path":"f3.txt",...})    # the ORIGINAL trajectory continues
```

这不是故事,这是 `apps/cli/tests/kill9.test.ts`——真 PTY、真进程、真 SIGKILL——断言恰好一个执行是 `uncertain`,被打断命令的标记文件不存在,而恢复是**续上**轨迹而非重放。`scripts/demo-kill9.sh` 对着已发布的二进制跑同一个故事,连跑两次,每次一个全新的 home。

**会话格式已冻结**(ADR-0051,2026-08-12 裁定)——是带可执行门禁(跑在 `npm run check` 里)的契约,不是会漂移的版本化 API:前缀完整恢复、歧义永不自动重复、turn commit、效果之前先落定意图、副作用之前先落定启动、意图身份稳定、单一持久真相。每条不变量连同钉住它的门禁:[docs/durability.md](docs/durability.md)。

## 已交付什么

每一行都由本仓库里的一个门禁证明。

| 能力 | 由什么交付 | 在哪证明 |
|---|---|---|
| 挺得过 `kill -9` | 事件溯源会话;resume 续上被打断的运行 | `apps/cli/tests/kill9.test.ts` |
| 持久化人工审批 | 暂停跨进程持久;裁决永不丢失 | `packages/runtime/tests/approvals.test.ts` |
| 崩溃一致执行 | 以 `executionId` 为键的持久化回执;已确认的成功永不重跑(框架自身窗口内的 exactly-once,其余是显式的人类消解不确定性) | `packages/core/tests/execution-gate.test.ts` |
| 扩展 | 策略 / 工具 / 钩子 / systemPrompt / dispose | `packages/runtime/tests/extensions.test.ts` |
| 内置扩展层 | mcp、skills、subagent 启动时进程内加载,ask 在终端上加入;用户副本响亮遮蔽 | `apps/cli/tests/builtin-layer.test.ts` |
| MCP 桥 | 官方扩展——0.1.45 起内置,内核不动 | `extensions/mcp/tests` |
| 子代理 | 官方扩展——角色策略子进程、worktree 隔离、委派契约 | `extensions/subagent/tests` |
| 技能 | 官方扩展——两级渐进式加载 | `extensions/skills/tests` |
| 任务 | 官方扩展——0.3.0 起 opt-in,持久化长期工作记忆 | `extensions/task/tests`、`apps/cli/tests/task-e2e.test.ts` |
| 凭据存储 | 凭据拥有它的 provider;不静默回退 env;`auth.json` 权限 0600 | `apps/cli/tests/credentials.test.ts`、`apps/cli/tests/oauth-chatgpt.test.ts` |
| Responses 方言 | 两个目标对着录制的字节 rig——请求字节、流式、工具回合、reasoning 重放、取消、错误映射、重试权 | `packages/provider-openai-responses/tests/or1-*.test.ts` |
| 上下文经济 | microcompact + `/compact` 模型摘要 + 提示词缓存字节纪律 | `packages/core/tests/prompt-cache.test.ts`、`packages/core/tests/summarize.test.ts` |
| 项目 `.kiso` 信任 | 内容摘要门,问一次,拒绝是黏性的 | `apps/cli/tests/project-trust.test.ts` |
| 单色纪律下的 markdown | 零依赖渲染器在 BLOCK-FREEZE 下流式渲染助手正文——闭合的块提交进 scrollback 且永不重画;属性优先于颜色,管道里是原始 markdown 字节 | `packages/tui-cells/tests/tui2-md-*.test.ts`、`packages/tui/tests/tui2-md-compositor.test.ts` |

## 扩展 kiso

一个扩展就是一个普通 `.mjs` 文件——没有 SDK,没有构建步骤——其默认导出提供钩子、工具、审批策略、压缩参数,或一段 systemPrompt 追加。加载是**响亮**的:坏文件或重名会在启动时让进程失败,并指出是哪个文件。级联顺序是**内置 → 用户 → 项目**;用户扩展可以按名遮蔽内置并在 banner 里说出来,项目扩展永远不可以遮蔽内置。官方扩展写在同一份契约上,它们做的事没有任何特权:

- **MCP**——每个 MCP 工具变成 `mcp__<server>__<tool>`,配置在 `~/.kiso/mcp.json`。连不上的 server 是软失败,stdio 子进程的 provider 凭据会被剥离。
- **子代理**——一个 `delegate` 工具在子 kiso 进程里跑 1-8 个任务,并发 4 个。implementer 在分离的 `git worktree` 里干活,diff 会回来;子进程是普通的持久会话,父进程被杀掉也能恢复。任务可以声明允许写入的路径(代价是失去 shell 工具)和一条父方持有的验收检查——命令永远不由模型提供。
- **技能**——`~/.kiso/skills` 下带 `SKILL.md` 的目录。frontmatter 变成一行常驻索引,`read_skill` 按需取正文,目录里别的文件在需要时按路径读。
- **提问**——`ask_user` 一次向你提 1-4 个真问题,每个 2-4 个选项。答案搭在普通的 tool result 上,所以答过的问题永不重问,`kill -9` 也一样。管道会话根本不加载它:没人能回答的问题不该付提示词租金。
- **任务**——整表替换的待办清单,清单是持久事件而非运行时状态,因此挺得过 `kill -9` 与 `/compact`。0.3.0 起 opt-in:在连续 13 个真实会话里它每次请求都付租,却一次也没被调用。

项目自己的 `.kiso` 目录是会在你机器上执行的克隆代码,所以它走一道内容摘要信任门:kiso 列出工件、问一次、记下裁决,只有文件变了才重问——并且刻意没有任何可以跳过这一问的环境变量。

参考——契约的类型、`deny > allow > ask` 的合成、`safe-defaults` 教程扩展、每个官方扩展的完整说明——在 [docs/extensions.md](docs/extensions.md)。

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
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
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

这就是 `examples/hello-agent.ts`(那里用 faux 适配器——零密钥),消费者冒烟测试在干净工程里对着打包 tarball 编译并运行它。`scripts/hero-check.mjs` 让两者保持同步:任一方向的漂移都会让 check 变红。

- 包构建为纯 ESM JavaScript + `.d.ts`——安装后的产物跑在任意 Node 工程上,无 tsx、无源码访问(`scripts/smoke.mjs` 每次 check 在干净临时工程里证明)。
- `@vincemakes/kiso-evals` 里的每个夹具都是真实生产事故,跑在真实会话运行时上而不是测试套件里——循环是对着它们得到证明的,而不只是快乐路径。

## 内核规则

> 内核不能超过 **2,200 行**。任何把它推过线的 PR 都会被关掉,无论特性多好。CI 在安装任何依赖之前就强制它。需要更多,就生长一个包。这正是重点。

注释不计入——解释可以充分,实现必须精悍。这道门是快照纪律,不是自调节棘轮:它只移动过两次,每次都经裁定修正,而常备的逃生口是**抽取**(ADR-0043)。今天内核停在 **2,139 / 2,200** 行。产品面自 Amendment 8 起走另一套体制——每次 check 打印以供观察,但从不让 check 失败,它们的保护转移到了架构门禁上。

内核拥有 L1 协议、L2 内核、带 JSON Schema 校验的工具契约,以及 eval 钩子。它拒绝拥有循环业务逻辑、UI、权限策略、计费、技能内容与检索:那些活在包里,行数上限不约束它们。一个替你决定这些的内核就是一坨 blob,而 blob 正是你最终要跟它搏斗的东西。[docs/kernel-rule.md](docs/kernel-rule.md) 写全了。

## 文档

| | |
|---|---|
| **从这里开始** | [cli-quickstart.md](docs/cli-quickstart.md)——五分钟跑起一个会话 · [getting-started.md](docs/getting-started.md)——十分钟嵌入 SDK |
| **参考** | [cli.md](docs/cli.md)——命令、审批、模式、键位 · [configuration.md](docs/configuration.md)——模型、effort、凭据 · [extensions.md](docs/extensions.md)——契约与五个官方扩展 |
| **设计** | [durability.md](docs/durability.md)——持久运行时、冻结契约、`kill -9` 证明 · [context.md](docs/context.md)——microcompact、`/compact`、字节纪律 · [concepts.md](docs/concepts.md)——词汇表 · [architecture.md](docs/architecture.md)——职责地图 · [kernel-rule.md](docs/kernel-rule.md)——2,200 行规则与两层结构 |
| **面** | [sdk.md](docs/sdk.md)——公开面与事件流契约 · [usage.md](docs/usage.md)——规范 usage schema 与价格表 · [request-trace.md](docs/request-trace.md)——请求追踪账本 |
| **记录** | [status.md](docs/status.md)——逐个面的交付状态 · [docs/adrs/](docs/adrs/README.md)——39 份架构决策记录 · [bench/README.md](bench/README.md)——bench:同一个模型、同一批任务、三个 Agent |

`npm run check` 是完整门链:build → typecheck → tests → size → pack → API 面 → hero → whitespace → CJK → versions → PTY manifest → dist inventory → bench repro → bytes → `git diff --check` → 消费者冒烟层 → demo。**2,988 个测试全绿,412 个文件**(单元 2,350,PTY 638),6 个事故夹具跑在真实运行时上,39 份 ADR。

## 为什么还要做一个

因为每个 Agent 框架都递给你代码和 API 文档,没有一个递给你推理过程。当模型下个季度变了、某个设计决策不再划算时,文档没法告诉你该拔掉哪一个。ADR 可以。

## 许可证

MIT
