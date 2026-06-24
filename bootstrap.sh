#!/usr/bin/env bash
# Echo one-command setup. Run once after cloning, on your own Mac:
#   ./bootstrap.sh
# Installs/builds everything heavy (whisper.cpp + models, deps, the app); the
# Notion token + Claude key are entered later in the app's GUI onboarding.
# Idempotent: re-running skips steps that are already done.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WHISPER_DIR="${ECHO_WHISPER_DIR:-$HOME/whisper.cpp}"
MODEL="$WHISPER_DIR/models/ggml-large-v3.bin"
VAD="$WHISPER_DIR/models/ggml-silero-v5.1.2.bin"
WHISPER_BIN="$WHISPER_DIR/build/bin/whisper-cli"

say() { printf "\n\033[1;35m▶ %s\033[0m\n" "$1"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
die() { printf "\n\033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

# Ensure a command exists; try `brew install <pkg>` if Homebrew is present, else instruct.
need() {
  local cmd="$1" pkg="${2:-$1}"
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd"; return; fi
  if command -v brew >/dev/null 2>&1; then
    say "Installing $pkg via Homebrew…"; brew install "$pkg"
  else
    die "Missing '$cmd' and Homebrew not found. Install Homebrew (https://brew.sh) or '$cmd', then re-run."
  fi
}

# ---------------------------------------------------------------------------
say "1/6  Prerequisites"
command -v brew >/dev/null 2>&1 && ok "brew" || echo "  (no Homebrew — will instruct if a tool is missing)"
need git
need node          # Node ≥20; the pipeline runs on it
need cmake         # to build whisper.cpp
need ffmpeg        # audio → 16kHz WAV
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] || die "Node ≥20 required (found $(node -v 2>/dev/null)). Upgrade Node and re-run."

# ---------------------------------------------------------------------------
say "2/6  whisper.cpp (Metal)"
if [ -x "$WHISPER_BIN" ]; then
  ok "whisper-cli already built ($WHISPER_BIN)"
else
  [ -d "$WHISPER_DIR/.git" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR"
  cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DWHISPER_METAL=ON
  cmake --build "$WHISPER_DIR/build" -j --config Release
  [ -x "$WHISPER_BIN" ] || die "whisper-cli did not build at $WHISPER_BIN"
  ok "built whisper-cli"
fi

say "3/6  Models (~3 GB on first run)"
[ -f "$MODEL" ] && ok "large-v3 present" || bash "$WHISPER_DIR/models/download-ggml-model.sh" large-v3
[ -f "$VAD" ]   && ok "silero VAD present" || bash "$WHISPER_DIR/models/download-vad-model.sh" silero-v5.1.2

# ---------------------------------------------------------------------------
say "4/6  Pipeline dependencies"
( cd "$ROOT/pipeline" && npm install --silent ) && ok "npm install"

# ---------------------------------------------------------------------------
say "5/6  Code-signing identity (stable TCC across rebuilds)"
if security find-identity -p codesigning 2>/dev/null | grep -q "Echo Self-Signed"; then
  ok "'Echo Self-Signed' identity present"
else
  TMP="$(mktemp -d)"
  cat > "$TMP/cs.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Echo Self-Signed
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
CNF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -keyout "$TMP/k.pem" -nodes -out "$TMP/c.pem" -days 3650 -config "$TMP/cs.cnf"
  /usr/bin/openssl pkcs12 -export -inkey "$TMP/k.pem" -in "$TMP/c.pem" -out "$TMP/c.p12" -passout pass:echo -name "Echo Self-Signed"
  security import "$TMP/c.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P echo -T /usr/bin/codesign
  rm -rf "$TMP"
  ok "created 'Echo Self-Signed' identity"
fi

# ---------------------------------------------------------------------------
say "6/6  .env + app build"
ENV="$ROOT/pipeline/.env"
if [ -f "$ENV" ]; then
  ok ".env exists — leaving it untouched"
else
  cp "$ROOT/pipeline/.env.example" "$ENV"
  perl -i -pe "s{^WHISPER_CPP_PATH=.*}{WHISPER_CPP_PATH=$WHISPER_BIN};
               s{^WHISPER_MODEL=.*}{WHISPER_MODEL=$MODEL};
               s{^WHISPER_VAD_MODEL=.*}{WHISPER_VAD_MODEL=$VAD}" "$ENV"
  ok "wrote pipeline/.env (whisper paths filled; Notion/Claude via the app's onboarding)"
fi
( cd "$ROOT/app" && ./build.sh >/dev/null ) && ok "built app/build/Echo.app"

# ---------------------------------------------------------------------------
printf "\n\033[1;32m✅ Echo is set up.\033[0m\n"
echo "Next:  open \"$ROOT/app/build/Echo.app\"  → finish setup in the onboarding window"
echo "       (Notion token → create databases, Claude access)."
