#!/usr/bin/env bash
# Self-tests for the app's pure decision logic — which processes count as a call
# (DetectExclusions) and when a recording gets split (SessionRotation). No app
# bundle, microphone or calendar needed, so this runs anywhere.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$(mktemp -d)/echo-tests"

swiftc \
  -swift-version 5 \
  -target arm64-apple-macos14.0 \
  -o "$BIN" \
  "$APP_DIR/Echo/Sources/SessionRotation.swift" \
  "$APP_DIR/Echo/Sources/DetectExclusions.swift" \
  "$APP_DIR/Echo/Tests/Check.swift" \
  "$APP_DIR/Echo/Tests/SessionRotationTests.swift" \
  "$APP_DIR/Echo/Tests/DetectExclusionsTests.swift" \
  "$APP_DIR/Echo/Tests/main.swift"

"$BIN"
