import SwiftUI
import AppKit
import UserNotifications

/// Drives the menu-bar UI and orchestrates record → pipeline, manually or
/// automatically (auto-detect a call, then auto-stop + summarize when it ends).
///
/// A recording can also be *rotated* — closed and immediately reopened — for
/// boundaries the call detector cannot see. Back-to-back meetings in the same
/// browser never free the microphone, so without rotation two calls land in one
/// note; and a forgotten Meet tab would otherwise record for hours.
@MainActor
final class AppState: ObservableObject {
    @Published var isRecording = false
    @Published var status = "Idle"
    @Published var autoDetect = true
    /// Recordings currently being transcribed + summarized. Pipeline jobs run in the
    /// background, so the next call can be recorded while the previous one is still
    /// being written up.
    @Published var pendingJobs = 0

    private let recorder = TwoTrackRecorder()
    private let detector = CallDetector()
    private var startedAt: Date?
    private var meeting: CalendarLookup.Current?
    private var recordingLabel = "Recording…"
    private var lastResult: String?

    private let minDuration: TimeInterval = 15 // discard accidental short mic blips
    /// Hard cap on a single recording. System audio costs ~1.4 GB/hour, so an
    /// unbounded session (a Meet tab left open all day) means a multi-GB file and a
    /// whisper job to match. At the cap the session is rotated, never dropped.
    private let maxDuration: TimeInterval = 90 * 60
    private let rotationPoll: TimeInterval = 30
    /// Don't act on a calendar change until the session has some substance —
    /// belt-and-braces against a lookup hiccup rotating the recording in a loop.
    private let minAgeBeforeSplit: TimeInterval = 60

    private var rotationTimer: DispatchSourceTimer?
    private var pipelineChain: Task<Void, Never>?

    var menuIcon: String { isRecording ? "record.circle.fill" : "waveform" }

    init() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        detector.onCallStart = { [weak self] in
            Task { @MainActor in
                guard let self, self.autoDetect, !self.isRecording else { return }
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

    // MARK: - Session lifecycle

    private func start(auto: Bool) async {
        status = auto ? "Call detected — recording…" : "Requesting permissions…"
        do {
            try await beginSession(label: auto ? "Recording (auto)…" : "Recording…")
            if auto {
                notify(title: "Echo — recording a call", body: "Auto-detected. Stop anytime from the menu.")
            }
        } catch {
            isRecording = false
            status = "Error: \(error.localizedDescription)"
        }
    }

    /// Open a recording: start both tracks, tag it with the current calendar event,
    /// and arm the checks that may later split it.
    private func beginSession(label: String) async throws {
        try await recorder.requestPermissions()
        try await recorder.start()
        isRecording = true
        startedAt = Date()
        recordingLabel = label
        refreshStatus()
        // Calendar enrichment (names + title + project). Best-effort; nil if none.
        meeting = await CalendarLookup.currentMeeting()
        armRotationTimer()
    }

    /// Close the current recording and hand it to the pipeline queue — or drop it
    /// if it was too short to have been a real call.
    private func closeSession() async {
        guard isRecording else { return }
        isRecording = false
        disarmRotationTimer()

        let elapsed = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let meetingPath = meeting?.jsonURL?.path
        startedAt = nil
        meeting = nil

        let out = await recorder.stop()
        if elapsed < minDuration {
            lastResult = "Ignored short session (\(Int(elapsed))s)"
            discard(out)
            return
        }
        enqueuePipeline(out, meetingJSON: meetingPath)
    }

    private func stop() async {
        await closeSession()
        refreshStatus()
    }

    /// End the current recording and immediately open a new one, so a boundary the
    /// detector can't see still produces two separate notes.
    private func rotate(reason: String) async {
        await closeSession()
        do {
            try await beginSession(label: "Recording (auto)…")
            notify(title: "Echo — split the recording", body: "\(reason). The previous part is being summarized.")
        } catch {
            status = "Error: \(error.localizedDescription)"
        }
    }

    // MARK: - Rotation checks

    private func armRotationTimer() {
        disarmRotationTimer()
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + rotationPoll, repeating: rotationPoll)
        t.setEventHandler { [weak self] in
            Task { @MainActor in await self?.checkRotation() }
        }
        rotationTimer = t
        t.resume()
    }

    private func disarmRotationTimer() {
        rotationTimer?.cancel()
        rotationTimer = nil
    }

    private func checkRotation() async {
        guard isRecording, let startedAt else { return }
        let age = Date().timeIntervalSince(startedAt)

        // The cap needs no calendar call, so short-circuit before asking EventKit.
        if age >= maxDuration {
            await rotate(reason: RotationReason.lengthCap(minutes: Int(maxDuration / 60)).message)
            return
        }
        guard age >= minAgeBeforeSplit else { return }

        // Back-to-back calls never free the mic, so `onCallEnd` can't fire between
        // them. A *different* event being under way means the previous meeting is
        // over. This asks for the ongoing event only: a call that overruns its slot
        // must not be cut — only an actual next meeting ends the session.
        let taggedWith = meeting?.eventID
        let ongoing = await CalendarLookup.ongoingEventID()
        // State may have moved on while we awaited the calendar.
        guard isRecording, meeting?.eventID == taggedWith else { return }
        guard let reason = SessionRotation.reason(
            age: age,
            maxDuration: maxDuration,
            minAgeBeforeSplit: minAgeBeforeSplit,
            taggedEventID: taggedWith,
            ongoingEventID: ongoing) else { return }
        await rotate(reason: reason.message)
    }

    // MARK: - Pipeline queue

    /// Queue a finished recording. Jobs run one at a time — two concurrent
    /// whisper.cpp large-v3 runs would fight over memory and cores — but they never
    /// block recording the next call.
    private func enqueuePipeline(_ out: TwoTrackRecorder.Output, meetingJSON: String?) {
        pendingJobs += 1
        refreshStatus()
        let previous = pipelineChain
        pipelineChain = Task { [weak self] in
            await previous?.value
            await self?.runPipeline(out, meetingJSON: meetingJSON)
        }
    }

    private func runPipeline(_ out: TwoTrackRecorder.Output, meetingJSON: String?) async {
        do {
            let url = try await Task.detached {
                try PipelineRunner.run(mic: out.mic, system: out.system, meetingJSON: meetingJSON)
            }.value
            lastResult = "Done ✓"
            notify(title: "Echo — note created", body: url)
        } catch PipelineError.emptyRecording {
            // No speech on either track — a false-positive "call" (some app briefly
            // held the mic). Nothing to summarize: discard quietly, no notification.
            lastResult = "No speech — ignored"
            discard(out)
        } catch {
            lastResult = "Error: \(error.localizedDescription)"
            notify(title: "Echo — failed", body: error.localizedDescription)
        }
        pendingJobs -= 1
        refreshStatus()
    }

    // MARK: - Helpers

    private func refreshStatus() {
        if isRecording {
            status = recordingLabel + (pendingJobs > 0 ? " · \(pendingJobs) summarizing" : "")
        } else if pendingJobs > 0 {
            status = pendingJobs > 1
                ? "Transcribing & summarizing… (\(pendingJobs))"
                : "Transcribing & summarizing…"
        } else {
            status = lastResult ?? "Idle"
        }
    }

    /// Drop a session we won't summarize: remove its temp recording dir.
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
        Toggle("Auto-detect calls", isOn: $state.autoDetect)
        Divider()
        Button("Set up Echo…") { SetupWindow.shared.show() }
        Button("Quit Echo") { NSApplication.shared.terminate(nil) }
    }
}
