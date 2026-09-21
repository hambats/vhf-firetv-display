/*
 * Intrinsic pixel dimensions of an image, read from its header.
 *
 * The display picks a slide's layout from the shape of the photograph on it
 * (docs/DESIGN_PLAN.md D3.2): a portrait photo gets the split treatment, a
 * landscape one gets the full-bleed wash. Scraped gallery photos already carry
 * width and height; hand-curated ones did not, so this supplies them at build
 * time and the television reads a number rather than measuring an image.
 *
 * Header-only, on purpose. Nothing is decoded and no dependency is added: the
 * project ships two runtime dependencies and this is not worth being the third.
 * Reading a few dozen bytes also means an 8 MB photo costs the same as a small
 * one.
 *
 * Returns { width, height } or null when the format is unrecognised or the
 * header is malformed. Null is a legitimate answer -- scenes.js falls back to
 * the browser's own measurement -- so this never throws on a bad file.
 */
import { promises as fs } from "node:fs";

/* PNG: fixed layout. 8-byte signature, then an IHDR chunk whose width and
   height are the two big-endian uint32s at offset 16. */
function png(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/*
 * JPEG: a chain of segments, and the dimensions live in whichever "start of
 * frame" marker the encoder happened to use. Walk the chain rather than
 * guessing an offset -- a file with an EXIF thumbnail or colour profile puts
 * SOF a long way in, and the naive "read byte 163" approach that circulates
 * gets those wrong.
 *
 * Skipped deliberately: C4 (Huffman table) and C8/CC are not frame headers
 * despite sitting in the Cx range, and D0-D9 are standalone markers carrying
 * no length field.
 */
function jpeg(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let i = 2;
  // <= , not <: the frame payload needs bytes i+5..i+8, so i may legitimately
  // sit exactly nine bytes from the end. `<` dropped a frame marker that landed
  // on the final byte of the buffer — rare in a real file, which has image data
  // after the header, but certain in a truncated read.
  while (i <= buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }        // resync past padding
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;  // end of header data
    const len = buf.readUInt16BE(i + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // SOF payload: precision(1), height(2), width(2)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/*
 * WebP: three incompatible sub-formats behind one RIFF container, and the
 * curated folder contains lossy ones today and could contain either of the
 * others tomorrow, so all three are handled.
 *   VP8   lossy      - 14-bit dimensions, minus one, after a 3-byte sync code
 *   VP8L  lossless   - 14-bit each, packed across four bytes, minus one
 *   VP8X  extended   - 24-bit each, little-endian, minus one
 */
function webp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = buf.toString("ascii", 12, 16);
  if (kind === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") {
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

export function imageSizeFromBuffer(buf) {
  return png(buf) || webp(buf) || jpeg(buf) || null;
}

/*
 * 64 KB is generous for a header and bounded for a folder of large photos.
 * A JPEG whose SOF sits beyond that (a very large embedded profile) reads as
 * null, which degrades to the browser measuring it rather than to a wrong
 * answer.
 */
export async function imageSize(path) {
  let handle;
  try {
    handle = await fs.open(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return imageSizeFromBuffer(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}
