import SwiftUI

/// First-run / settings window: prerequisite checks, Notion auto-provisioning,
/// and Claude access. Writes everything into pipeline/.env via `Setup`.
struct OnboardingView: View {
    @State private var token = ""
    @State private var parent = ""
    @State private var apiKey = ""
    @State private var status = ""
    @State private var working = false
    @State private var checks = Setup.checks()
    @State private var hasSub = Setup.hasClaudeSubscription()

    var body: some View {
        Form {
            Section("Requirements") {
                ForEach(checks) { c in
                    Label(c.name, systemImage: c.ok ? "checkmark.circle.fill" : "xmark.circle")
                        .foregroundStyle(c.ok ? Color.green : Color.secondary)
                }
                Button("Re-check", action: recheck)
            }

            Section("Notion") {
                Text("Create a page in Notion, share it with your Echo integration, then paste the page link here. Echo will create the Calls + Projects databases for you.")
                    .font(.caption).foregroundStyle(.secondary)
                SecureField("Integration token (ntn_…)", text: $token)
                TextField("Parent page URL", text: $parent)
                Button(working ? "Creating…" : "Create my Calls & Projects databases", action: provision)
                    .disabled(working || token.isEmpty || parent.isEmpty)
                if !status.isEmpty { Text(status).font(.caption) }
            }

            Section("Claude") {
                if hasSub {
                    Label("Using your Claude Code subscription", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(Color.green)
                } else {
                    Text("No Claude Code subscription detected — paste an Anthropic API key instead.")
                        .font(.caption).foregroundStyle(.secondary)
                    SecureField("ANTHROPIC_API_KEY", text: $apiKey)
                    Button("Save key") {
                        Setup.writeEnv(["SUMMARY_BACKEND": "api", "ANTHROPIC_API_KEY": apiKey])
                        recheck()
                    }
                    .disabled(apiKey.isEmpty)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480, height: 600)
    }

    private func recheck() {
        checks = Setup.checks()
        hasSub = Setup.hasClaudeSubscription()
    }

    private func provision() {
        working = true
        status = ""
        let t = token, p = parent
        Task {
            let r = await Task.detached { Setup.provisionNotion(token: t, parent: p) }.value
            status = (r.ok ? "✅ " : "⚠️ ") + r.message
            checks = Setup.checks()
            working = false
        }
    }
}
