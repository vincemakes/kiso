# @vincemakes/kiso-tui

kiso's terminal layer: the compositor (the scrollback transcript and the
pinned dock beneath it), the raw-mode editor (prompt, menu, paste, undo),
the pick panels (model, mode, sessions, the @-file window), the status
meters, the context ledger, the approval and ask panels, and the key
bindings sheet. Built on `@vincemakes/kiso-tui-cells` and otherwise
dependency-free: input is data, output is bytes.

The CLI (`@vincemakes/kiso-code`) drives it; nothing here reads a
provider or a session store. See the repository README for the
framework overview.
