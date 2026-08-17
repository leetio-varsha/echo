import Foundation

/// Why an in-progress recording should be closed and immediately reopened.
enum RotationReason: Equatable {
    /// The length cap was hit — summarize this part, keep recording.
    case lengthCap(minutes: Int)
    /// A different calendar event is now under way: the previous meeting is over
    /// even though the microphone was never freed.
    case nextMeetingStarted

    var message: String {
        switch self {
        case .lengthCap(let minutes): return "\(minutes) min recorded"
        case .nextMeetingStarted: return "next meeting started"
        }
    }
}

/// The "should this recording be split?" rule, kept as pure logic so it can be
/// exercised without a microphone, a calendar or a running app
/// (see `app/test-rotation.sh`).
enum SessionRotation {
    /// - Parameters:
    ///   - age: how long the current recording has been running.
    ///   - taggedEventID: the calendar event the recording was opened for; nil when
    ///     none matched (an ad-hoc call, or calendar access denied).
    ///   - ongoingEventID: the event strictly under way right now; nil when there is
    ///     none, or the calendar can't be read.
    static func reason(
        age: TimeInterval,
        maxDuration: TimeInterval,
        minAgeBeforeSplit: TimeInterval,
        taggedEventID: String?,
        ongoingEventID: String?
    ) -> RotationReason? {
        if age >= maxDuration {
            return .lengthCap(minutes: Int(maxDuration / 60))
        }
        // Too young to judge: guards against a calendar hiccup splitting in a loop.
        guard age >= minAgeBeforeSplit else { return nil }
        // No calendar signal (no event, or access denied) — leave the session alone.
        guard let ongoing = ongoingEventID, !ongoing.isEmpty else { return nil }
        // Same meeting still running, however far past its slot it goes.
        guard ongoing != taggedEventID else { return nil }
        return .nextMeetingStarted
    }
}
