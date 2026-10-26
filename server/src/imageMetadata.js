// Customers' photos can carry where and when they were taken (EXIF, often with GPS) and other text. Review photos are
// shown to everyone, so those parts are removed before storing: whole segments or chunks are dropped, the picture
// itself is untouched. The review form also re-draws photos in the browser, which leaves no such data; this covers
// uploads made any other way. Throws on a file that isn't well-formed.

// JPEG: keep everything but APP1 (EXIF, XMP), APP3–APP13 and APP15 (other metadata) and comments. APP0 (JFIF),
// APP2 (colour profile) and APP14 (Adobe colour transform) change how the picture looks, so they stay.
const DROPPED_JPEG = (marker) =>
  marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;

function stripJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('bad JPEG segment');
    while (buf[i] === 0xff && buf[i + 1] === 0xff) i++; // fill bytes
    const marker = buf[i + 1];
    if (marker === 0xda) {
      parts.push(buf.subarray(i)); // start of the image data: the rest is the picture
      return Buffer.concat(parts);
    }
    if (marker === 0xd9) break; // end of image
    if (i + 4 > buf.length) throw new Error('truncated JPEG');
    const length = buf.readUInt16BE(i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > buf.length) throw new Error('bad JPEG segment length');
    if (!DROPPED_JPEG(marker)) parts.push(buf.subarray(i, end));
    i = end;
  }
  throw new Error('JPEG has no image data');
}

// PNG: drop text, EXIF and time chunks; keep the rest (image data, palette, colour information).
const DROPPED_PNG = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(buf) {
  const parts = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + length;
    if (end > buf.length) throw new Error('bad PNG chunk length');
    if (!DROPPED_PNG.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  throw new Error('PNG has no end');
}

export function stripMetadata(type, buf) {
  if (type === 'image/jpeg') return stripJpeg(buf);
  if (type === 'image/png') return stripPng(buf);
  throw new Error(`no metadata stripping for ${type}`);
}
