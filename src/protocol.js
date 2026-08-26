// protocol.js — binary wire format for 30 Hz state packets. Dependency-free
// so it can be unit-tested in plain node (tools/test-protocol.mjs).
//
// Layout (little-endian, 24 bytes):
//   u8   version     (PROTO_VERSION — bump on ANY layout change, so packets
//                     from a stale client are rejected instead of misread)
//   u16  seq         (wrapping counter — stale packets are dropped)
//   u8   flags       bit7 = flashlight, bits 0-6 = status mask (effects.js)
//   f32  x, y, z
//   i16  yaw, pitch, swimYaw, swimPitch   (radians wrapped to ±π, ×ANGLE_SCALE)

export const STATE_PACKET_BYTES = 24;
export const PROTO_VERSION = 1;
const ANGLE_SCALE = 32767 / Math.PI;

export function wrapAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// `out` (optional): an ArrayBuffer(STATE_PACKET_BYTES) to encode into —
// callers on a hot path (30 Hz broadcast) pass a scratch buffer to avoid
// allocating per tick. RTCDataChannel.send copies synchronously, so the
// scratch can be reused immediately after sending.
export function encodeState(s, seq, out = null) {
  const buf = out ?? new ArrayBuffer(STATE_PACKET_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, PROTO_VERSION);
  v.setUint16(1, seq & 0xffff, true);
  v.setUint8(3, ((s.light ? 1 : 0) << 7) | (s.status & 0x7f));
  v.setFloat32(4, s.x, true);
  v.setFloat32(8, s.y, true);
  v.setFloat32(12, s.z, true);
  v.setInt16(16, wrapAngle(s.yaw) * ANGLE_SCALE, true);
  v.setInt16(18, wrapAngle(s.pitch) * ANGLE_SCALE, true);
  v.setInt16(20, wrapAngle(s.sy ?? s.yaw) * ANGLE_SCALE, true);
  v.setInt16(22, wrapAngle(s.sp ?? s.pitch) * ANGLE_SCALE, true);
  return buf;
}

export function decodeState(data) {
  const v = ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  if (v.byteLength < STATE_PACKET_BYTES || v.getUint8(0) !== PROTO_VERSION)
    return null;
  const flags = v.getUint8(3);
  return {
    seq: v.getUint16(1, true),
    light: (flags & 0x80) !== 0,
    status: flags & 0x7f,
    x: v.getFloat32(4, true),
    y: v.getFloat32(8, true),
    z: v.getFloat32(12, true),
    yaw: v.getInt16(16, true) / ANGLE_SCALE,
    pitch: v.getInt16(18, true) / ANGLE_SCALE,
    sy: v.getInt16(20, true) / ANGLE_SCALE,
    sp: v.getInt16(22, true) / ANGLE_SCALE,
  };
}

// Is sequence `a` newer than `b`, with u16 wraparound?
export function seqNewer(a, b) {
  return a !== b && ((a - b) & 0xffff) < 0x8000;
}
