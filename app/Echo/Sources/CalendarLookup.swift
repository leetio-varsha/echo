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

    static func currentMeetingJSON() async -> URL? {
        let store = EKEventStore()
        guard await requestAccess(store) else {
            return nil
        }

        let now = Date()
        let predicate = store.predicateForEvents(
            withStart: now.addingTimeInterval(-15 * 60),
            end: now.addingTimeInterval(15 * 60),
            calendars: nil)
        let events = store.events(matching: predicate).filter { !$0.isAllDay }

        let ongoing = events.first { $0.startDate <= now && $0.endDate >= now }
        let nearest = events.min {
            abs($0.startDate.timeIntervalSince(now)) < abs($1.startDate.timeIntervalSince(now))
        }
        guard let event = ongoing ?? nearest else {
            return nil
        }

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
                .appendingPathComponent("echo-meeting-\(Int(now.timeIntervalSince1970)).json")
            try JSONEncoder().encode(meeting).write(to: url)
            return url
        } catch {
            return nil
        }
    }

    private static func requestAccess(_ store: EKEventStore) async -> Bool {
        await withCheckedContinuation { cont in
            store.requestFullAccessToEvents { granted, _ in cont.resume(returning: granted) }
        }
    }
}
