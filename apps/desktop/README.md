# kiso desktop (work in progress)

An Electron app on the kiso hosted-session service. Not part of the root build, typecheck or check.

```
npm run build -w @vincemakes/kiso-desktop         # tsc (main, shared, state) + vite (renderer into out/)
npm run gates -w @vincemakes/kiso-desktop         # size, deps, imports, names, CJK
npm run proofs:fast -w @vincemakes/kiso-desktop   # daily, before each commit: no Electron, no kill -9
npm run proofs:full -w @vincemakes/kiso-desktop   # end of a milestone, before a push, before a release
npm run check -w @vincemakes/kiso-desktop         # build + typecheck + gates + proofs:fast
npm run check:full -w @vincemakes/kiso-desktop    # the same with proofs:full
```

Each proof is a script; its exit code is the verdict. `fast` is the reducer, markdown, usage, guard, policy,
control and task proofs (seconds to under a minute). `full` adds the ones that kill the host with `kill -9`
(headless, and the utility process under Electron) and the Electron window proofs. Rule: a change that only
touches renderer styles or components needs `fast`; a change to `src/main`, `src/shared`, the state reducer,
the transport or recovery needs `full`.

How it fits: the Electron main process starts the host in a utility process (session service, loopback
HTTP + SSE on 127.0.0.1, per-launch token) and opens one window on the host's own page. The page talks to the
host through `@vincemakes/kiso-client`. A host crash does not take the window with it.

S1 takes its model from the environment (`KISO_DESKTOP_DATA`, `KISO_DESKTOP_WORKSPACE`, `KISO_DESKTOP_PROVIDER`
with `KISO_DESKTOP_API_KEY`, or `KISO_DESKTOP_FAUX` for a scripted model); see `src/main/env.ts`. Config and
credentials shared with the terminal arrive in S2. The permission tier is process-wide (see `DEPS.md`).
`background: true` commands need the task runner, which fails under Electron until `runnerEnv` is in tools-node.

Plans, mocks and screenshots live outside this repository.
