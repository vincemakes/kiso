/**
 * DC-59 (0.32.2) — the one thing kiso can say about scrolling under tmux.
 *
 * Under tmux without `mouse on`, the terminal turns wheel and trackpad
 * scrolling into arrow keys for tmux's alternate screen and tmux passes
 * them to the pane: a scroll over the idle composer walks the history
 * (TMUX-F1). The editor's burst guard collapses a wheel NOTCH — three or
 * more identical arrows in one read — but a smooth trackpad stream arrives
 * one arrow per read and is indistinguishable from a hand. With `mouse on`
 * tmux owns the wheel and kiso receives nothing (measured). So kiso names
 * the cause once at start when it is knowable, and never guesses: no
 * `$TMUX`, no question asked; the option unreadable, no hint.
 *
 * PURE on purpose: the decision takes the env and a reader; the spawn that
 * asks tmux lives with the CLI's other spawns (this module's tests are
 * unit tests and must stay so — the pty-manifest gate classifies by import
 * closure).
 */
export const TMUX_MOUSE_HINT =
	"under tmux without `mouse on`, trackpad and wheel scrolling arrive as arrow keys and walk the composer history — add `set -g mouse on` to ~/.tmux.conf";

/** The hint, or null. `show` reads tmux's global `mouse` option ("on" /
 *  "off"), or null when tmux cannot be asked. */
export function tmuxMouseHint(env: Readonly<Record<string, string | undefined>>, show: () => string | null): string | null {
	if (env.TMUX === undefined || env.TMUX === "") return null;
	return show() === "off" ? TMUX_MOUSE_HINT : null;
}
