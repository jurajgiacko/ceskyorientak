/**
 * Minimal GeoTIFF reader — just enough for what ČÚZK's ImageServer emits.
 *
 * Deliberately not a general TIFF library. ČÚZK returns single-band float32,
 * uncompressed, in strips, which is a small and stable subset. Pulling in a
 * full GeoTIFF dependency for that would add weight to the build for format
 * coverage we will never exercise — and this way the failure mode when the
 * service changes is a loud, specific error rather than a subtle misparse.
 *
 * Everything unsupported throws by name so a format change is obvious.
 */

import { readFile } from 'node:fs/promises';

// TIFF tag numbers we care about.
const TAG = {
  IMAGE_WIDTH: 256,
  IMAGE_LENGTH: 257,
  BITS_PER_SAMPLE: 258,
  COMPRESSION: 259,
  STRIP_OFFSETS: 273,
  SAMPLES_PER_PIXEL: 277,
  ROWS_PER_STRIP: 278,
  STRIP_BYTE_COUNTS: 279,
  PLANAR_CONFIG: 284,
  // ČÚZK's ImageServer emits *tiled* TIFFs (128×128), not strips.
  TILE_WIDTH: 322,
  TILE_LENGTH: 323,
  TILE_OFFSETS: 324,
  TILE_BYTE_COUNTS: 325,
  SAMPLE_FORMAT: 339,
  // GeoTIFF
  MODEL_PIXEL_SCALE: 33550,
  MODEL_TIEPOINT: 33922,
};

/** Byte widths by TIFF field type code. */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * @typedef {object} Raster
 * @property {Float32Array} data   row-major, length width*height
 * @property {number} width
 * @property {number} height
 * @property {number} noData
 * @property {[number,number]} pixelScale  metres per pixel, [x, y]
 * @property {[number,number]} origin      world coords of the top-left corner
 * @property {number} min
 * @property {number} max
 */

/**
 * Parse a float32 single-band GeoTIFF.
 * @param {Buffer} buf
 * @param {number} noData
 * @returns {Raster}
 */
export function parseFloat32GeoTiff(buf, noData = -9999) {
  // --- header ---
  const bomTag = buf.toString('latin1', 0, 2);
  let le;
  if (bomTag === 'II') le = true;
  else if (bomTag === 'MM') le = false;
  else throw new Error(`Not a TIFF: byte-order mark was ${JSON.stringify(bomTag)}`);

  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));

  const magic = u16(2);
  if (magic !== 42) throw new Error(`Unsupported TIFF magic ${magic} (BigTIFF is not handled)`);

  // --- IFD ---
  const ifdOffset = u32(4);
  const entryCount = u16(ifdOffset);
  const tags = new Map();

  for (let i = 0; i < entryCount; i++) {
    const e = ifdOffset + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    // Values of 4 bytes or fewer are stored inline in the entry.
    const valueOffset = size <= 4 ? e + 8 : u32(e + 8);

    const read = (idx) => {
      const o = valueOffset + idx * (TYPE_SIZE[type] ?? 1);
      switch (type) {
        case 3:
          return u16(o);
        case 4:
          return u32(o);
        case 12:
          return f64(o);
        default:
          return u32(o);
      }
    };

    tags.set(tag, { type, count, read, valueOffset });
  }

  const one = (tag, fallback) => (tags.has(tag) ? tags.get(tag).read(0) : fallback);

  const width = one(TAG.IMAGE_WIDTH);
  const height = one(TAG.IMAGE_LENGTH);
  const bits = one(TAG.BITS_PER_SAMPLE, 32);
  const compression = one(TAG.COMPRESSION, 1);
  const samples = one(TAG.SAMPLES_PER_PIXEL, 1);
  const sampleFormat = one(TAG.SAMPLE_FORMAT, 3);

  if (compression !== 1) {
    throw new Error(`Compressed GeoTIFF (compression=${compression}) — reader handles uncompressed only`);
  }
  if (bits !== 32 || sampleFormat !== 3) {
    throw new Error(`Expected 32-bit float samples, got bits=${bits} sampleFormat=${sampleFormat}`);
  }
  if (samples !== 1) throw new Error(`Expected single-band, got ${samples} samples per pixel`);

  // --- pixel data: tiled or stripped ---
  const data = new Float32Array(width * height);
  const readF32 = (o) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o));

  if (tags.has(TAG.TILE_OFFSETS)) {
    // Tiled. This is what ČÚZK actually returns: 128×128 float32 tiles.
    // Tiles are padded out to full tile size even at the right and bottom
    // edges, so the trailing pixels of edge tiles must be discarded rather
    // than written — getting this wrong shears the raster diagonally.
    const tw = one(TAG.TILE_WIDTH);
    const th = one(TAG.TILE_LENGTH);
    const offsets = tags.get(TAG.TILE_OFFSETS);
    const tilesAcross = Math.ceil(width / tw);
    const tilesDown = Math.ceil(height / th);

    for (let ty = 0; ty < tilesDown; ty++) {
      for (let tx = 0; tx < tilesAcross; tx++) {
        const base = offsets.read(ty * tilesAcross + tx);
        for (let row = 0; row < th; row++) {
          const y = ty * th + row;
          if (y >= height) break;
          const rowBase = base + row * tw * 4;
          const dstBase = y * width + tx * tw;
          const cols = Math.min(tw, width - tx * tw);
          for (let col = 0; col < cols; col++) {
            data[dstBase + col] = readF32(rowBase + col * 4);
          }
        }
      }
    }
  } else {
    const offsetsTag = tags.get(TAG.STRIP_OFFSETS);
    const countsTag = tags.get(TAG.STRIP_BYTE_COUNTS);
    if (!offsetsTag || !countsTag) {
      throw new Error('Neither TileOffsets nor StripOffsets present');
    }
    const rowsPerStrip = one(TAG.ROWS_PER_STRIP, height);
    const stripCount = Math.ceil(height / rowsPerStrip);
    let written = 0;
    for (let s = 0; s < stripCount; s++) {
      const off = offsetsTag.read(s);
      const floats = countsTag.read(s) / 4;
      for (let i = 0; i < floats && written < data.length; i++) {
        data[written++] = readF32(off + i * 4);
      }
    }
    if (written !== data.length) {
      throw new Error(`Short read: got ${written} samples, expected ${data.length}`);
    }
  }

  // --- georeferencing ---
  const scaleTag = tags.get(TAG.MODEL_PIXEL_SCALE);
  const tieTag = tags.get(TAG.MODEL_TIEPOINT);
  const pixelScale = scaleTag ? [scaleTag.read(0), scaleTag.read(1)] : [1, 1];
  // Tiepoint is (i, j, k, x, y, z); we want the world x,y at raster 0,0.
  const origin = tieTag ? [tieTag.read(3), tieTag.read(4)] : [0, 0];

  // --- range, ignoring noData ---
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === noData || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return { data, width, height, noData, pixelScale, origin, min, max };
}

export async function readFloat32GeoTiff(path, noData = -9999) {
  return parseFloat32GeoTiff(await readFile(path), noData);
}
