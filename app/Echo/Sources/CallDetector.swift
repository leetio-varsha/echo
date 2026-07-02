import Foundation
import CoreAudio
import Darwin

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
    // Daemons spun up by Echo's OWN recording (ScreenCaptureKit → replayd) show as
    // mic-input processes and never release; they aren't "calls", so ignore them.
    private let excludedNames: Set<String> = ["replayd", "coreaudiod"]
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
        let others = otherMicInputPIDs()
        if !others.isEmpty {
            freeSince = nil
            if !callActive {
                callActive = true
                // Log which process triggered the detection so false-positive "calls"
                // (a background app grabbing the mic) can be traced in Console.app.
                let who = others.map { "\(processName($0))(\($0))" }.joined(separator: ", ")
                NSLog("Echo: call auto-detected — mic held by: \(who)")
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

    /// PIDs of audio processes other than Echo that currently have input running.
    private func otherMicInputPIDs() -> [pid_t] {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)

        var size: UInt32 = 0
        let sys = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else {
            return []
        }
        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        var procs = [AudioObjectID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &procs) == noErr else {
            return []
        }

        var result: [pid_t] = []
        for proc in procs {
            let pid = processPID(proc)
            if pid == myPID { continue }
            if excludedNames.contains(processName(pid)) { continue }
            if processInputRunning(proc) { result.append(pid) }
        }
        return result
    }

    /// Short executable name for a PID (e.g. "replayd"), or "" if unavailable.
    private func processName(_ pid: pid_t) -> String {
        guard pid > 0 else { return "" }
        var buf = [CChar](repeating: 0, count: 256)
        let n = proc_name(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : ""
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
