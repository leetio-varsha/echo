import SwiftUI
import AppKit
import UserNotifications

/// Drives the menu-bar UI and orchestrates record → pipeline.
@MainActor
final class AppState: ObservableObject {
    @Published var isRecording = false
    @Published var busy = false
    @Published var status = "Idle"

    private let recorder = TwoTrackRecorder()

    var menuIcon: String { isRecording ? "record.circle.fill" : "waveform" }

    init() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func toggle() {
        Task {
            if isRecording { await stop() } else { await start() }
        }
    }

    private func start() async {
        status = "Requesting permissions…"
        do {
            try await recorder.requestPermissions()
            try await recorder.start()
            isRecording = true
            status = "Recording…"
        } catch {
            isRecording = false
            status = "Error: \(error.localizedDescription)"
        }
    }

    private func stop() async {
        isRecording = false
        busy = true
        status = "Transcribing & summarizing…"
        let out = await recorder.stop()
        do {
            let url = try await Task.detached {
                try PipelineRunner.run(mic: out.mic, system: out.system)
            }.value
            status = "Done ✓"
            notify(title: "Echo — note created", body: url)
        } catch {
            status = "Error: \(error.localizedDescription)"
            notify(title: "Echo — failed", body: error.localizedDescription)
        }
        busy = false
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
            state.toggle()
        }
        .disabled(state.busy)
        Divider()
        Button("Quit Echo") { NSApplication.shared.terminate(nil) }
    }
}
