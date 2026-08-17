import Foundation

/// Parsing of RECONNECT_GRACE — the window that keeps one dropped-and-rejoined
/// call inside one note. Scenarios come from the 2026-08-17 incident, where a
/// headset drop split a single call into four sessions.
enum ReconnectGraceTests {
    static func run() {
        print("ReconnectGrace")

        Check.equal("default when unset", ReconnectGrace.seconds(env: [:]), 120)
        Check.equal("explicit value", ReconnectGrace.seconds(env: ["RECONNECT_GRACE": "45"]), 45)
        Check.equal("zero disables the grace", ReconnectGrace.seconds(env: ["RECONNECT_GRACE": "0"]), 0)
        Check.equal("spaces trimmed", ReconnectGrace.seconds(env: ["RECONNECT_GRACE": " 60 "]), 60)

        // Malformed values must fall back, never crash or disable by accident.
        Check.equal("junk falls back", ReconnectGrace.seconds(env: ["RECONNECT_GRACE": "abc"]), 120)
        Check.equal("negative falls back", ReconnectGrace.seconds(env: ["RECONNECT_GRACE": "-5"]), 120)
        Check.equal("blank falls back", ReconnectGrace.seconds(env: ["RECONNECT_GRACE": ""]), 120)
        Check.equal("capped at 10 min", ReconnectGrace.seconds(env: ["RECONNECT_GRACE": "9999"]), 600)
    }
}
