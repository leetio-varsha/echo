import SwiftUI
import AppKit
import UserNotifications

/// Drives the menu-bar UI and orchestrates record → pipeline, manually or
/// automatically (auto-detect a call, then auto-stop + summarize when it ends).
@MainActor
final class AppState: ObservableObject {
    @Published var isRecording = false
    @Published var busy = false
    @Published var status = "Idle"
    @Published var autoDetect = true

    private let recorder = TwoTrackRecorder()
    private let detector = CallDetector()
    private var startedAt: Date?
    private var meetingPath: URL?
    private let minDuration: TimeInterval = 15 // discard accidental short mic blips

    var menuIcon: String { isRecording ? "record.circle.fill" : "waveform" }

    init() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        detector.onCallStart = { [weak self] in
            Task { @MainActor in
                guard let self, self.autoDetect, !self.isRecording, !self.busy else { return }
                await self.start(auto: true)
            }
        }
        detector.onCallEnd = { [weak self] in
            Task { @MainActor in
                guard let self, self.isRecording else { return }
                await self.stop()
            }
        }
        detector.start()
    }

    func toggleRecording() {
        Task { if isRecording { await stop() } else { await start(auto: false) } }
    }

    private func start(auto: Bool) async {
        status = auto ? "Call detected — recording…" : "Requesting permissions…"
        do {
            try await recorder.requestPermissions()
            try await recorder.start()
            isRecording = true
            startedAt = Date()
            status = auto ? "Recording (auto)…" : "Recording…"
            if auto {
                notify(title: "Echo — recording a call", body: "Auto-detected. Stop anytime from the menu.")
            }
            // Calendar enrichment (names + title + project). Best-effort; nil if none.
            meetingPath = await CalendarLookup.currentMeetingJSON()
        } catch {
            isRecording = false
            status = "Error: \(error.localizedDescription)"
        }
    }

    private func stop() async {
        isRecording = false
        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        startedAt = nil
        let mp = meetingPath?.path
        meetingPath = nil
        let out = await recorder.stop()

        if elapsed < minDuration {
            status = "Ignored short session (\(Int(elapsed))s)"
            discard(out)
            return
        }

        busy = true
        status = "Transcribing & summarizing…"
        do {
            let url = try await Task.detached {
                try PipelineRunner.run(mic: out.mic, system: out.system, meetingJSON: mp)
            }.value
            status = "Done ✓"
            notify(title: "Echo — note created", body: url)
        } catch PipelineError.emptyRecording {
            // No speech on either track — a false-positive "call" (some app briefly
            // held the mic). Nothing to summarize: discard quietly, no notification.
            status = "No speech — ignored"
            discard(out)
        } catch {
            status = "Error: \(error.localizedDescription)"
            notify(title: "Echo — failed", body: error.localizedDescription)
        }
        busy = false
    }

    /// Drop a too-short session: remove its temp recording dir, summarize nothing.
    private func discard(_ out: TwoTrackRecorder.Output) {
        let dir = out.mic.deletingLastPathComponent()
        try? FileManager.default.removeItem(at: dir)
    }

    private func notify(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }
}

@main
struct EchoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            EchoMenu().environmentObject(state)
        } label: {
            Image(systemName: state.menuIcon)
        }
        .menuBarExtraStyle(.menu)
    }
}

struct EchoMenu: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        Text("Echo — \(state.status)")
        Divider()
        Button(state.isRecording ? "Stop & Summarize" : "Start Recording") {
            state.toggleRecording()
        }
        .disabled(state.busy)
        Toggle("Auto-detect calls", isOn: $state.autoDetect)
        Divider()
        Button("Set up Echo…") { SetupWindow.shared.show() }
        Button("Quit Echo") { NSApplication.shared.terminate(nil) }
    }
}
