# Security policy

kiso runs shell commands and edits files on your machine on behalf of a language model.
Its safety comes from the approval chain (deny > allow > ask), the workspace boundary the
file and shell tools enforce, and the durable log that records every decision. A way
around any of those is a security issue.

## Supported versions

The latest published `0.x` release on npm (`npm i -g @vincemakes/kiso-code@latest`). Fixes
are released as new versions; older versions are not patched.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability.

- Use GitHub's private reporting: **Security → Report a vulnerability** on
  https://github.com/vincemakes/kiso.
- If that is unavailable to you, open an issue titled `security contact request` with no
  details, and the maintainer will provide a private channel.

Include the version (`kiso --version`), the platform, what you did, what you observed,
and — where possible — the durable session log (`~/.kiso/sessions/<id>.jsonl`) with any
secrets removed. A minimal reproduction is the most useful thing you can send.

You will get an acknowledgement within a few days and a fix or a reasoned response as
soon as the issue is understood. The finding is credited in the release notes unless you
prefer otherwise.

## What is in scope

- The approval chain being bypassed: a tool running that should have asked, or a denial
  that did not hold across a process restart.
- The workspace boundary: a file tool or the shell tool touching a path outside the
  workspace without the approval the mode requires.
- Credentials: a stored key or token (`~/.kiso/auth.json`, mode 0600) reaching a
  subprocess, a log, the screen, or a request it was not meant for.
- Prompt injection that reaches a side effect without a human decision in the chain.

## What is out of scope

- Behaviour of the model providers themselves.
- Issues that require the user to run kiso with `--mode bypass` and then rely on the
  absence of approvals: bypass is the documented opt-out.
