import { deflateRawSync } from "node:zlib";

/** The most entries a zip without ZIP64 can count (16-bit fields). */
export const ZIP_MAX_ENTRIES = 0xffff;

export type ZipEntry = { path: string; read: () => Promise<Uint8Array> };

/**
 * Streams a zip archive, one file at a time, so memory stays near the size of the largest file.
 * Each file is deflated, or stored when deflate does not make it smaller. Binder caps a version
 * at 64 MB, so offsets and sizes fit in 32 bits; callers must keep entries under ZIP_MAX_ENTRIES.
 * Format: PKWARE APPNOTE.TXT, sections 4.3 (structure) and 4.4 (fields).
 */
export function zipStream(entries: ZipEntry[], mtime: Date): ReadableStream<Uint8Array> {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`a zip holds at most ${ZIP_MAX_ENTRIES} files`);
  const { time, date } = dosTime(mtime);
  const central: Uint8Array[] = [];
  let offset = 0;
  let i = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i === entries.length) {
        const size = central.reduce((n, b) => n + b.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, size, true);
        end.setUint32(16, offset, true);
        for (const c of central) controller.enqueue(c);
        controller.enqueue(new Uint8Array(end.buffer));
        controller.close();
        return;
      }
      const f = entries[i++]!;
      const data = await f.read();
      const name = new TextEncoder().encode(f.path);
      const deflated = deflateRawSync(data);
      const store = deflated.length >= data.length;
      const body = store ? data : deflated;
      const crc = Bun.hash.crc32(data) >>> 0;
      // Shared fields: version needed, flags (bit 11: UTF-8 names), method, time, date, crc, sizes.
      const common = (h: DataView, at: number) => {
        h.setUint16(at, 20, true);
        h.setUint16(at + 2, 0x0800, true);
        h.setUint16(at + 4, store ? 0 : 8, true);
        h.setUint16(at + 6, time, true);
        h.setUint16(at + 8, date, true);
        h.setUint32(at + 10, crc, true);
        h.setUint32(at + 14, body.length, true);
        h.setUint32(at + 18, data.length, true);
        h.setUint16(at + 22, name.length, true);
      };

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      common(lh, 4);
      controller.enqueue(new Uint8Array(lh.buffer));
      controller.enqueue(name);
      controller.enqueue(new Uint8Array(body));

      const ch = new DataView(new ArrayBuffer(46 + name.length));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 0x0314, true); // made by: Unix, spec 2.0
      common(ch, 6);
      ch.setUint32(38, 0o100644 << 16, true); // external attributes: a regular file, rw-r--r--
      ch.setUint32(42, offset, true);
      const c = new Uint8Array(ch.buffer);
      c.set(name, 46);
      central.push(c);

      offset += 30 + name.length + body.length;
    },
  });
}

/** MS-DOS date and time, in UTC so an archive does not depend on the server's time zone. */
function dosTime(d: Date) {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}
