#!/usr/bin/env bash
# Self-test for the recording-split rule (SessionRotation). Pure logic, so it
# compiles and runs on its own — no app bundle, microphone or calendar needed.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$(mktemp -d)/session-rotation-tests"

swiftc \
  -swift-version 5 \
  -target arm64-apple-macos14.0 \
  -o "$BIN" \
  "$APP_DIR/Echo/Sources/SessionRotation.swift" \
  "$APP_DIR/Echo/Tests/SessionRotationTests.swift"

"$BIN"
