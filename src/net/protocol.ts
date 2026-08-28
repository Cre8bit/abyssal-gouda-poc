// protocol.ts — binary wire format for 30 Hz state packets. Dependency-free
// so it can be unit-tested in plain node (tools/test-protocol.mjs).
//
// Layout (little-endian, 24 bytes):
//   u8   version     (PROTO_VERSION — bump on ANY layout change, so packets
//                     from a stale client are rejected instead of misread)
//   u16  seq         (wrapping counter — stale packets are dropped)
//   u8   flags       bit7 = flashlight, bits 0-6 = status mask (effects.ts)
//   f32  x, y, z
//   i16  yaw, pitch, swimYaw, swimPitch   (radians wrapped to ±π, ×ANGLE_SCALE)

// State broadcast every tick (sy/sp default to yaw/pitch if omitted).
export interface PlayerStateOut {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  sy?: number;
  sp?: number;
  light: boolean;
  status: number; // 7-bit mask, see effects.ts STATUS
}

// Decoded state with sequence number.
export interface PlayerStateIn {
  seq: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  sy: number;
  sp: number;
  light: boolean;
  status: number;
}

export const STATE_PACKET_BYTES = 24;
export const PROTO_VERSION = 1;
const ANGLE_SCALE = 32767 / Math.PI;

export function wrapAngle(a: number): number {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// `out` (optional): scratch buffer (30 Hz hot path; safe to reuse after send).
export function encodeState(
  s: PlayerStateOut,
  seq: number,
  out: ArrayBuffer | null = null,
): ArrayBuffer {
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

export function decodeState(
  data: ArrayBuffer | ArrayBufferView,
): PlayerStateIn | null {
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
export function seqNewer(a: number, b: number): boolean {
  return a !== b && ((a - b) & 0xffff) < 0x8000;
}
