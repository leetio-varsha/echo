import Foundation

/// Runs the Node pipeline on the two recorded tracks and returns the Notion URL.
enum PipelineRunner {
    static func run(mic: URL, system: URL, meetingJSON: String? = nil) throws -> String {
        let node = try resolveNode()
        let script = "\(BuildConfig.repoRoot)/pipeline/src/index.js"

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        var arguments = [script, "--mic=\(mic.path)", "--system=\(system.path)"]
        if let meetingJSON { arguments.append("--meeting-json=\(meetingJSON)") }
        proc.arguments = arguments
        proc.currentDirectoryURL = URL(fileURLWithPath: BuildConfig.repoRoot)

        // A Finder-launched app inherits a minimal PATH. Give node the full login
        // PATH so the tools it spawns by name (ffmpeg, whisper, claude) resolve.
        var env = ProcessInfo.processInfo.environment
        if let loginPath = try? loginShellPath(), !loginPath.isEmpty {
            env["PATH"] = loginPath
        }
        proc.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        // Drain stderr on a background queue so a full pipe can't deadlock the child.
        var errData = Data()
        let errLock = NSLock()
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if !d.isEmpty { errLock.lock(); errData.append(d); errLock.unlock() }
        }

        try proc.run()
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        errPipe.fileHandleForReading.readabilityHandler = nil

        let out = String(data: outData, encoding: .utf8) ?? ""
        errLock.lock(); let err = String(data: errData, encoding: .utf8) ?? ""; errLock.unlock()

        guard proc.terminationStatus == 0 else {
            throw PipelineError.failed((err.isEmpty ? out : err).trimmingCharacters(in: .whitespacesAndNewlines))
        }

        // index.js prints: "✅ Notion page: <url>"
        if let line = out.components(separatedBy: "\n").first(where: { $0.contains("Notion page:") }) {
            return line.replacingOccurrences(of: "✅ Notion page:", with: "").trimmingCharacters(in: .whitespaces)
        }
        return "Note created."
    }

    /// Resolve `node` via a login shell so homebrew / nvm PATHs are honored
    /// (a Finder-launched app gets a minimal PATH otherwise).
    private static func resolveNode() throws -> String {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        shell.standardOutput = pipe
        try shell.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        shell.waitUntilExit()

        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) else {
            throw PipelineError.nodeNotFound
        }
        return path
    }

    /// The user's full login-shell PATH (so child tools spawned by name resolve).
    private static func loginShellPath() throws -> String {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "printf %s \"$PATH\""]
        let pipe = Pipe()
        shell.standardOutput = pipe
        try shell.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        shell.waitUntilExit()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

enum PipelineError: LocalizedError {
    case nodeNotFound
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .nodeNotFound: return "Couldn't find `node`. Install Node ≥20 or fix your shell PATH."
        case .failed(let msg): return "Pipeline failed: \(msg)"
        }
    }
}
