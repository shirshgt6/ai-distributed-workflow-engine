import { createVectorStore } from "./vectorStore.js";
import { createRagPipeline } from "./pipeline.js";
import { KnowledgeDocument, KnowledgeChunk } from "../../models/knowledge.model.js";

/** Build the RAG pipeline from config (used by the API and by workers). */
export function createRagFromConfig({ config, provider, logger }) {
  const vectorStore = createVectorStore({ url: config.rag.qdrantUrl });
  const rag = createRagPipeline({
    provider,
    vectorStore,
    models: config.llm.models,
    KnowledgeDocument,
    KnowledgeChunk,
    logger,
    chunkSize: config.rag.chunkSize,
    chunkOverlap: config.rag.chunkOverlap,
    topK: config.rag.topK,
    minScore: config.rag.minScore,
  });
  return { rag, vectorStore };
}
