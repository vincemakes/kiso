# kiso desktop (work in progress)

An Electron app on the kiso hosted-session service. Not part of the root build, typecheck or check.

```
npm run build -w @vincemakes/kiso-desktop      # tsc (main, shared, state) + vite (renderer into out/)
npm run check -w @vincemakes/kiso-desktop      # build + typecheck + import gate
npm run proofs -w @vincemakes/kiso-desktop     # every proof script; the exit code is the verdict
```

How it fits: the Electron main process starts the host in a utility process (session service, loopback
HTTP + SSE on 127.0.0.1, per-launch token) and opens one window on the host's own page. The page talks to the
host through `@vincemakes/kiso-client`. A host crash does not take the window with it.

S1 takes its model from the environment (`KISO_DESKTOP_DATA`, `KISO_DESKTOP_WORKSPACE`, `KISO_DESKTOP_PROVIDER`
with `KISO_DESKTOP_API_KEY`, or `KISO_DESKTOP_FAUX` for a scripted model); see `src/main/env.ts`. Config and
credentials shared with the terminal arrive in S2. The permission tier is process-wide (see `DEPS.md`).

Plans, mocks and screenshots live outside this repository.
