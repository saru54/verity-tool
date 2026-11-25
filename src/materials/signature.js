import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import opentype from 'opentype.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dirname, 'fonts');

// Three open-source (OFL) handwriting fonts, each with a distinct personality:
//   DancingScript — flowing casual cursive, good for general names
//   Sacramento    — compact script, thinline pen feel
//   HomemadeApple — organic, slightly irregular, most "handwritten"
const FONT_FILES = Object.freeze({
  dancing: { file: 'DancingScript.ttf', pdfName: 'SigScriptA' },
  sacramento: { file: 'Sacramento.ttf', pdfName: 'SigScriptB' },
  homemade: { file: 'HomemadeApple.ttf', pdfName: 'SigScriptC' },
});

// WinAnsi encoding byte → Unicode codepoint. PDF's /WinAnsiEncoding maps byte
// values to Unicode; we need this to look up glyph advance widths per byte.
const WIN_ANSI_UNICODE = new Array(256);
for (let i = 0; i < 256; i++) WIN_ANSI_UNICODE[i] = i;
Object.assign(WIN_ANSI_UNICODE, {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
  0x9E: 0x017E, 0x9F: 0x0178,
});

const cache = new Map();

/**
 * Load a handwriting font and prepare embedding data for PDF.
 *
 * Uses opentype.js ONLY for extracting font metrics (advance widths, ascent,
 * descent, bounding box, italic angle) — NOT for glyph path extraction.
 * The raw TTF bytes are embedded into the PDF as a /FontFile2 stream, and
 * the signature is rendered via standard PDF text operators (Tf/Tm/Tj).
 * This gives exact control over position and size.
 *
 * @param {string} key — font key: 'dancing' | 'sacramento' | 'homemade'
 * @returns {object} frozen font descriptor with rawBytes, widths, metrics
 */
export function getSignatureFont(key) {
  if (cache.has(key)) return cache.get(key);
  const config = FONT_FILES[key];
  if (!config) throw new Error(`unknown signature font: ${key}`);
  const rawBytes = readFileSync(join(FONTS_DIR, config.file));
  const arrayBuffer = rawBytes.buffer.slice(
    rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength,
  );
  const font = opentype.parse(arrayBuffer);
  const scale = 1000 / font.unitsPerEm;

  // Build the 256-entry Widths array indexed by WinAnsi byte value.
  const widths = new Array(256);
  for (let i = 0; i < 256; i++) {
    const unicode = WIN_ANSI_UNICODE[i];
    const glyph = font.charToGlyph(String.fromCodePoint(unicode));
    widths[i] = glyph && glyph.index > 0
      ? Math.round(glyph.advanceWidth * scale)
      : 0;
  }

  const head = font.tables.head;
  const os2 = font.tables.os2;
  const post = font.tables.post;

  const data = Object.freeze({
    pdfName: config.pdfName,
    rawBytes,
    widths,
    ascent: Math.round(font.ascender * scale),
    descent: Math.round(font.descender * scale),
    bbox: [
      Math.round(head.xMin * scale),
      Math.round(head.yMin * scale),
      Math.round(head.xMax * scale),
      Math.round(head.yMax * scale),
    ],
    italicAngle: post ? Math.round(post.italicAngle * 100) / 100 : 0,
    capHeight: os2 && os2.capHeight
      ? Math.round(os2.capHeight * scale)
      : Math.round(font.ascender * scale * 0.7),
    stemV: 72,
    flags: 96, // bit 6 nonsymbolic (32) + bit 7 italic (64)
  });
  cache.set(key, data);
  return data;
}

/**
 * Deterministically pick a font key from the seed + name.
 * Names with non-ASCII characters skip HomemadeApple (limited glyph coverage).
 */
export function pickSignatureFontKey(seed, name = '') {
  const hasNonAscii = /[^\x00-\x7F]/.test(name);
  const keys = hasNonAscii ? ['dancing', 'sacramento'] : ['dancing', 'sacramento', 'homemade'];
  const hash = createHash('sha256').update(`sigfont:${seed}`).digest();
  return keys[hash.readUInt32LE(0) % keys.length];
}

// Preload fonts on module import so first call is instant in long-running servers.
export function preloadFonts() {
  for (const key of Object.keys(FONT_FILES)) {
    try { getSignatureFont(key); } catch { /* font may not be deployed yet */ }
  }
}

export { FONT_FILES };
