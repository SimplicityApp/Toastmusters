#!/bin/zsh
# click.sh <X,Y> [--activate] [--app <process name>]
# Clicks only if the expected app is frontmost (default zoom.us) — the user may be using the
# Mac, and a blind click lands in *their* window. Exit 3 = refused, nothing clicked.
# --activate: click twice, 0.4 s apart, for the Zoom panel when a first click only highlights.
# Never use --activate on dropdowns/toggles — the second click closes them.
p="$1"; shift; [ -z "$p" ] && { echo "usage: click.sh X,Y [--activate] [--app name]"; exit 1; }
act=""; app="zoom.us"
while [ -n "$1" ]; do case $1 in --activate) act=1; shift;; --app) app=$2; shift 2;; *) shift;; esac; done
front=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')
if [ "$front" != "$app" ]; then
  echo "REFUSED: frontmost app is '$front', expected '$app'. The user may be using the Mac — ask before taking over, or run zoom-front.sh first." >&2
  exit 3
fi
if [ -n "$act" ]; then cliclick c:$p w:400 c:$p; else cliclick c:$p; fi
