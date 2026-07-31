import Foundation

/// Self-test for `SessionRotation.reason` — the rule that decides when a recording
/// in progress gets split. Scenarios are taken from the 2026-07-31 incident, where
/// a Daily Sync and the meeting after it were recorded as one 2h25m session
/// because the browser never released the microphone between them.
///
/// Run with `app/test-rotation.sh`.
@main
struct SessionRotationTests {
    static let cap: TimeInterval = 90 * 60
    static let minAge: TimeInterval = 60

    static var failures = 0

    static func expect(
        _ name: String,
        age: TimeInterval,
        tagged: String?,
        ongoing: String?,
        _ want: RotationReason?
    ) {
        let got = SessionRotation.reason(
            age: age, maxDuration: cap, minAgeBeforeSplit: minAge,
            taggedEventID: tagged, ongoingEventID: ongoing)
        if got == want {
            print("  ok   \(name)")
        } else {
            print("  FAIL \(name): want \(String(describing: want)), got \(String(describing: got))")
            failures += 1
        }
    }

    static func main() {
        print("SessionRotation.reason")

        expect("just started, no calendar at all",
               age: 10, tagged: nil, ongoing: nil, nil)

        expect("recording the meeting it was opened for",
               age: 20 * 60, tagged: "daily", ongoing: "daily", nil)

        // 11:00–12:00 on the incident day: the daily was over, nothing else booked.
        // Silence is not a reason to split; the mic being held is not either.
        expect("current meeting ended, nothing else under way",
               age: 30 * 60, tagged: "daily", ongoing: nil, nil)

        // The actual bug: 12:00 arrives, a different meeting starts, mic never freed.
        expect("next meeting started while still recording",
               age: 75 * 60, tagged: "daily", ongoing: "leetio", .nextMeetingStarted)

        // The call that day was booked 12:00–12:30 but ran to 13:02. Ending a slot
        // must never cut the recording — only a *different* event may.
        expect("meeting overruns its slot",
               age: 62 * 60, tagged: "leetio", ongoing: "leetio", nil)

        expect("ad-hoc call, then a scheduled meeting starts",
               age: 10 * 60, tagged: nil, ongoing: "leetio", .nextMeetingStarted)

        expect("different event but session still too young",
               age: 30, tagged: "daily", ongoing: "leetio", nil)

        expect("empty ongoing id is treated as no event",
               age: 10 * 60, tagged: "daily", ongoing: "", nil)

        expect("length cap reached",
               age: cap, tagged: "daily", ongoing: "daily", .lengthCap(minutes: 90))

        expect("length cap wins over a young session",
               age: cap + 5, tagged: nil, ongoing: nil, .lengthCap(minutes: 90))

        if failures > 0 {
            print("\n\(failures) failure(s)")
            exit(1)
        }
        print("\nall passed")
    }
}
