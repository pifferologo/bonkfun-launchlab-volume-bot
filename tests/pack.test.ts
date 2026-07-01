import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatTime,
  groupIntoPhrases,
  renderPackedMarkdown,
} from "../src/lib/pack.js";
import type { ScribeWord } from "../src/types/index.js";

describe("pack", () => {
  it("formats timestamps with fixed width", () => {
    expect(formatTime(2.5)).toBe("002.50");
    expect(formatTime(123.456)).toBe("123.46");
  });

  it("formats duration in seconds and minutes", () => {
    expect(formatDuration(43)).toBe("43.0s");
    expect(formatDuration(90)).toBe("1m 30.0s");
  });

  it("groups words into phrases on silence gaps", () => {
    const words: ScribeWord[] = [
      { type: "word", text: "Hello", start: 0, end: 0.4, speaker_id: "speaker_0" },
      { type: "spacing", start: 0.4, end: 1.2 },
      { type: "word", text: "world", start: 1.2, end: 1.6, speaker_id: "speaker_0" },
    ];

    const phrases = groupIntoPhrases(words, 0.5);
    expect(phrases).toHaveLength(2);
    expect(phrases[0]?.text).toBe("Hello");
    expect(phrases[1]?.text).toBe("world");
  });

  it("breaks phrases on speaker change", () => {
    const words: ScribeWord[] = [
      { type: "word", text: "One", start: 0, end: 0.3, speaker_id: "speaker_0" },
      { type: "word", text: "Two", start: 0.35, end: 0.6, speaker_id: "speaker_1" },
    ];

    const phrases = groupIntoPhrases(words, 0.5);
    expect(phrases).toHaveLength(2);
    expect(phrases[0]?.speaker_id).toBe("speaker_0");
    expect(phrases[1]?.speaker_id).toBe("speaker_1");
  });

  it("renders markdown with phrase headers", () => {
    const markdown = renderPackedMarkdown(
      [
        {
          name: "C0103",
          duration: 5,
          phrases: [{ start: 2.52, end: 5.36, text: "Ninety percent wasted.", speaker_id: "speaker_0" }],
        },
      ],
      0.5,
    );

    expect(markdown).toContain("# Packed transcripts");
    expect(markdown).toContain("## C0103");
    expect(markdown).toContain("S0 Ninety percent wasted.");
  });
});
