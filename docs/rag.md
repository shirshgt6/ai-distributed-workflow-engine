# RAG (Phases 17–19)

## Pipeline
```
INGEST  POST /documents {title, content, mimeType: text/plain | text/markdown}
  clean (NFKC, strip control chars, collapse spaces, keep paragraphs)
  → SHA-256 of the cleaned text (dedupe: same content twice → 409)
  → chunk (LangChain RecursiveCharacterTextSplitter, 800 chars, 100 overlap)
  → embed (provider.embed, batches of 16; nomic-embed-text = 768 dims)
  → MongoDB KnowledgeChunk (text = source of truth)  +  Qdrant point (vector + payload)
  → Document READY   (on any failure: FAILED, chunks and vectors removed → never half-searchable)

ANSWER  ai.rag task / rag.answer()
  embed question → Qdrant query (cosine, top-K=4, score ≥ RAG_MIN_SCORE, filter ownerId)
  → nothing? → fixed "not enough information" answer, NO LLM call
  → numbered context [S1]..[Sk] wrapped as <document> (untrusted data)
  → LLM via generateStructured: { answer, citations: enum(S1..Sk), grounded }
  → grounded requires ≥ 1 valid citation; otherwise the answer is replaced by "not enough information"
```

## Concepts, the way they're used here
- **Embedding:** text → a vector where direction encodes meaning. Related texts point in similar directions.
  Measured locally: cos("refund for my order", "refund policy") = 0.777 vs ("refund…", "weather") = 0.369.
- **Cosine similarity:** `a·b / (|a||b|)`, the angle between vectors, ignoring length. Reference implementation in `src/ai/rag/text.js`.
- **Chunk size and overlap:** a small chunk means precise retrieval and less noise; a large chunk means more self-contained
  context. The overlap keeps facts that straddle a boundary whole. 800/100 are *starting values*, not tuned by an evaluation.
- **Top-K and threshold:** K bounds prompt size and cost. The threshold drops weak matches (an off-topic question retrieved 0
  chunks at 0.5 with nomic embeddings).
- **Metadata filtering:** `ownerId` is a payload index, and every query filters on it **inside Qdrant**, so a user can
  never retrieve another user's chunks (tested).
- **Hallucination and grounding:** answer only from retrieved sources, require citations, validate citations against the ids
  actually retrieved (a made-up `S9` fails the schema and triggers a repair), and refuse when there's no evidence.
- **One collection per (embedding model, dimension):** vectors from different models aren't comparable. Changing the model
  means re-embedding, which is possible because the chunk text lives in MongoDB.

## Where LangChain.js is used (Phase 19), and where it deliberately isn't
| Used | Why |
|---|---|
| `RecursiveCharacterTextSplitter` (`@langchain/textsplitters`) | A well-tested boundary-aware splitter (paragraph → line → sentence → word). There's no value in rewriting it |

| Not used | Why |
|---|---|
| LangChain chat models / chains | Our provider interface is ~100 lines over `fetch`, with our own error classification and timeouts. A chain would hide the retry/repair behaviour we need to reason about |
| LangChain vector store wrapper | We need exact control of the ownerId filter, the collection per model, and cleanup on failure. The Qdrant client is direct and small |
| LangChain agents | The agent (Phase 20) must be bounded and auditable (allowlist, max steps, permission checks). A hand-written loop makes every stop condition explicit |

Rule of thumb: use a library for well-defined utilities; keep control-flow that has safety or correctness implications in your own code.

## Verified behaviour
- **Tests** (real Qdrant + MongoDB, mock embeddings): ingestion into both stores, dedupe, failure cleanup, relevance ranking,
  **tenant isolation**, delete removes vectors, cited answers, hallucinated-citation repair, no-evidence answers without an
  LLM call, "sources don't contain it" → refusal, and `ai.rag` as a workflow task scoped to the run owner.
- **Real models** (`npm run test:llm`): retrieval of the right chunk with score 0.87, and an off-topic question retrieved 0
  chunks. **Honest limitation:** with a 3-paragraph chunk, qwen2.5:0.5b wrote the correct answer ("18 days") but returned
  `grounded: false` with no citation, so the system refused to answer (by design: no citation, no answer). With a single-paragraph
  context the same model answered and cited correctly. The prompt was revised to state the positive case first (`rag-answer.v2`)
  after the original prompt caused `grounded: false` even for cited answers. A larger model would be needed for reliable
  grounded answers. **No accuracy numbers are claimed.**

## Not implemented
PDF/DOCX extraction (text and markdown only), re-ranking, hybrid (keyword + vector) search, async ingestion through the
queue (ingestion is synchronous in the request, fine for documents ≤ 200 KB), and an evaluation set.
