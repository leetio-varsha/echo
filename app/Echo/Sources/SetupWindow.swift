import AppKit
import SwiftUI

/// Hosts the onboarding window. Echo is a menu-bar-only (LSUIElement / accessory)
/// app, so a plain NSWindow won't take keyboard focus — its text fields stay
/// uneditable. We flip the app to `.regular` while the window is open (so it can
/// become key and accept input) and back to `.accessory` when it closes.
@MainActor
final class SetupWindow: NSObject, NSWindowDelegate {
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
            w.delegate = self
            w.center()
            window = w
        }
        // Defer past the menu's dismissal — if we grab key focus while the menu is
        // still closing, an accessory app loses it again and the fields stay dead.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            NSApp.setActivationPolicy(.regular)  // normal app so the window can be key
            NSApp.activate(ignoringOtherApps: true)
            guard let w = self.window else { return }
            w.makeKeyAndOrderFront(nil)
            w.orderFrontRegardless()
        }
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)    // back to menu-bar-only
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
