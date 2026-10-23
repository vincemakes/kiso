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
the transport or recovery needs `full`. `proofs:full` shows nothing in the Dock: the Electron apps it starts run
with `KISO_DESKTOP_PROOF=1`, which makes them background-only on macOS (no icon, no bounce, no focus, no Cmd-Tab
entry), and the proofs assert it.

How it fits: the Electron main process starts the host in a utility process (session service, loopback
HTTP + SSE on 127.0.0.1, per-launch token) and opens one window on the host's own page. The page talks to the
host through `@vincemakes/kiso-client`. A host crash does not take the window with it.

The model, the effort and the sign-in come from the terminal's own configuration (`~/.kiso/config.json`, `auth.json`), read through
the `./config` door of `@vincemakes/kiso-code`: one login serves both products, and no key is read from the desktop's own environment.
Works live where the terminal keeps sessions (`~/.kiso/projects/<enc>/`), so the history lists the Works of every folder. The folder
a new task starts in is `KISO_DESKTOP_WORKSPACE`, else the one used last, else the working directory; see `src/main/env.ts` for the
rest (`KISO_DESKTOP_FAUX` runs a scripted model, for the proofs). The permission tier is process-wide (see `DEPS.md`).
`background: true` commands run in the task runner, which the host starts as a plain node process under Electron (`runnerEnv`).

Plans, mocks and screenshots live outside this repository.
