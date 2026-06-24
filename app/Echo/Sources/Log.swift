import Foundation

/// Tiny append-only debug log to /tmp/echo-debug.log (for diagnosing on-device
/// behavior we can't observe headless). Safe to remove once Phase 3 is verified.
enum DebugLog {
    private static let url = URL(fileURLWithPath: "/tmp/echo-debug.log")
    private static let fmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f
    }()

    static func log(_ msg: String) {
        let line = "[\(fmt.string(from: Date()))] \(msg)\n"
        guard let data = line.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: url.path) {
            try? data.write(to: url)
        } else if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            h.seekToEndOfFile()
            h.write(data)
        }
    }
}
