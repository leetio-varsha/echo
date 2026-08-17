import Foundation

/// How long a session keeps recording after the call app releases the
/// microphone, waiting for the call to come back.
///
/// A dropped connection — or a Bluetooth headset dying mid-call (2026-08-17:
/// a Beoplay HX lost its handsfree link, Chrome released the mic, and one call
/// became four sessions and four Notion notes) — frees the mic exactly like a
/// real hang-up, so the detector's short debounce alone cannot tell them apart.
/// Instead of closing the note right away, the session stays open through this
/// grace window; if a call resumes it continues in the SAME note, and only a
/// window that expires ends the session. The recorder keeps running through the
/// gap, so the tail is silence, never lost speech.
///
/// The min-duration filter measures up to the moment the mic went free (not the
/// end of the grace tail), so a 2-second mic blip is still discarded even
/// though the recorder ran minutes longer.
enum ReconnectGrace {
    /// Long enough to reload a Meet tab or power-cycle a headset; short enough
    /// that a real end-of-call note isn't delayed by much.
    static let defaultSeconds: TimeInterval = 120
    /// Grace this long would delay every note more than it saves — treat
    /// anything above as a typo, not an instruction.
    static let maxSeconds: TimeInterval = 600

    /// `RECONNECT_GRACE=seconds` in pipeline/.env; `0` disables (stop at the
    /// detector's debounce, the pre-grace behavior). Malformed values fall back
    /// to the default rather than taking the feature down.
    static func seconds(env: [String: String]) -> TimeInterval {
        guard let raw = env["RECONNECT_GRACE"]?.trimmingCharacters(in: .whitespaces),
              !raw.isEmpty else { return defaultSeconds }
        guard let v = TimeInterval(raw), v.isFinite, v >= 0 else { return defaultSeconds }
        return min(v, maxSeconds)
    }
}
