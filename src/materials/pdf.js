import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { getSignatureFont, pickSignatureFontKey, preloadFonts } from './signature.js';

// WinAnsi (CP1252) is what PDF base-14 fonts expect. German umlauts and the
// punctuation used by German university documents must survive byte-for-byte,
// so every character is mapped explicitly instead of relying on UTF-8 output.
const CP1252 = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86], ['‡', 0x87],
  ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c], ['Ž', 0x8e], ['‘', 0x91],
  ['’', 0x92], ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97], ['˜', 0x98],
  ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

// Helvetica advance widths (per 1000 units) for the characters used here.
const WIDTHS = new Map(Object.entries({
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333,
  ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556,
  M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667,
  Y: 667, Z: 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
  m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500,
  y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584,
  '€': 556, '„': 333, '“': 333, '”': 333, '‘': 222, '’': 222, '–': 556, '—': 1000, '•': 350,
  'ä': 556, 'ö': 556, 'ü': 556, 'ß': 556, 'Ä': 667, 'Ö': 778, 'Ü': 722, 'é': 556, 'è': 556,
}));
const BOLD_EXTRA = 30;

function encodeWinAnsi(text) {
  const bytes = [];
  for (const char of String(text)) {
    if (CP1252.has(char)) { bytes.push(CP1252.get(char)); continue; }
    const code = char.codePointAt(0);
    if (code <= 0xff) { bytes.push(code); continue; }
    // Unknown glyphs degrade to '?' exactly like a base-14 font would.
    bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

function escapeText(text) {
  return encodeWinAnsi(text).toString('latin1')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

const FONTS = {
  regular: { name: 'F1', base: 'Helvetica' },
  bold: { name: 'F2', base: 'Helvetica-Bold' },
  italic: { name: 'F3', base: 'Helvetica-Oblique' },
  mono: { name: 'F4', base: 'Courier' },
  serif: { name: 'F5', base: 'Times-Roman' },
  serifBold: { name: 'F6', base: 'Times-Bold' },
  serifItalic: { name: 'F7', base: 'Times-Italic' },
};

const REALISTIC_PRODUCERS = [
  { producer: 'macOS Version 14.6.1 (Build 23G93) Quartz PDFContext', creator: 'Safari' },
  { producer: 'Skia/PDF m130', creator: 'Chromium' },
  { producer: 'Microsoft: Print To PDF', creator: 'Microsoft Word' },
  { producer: 'LibreOffice 24.2', creator: 'Writer' },
  { producer: 'Adobe PDF Library 17.0', creator: 'Adobe InDesign 19.3' },
];

function pickProducer(seed) {
  const digest = createHash('sha256').update(String(seed || 'doc')).digest();
  return REALISTIC_PRODUCERS[digest[0] % REALISTIC_PRODUCERS.length];
}

function pdfTimestamp(issueDate, seed) {
  const digest = createHash('sha256').update(`${seed || 'doc'}:time`).digest();
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(issueDate || ''))
    ? new Date(`${issueDate}T09:00:00Z`)
    : new Date();
  const hour = 9 + (digest[1] % 8);
  const minute = digest[2] % 60;
  const second = digest[3] % 60;
  base.setUTCHours(hour, minute, second, 0);
  const created = `${base.getUTCFullYear()}${String(base.getUTCMonth() + 1).padStart(2, '0')}`
    + `${String(base.getUTCDate()).padStart(2, '0')}${String(base.getUTCHours()).padStart(2, '0')}`
    + `${String(base.getUTCMinutes()).padStart(2, '0')}${String(base.getUTCSeconds()).padStart(2, '0')}`;
  const modDate = new Date(base.getTime() + (5 + (digest[4] % 45)) * 1000);
  const modified = `${modDate.getUTCFullYear()}${String(modDate.getUTCMonth() + 1).padStart(2, '0')}`
    + `${String(modDate.getUTCDate()).padStart(2, '0')}${String(modDate.getUTCHours()).padStart(2, '0')}`
    + `${String(modDate.getUTCMinutes()).padStart(2, '0')}${String(modDate.getUTCSeconds()).padStart(2, '0')}`;
  return { created: `D:${created}Z`, modified: `D:${modified}Z` };
}

function colorParts(color) {
  if (typeof color === 'string') {
    const hex = color.replace('#', '');
    const value = Number.parseInt(hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex, 16);
    return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
  }
  if (Array.isArray(color)) return color;
  return [0, 0, 0];
}

const number = value => Number(value.toFixed(3));

export class PdfPage {
  constructor(document) {
    this.document = document;
    this.operations = [];
    this.textObjects = [];
  }

  get width() { return this.document.width; }
  get height() { return this.document.height; }

  // Page coordinates are top-left based; PDF content streams are bottom-left.
  toY(y) { return this.height - y; }

  textWidth(text, size = 10, { bold = false } = {}) {
    let width = 0;
    for (const char of String(text)) width += (WIDTHS.get(char) ?? 556) + (bold ? BOLD_EXTRA : 0);
    return (width * size) / 1000;
  }

  // Shrink a font size until the string fits the given width, never below minSize.
  fitText(value, maxWidth, { size = 10, minSize = 4, bold = false } = {}) {
    const longest = String(value).split('\n').reduce((max, line) => Math.max(max, this.textWidth(line, size, { bold })), 0);
    if (longest <= maxWidth || longest === 0) return size;
    return Math.max(minSize, (size * maxWidth) / longest);
  }

  text(value, x, y, options = {}) {
    const {
      size = 10, font = 'regular', color = '#000000', align = 'left', charSpace = 0, lineHeight = size * 1.2,
    } = options;
    const isBold = font === 'bold' || font === 'mono' || font === 'serifBold';
    const lines = String(value).split('\n');
    lines.forEach((line, index) => {
      let drawX = x;
      const width = this.textWidth(line, size, { bold: isBold });
      if (align === 'center') drawX = x - width / 2;
      else if (align === 'right') drawX = x - width;
      const [r, g, b] = colorParts(color);
      this.operations.push(
        `BT /${FONTS[font].name} ${number(size)} Tf ${number(r)} ${number(g)} ${number(b)} rg`
        + ` ${number(charSpace)} Tc 1 0 0 1 ${number(drawX)} ${number(this.toY(y + index * lineHeight))} Tm`
        + ` (${escapeText(line)}) Tj ET`,
      );
      this.textObjects.push({ text: line, x: drawX, y: y + index * lineHeight, size, font });
    });
    return this;
  }

  line(x1, y1, x2, y2, options = {}) {
    const { color = '#000000', width = 0.7, dash = null } = options;
    const [r, g, b] = colorParts(color);
    this.operations.push(
      `${number(r)} ${number(g)} ${number(b)} RG ${number(width)} w`
      + (dash ? ` [${dash.join(' ')}] 0 d` : ' [] 0 d')
      + ` ${number(x1)} ${number(this.toY(y1))} m ${number(x2)} ${number(this.toY(y2))} l S`,
    );
    return this;
  }

  rect(x, y, width, height, options = {}) {
    const { fill = null, stroke = '#000000', lineWidth = 0.7, radius = 0 } = options;
    if (fill) {
      const [r, g, b] = colorParts(fill);
      this.operations.push(`${number(r)} ${number(g)} ${number(b)} rg`);
    }
    if (stroke) {
      const [r, g, b] = colorParts(stroke);
      this.operations.push(`${number(r)} ${number(g)} ${number(b)} RG ${number(lineWidth)} w`);
    }
    const bottom = this.toY(y + height);
    if (!radius) {
      this.operations.push(`${number(x)} ${number(bottom)} ${number(width)} ${number(height)} re`);
    } else {
      const k = Math.min(radius, width / 2, height / 2);
      const right = x + width;
      const top = bottom + height;
      this.operations.push(
        `${number(x + k)} ${number(bottom)} m ${number(right - k)} ${number(bottom)} l`
        + ` ${number(right)} ${number(bottom)} ${number(right)} ${number(bottom + k)} ${number(right)} ${number(bottom + k)} c`
        + ` ${number(right)} ${number(top - k)} l ${number(right)} ${number(top)} ${number(right - k)} ${number(top)} ${number(right - k)} ${number(top)} c`
        + ` ${number(x + k)} ${number(top)} l ${number(x)} ${number(top)} ${number(x)} ${number(top - k)} ${number(x)} ${number(top - k)} c`
        + ` ${number(x)} ${number(bottom + k)} l ${number(x)} ${number(bottom)} ${number(x + k)} ${number(bottom)} ${number(x + k)} ${number(bottom)} c h`,
      );
    }
    this.operations.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    return this;
  }

  circle(cx, cy, radius, options = {}) {
    // Four cubic segments approximate a circle to sub-pixel accuracy.
    const { fill = null, stroke = '#000000', lineWidth = 0.7 } = options;
    const k = 0.5522847498 * radius;
    const y = this.toY(cy);
    if (fill) {
      const [r, g, b] = colorParts(fill);
      this.operations.push(`${number(r)} ${number(g)} ${number(b)} rg`);
    }
    if (stroke) {
      const [r, g, b] = colorParts(stroke);
      this.operations.push(`${number(r)} ${number(g)} ${number(b)} RG ${number(lineWidth)} w`);
    }
    this.operations.push(
      `${number(cx + radius)} ${number(y)} m`
      + ` ${number(cx + radius)} ${number(y + k)} ${number(cx + k)} ${number(y + radius)} ${number(cx)} ${number(y + radius)} c`
      + ` ${number(cx - k)} ${number(y + radius)} ${number(cx - radius)} ${number(y + k)} ${number(cx - radius)} ${number(y)} c`
      + ` ${number(cx - radius)} ${number(y - k)} ${number(cx - k)} ${number(y - radius)} ${number(cx)} ${number(y - radius)} c`
      + ` ${number(cx + k)} ${number(y - radius)} ${number(cx + radius)} ${number(y - k)} ${number(cx + radius)} ${number(y)} c h`,
    );
    this.operations.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    return this;
  }

  // Handwritten signature rendered as PDF text using an embedded TrueType
  // handwriting font (DancingScript / Sacramento / HomemadeApple).
  //
  // The font is embedded as a /FontFile2 stream in the PDF, and the name
  // is drawn via standard text operators (Tf/Tm/Tj).  This gives exact
  // control over position and size — no glyph-path extraction, no jitter.
  //
  // @param {string} seed   — deterministic seed for font + slant selection
  // @param {number} x      — left edge of signature box (top-down page coords)
  // @param {number} y      — top of signature box (top-down page coords)
  // @param {number} width  — available width for the signature
  // @param {number} height — available height for the signature
  // @param {object} opts   — { name, color }
  signature(seed, x, y, width, height, options = {}) {
    const { name = 'Signiert', color = '#00694e' } = options;

    let fontKey;
    try {
      fontKey = pickSignatureFontKey(seed, name);
    } catch {
      // Fallback: draw a thin wavy line as a signature placeholder.
      const [fr, fg, fb] = colorParts(color);
      this.operations.push(
        `${number(fr)} ${number(fg)} ${number(fb)} rg ${number(1)} w`
        + ` ${number(x)} ${number(this.toY(y + height * 0.55))} m`
        + ` ${number(x + width * 0.3)} ${number(this.toY(y + height * 0.45))} l`
        + ` ${number(x + width * 0.6)} ${number(this.toY(y + height * 0.65))} l`
        + ` ${number(x + width)} ${number(this.toY(y + height * 0.50))} l S`,
      );
      return this;
    }

    const fontData = getSignatureFont(fontKey);
    const font = this.document.registerEmbeddedFont(fontKey, fontData);

    // Font size: about 58 % of box height; shrink if text exceeds width.
    let fontSize = height * 0.58;
    const naturalWidth = this._signatureTextWidth(name, fontData, fontSize);
    if (naturalWidth > width * 0.95) {
      fontSize *= (width * 0.95) / naturalWidth;
    }

    // Baseline at 72 % down from the top of the box (top-down coords).
    const baselineY = y + height * 0.72;

    // Deterministic subtle rightward slant for a natural handwriting feel.
    const slantHash = createHash('sha256').update(`slant:${seed}`).digest();
    const slant = 0.02 + (slantHash.readUInt32LE(0) % 4) * 0.012; // 0.02–0.056 (~1–3°)

    const [r, g, b] = colorParts(color);
    this.operations.push(
      `BT /${font.resourceName} ${number(fontSize)} Tf`
      + ` ${number(r)} ${number(g)} ${number(b)} rg`
      + ` 1 0 ${number(slant)} 1 ${number(x)} ${number(this.toY(baselineY))} Tm`
      + ` (${escapeText(name)}) Tj ET`,
    );
    return this;
  }

  // Measure text width using an embedded signature font's advance widths.
  _signatureTextWidth(text, fontData, size) {
    const encoded = encodeWinAnsi(text);
    let total = 0;
    for (const byte of encoded) total += fontData.widths[byte] || 0;
    return (total * size) / 1000;
  }

  // Code-128-style bar strip; deterministic per seed for a reproducible card.
  barcode(seed, x, y, width, height) {
    let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 7;
    const random = () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state / 0x100000000;
    };
    this.rect(x, y, width, height, { fill: '#ffffff', stroke: null });
    let cursor = x + 2;
    while (cursor < x + width - 2) {
      const barWidth = 0.6 + random() * 2.4;
      if (random() > 0.42) this.rect(cursor, y + 2, barWidth, height - 4, { fill: '#000000', stroke: null });
      cursor += barWidth + 0.4 + random() * 1.6;
    }
    return this;
  }

  content() { return this.operations.join('\n'); }
}

export class PdfDocument {
  constructor({ width = 595.28, height = 841.89, title = '', author = '', subject = '', keywords = '', producer, creator, issueDate, seed } = {}) {
    this.width = width;
    this.height = height;
    this.info = { title, author, subject, keywords };
    this.meta = { producer, creator, issueDate, seed: seed ?? title ?? author };
    this.pages = [new PdfPage(this)];
    this.embeddedFonts = new Map();
  }

  addPage() {
    const page = new PdfPage(this);
    this.pages.push(page);
    return page;
  }

  // Register an embedded TrueType font and return a descriptor with the PDF
  // resource name (SF1, SF2, …) used in content-stream text operators.
  registerEmbeddedFont(key, data) {
    if (!this.embeddedFonts.has(key)) {
      const id = this.embeddedFonts.size;
      this.embeddedFonts.set(key, { ...data, resourceName: `SF${id + 1}` });
    }
    return this.embeddedFonts.get(key);
  }

  build() {
    const chunks = [];
    const offsets = [0];
    const push = value => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1'));
    const object = (index, body) => {
      offsets[index] = chunks.reduce((total, chunk) => total + chunk.length, 0);
      push(`${index} 0 obj\n${body}\nendobj\n`);
    };
    // Stream object that can contain binary data (used for embedded font files).
    const streamObject = (index, dict, data) => {
      offsets[index] = chunks.reduce((total, chunk) => total + chunk.length, 0);
      push(`${index} 0 obj\n${dict}\nstream\n`);
      push(data);
      push('\nendstream\nendobj\n');
    };

    push('%PDF-1.7\n');
    push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const baseFontNames = Object.keys(FONTS);
    const baseFontCount = baseFontNames.length;
    const embeddedList = [...this.embeddedFonts.values()];
    const embeddedCount = embeddedList.length;

    const firstBaseFont = 3;
    const firstEmbeddedFont = firstBaseFont + baseFontCount;
    // Each embedded font occupies 3 objects: Font dict, FontDescriptor, FontFile2.
    const firstPage = firstEmbeddedFont + embeddedCount * 3;
    const firstContent = firstPage + this.pages.length;
    const infoIndex = firstContent + this.pages.length;
    const total = infoIndex;

    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const kids = this.pages.map((_, index) => `${firstPage + index} 0 R`).join(' ');
    object(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);

    // Base-14 fonts (Helvetica family + Courier).
    Object.values(FONTS).forEach((font, index) => {
      object(firstBaseFont + index, `<< /Type /Font /Subtype /Type1 /BaseFont /${font.base} /Encoding /WinAnsiEncoding >>`);
    });

    // Embedded TrueType handwriting fonts for signatures.
    embeddedList.forEach((font, i) => {
      const fontObj = firstEmbeddedFont + i * 3;
      const descObj = fontObj + 1;
      const fileObj = fontObj + 2;
      const compressed = deflateSync(font.rawBytes);

      object(fontObj,
        `<< /Type /Font /Subtype /TrueType /BaseFont /${font.pdfName}`
        + ` /FirstChar 0 /LastChar 255`
        + ` /Widths [${font.widths.join(' ')}]`
        + ` /FontDescriptor ${descObj} 0 R`
        + ` /Encoding /WinAnsiEncoding >>`);

      object(descObj,
        `<< /Type /FontDescriptor /FontName /${font.pdfName}`
        + ` /Flags ${font.flags}`
        + ` /FontBBox [${font.bbox.join(' ')}]`
        + ` /ItalicAngle ${font.italicAngle}`
        + ` /Ascent ${font.ascent}`
        + ` /Descent ${font.descent}`
        + ` /CapHeight ${font.capHeight}`
        + ` /StemV ${font.stemV}`
        + ` /FontFile2 ${fileObj} 0 R >>`);

      streamObject(fileObj,
        `<< /Length ${compressed.length} /Length1 ${font.rawBytes.length} /Filter /FlateDecode >>`,
        compressed);
    });

    // Font resource dictionary entries for every page.
    const baseFontResources = baseFontNames
      .map(name => `/${FONTS[name].name} ${firstBaseFont + baseFontNames.indexOf(name)} 0 R`).join(' ');
    const embeddedFontResources = embeddedList
      .map((font, i) => `/${font.resourceName} ${firstEmbeddedFont + i * 3} 0 R`).join(' ');
    const allFontResources = [baseFontResources, embeddedFontResources].filter(Boolean).join(' ');

    this.pages.forEach((page, index) => {
      object(firstPage + index, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(this.width)} ${number(this.height)}]`
        + ` /Resources << /Font << ${allFontResources} >> >> /Contents ${firstContent + index} 0 R >>`);
      const content = page.content();
      object(firstContent + index, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    });

    const picked = pickProducer(this.meta.seed);
    const producer = this.meta.producer ?? picked.producer;
    const creator = this.meta.creator ?? picked.creator;
    const { created, modified } = pdfTimestamp(this.meta.issueDate, this.meta.seed);
    const info = Object.entries(this.info)
      .filter(([, value]) => value)
      .map(([key, value]) => `/${key[0].toUpperCase()}${key.slice(1)} (${escapeText(value)})`).join(' ');
    object(infoIndex, `<< ${info} /Creator (${escapeText(creator)}) /Producer (${escapeText(producer)}) /CreationDate (${created}) /ModDate (${modified}) >>`);

    const xrefOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let index = 1; index <= total; index++) {
      xref += `${String(offsets[index] ?? 0).padStart(10, '0')} 00000 n \n`;
    }
    push(xref);
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info ${infoIndex} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}
