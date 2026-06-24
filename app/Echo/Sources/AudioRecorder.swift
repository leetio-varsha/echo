import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

/// Records two tracks into a temp session dir:
///   - "Me"   = microphone, via AVAudioRecorder  -> me.m4a
///   - "Them" = system audio, via ScreenCaptureKit -> them.caf
final class TwoTrackRecorder: NSObject, SCStreamDelegate, SCStreamOutput {
    struct Output { let mic: URL; let system: URL }

    private var micRecorder: AVAudioRecorder?
    private var stream: SCStream?
    private var systemFile: AVAudioFile?
    private let audioQueue = DispatchQueue(label: "org.leetio.echo.audio")

    private var micURL: URL!
    private var systemURL: URL!

    /// Request Microphone + Screen Recording authorization. Throws if mic is denied.
    func requestPermissions() async throws {
        let micOK = await AVCaptureDevice.requestAccess(for: .audio)
        guard micOK else { throw RecorderError.micDenied }
        // Touching shareable content triggers / validates the Screen Recording grant.
        _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    }

    func start() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("echo-\(Int(Date().timeIntervalSince1970))", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        micURL = base.appendingPathComponent("me.m4a")
        systemURL = base.appendingPathComponent("them.caf")

        try startMic()
        try await startSystem()
    }

    func stop() async -> Output {
        micRecorder?.stop()
        micRecorder = nil
        if let stream { try? await stream.stopCapture() }
        stream = nil
        systemFile = nil
        return Output(mic: micURL, system: systemURL)
    }

    // MARK: - Microphone ("Me")

    private func startMic() throws {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100.0,
            AVNumberOfChannelsKey: 1,
        ]
        let rec = try AVAudioRecorder(url: micURL, settings: settings)
        guard rec.record() else { throw RecorderError.micStartFailed }
        micRecorder = rec
    }

    // MARK: - System audio ("Them") via ScreenCaptureKit

    private func startSystem() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw RecorderError.noDisplay }

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        // Video is captured by SCStream but we don't consume it; keep it tiny/cheap.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    // SCStreamOutput — called on audioQueue for each audio sample buffer.
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.numSamples > 0 else { return }
        guard let pcm = sampleBuffer.asPCMBuffer else { return }
        do {
            if systemFile == nil {
                systemFile = try AVAudioFile(forWriting: systemURL, settings: pcm.format.settings)
            }
            try systemFile?.write(from: pcm)
        } catch {
            NSLog("Echo: system-audio write failed: \(error.localizedDescription)")
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        NSLog("Echo: SCStream stopped with error: \(error.localizedDescription)")
    }
}

enum RecorderError: LocalizedError {
    case micDenied, micStartFailed, noDisplay
    var errorDescription: String? {
        switch self {
        case .micDenied: return "Microphone access denied (System Settings → Privacy & Security → Microphone)."
        case .micStartFailed: return "Could not start the microphone recorder."
        case .noDisplay: return "No display available for system-audio capture."
        }
    }
}

/// CMSampleBuffer → AVAudioPCMBuffer (the standard ScreenCaptureKit-audio bridge).
extension CMSampleBuffer {
    var asPCMBuffer: AVAudioPCMBuffer? {
        try? withAudioBufferList { list, _ -> AVAudioPCMBuffer? in
            guard let absd = formatDescription?.audioStreamBasicDescription,
                  let format = AVAudioFormat(standardFormatWithSampleRate: absd.mSampleRate,
                                             channels: absd.mChannelsPerFrame)
            else { return nil }
            return AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer)
        }
    }
}
