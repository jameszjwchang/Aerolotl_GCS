import SwiftUI

@main
struct AerolotlSenderApp: App {
    var body: some Scene {
        WindowGroup { SenderView() }
    }
}

private struct SenderView: View {
    @AppStorage("receiverAddress") private var address = ""
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var editingAddress: Bool
    @StateObject private var sender = TelemetrySender()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ws://192.168.1.24:3000/ws/ingest", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .focused($editingAddress)
                        .disabled(sender.isRunning)
                        .accessibilityLabel("Receiver address")
                    if sender.isRunning {
                        Button("Stop streaming", role: .destructive) { sender.stop() }
                    } else {
                        Button("Start streaming") {
                            editingAddress = false
                            sender.start(address: address)
                        }
                        .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                } header: {
                    Text("GCS receiver")
                } footer: {
                    Text("Join the same Wi-Fi as your Mac. Paste the address from the GCS dashboard.")
                }

                Section("Telemetry") {
                    Label(sender.status, systemImage: sender.isStreaming ? "dot.radiowaves.left.and.right" : "circle")
                        .foregroundStyle(sender.isStreaming ? Color.green : Color.primary)
                    LabeledContent("Motion sampling", value: sender.motionRate.map {
                        String(format: "%.1f Hz", $0)
                    } ?? "—")
                    LabeledContent("Barometer", value: sender.barometerStatus)
                    LabeledContent("Packets queued", value: sender.sentPackets.formatted())
                    LabeledContent("Packets skipped", value: sender.skippedPackets.formatted())
                }
                .monospacedDigit()
            }
            .navigationTitle("Aerolotl Sender")
            .onChange(of: scenePhase) { _, phase in
                if phase == .background, sender.isRunning {
                    sender.stop(message: "Paused when the app left the foreground. Tap Start streaming.")
                }
            }
        }
    }
}
