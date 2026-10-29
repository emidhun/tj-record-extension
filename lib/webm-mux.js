// Writes a WebM file from encoded VP8/VP9 frames (WebCodecs output). Instant replay keeps encoded
// frames in a rolling buffer; saving muxes the kept part, starting at a keyframe with timestamps from
// 0, plus a Duration and Cues so players know the length and can seek.
const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  TrackType: 0x83,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};

// A cluster's blocks store their time as a signed 16-bit offset (ms) from the cluster's time.
const MAX_CLUSTER_MS = 30000;

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bigEndian(value, len) {
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

const idBytes = (id) => bigEndian(id, Math.max(1, Math.ceil(Math.log2(id + 1) / 8)));

// EBML size: the shortest length that fits (all-ones is reserved for "unknown"), or a fixed length.
function vint(value, fixed) {
  let len = fixed || 1;
  while (!fixed && value >= 2 ** (7 * len) - 1) len += 1;
  const out = bigEndian(value, len);
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function uintBytes(value, fixed) {
  let len = fixed || 1;
  while (!fixed && value >= 2 ** (8 * len)) len += 1;
  return bigEndian(value, len);
}

const el = (id, data) => concat([idBytes(id), vint(data.length), data]);
const uint = (id, value, fixed) => el(id, uintBytes(value, fixed));
const str = (id, value) => el(id, new TextEncoder().encode(value));
const master = (id, children) => el(id, concat(children));
function float(id, value) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return el(id, b);
}

// frames: [{ ts (ms from 0, non-decreasing), key, data: Uint8Array }]; the first must be a keyframe.
export function muxWebm({ codecId, width, height, durationMs, frames }) {
  const header = master(ID.EBML, [
    uint(ID.EBMLVersion, 1),
    uint(ID.EBMLReadVersion, 1),
    uint(ID.EBMLMaxIDLength, 4),
    uint(ID.EBMLMaxSizeLength, 8),
    str(ID.DocType, 'webm'),
    uint(ID.DocTypeVersion, 4),
    uint(ID.DocTypeReadVersion, 2),
  ]);
  const info = master(ID.Info, [
    uint(ID.TimecodeScale, 1e6), // 1 ms ticks
    str(ID.MuxingApp, 'TJ Record'),
    str(ID.WritingApp, 'TJ Record'),
    float(ID.Duration, durationMs),
  ]);
  const tracks = master(ID.Tracks, [
    master(ID.TrackEntry, [
      uint(ID.TrackNumber, 1),
      uint(ID.TrackUID, 1),
      uint(ID.FlagLacing, 0),
      str(ID.CodecID, codecId),
      uint(ID.TrackType, 1),
      master(ID.Video, [uint(ID.PixelWidth, width), uint(ID.PixelHeight, height)]),
    ]),
  ]);

  // A new cluster at every keyframe, so each cue points at a cluster that starts with one.
  const clusters = [];
  let cur = null;
  for (const f of frames) {
    if (!cur || f.key || f.ts - cur.ts > MAX_CLUSTER_MS) {
      cur = { ts: f.ts, key: f.key, parts: [uint(ID.Timecode, f.ts)] };
      clusters.push(cur);
    }
    const rel = f.ts - cur.ts;
    const block = new Uint8Array([0x81, (rel >> 8) & 0xff, rel & 0xff, f.key ? 0x80 : 0]);
    cur.parts.push(idBytes(ID.SimpleBlock), vint(block.length + f.data.length), block, f.data);
  }

  // Positions are relative to the start of the Segment's data. SeekPosition is written with a fixed
  // 8 bytes so the SeekHead's size doesn't depend on the positions it holds.
  const seekHead = (positions) => master(ID.SeekHead, positions.map(([id, pos]) => master(ID.Seek, [el(ID.SeekID, idBytes(id)), uint(ID.SeekPosition, pos, 8)])));
  const seekLen = seekHead([[ID.Info, 0], [ID.Tracks, 0], [ID.Cues, 0]]).length;
  let pos = seekLen + info.length + tracks.length;
  const clusterParts = [];
  for (const c of clusters) {
    const size = c.parts.reduce((n, p) => n + p.length, 0);
    c.pos = pos;
    const head = concat([idBytes(ID.Cluster), vint(size)]);
    clusterParts.push(head, ...c.parts);
    pos += head.length + size;
  }
  const cues = master(ID.Cues, clusters.filter((c) => c.key).map((c) => master(ID.CuePoint, [
    uint(ID.CueTime, c.ts),
    master(ID.CueTrackPositions, [uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, c.pos)]),
  ])));
  const seek = seekHead([[ID.Info, seekLen], [ID.Tracks, seekLen + info.length], [ID.Cues, pos]]);
  const segmentHead = concat([idBytes(ID.Segment), vint(pos + cues.length, 8)]);
  return new Blob([header, segmentHead, seek, info, tracks, ...clusterParts, cues], { type: 'video/webm' });
}
