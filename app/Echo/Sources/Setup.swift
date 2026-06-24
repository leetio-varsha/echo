import Foundation

/// First-run/config helpers backing the onboarding window: reads/writes
/// pipeline/.env, runs the Notion auto-provisioner, and checks prerequisites.
enum Setup {
    static var repoRoot: String { BuildConfig.repoRoot }
    static var envPath: String { "\(repoRoot)/pipeline/.env" }

    // MARK: .env

    static func readEnv() -> [String: String] {
        guard let text = try? String(contentsOfFile: envPath, encoding: .utf8) else { return [:] }
        var map: [String: String] = [:]
        for raw in text.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.hasPrefix("#"), let eq = line.firstIndex(of: "=") else { continue }
            let k = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
            let v = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if !k.isEmpty { map[k] = v }
        }
        return map
    }

    static func isConfigured() -> Bool { !(readEnv()["NOTION_TOKEN"] ?? "").isEmpty }

    /// Update KEY=value pairs in pipeline/.env (seed from .env.example if missing).
    static func writeEnv(_ updates: [String: String]) {
        var text = (try? String(contentsOfFile: envPath, encoding: .utf8))
            ?? (try? String(contentsOfFile: envPath + ".example", encoding: .utf8)) ?? ""
        for (k, v) in updates {
            let pat = "(?m)^" + NSRegularExpression.escapedPattern(for: k) + "=.*$"
            let range = NSRange(text.startIndex..., in: text)
            if let re = try? NSRegularExpression(pattern: pat), re.firstMatch(in: text, range: range) != nil {
                text = re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text),
                                                   withTemplate: "\(k)=\(v)")
            } else {
                if !text.isEmpty && !text.hasSuffix("\n") { text += "\n" }
                text += "\(k)=\(v)\n"
            }
        }
        try? text.write(toFile: envPath, atomically: true, encoding: .utf8)
    }

    // MARK: Claude

    /// True if Claude Code is logged in via a subscription (oauthAccount, no API key).
    static func hasClaudeSubscription() -> Bool {
        let p = (NSHomeDirectory() as NSString).appendingPathComponent(".claude.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: p)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return obj["oauthAccount"] != nil
    }

    // MARK: Notion provisioning

    /// Run setup-notion.js to create the Calls + Projects databases. Blocking — call off the main actor.
    static func provisionNotion(token: String, parent: String) -> (ok: Bool, message: String) {
        guard let node = resolveNode() else {
            return (false, "Couldn't find `node`. Install Node ≥20.")
        }
        let out = run(node, ["\(repoRoot)/pipeline/src/setup-notion.js",
                             "--token=\(token)", "--parent=\(parent)"])
        // setup-notion prints a JSON line.
        let line = out.split(separator: "\n").last(where: { $0.contains("\"ok\"") }).map(String.init) ?? out
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (false, "Setup failed: \(out.suffix(200))")
        }
        if obj["ok"] as? Bool == true {
            return (true, "Created/linked Calls + Projects databases.")
        }
        return (false, (obj["error"] as? String) ?? "Notion setup failed.")
    }

    // MARK: Prerequisite checks

    struct Check: Identifiable { let id = UUID(); let name: String; let ok: Bool }

    static func checks() -> [Check] {
        let env = readEnv()
        let whisper = env["WHISPER_CPP_PATH"] ?? ""
        let model = env["WHISPER_MODEL"] ?? ""
        let vad = env["WHISPER_VAD_MODEL"] ?? ""
        return [
            Check(name: "Node ≥20", ok: resolveNode() != nil),
            Check(name: "ffmpeg", ok: onPath("ffmpeg")),
            Check(name: "whisper-cli", ok: isExecutable(whisper)),
            Check(name: "whisper model (large-v3)", ok: fileExists(model)),
            Check(name: "VAD model (silero)", ok: fileExists(vad)),
            Check(name: "Notion configured", ok: isConfigured()),
        ]
    }

    // MARK: shell helpers

    private static func resolveNode() -> String? {
        let p = run("/bin/zsh", ["-lc", "command -v node"]).trimmingCharacters(in: .whitespacesAndNewlines)
        return (!p.isEmpty && isExecutable(p)) ? p : nil
    }

    private static func onPath(_ tool: String) -> Bool {
        !run("/bin/zsh", ["-lc", "command -v \(tool)"]).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func isExecutable(_ path: String) -> Bool {
        !path.isEmpty && FileManager.default.isExecutableFile(atPath: path)
    }
    private static func fileExists(_ path: String) -> Bool {
        !path.isEmpty && FileManager.default.fileExists(atPath: path)
    }

    /// Run a command with the login-shell PATH; return combined stdout.
    @discardableResult
    private static func run(_ exe: String, _ args: [String]) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: exe)
        proc.arguments = args
        var env = ProcessInfo.processInfo.environment
        if let lp = loginPath() { env["PATH"] = lp }
        proc.environment = env
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        do { try proc.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func loginPath() -> String? {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "printf %s \"$PATH\""]
        let pipe = Pipe()
        shell.standardOutput = pipe
        do { try shell.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        shell.waitUntilExit()
        let p = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (p?.isEmpty == false) ? p : nil
    }
}
