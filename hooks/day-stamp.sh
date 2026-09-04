#!/bin/sh
# Agentrava day stamp. Records that a session was active today, so streaks stay
# honest without the cost of parsing a transcript and re-rendering a card.
#
# Deliberately not Node: spawning a runtime is most of what the full hook costs.
# Appends at most one line per day; concurrent sessions may double-append, which
# is harmless because the file is read as a set.
d=$(date +%Y-%m-%d)
f="${AGENTRAVA_HOME:-$HOME/.agentrava}/days.txt"
mkdir -p "$(dirname "$f")" 2>/dev/null
[ -f "$f" ] && [ "$(tail -n 1 "$f" 2>/dev/null)" = "$d" ] || printf '%s\n' "$d" >> "$f"
exit 0
