import Foundation
import CoreAudio

/// Detects when a call is happening by watching whether any process *other than
/// Echo itself* is using audio input (the microphone). Fires `onCallStart` when
/// such a process appears and `onCallEnd` once none remain (after a short
/// debounce, so brief blips/mutes don't end a call).
///
/// Uses the per-process Core Audio HAL (macOS 14.4+): a plain
/// `kAudioDevicePropertyDeviceIsRunningSomewhere` boolean can't work here because
/// Echo's own recording keeps the mic "running"; excluding our PID fixes that.
final class CallDetector {
    var onCallStart: (() -> Void)?
    var onCallEnd: (() -> Void)?

    private let myPID = ProcessInfo.processInfo.processIdentifier
    private let pollInterval: TimeInterval = 2
    private let endDebounce: TimeInterval = 5   // mic must stay free this long to end a call

    private var timer: DispatchSourceTimer?
    private var callActive = false
    private var freeSince: Date?

    func start() {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 1, repeating: pollInterval)
        t.setEventHandler { [weak self] in self?.poll() }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
        callActive = false
        freeSince = nil
    }

    private func poll() {
        let othersOnMic = micUsedByOtherProcess()
        if othersOnMic {
            freeSince = nil
            if !callActive {
                callActive = true
                onCallStart?()
            }
        } else if callActive {
            if freeSince == nil {
                freeSince = Date()
            } else if Date().timeIntervalSince(freeSince!) >= endDebounce {
                callActive = false
                freeSince = nil
                onCallEnd?()
            }
        }
    }

    /// True if any audio process other than Echo currently has input running.
    private func micUsedByOtherProcess() -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)

        var size: UInt32 = 0
        let sys = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else {
            return false
        }
        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        var procs = [AudioObjectID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &procs) == noErr else {
            return false
        }

        for proc in procs {
            if processPID(proc) == myPID { continue }
            if processInputRunning(proc) { return true }
        }
        return false
    }

    private func processPID(_ proc: AudioObjectID) -> pid_t {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var pid: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        _ = AudioObjectGetPropertyData(proc, &addr, 0, nil, &size, &pid)
        return pid
    }

    private func processInputRunning(_ proc: AudioObjectID) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningInput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(proc, &addr, 0, nil, &size, &running) == noErr else {
            return false
        }
        return running != 0
    }
}
