import Foundation

/// Which processes must never be mistaken for a call. Scenarios come from the
/// 2026-07-30/31 incident: Sufler (shipped as `CallPilot.app`) sits on the
/// microphone for as long as it runs, which produced 33 phantom recordings
/// overnight and kept Echo from ever auto-stopping a real one.
enum DetectExclusionsTests {
    static func run() {
        print("DetectExclusions")

        let none = DetectExclusions.names(env: [:])

        // The sibling call-assistant, under both names it has shipped as.
        Check.equal("CallPilot excluded", none.contains("CallPilot"), true)
        Check.equal("Sufler excluded", none.contains("Sufler"), true)
        Check.equal("sufler-helper excluded", none.contains("sufler-helper"), true)

        // Pre-existing exclusions must survive the change.
        Check.equal("replayd still excluded", none.contains("replayd"), true)
        Check.equal("corespeechd still excluded", none.contains("corespeechd"), true)

        // Real call apps must still be detected — this is the whole point.
        Check.equal("Chrome helper not excluded", none.contains("Google Chrome Helper"), false)
        Check.equal("zoom not excluded", none.contains("zoom.us"), false)
        Check.equal("Slack helper not excluded", none.contains("Slack Helper"), false)

        // DETECT_EXCLUDE — same key and format Sufler uses.
        let extra = DetectExclusions.names(env: ["DETECT_EXCLUDE": "Loom, Slack Helper"])
        Check.equal("env name added", extra.contains("Loom"), true)
        Check.equal("env name with spaces trimmed", extra.contains("Slack Helper"), true)
        Check.equal("built-ins kept alongside env", extra.contains("CallPilot"), true)

        // A malformed value must not wipe the built-in list.
        Check.equal("blank env is ignored", DetectExclusions.parse(""), [])
        Check.equal("stray commas ignored", DetectExclusions.parse(" , ,, "), [])
        Check.equal("nil env is ignored", DetectExclusions.parse(nil), [])
        Check.equal(
            "built-ins survive a junk env",
            DetectExclusions.names(env: ["DETECT_EXCLUDE": " , ,, "]).contains("CallPilot"),
            true)
        Check.equal("single name, no comma", DetectExclusions.parse("Loom"), ["Loom"])
    }
}
