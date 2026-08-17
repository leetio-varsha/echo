import Foundation

/// Tiny assertion harness shared by the pure-logic suites, so `app/test.sh` can
/// run them all in one binary and report a single verdict.
enum Check {
    static var failures = 0

    static func equal<T: Equatable>(_ name: String, _ got: T, _ want: T) {
        if got == want {
            print("  ok   \(name)")
        } else {
            print("  FAIL \(name): want \(want), got \(got)")
            failures += 1
        }
    }
}
