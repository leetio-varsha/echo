import AppKit
import SwiftUI

/// Hosts the onboarding window (a plain AppKit window so we can open it on launch
/// even for a menu-bar-only LSUIElement app). Reused by the launch hook and the
/// "Set up Echo…" menu item.
@MainActor
final class SetupWindow {
    static let shared = SetupWindow()
    private var window: NSWindow?

    func show() {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 480, height: 600),
                styleMask: [.titled, .closable, .miniaturizable],
                backing: .buffered, defer: false)
            w.title = "Set up Echo"
            w.contentViewController = NSHostingController(rootView: OnboardingView())
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

/// Opens onboarding automatically on first launch when Echo isn't configured yet.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        if !Setup.isConfigured() {
            DispatchQueue.main.async { SetupWindow.shared.show() }
        }
    }
}
