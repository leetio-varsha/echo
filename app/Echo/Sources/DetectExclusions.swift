import Foundation

/// Process names that hold an audio input device but are never a call.
///
/// Three kinds end up here:
/// 1. daemons Echo's OWN recording spins up (`replayd` via ScreenCaptureKit) —
///    they never release, so without excluding them auto-stop can't fire;
/// 2. macOS speech daemons (`corespeechd`), also caught by the tap-vs-device
///    check in `CallDetector`;
/// 3. **sibling listener apps** — Sufler (built as `CallPilot.app`) is a
///    real-time call assistant that sits on the microphone the whole time it
///    runs. Sufler excludes Echo for exactly the same reason; this is the other
///    half of that pact. Without it Echo both starts phantom recordings and,
///    worse, can never auto-stop a real one while Sufler is up.
enum DetectExclusions {
    /// Known on this machine. Sufler has shipped under two executable names, so
    /// both are listed — see `DETECT_EXCLUDE` for anything not covered here.
    static let builtIn: Set<String> = [
        "replayd",
        "coreaudiod",
        "corespeechd",
        "Sufler",
        "CallPilot",
        "sufler-helper",
    ]

    /// Parse a `DETECT_EXCLUDE=Loom, Slack` value into process names.
    /// Tolerant of blanks and stray commas — a malformed entry must not take
    /// the whole exclusion list down with it.
    static func parse(_ raw: String?) -> Set<String> {
        guard let raw else { return [] }
        return Set(
            raw.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty })
    }

    /// Built-ins plus whatever `DETECT_EXCLUDE` adds (same key Sufler uses, read
    /// from the same `pipeline/.env`).
    static func names(env: [String: String]) -> Set<String> {
        builtIn.union(parse(env["DETECT_EXCLUDE"]))
    }
}
