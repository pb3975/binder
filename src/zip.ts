import { deflateRawSync } from "node:zlib";

/**
 * Writes a zip archive in memory. Binder caps a version at 64 MB, so ZIP64 is never needed.
 * Each file is deflated, or stored when deflate does not make it smaller.
 * Format: PKWARE APPNOTE.TXT, sections 4.3 (structure) and 4.4 (fields).
 */
export function zip(files: { path: string; data: Uint8Array }[], mtime: Date): Uint8Array<ArrayBuffer> {
  const { time, date } = dosTime(mtime);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = new TextEncoder().encode(f.path);
    const deflated = deflateRawSync(f.data);
    const store = deflated.length >= f.data.length;
    const body = store ? f.data : deflated;
    const crc = Bun.hash.crc32(f.data) >>> 0;
    // Shared fields: version needed, flags (bit 11: UTF-8 names), method, time, date, crc, sizes.
    const common = (h: DataView, at: number) => {
      h.setUint16(at, 20, true);
      h.setUint16(at + 2, 0x0800, true);
      h.setUint16(at + 4, store ? 0 : 8, true);
      h.setUint16(at + 6, time, true);
      h.setUint16(at + 8, date, true);
      h.setUint32(at + 10, crc, true);
      h.setUint32(at + 14, body.length, true);
      h.setUint32(at + 18, f.data.length, true);
      h.setUint16(at + 22, name.length, true);
    };

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    common(lh, 4);
    local.push(new Uint8Array(lh.buffer), name, body);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 0x0314, true); // made by: Unix, spec 2.0
    common(ch, 6);
    ch.setUint32(38, 0o100644 << 16, true); // external attributes: a regular file, rw-r--r--
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...local, ...central, new Uint8Array(end.buffer)]));
}

/** MS-DOS date and time, in UTC so an archive does not depend on the server's time zone. */
function dosTime(d: Date) {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}
