#!/usr/bin/env bash
# Generate a short multilingual test clip using macOS `say` -> .m4a.
# Usage: ./samples/make-sample.sh   (run from the repo root, macOS only)
set -euo pipefail

OUT="${1:-samples/test.m4a}"
TXT=$(cat <<'EOF'
Привет, это тестовый звонок для проекта Echo.
Давай решим: релиз делаем в пятницу. Юра подготовит спецификацию.
Open question: do we need speaker diarization in phase two?
EOF
)

# `say` writes AIFF; convert to m4a with afconvert (both ship with macOS).
TMP_AIFF=$(mktemp -t echo-sample).aiff
say -v Milena "$TXT" -o "$TMP_AIFF" 2>/dev/null || say "$TXT" -o "$TMP_AIFF"
afconvert "$TMP_AIFF" "$OUT" -f m4af -d aac
rm -f "$TMP_AIFF"
echo "Wrote $OUT"
