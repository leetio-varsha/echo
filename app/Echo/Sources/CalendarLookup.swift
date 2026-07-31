import Foundation
import EventKit

/// Looks up the calendar event happening right now (across any account synced to
/// macOS Calendar) and writes it to a temp JSON the pipeline reads via
/// --meeting-json. Returns nil if access is denied or no event matches — the
/// pipeline then just runs without calendar enrichment.
enum CalendarLookup {
    private struct Meeting: Codable {
        let title: String
        let me: String
        let attendees: [String]
    }

    /// The event a recording belongs to: a stable identity (so the app can notice
    /// when the *next* meeting begins) plus the JSON handed to the pipeline.
    /// `jsonURL` is nil when the event matched but its JSON couldn't be written —
    /// the identity still counts, so a failed write can't make the app think the
    /// meeting changed and split the recording over and over.
    struct Current {
        let eventID: String
        let jsonURL: URL?
    }

    // One long-lived store: `ongoingEventID()` is polled while recording.
    private static let store = EKEventStore()

    /// Event for a recording that is starting now. Accepts an event up to 15 min
    /// away, so joining a little early (or late) still gets enriched.
    static func currentMeeting() async -> Current? {
        guard let event = await matchingEvent(ongoingOnly: false) else { return nil }
        return Current(eventID: event.eventIdentifier ?? "", jsonURL: writeJSON(for: event))
    }

    /// Identifier of the event strictly under way right now, or nil if there is none.
    ///
    /// Ongoing-only on purpose. This drives the "a new meeting started, split the
    /// recording" check, and a call that runs past its slot must NOT be cut short:
    /// only an actual next event ends a session, never the end of the current one.
    static func ongoingEventID() async -> String? {
        await matchingEvent(ongoingOnly: true)?.eventIdentifier
    }

    private static func matchingEvent(ongoingOnly: Bool) async -> EKEvent? {
        guard await requestAccess() else { return nil }

        let now = Date()
        let window: TimeInterval = 15 * 60
        let predicate = store.predicateForEvents(
            withStart: now.addingTimeInterval(-window),
            end: now.addingTimeInterval(window),
            calendars: nil)
        let events = store.events(matching: predicate).filter { !$0.isAllDay }

        let ongoing = events.first { $0.startDate <= now && $0.endDate >= now }
        if ongoingOnly { return ongoing }

        let nearest = events.min {
            abs($0.startDate.timeIntervalSince(now)) < abs($1.startDate.timeIntervalSince(now))
        }
        return ongoing ?? nearest
    }

    private static func writeJSON(for event: EKEvent) -> URL? {
        var me = ""
        var attendees: [String] = []
        for p in event.attendees ?? [] {
            let nm = p.name ?? p.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
            guard !nm.isEmpty else { continue }
            attendees.append(nm)
            if p.isCurrentUser { me = nm }
        }

        let meeting = Meeting(title: event.title ?? "", me: me, attendees: attendees)

        do {
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("echo-meeting-\(Int(Date().timeIntervalSince1970)).json")
            try JSONEncoder().encode(meeting).write(to: url)
            return url
        } catch {
            return nil
        }
    }

    private static func requestAccess() async -> Bool {
        await withCheckedContinuation { cont in
            store.requestFullAccessToEvents { granted, _ in cont.resume(returning: granted) }
        }
    }
}
