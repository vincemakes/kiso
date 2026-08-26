#!/bin/sh
# REL-0152-D1 — which private mode makes the brackets?
#
# The owner reports stray `[` and `]` at the row edges in kiso and NOT
# in the reference implementation, in the SAME terminal. That is the
# useful half of the report: a terminal does not decorate rows by
# itself, so kiso is holding a mode the other one does not and the
# terminal is rendering something about it.
#
# kiso holds exactly three private modes while a frame paints on this
# terminal — the cursor hidden, autowrap off, bracketed paste on — plus
# mouse reporting while a panel is up. This draws the same box under
# each of them, and then under all of them at once, which is the state
# a real frame is in.
#
# Nothing here is kiso: it is printf and tput. A block that shows a
# bracket names the mode, and says the answer is the TERMINAL's
# handling of that mode rather than anything in the renderer.
#
#   sh scripts/bracket-probe.sh
#
# Compare each block with the CONTROL at the end.
W=$(tput cols 2>/dev/null || echo 80)
line() { printf '%*s' "$1" '' | tr ' ' '-'; }
box() {
  printf '\033[2m+%s+\033[0m\n' "$(line $((W-2)))"
  printf '\033[2m|\033[0m > %*s\033[2m|\033[0m\n' $((W-5)) ''
  printf '\033[2m+%s+\033[0m\n' "$(line $((W-2)))"
}
show() { # $1 = label, $2... = the sequences to hold
  printf '\n=== %s ===\n' "$1"
  shift
  for seq in "$@"; do printf '%b' "$seq"; done
  box
  # every mode back to its DEFAULT: cursor shown, autowrap on, the rest off
  printf '\033[?25h\033[?7h\033[?2004l\033[?1000l\033[?1006l\033[?2026l'
}
show "cursor hidden (?25l) — kiso holds this for the whole frame" '\033[?25l'
show "autowrap off (?7l) — kiso holds this for the whole frame" '\033[?7l'
show "bracketed paste on (?2004h) — kiso holds this the whole session" '\033[?2004h'
show "mouse reporting on (?1000h ?1006h) — only while a panel is up" '\033[?1000h' '\033[?1006h'
show "synchronized output (?2026h) — NOT used on Apple Terminal" '\033[?2026h'
show "ALL of kiso's frame modes at once — the real state" '\033[?25l' '\033[?7l' '\033[?2004h'
printf '\n=== CONTROL: every mode at its default ===\n'
box
printf '\n'
printf 'If one block shows a bracket at a row edge and the CONTROL does not,\n'
printf 'that mode is the answer. If none of them do, the modes are innocent.\n'
