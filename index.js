import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
// Using dynamic import to avoid test file issues
let PdfParse;
(async () => {
  const pdfModule = await import('pdf-parse/lib/pdf-parse.js');
  PdfParse = pdfModule.default || pdfModule;
})();
import path from 'path';
import { Queue } from "bullmq";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { json } from 'stream/consumers';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

// extract the pdf for the sake of summarization

async function extractPdfText(pdfPath) {
  console.log('🔍 Starting PDF text extraction...');
  try {
    // Ensure PdfParse is loaded
    if (!PdfParse) {
      console.log('📦 Loading pdf-parse module...');
      const pdfModule = await import('pdf-parse/lib/pdf-parse.js');
      PdfParse = pdfModule.default || pdfModule;
    }
    
    console.log(`📄 Reading PDF file from: ${pdfPath}`);
    
    // Check if file exists
    if (!fs.existsSync(pdfPath)) {
      console.error(`❌ File does not exist at path: ${pdfPath}`);
      throw new Error(`PDF file not found at: ${pdfPath}`);
    }
    
    // Check file stats
    const stats = fs.statSync(pdfPath);
    console.log(`📊 File stats - Size: ${(stats.size / 1024).toFixed(2)} KB, Modified: ${stats.mtime}`);
    
    const buffer = fs.readFileSync(pdfPath);
    console.log(`📊 Read ${(buffer.length / 1024).toFixed(2)} KB of data`);
    
    console.log('🔍 Parsing PDF content...');
    const data = await PdfParse(buffer);
    
    if (!data || !data.text) {
      console.error('❌ No text content found in PDF');
      throw new Error('No text content found in PDF');
    }
    
    console.log(`✅ Successfully extracted ${data.text.length} characters from PDF`);
    return data.text;
  } catch (error) {
    console.error('❌ Error in extractPdfText:', error);
    throw error; // Re-throw to be caught by the route handler
  }
}



const genAI = new GoogleGenerativeAI(process.env.API_KEY);

const queue = new Queue("file-upload-queue", {
  connection: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
  }
});

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Created uploads directory');
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, `${uniqueSuffix}-${file.originalname}`)
  }
})


const upload = multer({ storage: storage })
const app = express();
app.use(cors());

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), {
  setHeaders: (res, path) => {
    // Set proper headers for PDF files
    if (path.endsWith('.pdf')) {
      res.setHeader('Content-Type', 'application/pdf');
    }
  }
}));


app.post('/upload/pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  // add to the queue
  await queue.add('file-ready', JSON.stringify({
    filename: req.file.filename,
    source: req.file.destination,
    path: req.file.path,
  }))

  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  console.log('File uploaded:', req.file);
  return res.json({
    message: 'File uploaded successfully',
    filename: req.file.filename,
    redirectUrl: '/chat',
    pdfurl: fileUrl
  });
});






// when user tap summary button
app.get('/summary', async (req, res) => {
  console.log('Summary endpoint hit');
  try {
    const {file} = req.query;
    console.log('Requested file:', file);
    
    if(!file) {
      console.error('No file specified in query');
      return res.status(400).json({ error: 'No file specified' });
    }
    
    const pdfPath = path.join(process.cwd(), 'uploads', file);
    console.log('Looking for PDF at path:', pdfPath);

    if (!fs.existsSync(pdfPath)) {
      console.error('PDF not found at path:', pdfPath);
      return res.status(404).json({ error: 'PDF not found' });
    }

    console.log('Extracting text from PDF...');
    const pdftext = await extractPdfText(pdfPath);
    
    if (!pdftext || pdftext.trim().length === 0) {
      console.error('Extracted text is empty');
      return res.status(500).json({ error: 'Failed to extract text from PDF' });
    }
    
    console.log('Text extracted successfully. Length:', pdftext.length);
    
    const prompt = `
      Summarize the following PDF content clearly and concisely in depth:
      ${pdftext}`; // Show first 1000 chars for logging
      
    console.log('Sending request to Gemini API...');
    
    try {
      const model = genAI.getGenerativeModel({model: "gemini-1.5-flash"});
      console.log('Model initialized, generating content...');
      
      const result = await model.generateContent(prompt);
      console.log('Received response from Gemini API');
      
      if (!result || !result.response) {
        console.error('Invalid response from Gemini API:', result);
        throw new Error('Invalid response from Gemini API');
      }
      
      const response = result.response;
      console.log('Processing response...');
      
      const summary = await response.text();
      console.log('Generated summary length:', summary?.length || 0);

      if (!summary) {
        console.error('Empty summary generated');
        throw new Error('Failed to generate summary: Empty response');
      }

      console.log('Sending summary to client');
      return res.json({
        status: 'success',
        summary: summary
      });
      
    } catch (apiError) {
      console.error('Gemini API error:', apiError);
      throw apiError;
    }
    
  } catch (err) {
    console.error('Summarization error:', err);
    res.status(500).json({ 
      error: 'Failed to summarize PDF',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
})

// q&a flashcards generation endpoint

app.get('/flashcards', async (req, res) => {
  console.log('Flashcards endpoint hit');
  try {
    const { file } = req.query;
    console.log('Requested file:', file);

    if (!file) {
      console.error('No file specified in query');
      return res.status(400).json({ error: 'No file specified' });
    }

    const pdfPath = path.join(process.cwd(), 'uploads', file);
    console.log('Looking for PDF at path:', pdfPath);

    if (!fs.existsSync(pdfPath)) {
      console.error('PDF not found at path:', pdfPath);
      return res.status(404).json({ error: 'PDF not found' });
    }

    console.log('Extracting text from PDF...');
    const pdftext = await extractPdfText(pdfPath);

    if (!pdftext || pdftext.trim().length === 0) {
      console.error('Extracted text is empty');
      return res.status(500).json({ error: 'Failed to extract text from PDF' });
    }

    console.log('Text extracted successfully. Length:', pdftext.length);

    // Prompt for flashcards
   const prompt = `
You are a flashcard generator.

TASK:
From the given text, create exactly 10 flashcards.

FORMAT:
Return ONLY valid JSON. Do not include explanations, notes, or markdown formatting.
The JSON must be an array of objects with "question" and "answer".

Example:
[
  { "question": "What is photosynthesis?", "answer": "The process by which plants make food using sunlight." },
  { "question": "Who discovered gravity?", "answer": "Sir Isaac Newton" }
]

CONTENT:
${pdftext}
`;


    console.log('Sending request to Gemini API for flashcards...');

    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent(prompt);
      console.log('Received response from Gemini API');

      if (!result || !result.response) {
        console.error('Invalid response from Gemini API:', result);
        throw new Error('Invalid response from Gemini API');
      }

      const response = await result.response;
      const textResponse = response.text();
      
      // Clean up the response to ensure it's valid JSON
      let jsonString = textResponse.trim();
      
      // Remove markdown code block markers if present
      if (jsonString.startsWith('```json')) {
        jsonString = jsonString.slice(7); // Remove ```json
      }
      if (jsonString.endsWith('```')) {
        jsonString = jsonString.slice(0, -3); // Remove ```
      }
      
      let flashcards;
      try {
        flashcards = JSON.parse(jsonString);
      } catch (e) {
        console.warn('Failed to parse JSON, wrapping in array as fallback');
        console.warn('Response that failed to parse:', jsonString);
        flashcards = [{ question: "Error parsing flashcards", answer: "The response format was invalid. Please try again." }];
      }

      console.log('Sending flashcards to client');
      return res.json({
        status: 'success',
        flashcards: flashcards
      });

    } catch (apiError) {
      console.error('Gemini API error:', apiError);
      throw apiError;
    }

  } catch (err) {
    console.error('Flashcards generation error:', err);
    res.status(500).json({
      error: 'Failed to generate flashcards',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});



app.get('/chat', async (req, res) => {
  const query = req.query.message;
  const embeddings = new GoogleGenerativeAIEmbeddings({
    modelName: "embedding-001",
    apiKey: process.env.API_KEY,
  });
  const vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
    collectionName: "langchainjs-testing",
  });

  const retr = vectorStore.asRetriever({
    k: 2,
  })
  const result = await retr.invoke(query);

  const SYSTEM_PROMPT = `You are an intelligent AI assistant that helps users by answering questions  based on the content of the uploaded PDF documents or other relevant information.  
Always provide clear, concise, and accurate answers referencing only the information contained in the PDFs.  
If the answer is not found in the documents, politely say that the information is not available in the uploaded content.  
Avoid making up answers or providing unrelated information.  
Respond in a friendly and helpful tone.
context:${JSON.stringify(result)}
`;

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = `${SYSTEM_PROMPT}\n\nUser question: ${query}`;
  const chatresult = await model.generateContent(prompt);
  const response = chatresult.response;

  return res.json({
    status: 'success',
    message: response.text(),
    docs: result,

  });


})

const DEFAULT_PORT = Number(process.env.PORT) || 8000;

function startServer(startPort) {
  const portToUse = Number(startPort);
  const server = app.listen(portToUse, () => {
    console.log(`Server is running on port ${portToUse}`);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const nextPort = portToUse + 1;
      console.warn(`Port ${portToUse} in use, retrying on ${nextPort}...`);
      startServer(nextPort);
    } else {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  });
}

startServer(DEFAULT_PORT);