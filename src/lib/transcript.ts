/**
 * Transcript importers.
 *
 * `/meetings/import` accepted a single plaintext string, and `source` was only
 * a free-form label — a caller with an existing corpus had to write a parser
 * before they could spend anything. That put the work upstream of the paywall,
 * which is the wrong side: the friction lands before any value is delivered.
 *
 * WebVTT and SRT cover the overwhelming majority of real exports (Zoom, Teams
 * and Meet all emit WebVTT). Vendor-specific JSON formats are deliberately not
 * handled here — they are proprietary, they change without notice, and no
 * caller has asked for one.
 *
 * The point is not merely to strip timestamps. Speaker attribution is what
 * makes a search result useful: "Alice said we'd ship before the audit" is
 * worth paying for in a way that an anonymous line of text is not.
 */

export type TranscriptFormat = "webvtt" | "srt" | "plain";

export interface ParsedTranscript {
  /** Speaker-attributed plain text, one line per contiguous turn. */
  text: string;
  /** Distinct speakers, in first-appearance order. Empty if unattributed. */
  speakers: string[];
  /** Number of cues consumed. Zero for plain text. */
  cues: number;
  format: TranscriptFormat;
}

/** `00:01:02.500 --> 00:01:04.000`, with `,` for SRT and `.` for WebVTT. */
const TIMING = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

/** WebVTT voice span: `<v Alice>text` or `<v.loud Alice>text</v>`. */
const VOICE = /^<v(?:\.[^\s>]+)*\s+([^>]*)>/;

/** Any remaining markup: WebVTT cue tags, or the HTML some tools emit. */
const TAGS = /<\/?[^>]+>/g;

/**
 * `Alice Smith: text` at the start of a cue.
 *
 * Bounded deliberately. An unanchored "anything before a colon" would treat
 * "Note: we agreed" or a bare URL as a speaker, inventing participants that
 * were never in the meeting. Requiring a short, colon-terminated prefix that
 * looks like a name is wrong less often, and failing to detect a speaker only
 * loses attribution -- inventing one corrupts the record.
 */
const INLINE_SPEAKER = /^([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*){0,3})\s*:\s+(?=\S)/u;

/**
 * Identifies the format from content, not from the caller's `source` label.
 *
 * The label is caller-supplied and frequently wrong -- an agent forwarding a
 * file it did not create has no reliable idea what is in it.
 */
export function detectFormat(raw: string): TranscriptFormat {
  const head = raw.slice(0, 4096);
  // The WEBVTT magic may follow a BOM, and must be the first token.
  if (/^\uFEFF?WEBVTT(\s|$)/.test(head)) return "webvtt";

  // Scan every line rather than testing the head as a whole: a headerless SRT
  // opens with its cue identifier, so an anchored test against the start of
  // the string sees a bare number and concludes prose.
  for (const line of head.split(/\r?\n/)) {
    if (!TIMING.test(line)) continue;
    // Both formats carry `-->`; the millisecond separator distinguishes them.
    return line.includes(",") ? "srt" : "webvtt";
  }
  return "plain";
}

function stripTags(line: string): string {
  return line.replace(TAGS, "").trim();
}

/**
 * Splits into cue blocks on blank lines, discarding WebVTT metadata.
 *
 * NOTE, STYLE and REGION blocks are authoring metadata. Indexing them would
 * pollute search results with text nobody in the meeting said.
 */
function cueBlocks(raw: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  return blocks.filter((b) => {
    const first = b[0] ?? "";
    if (/^\uFEFF?WEBVTT(\s|$)/.test(first)) return false;
    if (/^(NOTE|STYLE|REGION)\b/.test(first)) return false;
    return true;
  });
}

/**
 * Parses a subtitle transcript into speaker-attributed text.
 *
 * Plain text is returned untouched rather than being rejected: the endpoint
 * accepted plain text before this existed, and breaking that would be a far
 * worse outcome than failing to parse an exotic file.
 */
export function parseTranscript(
  raw: string,
  declared?: string,
): ParsedTranscript {
  const format =
    declared === "webvtt" || declared === "srt"
      ? // A declared subtitle format is still verified: if the body does not
        // look like one, trusting the label would mangle it.
        detectFormat(raw) === "plain"
        ? "plain"
        : (declared as TranscriptFormat)
      : detectFormat(raw);

  if (format === "plain") {
    return { text: raw.trim(), speakers: [], cues: 0, format: "plain" };
  }

  const speakers: string[] = [];
  const turns: { speaker: string | null; parts: string[] }[] = [];
  let cues = 0;

  for (const block of cueBlocks(raw)) {
    // Drop the optional numeric cue identifier and the timing line. What
    // remains is what someone actually said.
    let lines = block;
    if (/^\d+$/.test(lines[0] ?? "")) lines = lines.slice(1);
    const timingAt = lines.findIndex((l) => TIMING.test(l));
    if (timingAt === -1) continue;
    lines = lines.slice(timingAt + 1);
    if (lines.length === 0) continue;
    cues++;

    let speaker: string | null = null;
    const parts: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      const voice = line.match(VOICE);
      if (voice) {
        speaker ??= voice[1].trim();
        line = line.slice(voice[0].length);
      }

      line = stripTags(line);
      if (line === "") continue;

      // Only the first line of a cue can introduce a speaker; a colon later in
      // the cue is ordinary punctuation.
      if (speaker === null && i === 0) {
        const inline = line.match(INLINE_SPEAKER);
        if (inline) {
          speaker = inline[1].trim();
          line = line.slice(inline[0].length);
        }
      }

      if (line !== "") parts.push(line);
    }

    if (parts.length === 0) continue;
    if (speaker !== null && !speakers.includes(speaker)) speakers.push(speaker);

    /**
     * Merge consecutive cues from one speaker.
     *
     * Notetakers split a single sentence across cues on timing, not grammar,
     * so keeping cue boundaries would leave half-sentences that match no
     * search phrase and read as nonsense when returned as an excerpt.
     */
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) {
      last.parts.push(...parts);
    } else {
      turns.push({ speaker, parts });
    }
  }

  const text = turns
    .map((t) => {
      const said = t.parts.join(" ").replace(/\s+/g, " ").trim();
      return t.speaker ? `${t.speaker}: ${said}` : said;
    })
    .filter((l) => l !== "")
    .join("\n");

  // A subtitle file that yielded nothing is more likely misdetected than
  // genuinely empty, so fall back rather than storing a blank meeting.
  if (text === "") {
    return { text: raw.trim(), speakers: [], cues: 0, format: "plain" };
  }

  return { text, speakers, cues, format };
}
