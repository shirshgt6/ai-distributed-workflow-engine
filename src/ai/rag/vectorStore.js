import { QdrantClient } from "@qdrant/js-client-rest";

/**
 * VECTOR STORE on Qdrant.
 *
 * One collection per (embedding model, dimension): vectors from different
 * models live in different spaces and must never be compared. Changing the
 * embedding model therefore means a new collection + re-embedding (the chunk
 * text in MongoDB makes that possible).
 *
 * Every point carries a payload { ownerId, documentId, chunkIndex, title, text }.
 * `ownerId` is indexed and EVERY search filters on it: tenant isolation is
 * enforced inside the vector query, the same idea as ownerScope() for MongoDB.
 *
 * @param {{ url: string, prefix?: string }} options
 */
export function createVectorStore({ url, prefix = "knowledge" }) {
  const client = new QdrantClient({ url, checkCompatibility: false });
  const ready = new Map(); // collection name -> Promise (create once per process)

  const collectionName = (model, dims) => `${prefix}_${model.replace(/[^a-zA-Z0-9]+/g, "_")}_${dims}`;

  async function ensureCollection(name, dims) {
    if (!ready.has(name)) {
      ready.set(
        name,
        (async () => {
          const { exists } = await client.collectionExists(name);
          if (!exists) {
            try {
              await client.createCollection(name, { vectors: { size: dims, distance: "Cosine" } });
            } catch (err) {
              // Another process created it at the same moment: fine.
              if (!(await client.collectionExists(name)).exists) throw err;
            }
            await client.createPayloadIndex(name, { field_name: "ownerId", field_schema: "keyword", wait: true });
            await client.createPayloadIndex(name, { field_name: "documentId", field_schema: "keyword", wait: true });
          }
        })().catch((err) => {
          ready.delete(name);
          throw err;
        })
      );
    }
    await ready.get(name);
  }

  return {
    collectionName,

    /** @param {{ id: string, vector: number[], payload: object }[]} points */
    async upsert(model, points) {
      if (points.length === 0) return;
      const name = collectionName(model, points[0].vector.length);
      await ensureCollection(name, points[0].vector.length);
      await client.upsert(name, { wait: true, points });
    },

    /**
     * Nearest neighbours by cosine similarity, ONLY among the owner's points.
     * @returns {Promise<{ id: string, score: number, payload: object }[]>}
     */
    async search(model, vector, { ownerId, topK = 4, minScore = 0 }) {
      const name = collectionName(model, vector.length);
      await ensureCollection(name, vector.length);
      // Qdrant's Query API (client >= 1.10; the older `search` method is gone).
      const { points } = await client.query(name, {
        query: vector,
        limit: topK,
        score_threshold: minScore,
        with_payload: true,
        filter: { must: [{ key: "ownerId", match: { value: String(ownerId) } }] },
      });
      return points;
    },

    async deleteByDocument(model, dims, documentId) {
      const name = collectionName(model, dims);
      await ensureCollection(name, dims);
      await client.delete(name, { wait: true, filter: { must: [{ key: "documentId", match: { value: String(documentId) } }] } });
    },

    async deleteCollection(model, dims) {
      await client.deleteCollection(collectionName(model, dims)).catch(() => {});
      ready.delete(collectionName(model, dims));
    },

    async ping() {
      await client.getCollections();
    },
  };
}
