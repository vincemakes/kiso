<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.png"><img src="assets/hero.png" width="100%" alt="kiso"></picture></p>

<p align="center"><b>v0.42.3</b> · MIT · Node ≥ 22 · <a href="https://kiso.work">kiso.work</a> · <a href="README.md">English edition</a></p>

**kiso 是一个在终端里用的 AI 编程助手。** 它建在自己的 agent 运行时之上，这套运行时也可以用 [SDK](#作为-sdk-使用) 嵌进你自己的程序。

- **断了能接着做。** 每次审批、每个工具结果都在发生时写进磁盘。进程崩溃、`kill -9`、关掉终端之后，`kiso resume` 从已提交的持久前缀继续：中断时还没生成完的内容会重新生成，结果不确定的操作交给人决定，绝不自动重做。
- **长任务不爆上下文。** 用到窗口一半时自动压缩，新摘要替换旧摘要，不会越压越多。窗口大小按模型识别；端点拒绝超长请求时，kiso 会记住它真实的上限。
- **你说了算，底线也兜得住。** 五种审批模式随时切换；"不再询问"存成一个可以删掉的规则文件；就算在全部放行的模式下，删了就回不来的命令也会被拒绝。
- **哪家的模型都能接。** DeepSeek、Claude、GPT、ChatGPT 订阅，以及任何 OpenAI 兼容的端点和网关。密钥从不写进配置文件。
- **花在哪里一目了然。** 每轮结束显示这一轮的新输入、输出和缓存命中；`/context` 看上下文被什么占着；`/status` 说清窗口大小是从哪来的。
- **小而透明。** 内核上限 2,200 行（现在 2,191 行），超了就不合并；会话就是一份可以直接读的 JSONL 日志；每个设计决定都记在 42 份 ADR 里，写明为什么这样做、什么情况下该推翻它。

## 安装

```bash
npm install -g @vincemakes/kiso-code
kiso
```

需要 Node ≥ 22，支持 macOS 和 Linux。不想安装可以直接 `npx @vincemakes/kiso-code`。有新版本时启动会提示，`kiso update` 一键升级。

第一次运行不需要密钥：kiso 会先用内置脚本演示一轮完整流程，不花一分钱。演示结束后，它会提示你接入模型。

## 接入模型

先登录，把密钥存好：

```bash
kiso login deepseek      # 也可以是 anthropic / openai / zai
kiso login chatgpt       # ChatGPT 订阅，浏览器登录，不需要密钥
kiso login --endpoint https://gateway.example/v1   # 网关：密钥只发给这个网关
kiso auth                # 查看已存的登录信息（已打码）
```

然后在 `~/.kiso/config.json` 里用模型档选模型，`kiso login` 会打印一段可以直接粘贴的配置。下面是带注释的 JSONC，保存前要删掉 `//` 注释：

```jsonc
{
  "model": "deepseek",
  "models": {
    "deepseek": { "kind": "openai-compat", "model": "deepseek-flash", "baseUrl": "https://api.deepseek.com" },
    "claude": {
      "kind": "anthropic",
      "model": "claude-opus-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY",    // 密钥所在的环境变量名，不是密钥本身
      "promptCaching": false
    }
  }
}
```

- 配置文件里**从不存密钥**：密钥来自 `kiso login`，或者由 `apiKeyEnv` 指定一个环境变量名。
- 只设了 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 环境变量，也能直接跑。
- 会话里用 `/model` 切换模型和思考档位（←→ 调档位，有的模型可以调到 `none` 关掉 thinking）。
- 自定义网关、上下文窗口、请求头等全部选项见 [docs/configuration.md](docs/configuration.md)。

## 日常使用

直接说你要做什么。模型有六个工具：读文件、列目录、搜索、写文件、改文件、跑命令。写文件和跑命令默认会先问你。

**常用按键**（会话里按 `?` 看全部）：

| 按键 | 作用 |
|---|---|
| `enter` | 发送 |
| `ctrl+j` / `shift+enter` | 换行 |
| `esc` | 停止当前运行 |
| `alt+enter` | 停止当前运行，改发这一条 |
| `@` | 引用项目里的文件 |
| `ctrl+o` | 展开 / 收起工具输出 |
| `ctrl+t` | 隐藏 / 显示 thinking（会记住） |
| `ctrl+r` | 查看完整对话记录 |
| `ctrl+g` | 用 `$EDITOR` 编辑输入框 |
| `ctrl+x` | 复制上一条回答 |
| `ctrl+v` | 贴剪贴板里的图片（macOS；其他系统在消息里写上图片路径） |
| `shift+tab` | 切换审批模式 |

**常用命令**（输入 `/help` 看全部）：

| 命令 | 作用 |
|---|---|
| `/model` | 切换模型和思考档位 |
| `/mode` | 切换审批模式 |
| `/status` | 会话编号、上下文用量、当前模型和版本 |
| `/settings` | 当前生效的设置、每项的来源和怎么改 |
| `/compact` | 压缩较早的对话，腾出上下文 |
| `/resume` | 切到另一个会话 |
| `/clear` | 开一个新会话（旧的仍可恢复） |
| `/think` | 查看上一段完整的 thinking |
| `/copy` | 复制上一条回答 |
| `/skills` | 列出已安装的技能 |
| `!命令` | 跑一条 shell 命令，连同输出一起发给模型 |
| `!!命令` | 只在本地跑，模型看不到 |

## 审批模式

`/mode` 或 `shift+tab` 切换，状态栏始终显示当前模式。

| 模式 | 行为 |
|---|---|
| `default` | 读文件和只读命令直接放行；写文件、改文件、其他命令先问你 |
| `accept-edits` | 在 `default` 基础上，改文件直接放行（`.git/`、`.kiso/` 除外） |
| `plan` | 只能读，其他一律拒绝 |
| `bypass` | 全部放行 |
| `dontAsk` | 从不提问：会问的都直接拒绝，运行继续。适合无人值守和 CI |

模式只是 `deny > allow > ask` 这条链里的一票：保存过的"不再询问"规则在任何模式下都照样放行，切换模式不会撤销它。这些规则存在 `~/.kiso/extensions/dont-ask-again.mjs`，删掉一条就会重新询问。

**任何模式下（包括 `bypass`）**，kiso 都会拒绝删了就无法恢复的命令：比如 `rm -rf` 指向你的家目录、工作区根目录、`.git`、`~/.ssh` 这类位置。完整规则见 [docs/cli.md](docs/cli.md)。

## 会话与恢复

```bash
kiso resume              # 选一个会话接着做
kiso resume <id>         # 直接接着做指定会话
kiso sessions            # 列出会话和各自的状态
```

- 会话按项目存放，只在它自己的项目里恢复。
- 中途被打断的会话，恢复后**接着原来的步骤做**，不会重放已经完成的操作。
- 结果不确定的操作（比如跑到一半的命令）会先问你要不要重跑，绝不自动重复。
- 上下文用到窗口一半时，kiso 会在一个阶段结束后自动压缩；到 80% 时立即压缩。也可以随时 `/compact`。

## 扩展

扩展就是一个普通的 `.mjs` 文件，不需要构建。内置了五个：

- **MCP**：在 `~/.kiso/mcp.json` 配置，每个 MCP 工具都会变成模型可以调用的工具。
- **技能**：`~/.kiso/skills` 下放一个带 `SKILL.md` 的目录，按需加载。
- **子代理**：`delegate` 工具最多同时跑 4 个子任务，改代码的子任务在独立的 git worktree 里做。
- **提问**：模型可以一次问你 1 到 4 个带选项的问题。
- **任务清单**：可持久化的待办列表，默认关闭。

**哪些子进程会被剥离凭据。** 模型能触发运行的两类：shell 工具，以及用 stdio 启动的 MCP 服务器。它们拿不到模型商的凭据：已知的密钥变量、以 `_API_KEY` 或 `_AUTH_TOKEN` 结尾的变量、以及模型档 `apiKeyEnv` 指定的变量都会被去掉。不剥离的：subagent 的子进程（它就是 kiso 本身，要连模型），以及你自己启动的程序（`$EDITOR`、登录用的浏览器、`kiso update`），它们照常继承你的环境。

写自己的扩展见 [docs/extensions.md](docs/extensions.md)。

## 作为 SDK 使用

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

入门见 [docs/getting-started.md](docs/getting-started.md)。

## 文档

| | |
|---|---|
| 上手 | [cli-quickstart.md](docs/cli-quickstart.md) · [getting-started.md](docs/getting-started.md) |
| 参考 | [cli.md](docs/cli.md) · [configuration.md](docs/configuration.md) · [extensions.md](docs/extensions.md) · [sdk.md](docs/sdk.md) |
| 设计 | [durability.md](docs/durability.md) · [context.md](docs/context.md) · [architecture.md](docs/architecture.md) · [kernel-rule.md](docs/kernel-rule.md) · [ADR](docs/adrs/README.md) |
| 现状 | [status.md](docs/status.md) · [bench/README.md](bench/README.md) |

## 许可

MIT
