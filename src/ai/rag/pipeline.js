import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { cleanText, chunkText } from "./text.js";
import { generateStructured } from "../structured.js";
import { wrapUntrusted } from "../prompts/safety.js";
import { ConflictError, NotFoundError, ValidationError } from "../../utils/errors.js";

const DUPLICATE_KEY = 11000;
const EMBED_BATCH = 16;

export const RAG_PROMPT_VERSION = "rag-answer.v2";
export const NO_ANSWER = "I don't have enough information in the knowledge base to answer that.";

/**
 * RAG PIPELINE: ingestion (document -> chunks -> vectors) and
 * question answering (question -> retrieval -> grounded, cited answer).
 *
 * @param {{ provider, vectorStore, models: { embedding: string }, KnowledgeDocument, KnowledgeChunk, logger,
 *           chunkSize?: number, chunkOverlap?: number, topK?: number, minScore?: number }} deps
 */
export function createRagPipeline({
  provider,
  vectorStore,
  models,
  KnowledgeDocument,
  KnowledgeChunk,
  logger,
  chunkSize = 800,
  chunkOverlap = 100,
  topK = 4,
  minScore = 0.3,
}) {
  async function embedAll(texts, signal) {
    const vectors = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const { vectors: batch } = await provider.embed({ model: models.embedding, input: texts.slice(i, i + EMBED_BATCH), signal });
      vectors.push(...batch);
    }
    return vectors;
  }

  /** Top-K chunks for a question, restricted to one owner's documents. */
  async function retrieve({ ownerId, query, signal, k = topK }) {
    const [vector] = (await provider.embed({ model: models.embedding, input: [query], signal })).vectors;
    const hits = await vectorStore.search(models.embedding, vector, { ownerId, topK: k, minScore });
    return hits.map((h) => ({
      pointId: String(h.id),
      score: Number(h.score.toFixed(4)),
      documentId: h.payload.documentId,
      title: h.payload.title,
      chunkIndex: h.payload.chunkIndex,
      text: h.payload.text,
    }));
  }

  return {
    retrieve,

    /**
     * INGEST: extract -> clean -> dedupe -> chunk -> embed -> store.
     * The Document is PROCESSING until every chunk is in BOTH MongoDB and
     * Qdrant; on failure it becomes FAILED and its vectors are removed, so a
     * half-ingested document is never searchable.
     */
    async ingest({ ownerId, title, content, mimeType = "text/plain" }) {
      const text = cleanText(content);
      if (text.length < 20) throw new ValidationError("Document has too little text after cleaning");
      const contentHash = createHash("sha256").update(text).digest("hex");

      let doc;
      try {
        doc = await KnowledgeDocument.create({ ownerId, title, mimeType, contentHash, embeddingModel: models.embedding });
      } catch (err) {
        if (err?.code === DUPLICATE_KEY) {
          throw new ConflictError("This document was already uploaded", { code: "DUPLICATE_DOCUMENT" });
        }
        throw err;
      }

      let dims = null;
      try {
        const pieces = await chunkText(text, { chunkSize, chunkOverlap });
        const vectors = await embedAll(pieces);
        dims = vectors[0].length;
        const chunks = pieces.map((piece, index) => ({
          documentId: doc._id,
          ownerId,
          index,
          text: piece,
          pointId: randomUUID(),
          embeddingModel: models.embedding,
        }));
        await KnowledgeChunk.insertMany(chunks);
        await vectorStore.upsert(
          models.embedding,
          chunks.map((c, i) => ({
            id: c.pointId,
            vector: vectors[i],
            payload: { ownerId: String(ownerId), documentId: String(doc._id), chunkIndex: c.index, title, text: c.text },
          }))
        );
        doc.status = "READY";
        doc.chunkCount = chunks.length;
        doc.vectorDims = dims;
        await doc.save();
        logger.info({ documentId: String(doc._id), chunks: chunks.length }, "document ingested");
        return doc;
      } catch (err) {
        await KnowledgeChunk.deleteMany({ documentId: doc._id }).catch(() => {});
        if (dims) await vectorStore.deleteByDocument(models.embedding, dims, doc._id).catch(() => {});
        doc.status = "FAILED";
        doc.error = err.message.slice(0, 500);
        await doc.save();
        throw err;
      }
    },

    async deleteDocument({ ownerScopeFilter, documentId }) {
      const doc = await KnowledgeDocument.findOne({ _id: documentId, ...ownerScopeFilter });
      if (!doc) throw new NotFoundError("Document not found");
      if (doc.vectorDims) await vectorStore.deleteByDocument(doc.embeddingModel, doc.vectorDims, doc._id);
      await KnowledgeChunk.deleteMany({ documentId: doc._id });
      await doc.deleteOne();
    },

    /**
     * ANSWER: retrieve -> build numbered context -> LLM -> validated answer
     * whose citations may ONLY be ids that were actually retrieved.
     *
     * Grounding / hallucination controls:
     *   - nothing retrieved above minScore -> fixed "not enough information"
     *     answer, and the LLM is not called at all
     *   - the prompt says: use only the sources, cite them, admit when unsure
     *   - citations are validated against a dynamic enum of retrieved ids,
     *     so a made-up source ("S9") fails validation and triggers a repair
     *
     * @returns {Promise<{ answer, citations: object[], grounded: boolean, retrieved: number, usage, model, promptVersion }>}
     */
    async answer({ ownerId, question, model, signal }) {
      const hits = await retrieve({ ownerId, query: question, signal });
      if (hits.length === 0) {
        return { answer: NO_ANSWER, citations: [], grounded: false, retrieved: 0, usage: { inputTokens: 0, outputTokens: 0 }, model: null, promptVersion: RAG_PROMPT_VERSION };
      }

      const ids = hits.map((_, i) => `S${i + 1}`);
      const context = hits.map((h, i) => `[${ids[i]}] ${h.title} (chunk ${h.chunkIndex})\n${h.text}`).join("\n\n");
      const schema = z.object({
        answer: z.string().min(1).max(3000),
        citations: z.array(z.enum(ids)).max(ids.length), // only real, retrieved sources
        grounded: z.boolean(), // false = the sources didn't contain the answer
      });

      const r = await generateStructured({
        provider,
        model,
        schema,
        // v2: state the POSITIVE case first. v1 only said when grounded is
        // false, and qwen2.5:0.5b copied `false` even for a correct, cited answer.
        system:
          "Answer the question using ONLY the numbered sources in <document>. " +
          'When a source contains the answer: write the answer, set grounded to true, and list the source ids you used in citations (e.g. ["S1"]). ' +
          `Only if NO source contains the answer: set grounded to false, citations to [], and answer exactly: "${NO_ANSWER}"`,
        user: `${wrapUntrusted("document", context)}\n\nQuestion:\n${wrapUntrusted("user_input", question)}`,
        signal,
      });

      const cited = [...new Set(r.data.citations)].map((id) => {
        const h = hits[ids.indexOf(id)];
        return { id, documentId: h.documentId, title: h.title, chunkIndex: h.chunkIndex, score: h.score };
      });
      const grounded = r.data.grounded && cited.length > 0;
      return {
        answer: grounded ? r.data.answer : NO_ANSWER,
        citations: grounded ? cited : [],
        grounded,
        retrieved: hits.length,
        usage: r.usage,
        model,
        promptVersion: RAG_PROMPT_VERSION,
      };
    },
  };
}
