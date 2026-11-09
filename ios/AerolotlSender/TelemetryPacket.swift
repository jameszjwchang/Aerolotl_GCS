import Foundation

struct TelemetryPacket: Encodable {
    struct Vector: Encodable {
        let x: Double
        let y: Double
        let z: Double
    }

    struct Motion: Encodable {
        let acceleration: Vector
        let gyro: Vector
        let attitude: Quaternion
    }

    struct Quaternion: Encodable {
        let x: Double
        let y: Double
        let z: Double
        let w: Double
    }

    struct Barometer: Encodable {
        let pressureHpa: Double
        let relativeAltitudeM: Double
    }

    let version = 1
    let deviceId: String
    let sessionId: String
    let sequence: Int
    let measuredAtMs: Double
    let motion: Motion?
    let barometer: Barometer?
}
