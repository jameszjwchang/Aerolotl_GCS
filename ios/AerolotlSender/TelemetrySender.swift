import CoreMotion
import Foundation
import SwiftUI
import UIKit

@MainActor
final class TelemetrySender: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var isStreaming = false
    @Published private(set) var status = "Ready"
    @Published private(set) var motionRate: Double?
    @Published private(set) var barometerStatus = "Waiting to start"
    @Published private(set) var sentPackets = 0
    @Published private(set) var skippedPackets = 0

    private let motionManager = CMMotionManager()
    private let altimeter = CMAltimeter()
    private let encoder = JSONEncoder()
    private let deviceId = (UIDevice.current.identifierForVendor ?? UUID()).uuidString
    private var socket: SenderConnection?
    private var connectionTimeout: Task<Void, Never>?
    private var sessionId = ""
    private var epochOffsetMs = 0.0
    private var sequence = 0
    private var queued = 0
    private var skipped = 0
    private var rateStart: TimeInterval?
    private var rateIntervals = 0
    private var lastMotionTimestamp: TimeInterval?
    private var sampling = false

    func start(address: String) {
        guard !isRunning else { return }
        guard let url = Self.senderURL(address) else {
            status = "Enter the Aerolotl Sender address from the GCS."
            return
        }
        guard motionManager.isDeviceMotionAvailable else {
            status = "Motion sensors are unavailable. Run the app on your iPhone."
            return
        }

        sessionId = UUID().uuidString
        epochOffsetMs = (Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime) * 1000
        sequence = 0
        queued = 0
        skipped = 0
        sentPackets = 0
        skippedPackets = 0
        rateStart = nil
        rateIntervals = 0
        lastMotionTimestamp = nil
        motionRate = nil
        barometerStatus = "Waiting for connection"
        status = "Connecting to GCS…"
        isRunning = true
        UIApplication.shared.isIdleTimerDisabled = true

        let socket = SenderConnection(url: url) { [weak self] event in
            guard let self else { return }
            switch event {
            case .ready:
                self.status = "Waiting for the first sample…"
                self.startSensors()
            case .accepted:
                self.connectionTimeout?.cancel()
                self.isStreaming = true
                self.status = "Streaming to GCS"
            case .waiting:
                self.status = "Waiting for Wi-Fi or Local Network permission…"
                self.isStreaming = false
            case .closed(let message):
                self.stop(message: message)
            }
        }
        self.socket = socket
        socket.start()
        connectionTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            self?.stop(message: "No response from GCS. Check the address, Wi-Fi, and Local Network permission.")
        }
    }

    func stop(message: String = "Stopped") {
        connectionTimeout?.cancel()
        connectionTimeout = nil
        motionManager.stopDeviceMotionUpdates()
        altimeter.stopRelativeAltitudeUpdates()
        socket?.stop()
        socket = nil
        sampling = false
        isRunning = false
        isStreaming = false
        UIApplication.shared.isIdleTimerDisabled = false
        sentPackets = queued
        skippedPackets = skipped
        status = message
    }

    private func startSensors() {
        guard !sampling else { return }
        sampling = true
        let session = sessionId
        motionManager.deviceMotionUpdateInterval = 0.01
        motionManager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] data, error in
            MainActor.assumeIsolated {
                guard let self, self.isRunning, self.sessionId == session else { return }
                if let error {
                    self.stop(message: "Motion sensor error. " + error.localizedDescription)
                } else if let data {
                    self.sendMotion(data)
                }
            }
        }
        guard CMAltimeter.isRelativeAltitudeAvailable() else {
            barometerStatus = "Unavailable on this device"
            return
        }
        barometerStatus = "Waiting for pressure and altitude"
        altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, error in
            MainActor.assumeIsolated {
                guard let self, self.isRunning, self.sessionId == session else { return }
                if error != nil {
                    self.barometerStatus = "Unavailable. Check Motion & Fitness permission."
                    self.altimeter.stopRelativeAltitudeUpdates()
                } else if let data {
                    self.sendBarometer(data)
                }
            }
        }
    }

    private func sendMotion(_ data: CMDeviceMotion) {
        guard lastMotionTimestamp != data.timestamp else { return }
        lastMotionTimestamp = data.timestamp
        let acceleration = data.userAcceleration
        let rotation = data.rotationRate
        let attitude = data.attitude.quaternion
        let g = 9.80665
        send(at: data.timestamp, motion: .init(
            acceleration: .init(x: acceleration.x * g, y: acceleration.y * g, z: acceleration.z * g),
            gyro: .init(x: rotation.x, y: rotation.y, z: rotation.z),
            // Preserve the motion packet's reference-to-phone convention.
            attitude: .init(x: -attitude.x, y: -attitude.y, z: -attitude.z, w: attitude.w)
        ))
        if let start = rateStart {
            rateIntervals += 1
            let span = data.timestamp - start
            if span >= 0.5 {
                motionRate = Double(rateIntervals) / span
                sentPackets = queued
                skippedPackets = skipped
                rateStart = data.timestamp
                rateIntervals = 0
            }
        } else {
            rateStart = data.timestamp
        }
    }

    private func sendBarometer(_ data: CMAltitudeData) {
        let pressureHpa = data.pressure.doubleValue * 10
        let altitudeM = data.relativeAltitude.doubleValue
        send(at: data.timestamp, barometer: .init(pressureHpa: pressureHpa, relativeAltitudeM: altitudeM))
        barometerStatus = String(format: "%.2f hPa · %.2f m", pressureHpa, altitudeM)
    }

    private func send(at timestamp: TimeInterval, motion: TelemetryPacket.Motion? = nil,
                      barometer: TelemetryPacket.Barometer? = nil) {
        let packet = TelemetryPacket(deviceId: deviceId, sessionId: sessionId, sequence: sequence,
                                     measuredAtMs: epochOffsetMs + timestamp * 1000,
                                     motion: motion, barometer: barometer)
        sequence += 1
        if let data = try? encoder.encode(packet), socket?.send(data) == true {
            queued += 1
        } else {
            skipped += 1
        }
    }

    static func senderURL(_ address: String) -> URL? {
        let input = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let urlString = input.contains("://") ? input : "ws://" + input
        guard var parts = URLComponents(string: urlString),
              let scheme = parts.scheme?.lowercased(), scheme == "ws" || scheme == "http",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path == "" || parts.path == "/" || parts.path == "/ws/ingest",
              (1...65535).contains(parts.port ?? 3000) else { return nil }
        parts.scheme = "ws"
        parts.port = parts.port ?? 3000
        parts.path = "/ws/ingest"
        return parts.url
    }
}
