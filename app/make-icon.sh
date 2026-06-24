#!/usr/bin/env bash
# Generate Echo's app icon (gradient squircle + white waveform) → Echo/AppIcon.icns.
# Pure code, no design tools. Re-run to regenerate. Optional arg: preview PNG path.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
PREVIEW="${1:-}"

cat > "$TMP/icon.swift" <<'SWIFT'
import AppKit
_ = NSApplication.shared
let S = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: S, pixelsHigh: S,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let size = CGFloat(S)
let rect = NSRect(x: 0, y: 0, width: size, height: size)
NSBezierPath(roundedRect: rect, xRadius: 230, yRadius: 230).addClip()
NSGradient(colors: [
    NSColor(srgbRed: 0.40, green: 0.19, blue: 0.92, alpha: 1),
    NSColor(srgbRed: 0.96, green: 0.28, blue: 0.55, alpha: 1)])!
    .draw(in: rect, angle: -45)
NSColor.white.setFill()
let heights: [CGFloat] = [0.30, 0.52, 0.80, 1.0, 0.80, 0.52, 0.30]
let barW: CGFloat = 76, gap: CGFloat = 46
let totalW = CGFloat(heights.count) * barW + CGFloat(heights.count - 1) * gap
var x = (size - totalW) / 2
for h in heights {
    let bh = size * 0.60 * h, y = (size - bh) / 2
    NSBezierPath(roundedRect: NSRect(x: x, y: y, width: barW, height: bh),
                 xRadius: barW / 2, yRadius: barW / 2).fill()
    x += barW + gap
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
SWIFT

swift "$TMP/icon.swift" "$TMP/icon.png"

ICONSET="$TMP/Echo.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z "$d" "$d" "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$DIR/Echo/AppIcon.icns"
[ -n "$PREVIEW" ] && cp "$TMP/icon.png" "$PREVIEW"
echo "wrote $DIR/Echo/AppIcon.icns"
