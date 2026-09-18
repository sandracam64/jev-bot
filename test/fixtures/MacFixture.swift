import Cocoa
import Foundation

// A deliberately small native target. It never knows the expected test token.
// The only receipt writer is the Submit button's native action.
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let receiptURL: URL
    private let readyURL: URL
    private let title: String
    private var window: NSWindow?
    private let valueField = NSTextField(frame: NSRect(x: 24, y: 118, width: 432, height: 28))
    private let status = NSTextField(labelWithString: "Waiting for Submit")
    private var clickCount = 0

    init(receiptPath: String, readyPath: String, title: String) {
        self.receiptURL = URL(fileURLWithPath: receiptPath)
        self.readyURL = URL(fileURLWithPath: readyPath)
        self.title = title
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 220, y: 220, width: 480, height: 220),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        self.window = window
        window.title = title
        window.delegate = self
        window.isReleasedWhenClosed = false

        let label = NSTextField(labelWithString: "Verification value")
        label.frame = NSRect(x: 24, y: 158, width: 432, height: 22)
        window.contentView?.addSubview(label)

        valueField.stringValue = ""
        valueField.isEditable = true
        valueField.isSelectable = true
        valueField.setAccessibilityLabel("Verification value")
        valueField.setAccessibilityIdentifier("verification-value")
        window.contentView?.addSubview(valueField)

        let submit = NSButton(title: "Submit", target: self, action: #selector(submitValue))
        submit.frame = NSRect(x: 24, y: 65, width: 110, height: 32)
        submit.bezelStyle = .rounded
        submit.setAccessibilityLabel("Submit")
        submit.setAccessibilityIdentifier("submit")
        window.contentView?.addSubview(submit)

        status.frame = NSRect(x: 24, y: 22, width: 432, height: 22)
        window.contentView?.addSubview(status)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self = self else { return }
            self.writeJSON([
                "ready": true,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "windowTitle": self.title,
            ], to: self.readyURL)
        }
        // The runner also terminates its child. This bounds an orphan if the
        // runner itself is interrupted before cleanup.
        Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { _ in
            NSApp.terminate(nil)
        }
    }

    @objc private func submitValue(_ sender: Any?) {
        window?.makeFirstResponder(nil)
        clickCount += 1
        writeJSON([
            "token": valueField.stringValue,
            "clickCount": clickCount,
            "pid": ProcessInfo.processInfo.processIdentifier,
        ], to: receiptURL)
        status.stringValue = "Submitted \(clickCount) time(s)"
    }

    private func writeJSON(_ value: [String: Any], to url: URL) {
        do {
            let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
            try data.write(to: url, options: [.atomic])
        } catch {
            status.stringValue = "Fixture receipt could not be written"
        }
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }
}

guard CommandLine.arguments.count == 4 else {
    fputs("Usage: JevBotFixture receipt.json ready.json window-title\n", stderr)
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = FixtureDelegate(
    receiptPath: CommandLine.arguments[1],
    readyPath: CommandLine.arguments[2],
    title: CommandLine.arguments[3]
)
app.delegate = delegate
app.run()
