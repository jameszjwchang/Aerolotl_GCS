import Foundation
import Network

@MainActor
final class SenderConnection {
    enum Event {
        case ready
        case accepted
        case waiting
        case closed(String)
    }

    private let connection: NWConnection
    private let onEvent: (Event) -> Void
    private var pendingSends = 0
    private var stopped = false
    private var ready = false

    init(url: URL, onEvent: @escaping (Event) -> Void) {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let parameters = NWParameters(tls: nil, tcp: tcp)
        let webSocket = NWProtocolWebSocket.Options()
        webSocket.autoReplyPing = true
        webSocket.maximumMessageSize = 4096
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocket, at: 0)
        connection = NWConnection(to: .url(url), using: parameters)
        self.onEvent = onEvent
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            // Network delivers state and completion callbacks on the queue passed to start.
            MainActor.assumeIsolated { self?.handle(state) }
        }
        connection.start(queue: .main)
    }

    func send(_ data: Data) -> Bool {
        // Bound application backpressure. A stalled link should not build a queue of old samples.
        guard ready, !stopped, pendingSends < 2 else { return false }
        pendingSends += 1
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "telemetry", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true,
                        completion: .contentProcessed { [weak self] error in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                self.pendingSends -= 1
                if let error { self.fail("Send failed. " + error.localizedDescription) }
            }
        })
        return true
    }

    func stop() {
        stopped = true
        ready = false
        connection.stateUpdateHandler = nil
        connection.cancel()
    }

    private func handle(_ state: NWConnection.State) {
        guard !stopped else { return }
        switch state {
        case .ready:
            ready = true
            receive()
            onEvent(.ready)
        case .waiting:
            ready = false
            onEvent(.waiting)
        case .failed(let error):
            fail("Connection failed. " + error.localizedDescription)
        case .cancelled:
            fail("Connection closed.")
        default:
            break
        }
    }

    private func receive() {
        connection.receiveMessage { [weak self] data, context, _, error in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                    as? NWProtocolWebSocket.Metadata
                if metadata?.opcode == .close {
                    let reason = data.flatMap { String(data: $0, encoding: .utf8) }
                    self.fail(reason.flatMap { $0.isEmpty ? nil : $0 } ?? "The GCS closed the connection.")
                } else if let error {
                    self.fail("Connection lost. " + error.localizedDescription)
                } else if context == nil {
                    self.fail("The GCS closed the connection.")
                } else {
                    if let data, let reply = try? JSONDecoder().decode(Reply.self, from: data),
                       reply.type == "accepted" {
                        self.onEvent(.accepted)
                    }
                    self.receive()
                }
            }
        }
    }

    private func fail(_ message: String) {
        guard !stopped else { return }
        stop()
        onEvent(.closed(message))
    }

    private struct Reply: Decodable {
        let type: String
    }
}
