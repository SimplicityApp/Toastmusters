#!/bin/zsh
# scroll.sh <X,Y> <lines>   (negative = down). The Zoom webview ignores Page Down and
# cliclick cannot scroll, so this posts a real wheel event (compiled once, cached).
source "$(dirname "$0")/_env.sh"; mkdir -p "$BIN"
S="$BIN/scroll"
if [ ! -x "$S" ]; then
cat > "$BIN/scroll.swift" <<'SW'
import CoreGraphics
import Foundation
let a = CommandLine.arguments
let x = Double(a[1])!, y = Double(a[2])!, n = Int32(a[3])!
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(50000)
let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: n, wheel2: 0, wheel3: 0)
e?.location = CGPoint(x: x, y: y)
e?.post(tap: .cghidEventTap)
SW
swiftc -O -o "$S" "$BIN/scroll.swift" || exit 1
fi
"$S" ${1%,*} ${1#*,} $2
