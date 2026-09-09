import { describe, expect, it } from "vitest";
import { detectFormat, parseTranscript } from "../src/lib/transcript";

// Shaped after a real Zoom export: WEBVTT header, numeric ids, voice spans,
// and a sentence split across cues on timing rather than grammar.
const ZOOM_VTT = `WEBVTT

1
00:00:04.120 --> 00:00:07.880
<v Alice>we agreed to ship the redesign

2
00:00:07.900 --> 00:00:09.400
<v Alice>before the audit

3
00:00:09.500 --> 00:00:12.000
<v Bob>that works for me
`;

const SRT = `1
00:00:04,120 --> 00:00:07,880
Alice: we agreed to ship the redesign

2
00:00:09,500 --> 00:00:12,000
Bob: that works for me
`;

describe("detecting the format from content", () => {
  it("recognises WebVTT by its magic token", () => {
    expect(detectFormat(ZOOM_VTT)).toBe("webvtt");
  });

  it("distinguishes SRT by its comma millisecond separator", () => {
    // The only structural difference between the two once the header is gone.
    expect(detectFormat(SRT)).toBe("srt");
  });

  it("treats ordinary prose as plain text", () => {
    expect(detectFormat("Alice: we agreed to ship the redesign.")).toBe("plain");
  });

  it("does not mistake a bare number in prose for a cue", () => {
    expect(detectFormat("We reviewed the numbers.\n\n42\n\nThat was it.")).toBe(
      "plain",
    );
  });
});

describe("parsing subtitle transcripts", () => {
  it("keeps speaker attribution, which is the point", () => {
    const out = parseTranscript(ZOOM_VTT);
    expect(out.format).toBe("webvtt");
    expect(out.speakers).toEqual(["Alice", "Bob"]);
  });

  it("merges consecutive cues from one speaker into a whole sentence", () => {
    // Notetakers split on timing, not grammar. Preserving cue boundaries
    // leaves half-sentences that match no search phrase.
    const out = parseTranscript(ZOOM_VTT);
    expect(out.text).toBe(
      "Alice: we agreed to ship the redesign before the audit\nBob: that works for me",
    );
  });

  it("reads inline speaker labels in SRT", () => {
    const out = parseTranscript(SRT);
    expect(out.format).toBe("srt");
    expect(out.speakers).toEqual(["Alice", "Bob"]);
    expect(out.text).toBe(
      "Alice: we agreed to ship the redesign\nBob: that works for me",
    );
  });

  it("counts the cues it consumed", () => {
    expect(parseTranscript(ZOOM_VTT).cues).toBe(3);
  });

  it("discards WebVTT authoring metadata", () => {
    // NOTE/STYLE blocks are not speech; indexing them pollutes search with
    // text nobody in the meeting said.
    const vtt = `WEBVTT

NOTE this file was generated automatically

STYLE
::cue { color: peachpuff; }

1
00:00:01.000 --> 00:00:02.000
<v Alice>hello
`;
    const out = parseTranscript(vtt);
    expect(out.text).toBe("Alice: hello");
    expect(out.text).not.toContain("generated automatically");
    expect(out.text).not.toContain("peachpuff");
  });

  it("strips cue markup without eating the words", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
<v Alice><b>ship</b> it <i>now</i>
`;
    expect(parseTranscript(vtt).text).toBe("Alice: ship it now");
  });

  it("handles voice spans with classes and closing tags", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
<v.loud Alice>ship it</v>
`;
    expect(parseTranscript(vtt).text).toBe("Alice: ship it");
  });

  it("keeps unattributed subtitles rather than dropping them", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
the room agreed to proceed
`;
    const out = parseTranscript(vtt);
    expect(out.text).toBe("the room agreed to proceed");
    expect(out.speakers).toEqual([]);
  });

  it("accepts hour-less timestamps", () => {
    const srt = `1
00:04,120 --> 00:07,880
Alice: short form timing
`;
    expect(parseTranscript(srt).text).toBe("Alice: short form timing");
  });
});

describe("refusing to invent structure", () => {
  it("passes plain text through untouched", () => {
    // The endpoint accepted plain text before importers existed. Breaking
    // that would be worse than failing to parse an exotic file.
    const raw = "Alice: we agreed to ship. Bob: sounds good.";
    const out = parseTranscript(raw);
    expect(out.text).toBe(raw);
    expect(out.format).toBe("plain");
    expect(out.cues).toBe(0);
  });

  it("does not treat a sentence-leading word before a colon as a speaker", () => {
    // "Note:" and "Update:" are not people. Inventing a participant corrupts
    // the record; missing one merely loses attribution.
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
https://example.com/spec is the reference
`;
    const out = parseTranscript(vtt);
    expect(out.speakers).toEqual([]);
    expect(out.text).toContain("https://example.com/spec");
  });

  it("does not accept a whole sentence as a speaker name", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
one thing we should all remember here is: ship early
`;
    // Too many words to be a name, so it stays part of the utterance.
    expect(parseTranscript(vtt).speakers).toEqual([]);
  });

  it("falls back to the raw body when a subtitle file yields nothing", () => {
    // More likely misdetected than genuinely empty, and storing a blank
    // meeting would silently lose the caller's data.
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
<v Alice></v>
`;
    const out = parseTranscript(vtt);
    expect(out.format).toBe("plain");
    expect(out.text).toContain("WEBVTT");
  });

  it("ignores a declared format the body contradicts", () => {
    // `source` is caller-supplied and often wrong; trusting it over the
    // bytes would mangle the transcript.
    const out = parseTranscript("just some prose about the meeting", "webvtt");
    expect(out.format).toBe("plain");
    expect(out.text).toBe("just some prose about the meeting");
  });

  it("survives CRLF line endings", () => {
    const out = parseTranscript(ZOOM_VTT.replace(/\n/g, "\r\n"));
    expect(out.speakers).toEqual(["Alice", "Bob"]);
  });
});
