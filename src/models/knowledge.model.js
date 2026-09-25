import mongoose from "mongoose";

const { Schema } = mongoose;

// A source document uploaded for RAG. MongoDB keeps the metadata and chunk
// TEXT (the source of truth, re-embeddable); Qdrant keeps the VECTORS for
// similarity search. The two are linked by KnowledgeChunk.pointId.
const documentSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    mimeType: { type: String, enum: ["text/plain", "text/markdown"], default: "text/plain" },
    contentHash: { type: String, required: true }, // SHA-256 of the cleaned text: dedupe re-uploads
    status: { type: String, enum: ["PROCESSING", "READY", "FAILED"], default: "PROCESSING" },
    chunkCount: { type: Number, default: 0 },
    embeddingModel: String,
    vectorDims: { type: Number, default: null }, // which Qdrant collection holds its vectors
    error: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_d, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);
documentSchema.index({ ownerId: 1, contentHash: 1 }, { unique: true });
documentSchema.index({ ownerId: 1, createdAt: -1 });

const chunkSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: "KnowledgeDocument", required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  index: { type: Number, required: true }, // position within the document
  text: { type: String, required: true },
  pointId: { type: String, required: true }, // Qdrant point id (UUID)
  embeddingModel: { type: String, required: true }, // re-embed needed when this changes
});
chunkSchema.index({ documentId: 1, index: 1 }, { unique: true });

export const KnowledgeDocument = mongoose.model("KnowledgeDocument", documentSchema);
export const KnowledgeChunk = mongoose.model("KnowledgeChunk", chunkSchema);
