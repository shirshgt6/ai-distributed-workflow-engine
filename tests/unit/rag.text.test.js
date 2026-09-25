import { cleanText, chunkText, cosineSimilarity } from "../../src/ai/rag/text.js";

describe("cleanText", () => {
  test("normalises unicode, strips control chars, collapses spaces, keeps paragraphs", () => {
    const raw = "Refund policy:\t  30 days\u0007.\r\n\n\n\nContact   support.";
    expect(cleanText(raw)).toBe("Refund policy: 30 days.\n\nContact support.");
  });
});

describe("chunkText (LangChain RecursiveCharacterTextSplitter)", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} talks about topic ${i % 3}.`).join(" ");

  test("respects chunkSize and overlaps neighbouring chunks", async () => {
    const chunks = await chunkText(text, { chunkSize: 200, chunkOverlap: 50 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    // Overlap: the start of each chunk repeats text from the end of the previous one.
    for (let i = 1; i < chunks.length; i++) {
      const head = chunks[i].slice(0, 15);
      expect(chunks[i - 1]).toContain(head);
    }
  });

  test("prefers paragraph boundaries", async () => {
    const chunks = await chunkText(`${"A".repeat(60)}\n\n${"B".repeat(60)}`, { chunkSize: 100, chunkOverlap: 0 });
    expect(chunks).toEqual(["A".repeat(60), "B".repeat(60)]);
  });
});

describe("cosineSimilarity", () => {
  test("same direction = 1, orthogonal = 0, opposite = -1, length doesn't matter", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });
  test("dimension mismatch is an error; zero vector gives 0", () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
