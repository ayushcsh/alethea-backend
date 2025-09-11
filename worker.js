import { Worker } from 'bullmq';
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import dotenv from "dotenv";
dotenv.config();


  const worker = new Worker(
    'file-upload-queue',
    async job => {
      console.log(`Job: ${JSON.stringify(job.data)}`);
      const data = JSON.parse(job.data)
      console.log("data:", data);

      // load the pdf 
      const loader = new PDFLoader(data.path);
      const docs = await loader.load();

      console.log("docs:", docs);
      
      // step 3 make vector of every chunk 
      const embeddings = new GoogleGenerativeAIEmbeddings({
        modelName: "embedding-001",
        apiKey: process.env.API_KEY,
      });

      // This call will create the vector store and add all documents with their embeddings
      const vectorStore = await QdrantVectorStore.fromDocuments(docs, embeddings, {
        url: process.env.QDRANT_URL,
        apiKey: process.env.QDRANT_API_KEY,
        collectionName: "langchainjs-testing",
      });

      // REMOVE THIS LINE: It's redundant and doubles your embedding calls
      // await vectorStore.addDocuments(docs); 
      
      console.log("all docs are stored in vector")

    },
    {
      concurrency: 100, // Be cautious with high concurrency and API quotas
      connection: {
        url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
      },
    }
  );