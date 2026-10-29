// Chrome's MediaRecorder writes WebM without a Duration, so players show an unknown length and
// seek poorly. This adds Segment > Info > Duration (or overwrites an existing one) in place.
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
};

const vintLength = (byte) => {
  for (let i = 0; i < 8; i += 1) if (byte & (0x80 >> i)) return i + 1;
  return 0;
};

function readId(bytes, pos) {
  const len = vintLength(bytes[pos]);
  if (!len || len > 4 || pos + len > bytes.length) throw new Error('bad EBML id');
  let value = 0;
  for (let i = 0; i < len; i += 1) value = value * 256 + bytes[pos + i];
  return { value, len };
}

// Returns size -1 for the "unknown size" marker (all value bits set).
function readSize(bytes, pos) {
  const len = vintLength(bytes[pos]);
  if (!len || pos + len > bytes.length) throw new Error('bad EBML size');
  let value = bytes[pos] & (0xff >> len);
  let unknown = value === 0xff >> len;
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) unknown = false;
  }
  return { value: unknown ? -1 : value, len };
}

function encodeSize(value, len) {
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

const fits = (value, len) => value < 2 ** (7 * len) - 1;

function readUint(bytes, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i += 1) v = v * 256 + bytes[pos + i];
  return v;
}

function float64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function fixWebmDuration(blob, durationMs) {
  if (!blob || !blob.size || !(durationMs > 0)) return blob;
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 512 * 1024)).arrayBuffer());
  try {
    let pos = 0;
    let id = readId(head, pos);
    if (id.value !== ID.EBML) return blob;
    let size = readSize(head, pos + id.len);
    pos += id.len + size.len + size.value;

    id = readId(head, pos);
    if (id.value !== ID.Segment) return blob;
    const segSizePos = pos + id.len;
    const segSize = readSize(head, segSizePos);
    pos = segSizePos + segSize.len;

    while (pos < head.length) {
      id = readId(head, pos);
      size = readSize(head, pos + id.len);
      // Moving bytes would break SeekHead offsets; MediaRecorder output has none, so just bail.
      if (id.value === ID.SeekHead || id.value === ID.Cluster || size.value < 0) return blob;
      if (id.value !== ID.Info) {
        pos += id.len + size.len + size.value;
        continue;
      }

      const sizePos = pos + id.len;
      const dataStart = sizePos + size.len;
      const dataEnd = dataStart + size.value;
      if (dataEnd > head.length) return blob;

      let scale = 1e6;
      let durationAt = -1;
      let durationLen = 0;
      for (let q = dataStart; q < dataEnd; ) {
        const cid = readId(head, q);
        const csize = readSize(head, q + cid.len);
        const valueAt = q + cid.len + csize.len;
        if (cid.value === ID.TimecodeScale) scale = readUint(head, valueAt, csize.value) || 1e6;
        if (cid.value === ID.Duration) {
          durationAt = valueAt;
          durationLen = csize.value;
        }
        q = valueAt + csize.value;
      }
      const ticks = (durationMs * 1e6) / scale;

      if (durationAt >= 0) {
        const patched = head.slice(0, dataEnd);
        const view = new DataView(patched.buffer);
        if (durationLen === 8) view.setFloat64(durationAt, ticks);
        else if (durationLen === 4) view.setFloat32(durationAt, ticks);
        else return blob;
        return new Blob([patched, blob.slice(dataEnd)], { type: blob.type });
      }

      const element = concat([new Uint8Array([0x44, 0x89, 0x88]), float64(ticks)]);
      const infoSize = size.value + element.length;
      const infoSizeBytes = encodeSize(infoSize, fits(infoSize, size.len) ? size.len : 8);
      const delta = element.length + infoSizeBytes.length - size.len;
      const before = head.slice(0, sizePos);
      if (segSize.value >= 0) {
        if (!fits(segSize.value + delta, segSize.len)) return blob;
        before.set(encodeSize(segSize.value + delta, segSize.len), segSizePos);
      }
      const prefix = concat([before, infoSizeBytes, head.slice(dataStart, dataEnd), element]);
      return new Blob([prefix, blob.slice(dataEnd)], { type: blob.type });
    }
  } catch (e) {
    return blob;
  }
  return blob;
}
