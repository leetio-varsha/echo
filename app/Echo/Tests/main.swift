import Foundation

// Pure-logic suites — no microphone, calendar or app bundle involved.
SessionRotationTests.run()
print("")
DetectExclusionsTests.run()

if Check.failures > 0 {
    print("\n\(Check.failures) failure(s)")
    exit(1)
}
print("\nall passed")
