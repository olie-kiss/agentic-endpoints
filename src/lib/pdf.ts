/**
 * Minimal PDF text extractor.
 *
 * The previous implementation scanned the raw file for `BT ... ET` blocks.
 * That only works on uncompressed PDFs, which are rare in the wild — nearly
 * every real PDF stores its page content in FlateDecode streams, so the old
 * extractor returned "no extractable text" for almost every genuine input
 * while still charging for the call.
 *
 * This version inflates content streams (using the runtime's built-in
 * DecompressionStream), walks the page tree to split text per page, and
 * interprets the actual PDF text-showing operators.
 *
 * Subset and composite fonts don't use ASCII character codes, so shown
 * strings are decoded through each font's /ToUnicode CMap when one exists.
 * Without that step, most PDFs produced by LaTeX, Word or InDesign come back
 * as unreadable glyph indices.
 *
 * Deliberately out of scope: encrypted PDFs and scanned images. Those cases
 * are reported honestly rather than answered with garbage.
 */

export interface PdfPage {
  page: number;
  text: string;
}

export interface PdfExtraction {
  pages: PdfPage[];
  /** Set when the document was readable but contains no extractable text. */
  reason?: "encrypted" | "no-text" | "unsupported";
}

/** Decode bytes to a string where 1 byte == 1 char, preserving offsets. */
function toLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(
      ...(bytes.subarray(i, i + CHUNK) as unknown as number[]),
    );
  }
  return out;
}

function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Hard ceilings for untrusted input. A PDF is attacker-supplied, so every
 * unbounded loop or buffer here is a denial-of-service vector.
 */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024; // per stream
const MAX_TOTAL_TEXT = 5 * 1024 * 1024;

/**
 * Inflate a zlib or raw-deflate stream. PDF writers are inconsistent about
 * emitting the zlib header, so try both framings before giving up.
 *
 * Output is capped: a decompression bomb is a few KB on the wire and
 * hundreds of MB once expanded, which would exhaust the Worker's memory.
 */
async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const stream = new Response(data).body;
      if (!stream) continue;

      const reader = stream
        .pipeThrough(new DecompressionStream(format))
        .getReader();

      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_INFLATED_BYTES) {
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }

      if (truncated) return null;

      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } catch {
      // Wrong framing — fall through and try the next one.
    }
  }
  return null;
}

interface PdfObject {
  num: number;
  dict: string;
  /** Raw (still encoded) stream payload, if the object has one. */
  stream: Uint8Array | null;
}

/** Index every `N G obj ... endobj` in the file. */
function parseObjects(raw: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  // Digit runs are bounded deliberately. An unbounded `\d+` here backtracks
  // catastrophically across a long run of digits — a 200 KB numeric blob in
  // a hostile PDF took 60s to scan. Real object and generation numbers are
  // far smaller than these caps.
  const objRegex = /(\d{1,10})\s{1,8}(\d{1,6})\s{1,8}obj\b/g;
  let match: RegExpExecArray | null;

  while ((match = objRegex.exec(raw)) !== null) {
    const num = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const endObj = raw.indexOf("endobj", bodyStart);
    const body = raw.slice(bodyStart, endObj === -1 ? undefined : endObj);

    const streamIdx = body.indexOf("stream");
    let dict = body;
    let stream: Uint8Array | null = null;

    if (streamIdx !== -1) {
      dict = body.slice(0, streamIdx);

      // The keyword is followed by CRLF or LF (never a bare CR).
      let dataStart = streamIdx + "stream".length;
      if (body[dataStart] === "\r") dataStart++;
      if (body[dataStart] === "\n") dataStart++;

      // /Length is often an indirect reference, so trust `endstream` instead.
      const endStream = body.indexOf("endstream", dataStart);
      if (endStream !== -1) {
        let dataEnd = endStream;
        if (body[dataEnd - 1] === "\n") dataEnd--;
        if (body[dataEnd - 1] === "\r") dataEnd--;
        stream = fromLatin1(body.slice(dataStart, dataEnd));
      }
    }

    objects.set(num, { num, dict, stream });
  }

  return objects;
}

/** Decode an object's stream according to its /Filter entry. */
async function decodeStream(obj: PdfObject): Promise<string | null> {
  if (!obj.stream) return null;

  if (/\/FlateDecode/.test(obj.dict)) {
    const inflated = await inflate(obj.stream);
    return inflated ? toLatin1(inflated) : null;
  }

  // Filters we don't implement (DCTDecode, JPXDecode, LZWDecode, ...) carry
  // image data or need a decoder we don't ship. Skip rather than emit noise.
  if (/\/Filter/.test(obj.dict)) return null;

  return toLatin1(obj.stream);
}

/**
 * PDF 1.5+ packs most non-stream objects (page dicts, font dicts, ...) into
 * compressed /ObjStm streams, where the plain `N G obj` scan cannot see them.
 * Inflate those and register their contents as ordinary objects.
 */
async function expandObjectStreams(objects: Map<number, PdfObject>) {
  for (const obj of [...objects.values()]) {
    if (!obj.stream || !/\/Type\s*\/ObjStm/.test(obj.dict)) continue;

    const data = await decodeStream(obj);
    if (!data) continue;

    const count = Number(obj.dict.match(/\/N\s+(\d+)/)?.[1] ?? 0);
    const first = Number(obj.dict.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    if (!count || !first) continue;

    const header = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i++) {
      const num = header[i * 2];
      const offset = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(offset)) continue;

      const nextOffset =
        i + 1 < count ? first + header[i * 2 + 3] : data.length;
      const body = data.slice(first + offset, nextOffset);

      // Objects written directly in the file take precedence over the
      // packed copy, which may be a superseded revision.
      if (!objects.has(num)) {
        objects.set(num, { num, dict: body, stream: null });
      }
    }
  }
}

/**
 * A font's character-code -> text mapping, derived from its /ToUnicode CMap.
 * `bytes` is the code width: simple fonts use 1, composite (Type0) use 2.
 */
interface FontMap {
  map: Map<number, string>;
  bytes: 1 | 2;
}

/**
 * Read the raw text of a dictionary value, following one level of indirection.
 * Regex alone can't do this safely because dictionary values nest.
 */
function dictValue(
  dict: string,
  key: string,
  objects: Map<number, PdfObject>,
): string | null {
  const at = dict.indexOf(key);
  if (at === -1) return null;

  let i = at + key.length;
  while (i < dict.length && /\s/.test(dict[i])) i++;

  if (dict.startsWith("<<", i)) {
    let depth = 0;
    let j = i;
    while (j < dict.length) {
      if (dict.startsWith("<<", j)) { depth++; j += 2; continue; }
      if (dict.startsWith(">>", j)) {
        depth--;
        j += 2;
        if (depth === 0) return dict.slice(i, j);
        continue;
      }
      j++;
    }
    return dict.slice(i);
  }

  const ref = dict.slice(i).match(/^(\d{1,10})\s{1,8}\d{1,6}\s{1,8}R/);
  if (ref) return objects.get(Number(ref[1]))?.dict ?? null;

  return null;
}

/** Parse a /ToUnicode CMap into a code -> string table. */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();

  const hexToText = (hex: string): string => {
    let out = "";
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const unit = hex.slice(i, i + 4);
      if (unit.length < 4) break;
      out += String.fromCharCode(parseInt(unit, 16));
    }
    return out;
  };

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(pair[1], 16), hexToText(pair[2]));
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];

    // <lo> <hi> [<d1> <d2> ...] — one destination per code.
    for (const m of body.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g,
    )) {
      const lo = parseInt(m[1], 16);
      const dests = [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)];
      dests.forEach((d, idx) => map.set(lo + idx, hexToText(d[1])));
    }

    // <lo> <hi> <dstStart> — destinations increment across the range.
    for (const m of body.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
    )) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const dst = m[3];
      const base = parseInt(dst.slice(-4), 16);
      const prefix = dst.slice(0, -4);
      // Guard against a malformed range asking us to build millions of entries.
      const end = Math.min(hi, lo + 65535);
      for (let code = lo; code <= end; code++) {
        map.set(code, hexToText(prefix + (base + code - lo).toString(16).padStart(4, "0")));
      }
    }
  }

  return map;
}

/** Build the resource-name -> FontMap table for a page. */
async function pageFonts(
  pageDict: string,
  objects: Map<number, PdfObject>,
): Promise<Map<string, FontMap>> {
  const fonts = new Map<string, FontMap>();

  const resources = dictValue(pageDict, "/Resources", objects);
  if (!resources) return fonts;

  const fontDict = dictValue(resources, "/Font", objects);
  if (!fontDict) return fonts;

  for (const entry of fontDict.matchAll(/\/([^\s/<>\[\]()]{1,127})\s{1,8}(\d{1,10})\s{1,8}\d{1,6}\s{1,8}R/g)) {
    const [, name, num] = entry;
    const fontObj = objects.get(Number(num));
    if (!fontObj) continue;

    // Composite fonts address glyphs with 2-byte codes.
    const isTwoByte =
      /\/Subtype\s*\/Type0/.test(fontObj.dict) ||
      /\/Encoding\s*\/Identity-[HV]/.test(fontObj.dict);

    const toUnicodeRef = fontObj.dict.match(/\/ToUnicode\s{1,8}(\d{1,10})\s{1,8}\d{1,6}\s{1,8}R/);
    let map = new Map<number, string>();
    if (toUnicodeRef) {
      const cmapObj = objects.get(Number(toUnicodeRef[1]));
      if (cmapObj) {
        const cmap = await decodeStream(cmapObj);
        if (cmap) map = parseToUnicode(cmap);
      }
    }

    if (map.size > 0 || isTwoByte) {
      fonts.set(name, { map, bytes: isTwoByte ? 2 : 1 });
    }
  }

  return fonts;
}

/** Resolve `/Contents` to the list of object numbers holding page content. */
function contentRefs(dict: string): number[] {
  const single = dict.match(/\/Contents\s{1,8}(\d{1,10})\s{1,8}\d{1,6}\s{1,8}R/);
  if (single) return [Number(single[1])];

  const array = dict.match(/\/Contents\s*\[([^\]]*)\]/);
  if (array) {
    return [...array[1].matchAll(/(\d{1,10})\s{1,8}\d{1,6}\s{1,8}R/g)].map((m) => Number(m[1]));
  }

  return [];
}

/**
 * Interpret a content stream and pull out the shown text.
 *
 * Handles the four text-showing operators (Tj, TJ, ' and ") plus the
 * positioning operators that imply a line break.
 */
function extractTextFromContent(
  content: string,
  fonts: Map<string, FontMap>,
): string {
  const out: string[] = [];
  let pending: string[] = [];
  let i = 0;
  let currentFont: FontMap | undefined;
  let lastName = "";
  // Recent numeric operands, so Td/TD can tell a vertical move from a
  // purely horizontal one. Only a vertical move is a new line.
  let numbers: number[] = [];

  const flush = () => {
    if (pending.length) {
      out.push(pending.join(""));
      pending = [];
    }
  };

  /**
   * Turn raw string bytes into text. Character codes are font-specific, so
   * without the active font's CMap the "text" would just be glyph indices.
   */
  const decode = (rawStr: string): string => {
    if (!currentFont) return rawStr;
    const { map, bytes } = currentFont;

    if (bytes === 2) {
      let out = "";
      for (let k = 0; k + 1 < rawStr.length; k += 2) {
        const code = (rawStr.charCodeAt(k) << 8) | rawStr.charCodeAt(k + 1);
        out += map.get(code) ?? "";
      }
      return out;
    }

    if (map.size === 0) return rawStr;

    let out = "";
    for (let k = 0; k < rawStr.length; k++) {
      const code = rawStr.charCodeAt(k);
      out += map.get(code) ?? String.fromCharCode(code);
    }
    return out;
  };

  while (i < content.length) {
    const ch = content[i];

    if (ch === "(") {
      // Literal string — honour escapes and balanced inner parens.
      let depth = 1;
      let str = "";
      i++;
      while (i < content.length && depth > 0) {
        const c = content[i];
        if (c === "\\") {
          const next = content[i + 1];
          if (next >= "0" && next <= "7") {
            let oct = "";
            let k = i + 1;
            while (k < content.length && oct.length < 3 && content[k] >= "0" && content[k] <= "7") {
              oct += content[k];
              k++;
            }
            str += String.fromCharCode(parseInt(oct, 8));
            i = k;
            continue;
          }
          const escapes: Record<string, string> = {
            n: "\n", r: "\r", t: "\t", b: "\b", f: "\f",
            "(": "(", ")": ")", "\\": "\\",
          };
          if (next === "\n") { i += 2; continue; } // line continuation
          str += escapes[next] ?? next;
          i += 2;
          continue;
        }
        if (c === "(") depth++;
        if (c === ")") {
          depth--;
          if (depth === 0) { i++; break; }
        }
        str += c;
        i++;
      }
      pending.push(decode(str));
      continue;
    }

    if (ch === "<" && content[i + 1] !== "<") {
      // Hex string.
      const end = content.indexOf(">", i);
      if (end === -1) break;
      const hex = content.slice(i + 1, end).replace(/\s+/g, "");
      let str = "";
      for (let k = 0; k + 1 < hex.length; k += 2) {
        str += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      }
      if (hex.length % 2 === 1) {
        str += String.fromCharCode(parseInt(hex[hex.length - 1] + "0", 16));
      }
      pending.push(decode(str));
      i = end + 1;
      continue;
    }

    if (ch === "/") {
      let name = "";
      i++;
      while (i < content.length && /[^\s/<>\[\]()]/.test(content[i])) {
        name += content[i];
        i++;
      }
      lastName = name;
      continue;
    }

    // Inside a TJ array, a sufficiently large negative kern is a word space.
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let numStr = "";
      while (i < content.length && /[-0-9.]/.test(content[i])) {
        numStr += content[i];
        i++;
      }
      const n = parseFloat(numStr);
      if (Number.isFinite(n)) {
        numbers.push(n);
        if (numbers.length > 6) numbers.shift();
      }
      if (pending.length && n <= -150) pending.push(" ");
      continue;
    }

    if (/[A-Za-z'"*]/.test(ch)) {
      let op = "";
      while (i < content.length && /[A-Za-z0-9*'"]/.test(content[i])) {
        op += content[i];
        i++;
      }
      if (op === "Tf") {
        currentFont = fonts.get(lastName);
      } else if (op === "Tj" || op === "TJ") {
        flush();
      } else if (op === "'" || op === '"') {
        flush();
        out.push("\n");
      } else if (op === "Td" || op === "TD") {
        // Operands are (tx, ty). A zero ty is kerning within the same line,
        // so emitting a newline there shreds words apart.
        const ty = numbers[numbers.length - 1];
        flush();
        out.push(ty !== undefined && ty !== 0 ? "\n" : " ");
      } else if (op === "T*" || op === "ET") {
        flush();
        out.push("\n");
      }
      numbers = [];
      continue;
    }

    i++;
  }

  flush();

  return out
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdfText(
  bytes: Uint8Array,
): Promise<PdfExtraction> {
  const raw = toLatin1(bytes);

  if (!raw.startsWith("%PDF-") && !raw.slice(0, 1024).includes("%PDF-")) {
    return { pages: [], reason: "unsupported" };
  }

  // Encrypted documents need the standard security handler to decrypt
  // streams; anything we extracted would be ciphertext.
  if (/\/Encrypt\s{1,8}\d{1,10}\s{1,8}\d{1,6}\s{1,8}R/.test(raw)) {
    return { pages: [], reason: "encrypted" };
  }

  const objects = parseObjects(raw);
  await expandObjectStreams(objects);

  // Page objects, in document order. `/Type /Page` must not match `/Pages`.
  const pageObjects = [...objects.values()].filter((o) =>
    /\/Type\s*\/Page(?![a-zA-Z])/.test(o.dict),
  );

  const pages: PdfPage[] = [];

  let totalText = 0;

  if (pageObjects.length > 0) {
    for (const [idx, pageObj] of pageObjects.entries()) {
      // Stop once the response would be unreasonably large rather than
      // building a multi-hundred-megabyte JSON body.
      if (totalText >= MAX_TOTAL_TEXT) break;

      const fonts = await pageFonts(pageObj.dict, objects);
      const parts: string[] = [];
      for (const ref of contentRefs(pageObj.dict)) {
        const target = objects.get(ref);
        if (!target) continue;
        const content = await decodeStream(target);
        if (content) parts.push(extractTextFromContent(content, fonts));
      }
      const text = parts.filter(Boolean).join("\n").trim();
      totalText += text.length;
      pages.push({ page: idx + 1, text });
    }
  } else {
    // No page tree found — likely a cross-reference/object stream PDF.
    // Fall back to every decodable content stream as a single page.
    const parts: string[] = [];
    for (const obj of objects.values()) {
      if (!obj.stream) continue;
      if (/\/Type\s*\/(XObject|Metadata|ObjStm|XRef|Font)/.test(obj.dict)) continue;
      const content = await decodeStream(obj);
      if (content && /(\bTj\b|\bTJ\b|\bBT\b)/.test(content)) {
        const text = extractTextFromContent(content, new Map());
        totalText += text.length;
        parts.push(text);
        if (totalText >= MAX_TOTAL_TEXT) break;
      }
    }
    const text = parts.filter(Boolean).join("\n").trim();
    if (text) pages.push({ page: 1, text });
  }

  const hasText = pages.some((p) => p.text.length > 0);
  if (!hasText) {
    return { pages: [], reason: "no-text" };
  }

  return { pages };
}
