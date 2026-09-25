import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

/**
 * CLEANING: make text consistent before chunking and hashing.
 *  - NFKC normalisation (fancy quotes/ligatures/full-width chars -> plain)
 *  - drop control characters (except newlines/tabs)
 *  - collapse runs of spaces/tabs; keep paragraph breaks (the splitter uses them)
 */
export function cleanText(raw) {
  return String(raw)
    .normalize("NFKC")
    .replace(/[^\S\n]+/g, " ") // collapse horizontal whitespace (spaces, tabs, \r, nbsp)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") // eslint-disable-line no-control-regex
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * CHUNKING with LangChain's RecursiveCharacterTextSplitter (the one place
 * LangChain.js is used, see docs/ai-architecture.md): it tries to split on
 * paragraphs, then lines, then sentences/words, so chunks end at natural
 * boundaries instead of mid-word.
 *
 * chunkSize: small enough that a retrieved chunk is about ONE thing (precise
 *   retrieval, less irrelevant context sent to the LLM), large enough to be
 *   self-contained. ~800 chars is a common starting point; tune with evals.
 * chunkOverlap: repeat the tail of one chunk at the head of the next, so a
 *   fact straddling a boundary is still whole in at least one chunk.
 *
 * @returns {Promise<string[]>}
 */
export async function chunkText(text, { chunkSize = 800, chunkOverlap = 100 } = {}) {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  return splitter.splitText(text);
}

/**
 * COSINE SIMILARITY: cos θ = (a·b) / (|a||b|), in [-1, 1].
 * Measures the ANGLE between two vectors (direction = meaning), ignoring
 * length. Qdrant computes this for us at scale; this reference version is
 * used in tests and is the classic interview exercise.
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error("vectors must have the same dimension");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
