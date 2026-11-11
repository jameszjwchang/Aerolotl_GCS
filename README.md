# Aerolotl GCS

On the Mac, run `npm ci` and `npm start`, then open `http://localhost:3000`. The startup output and **Connect telemetry** panel show the receiver addresses. Set `PORT` to change the port for both the dashboard and the flight receiver.

## Senders

- **Flight computer** · Send one UTF-8 JSON object per UDP datagram through the ESP AirLift to the GCS computer’s IPv4 address and UDP port `3000`. Connect both ends to the same local network for bench testing. The AirLift Wi-Fi coprocessor takes socket commands from the flight computer over SPI. See the [AirLift breakout guide](https://learn.adafruit.com/adafruit-airlift-breakout?view=all).
- **iPhone bench test** · Install Aerolotl Sender, join the same Wi-Fi network, and paste the `ws://<GCS-IP>:3000/ws/ingest` address into the app. Each WebSocket text message contains one JSON object in the same packet format.

Both inputs feed the same decoder, graphs, and rocket view. To switch senders, stop the active stream, wait two seconds, then start the other sender with a fresh session ID. The dashboard resets its history and pose for the new session.

The rocket view's reference axes stay fixed as telemetry rotates the rocket and follow your view when you drag. Their colors match the X/Y/Z graph traces. A circled dot means an axis points toward you; a circled cross means it points away. **Zero position** zeroes the rocket pose and resets the view with +X pointing out of the screen, +Y up, and +Z left. It also resets a dragged view when no sender is connected.

## Telemetry packet v1

Example flight IMU packet. Send the JSON bytes without an HTTP or WebSocket header.

```json
{
  "version": 1,
  "deviceId": "flight-computer",
  "sessionId": "boot-17",
  "sequence": 42,
  "uptimeMs": 1250,
  "motion": {
    "acceleration": { "x": 0.04, "y": 9.81, "z": -0.02 },
    "accelerationKind": "specific-force",
    "gyro": { "x": 0.01, "y": 0, "z": -0.01 }
  }
}
```

- `version` is `1`. `deviceId` identifies the sender and `sessionId` identifies a run. Both use 1–64 letters, digits, or hyphens. Start a new session after reboot, counter reset, or a sender change. Increment `sequence` for every packet in that session, including barometer packets. Use a nonnegative integer.
- Use `uptimeMs` for an integer millisecond reading from the flight computer’s monotonic clock at sample time. Keep it increasing across counter rollover or start a new session at rollover. A sender with a wall clock can use `measuredAtMs` (Unix epoch milliseconds, as on the iPhone) instead. Use one timestamp field throughout each session.
- Each packet carries either `motion` or `barometer`. For `motion`, send `acceleration` in m/s², `gyro` in rad/s, or both if they share the same capture time. Set `accelerationKind` to `specific-force` for raw accelerometer data, which reads about 1 g when held still. Use `linear` for gravity-removed acceleration. Omitting the field means `linear` for compatibility with the iPhone app. Keep the same acceleration kind per session.
- If the flight computer estimates attitude, add `motion.attitude` alongside `gyro`. It is a unit quaternion `{ "x", "y", "z", "w" }` rotating reference coordinates into body coordinates. Use the same right-handed body axes for acceleration, gyro, and attitude, with the rocket nose along +Y in the viewer’s neutral pose. The viewer zeroes to the first attitude. When only the gyro is available it integrates the rate, so orientation can drift.
- For a barometer packet, replace `motion` with `"barometer": { "pressureHpa": 1013.25, "relativeAltitudeM": 0 }`. Either field may be sent on its own. Send actual readings for available sensors and omit missing fields.
- Keep UDP payloads at or below 1,200 bytes. The receiver skips malformed and duplicate packets. UDP telemetry has no acknowledgement or retransmission.

In the flight firmware, map each sensor reading into this format and encode it as JSON. Once AirLift is on Wi-Fi, send the bytes with `WiFiUDP.beginPacket(gcsIp, port)`, `write(bytes, length)`, and `endPacket()`. See the [Adafruit WiFiNINA UDP interface](https://github.com/adafruit/WiFiNINA/blob/master/src/WiFiUdp.h).
