<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.png"><img src="assets/hero.png" width="100%" alt="kiso — the durable runtime for AI agents"></picture></p>

<p align="center"><b>v0.42.3</b> · MIT · Node ≥ 22 · <a href="https://kiso.work">kiso.work</a> · <a href="README.zh.md">简体中文</a></p>

**kiso is an AI coding agent for your terminal.** It runs on its own agent runtime, which you can also embed in your own program through [the SDK](#using-it).

- **It picks up where it left off.** Every approval and tool result is on disk the moment it happens. After a crash, a `kill -9` or a closed terminal, `kiso resume` continues from the durable committed prefix: generation still streaming when it died is regenerated, and a side effect whose outcome is unknown goes to a human rather than being repeated.
- **Long tasks don't overflow.** Past half the window, kiso compacts at the end of a phase, and each new summary replaces the last instead of piling up. The window is known per model; when an endpoint refuses an oversized request, kiso learns its real limit.
- **You decide, and the floor holds.** Five approval modes; "don't ask again" becomes a rule file you can delete; even in bypass, a command that would destroy something unrecoverable is refused.
- **Any model you have.** DeepSeek, Claude, GPT, a ChatGPT subscription, and any OpenAI-compatible endpoint or gateway. Keys never go in the config file.
- **You can see where it goes.** Each turn ends with its fresh input, output and cache hits; `/context` shows what fills the context; `/status` says where the window figure comes from.
- **Small and inspectable.** The kernel is capped at 2,200 lines (2,191 of 2,200 today); a session is a JSONL log you can read; every design decision is one of 42 ADRs, with why, and when to overturn it.

## Install

```bash
npm install -g @vincemakes/kiso-code
kiso
```

Node ≥ 22 on macOS or Linux. Or run it without installing: `npx @vincemakes/kiso-code`. A newer release announces itself at start, and `kiso update` installs it.

The first run needs no key: kiso plays a scripted demo turn, so you see the shape before anything is spent, then asks you to connect a model.

## Models and effort

Sign in once:

```bash
kiso login deepseek      # or anthropic / openai / zai
kiso login chatgpt       # a ChatGPT subscription: a browser sign-in, no key
kiso login --endpoint https://gateway.example/v1   # a gateway: its key, sent to it alone
kiso auth                # what is stored, masked
```

Then a profile in `~/.kiso/config.json` picks the model; `kiso login` prints one you can paste. The block below is annotated JSONC — strip the `//` comments before saving it:

```jsonc
{
  "model": "deepseek",
  "models": {
    "deepseek": { "kind": "openai-compat", "model": "deepseek-flash", "baseUrl": "https://api.deepseek.com" },
    "claude": {
      "kind": "anthropic",
      "model": "claude-opus-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY",    // the key's env var — never the key
      "promptCaching": false
    }
  }
}
```

- Keys are never in the config: they come from `kiso login`, or from the variable a profile names in `apiKeyEnv`. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` alone in the environment also works.
- `/model` switches the model and its effort in a session (←→ picks the level; some models go down to `none`, which turns thinking off).
- Gateways, context windows, request headers and every other option: [docs/configuration.md](docs/configuration.md).

## Everyday use

Say what you want done. The model has six tools — read, list, search, write, edit and shell — and writes and shell ask you first by default.

**Keys** (`?` shows them all):

| key | does |
|---|---|
| `enter` | send |
| `ctrl+j` / `shift+enter` | newline |
| `esc` | stop the run |
| `alt+enter` | stop the run and send this instead |
| `@` | reference a file |
| `ctrl+o` | expand / collapse tool output |
| `ctrl+t` | hide / show thinking (remembered) |
| `ctrl+r` | the full transcript |
| `ctrl+g` | edit the prompt in `$EDITOR` |
| `ctrl+x` | copy the last answer |
| `ctrl+v` | attach the clipboard image (macOS; elsewhere, put the image's path in your message) |
| `shift+tab` | switch the approval mode |

**Commands** (`/help` lists them all):

| command | does |
|---|---|
| `/model` | switch the model and its effort |
| `/mode` | switch the approval mode |
| `/status` | session id, context use, model and version |
| `/settings` | the settings in force, where each came from, how to change it |
| `/compact` | summarize the older conversation to free context |
| `/resume` | switch to another session |
| `/clear` | start a fresh session (the old one stays resumable) |
| `/think` | show the last full thinking block |
| `/copy` | copy the last answer |
| `/skills` | list the installed skills |
| `!cmd` | run a shell command and send it with its output |
| `!!cmd` | run it here only — the model never sees it |

## Modes

`/mode` or `shift+tab` switches; the status row always names the mode.

| mode | does |
|---|---|
| `default` | reads and read-only shell run; writes, edits and other shell ask |
| `accept-edits` | `default`, and edits run too (except into `.git/` or `.kiso/`) |
| `plan` | reads only; everything else is refused |
| `bypass` | everything runs |
| `dontAsk` | never asks: whatever would ask is refused and the run goes on — for unattended and CI runs |

A mode is one voice in a `deny > allow > ask` chain, so a saved "don't ask again" rule still allows under any mode: switching modes is not a revocation. The rules live in `~/.kiso/extensions/dont-ask-again.mjs`; delete one to be asked again.

In every mode, bypass included, a destructive command aimed at what cannot be recovered — `/`, your home directory, the workspace root, its `.git`, `~/.ssh` and the like — is refused. The full rules: [docs/cli.md](docs/cli.md).

## Sessions

```bash
kiso resume              # pick a session to continue
kiso resume <id>         # continue that one
kiso sessions            # list sessions and their state
```

- Sessions live per project and resume only in their own project.
- An interrupted session resumes its own trajectory; completed steps are not replayed.
- An operation whose outcome is unknown (a command cut off mid-run) is put to you before anything reruns — never repeated on its own.
- Past half the model's window kiso compacts at the next phase end, past 80% at once; `/compact` does it on demand.

## Extending kiso

An extension is a plain `.mjs` file — no build step. Five ship built in:

- **MCP** — configure servers in `~/.kiso/mcp.json`; each of their tools becomes one the model can call.
- **Skills** — a directory with a `SKILL.md` under `~/.kiso/skills`, loaded on demand.
- **Subagents** — the `delegate` tool runs up to 4 tasks at a time; implementers work in their own git worktree.
- **Ask** — the model can put 1–4 multiple-choice questions to you.
- **Task** — a durable todo list; off by default.

**Which children are stripped.** The two a model can cause to run — the shell tool and an MCP server started over stdio — lose provider credentials: the known key variables, anything ending `_API_KEY` or `_AUTH_TOKEN`, and every variable a profile names in `apiKeyEnv`. NOT stripped: a subagent's child (it is kiso itself and must reach the model) and the programs you start yourself (`$EDITOR`, the sign-in browser, `kiso update`), which inherit your environment.

Writing your own: [docs/extensions.md](docs/extensions.md).

## Using it

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

Getting started with the SDK: [docs/getting-started.md](docs/getting-started.md).

## Documentation

| | |
|---|---|
| Start | [cli-quickstart.md](docs/cli-quickstart.md) · [getting-started.md](docs/getting-started.md) |
| Reference | [cli.md](docs/cli.md) · [configuration.md](docs/configuration.md) · [extensions.md](docs/extensions.md) · [sdk.md](docs/sdk.md) |
| Design | [durability.md](docs/durability.md) · [context.md](docs/context.md) · [architecture.md](docs/architecture.md) · [kernel-rule.md](docs/kernel-rule.md) · [ADRs](docs/adrs/README.md) |
| Status | [status.md](docs/status.md) · [bench/README.md](bench/README.md) |

## License

MIT
