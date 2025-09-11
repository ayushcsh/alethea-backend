import { Worker } from "bullmq";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

dotenv.config();

async function handler(job) {
  try {
    console.log("Received job:", job.data);
    const data = typeof job.data === "string" ? JSON.parse(job.data) : job.data;

    // ----- 1. Make sure we actually have the PDF -----
    // If you're sending a URL from the backend, download it to a temp file.
    const pdfPath = data.path.startsWith("http")
      ? await downloadFile(data.path)
      : data.path;

    const loader = new PDFLoader(pdfPath);
    const docs = await loader.load();
    console.log(`Loaded ${docs.length} doc chunks`);

    // ----- 2. Generate embeddings -----
    const embeddings = new GoogleGenerativeAIEmbeddings({
      modelName: "embedding-001",
      apiKey: process.env.API_KEY,
    });

    const vectorStore = await QdrantVectorStore.fromDocuments(docs, embeddings, {
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
      collectionName: "langchainjs-testing",
    });

    console.log("All docs stored in Qdrant");
  } catch (err) {
    // catch rate-limit or network errors so the worker doesn’t crash
    console.error("Worker error:", err);
    throw err; // let BullMQ mark job as failed/retry if you want
  }
}

const worker = new Worker("file-upload-queue", handler, {
  concurrency: 2, // safer start value
  connection: {
    url: process.env.REDIS_URL,
  },
});

// Helper to download a PDF if backend sends a URL
async function downloadFile(fileUrl) {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to download: ${fileUrl}`);
  const buf = await res.arrayBuffer();
  const temp = path.join("/tmp", `job-${Date.now()}.pdf`);
  await fs.writeFile(temp, Buffer.from(buf));
  return temp;
}
