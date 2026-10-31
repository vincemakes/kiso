# Dependencies

Every dependency of `apps/web`, one line of reason each. A new one is a plan change; the dependency
gate compares this list with `package.json`.

## Workspace packages (all `0.51.1`, the lockstep)

| Package | Why |
|---|---|
| `@vincemakes/kiso-client` | the typed client the page and the proofs use over the loopback |
| `@vincemakes/kiso-code` | the terminal product's doors: `./policy` (prompt, tool rules, floor, guards, mode tiers) and `./config` (profiles, sign-in, session folders) |
| `@vincemakes/kiso-core` | event and tool types, `projectMessages` |
| `@vincemakes/kiso-protocol` | the wire types |
| `@vincemakes/kiso-provider-openai` | the model adapter the runtime loads for an OpenAI-compatible endpoint |
| `@vincemakes/kiso-runtime` | the agent, the session store, `kisoHome`, `canonicalizeUsage`; `/internal` only in `src/main/tasks.ts` until the task manager is exported |
| `@vincemakes/kiso-server` | the hosted-session service and its HTTP + SSE transport |
| `@vincemakes/kiso-tools-node` | the coding tools and the process task backend |
| `@vincemakes/kiso-evals` (dev) | the scripted model the proofs run on |

## Tools and the renderer (all dev, exact versions)

| Package | Why |
|---|---|
| `typescript`, `@types/node` | the language and the Node types |
| `react`, `react-dom` | the renderer's UI |
| `@types/react`, `@types/react-dom` | types for the two above (no runtime code) |
| `vite`, `@vitejs/plugin-react` | bundles the page into `out/renderer`, which the host serves |

The proofs drive a headless Chrome through the DevTools protocol with Node's built-in `WebSocket`: no browser driver is a dependency.
Chrome itself is found on the machine (`KISO_WEB_CHROME`, else the usual places on macOS and Linux).
