# kiso web (work in progress)

A local web app on the kiso hosted-session service: `kiso-web` runs the host in its own process and serves the page at
`http://127.0.0.1:4317`. Not part of the root build, typecheck or check.

```
npm run build -w @vincemakes/kiso-web         # tsc (host, shared, state) + vite (the page into out/)
npm run start -w @vincemakes/kiso-web         # kiso-web: the host, and the default browser opened on the page
npm run gates -w @vincemakes/kiso-web         # size, deps, imports, names, paths, CJK
npm run proofs:fast -w @vincemakes/kiso-web   # daily, before each commit: no browser, no kill -9
npm run proofs:full -w @vincemakes/kiso-web   # end of a milestone, before a push, before a release
npm run check -w @vincemakes/kiso-web         # build + typecheck + gates + proofs:fast
npm run check:full -w @vincemakes/kiso-web    # the same with proofs:full
```

`kiso-web [--port 4317] [--no-open] [--revoke-sessions]`. The port is fixed, so a page added to the Dock (Safari: File > Add to Dock;
Chrome or Edge: Install page as app) keeps its address. Running it again while a host holds the port opens the browser on that host;
anything else on the port is an error that names the process. The host runs while the command runs: with no host, the page cannot load.

Sign-in: the command opens the browser on a one-time connect code in the address (good for two minutes); the page trades it for a
session cookie (`HttpOnly`, `SameSite=Strict`, named after the port) and strips it from the address, so the page holds no secret of its
own. The host keeps the sessions hashed in `$KISO_HOME/web.json` (mode 0600); `--revoke-sessions` forgets them all, and every page signs in
again from the command. Every request still passes the Host and Origin checks: a cookie on 127.0.0.1 is sent to every port of it. A session
is a key to this machine's shell: do not run a page you do not trust on 127.0.0.1.

Each proof is a script; its exit code is the verdict. `fast` is the reducer, markdown, usage, guard, sign-in, policy, control and task
proofs (seconds to under a minute). `full` adds the ones that kill the host with `kill -9` and the page proofs, which drive a headless
Chrome through the DevTools protocol (Chrome is found on the machine, or named by `KISO_WEB_CHROME`), including a tab closed and reopened
mid-run and one approval answered from two tabs. Rule: a change that only touches page styles or components needs `fast`; a change to
`src/main`, `src/shared`, the state reducer, the transport or recovery needs `full`.

The model, the effort and the sign-in come from the terminal's own configuration (`~/.kiso/config.json`, `auth.json`), read through
the `./config` door of `@vincemakes/kiso-code`: one login serves both products, and no key is read from the web app's own environment.
Works live where the terminal keeps sessions (`~/.kiso/projects/<enc>/`), so the history lists the Works of every folder. The folder
a new task starts in is `KISO_WEB_WORKSPACE`, else the one used last while it still exists, else the home folder; another is chosen in
the page's folder browser (folders only; from home, or from a full path typed in). Notifications are off until turned on in Settings,
and only while the page is open. See `src/main/env.ts` for the rest (`KISO_WEB_FAUX` runs a scripted model, for the proofs).

The proofs budget (`scripts/proofs`) is 1,600 lines from S5 on, by an owner ruling of 2026-10-26 (it was 1,300 from S4 by a ruling of 2026-10-25, 1,000 from S2 by a ruling of 2026-10-23, and 700 before); the other budgets are unchanged.

Plans, mocks and screenshots live outside this repository.
