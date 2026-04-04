require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const path = require('path');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 5000;

// Enhanced Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development
}));
app.use(compression()); // Compress responses
app.use(cors({
  origin: ['http://localhost:5173', 'https://ai-agent-ui-fawn.vercel.app'],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS']
  // No need for allowedHeaders if not sending custom headers
}));
app.use(express.json({ limit: '10mb' }));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Cache responses
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// --- 1. AI Setup with Caching ---
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ GEMINI_API_KEY not found in .env");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

// Response cache for frequent queries
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- 2. Google Sheets Setup ---
const keyFilePath = path.resolve(__dirname, './serviceAccountKey.json');
let sheets = null;
let isSheetsReady = false;

try {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth });
  isSheetsReady = true;
  console.log('✅ Google Sheets auth loaded');
} catch (err) {
  console.warn('⚠️ Google Sheets not configured:', err.message);
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const RANGE = 'Leads!A:E'; // Updated range with better sheet name

// --- 3. Enhanced Tools ---
const tools = [
  {
    functionDeclarations: [
      {
        name: "get_current_time",
        description: "Get the current date and time for a specific location.",
        parameters: {
          type: "OBJECT",
          properties: {
            location: { type: "STRING", description: "City name or timezone" },
            format: { type: "STRING", description: "Time format (short/long)", enum: ["short", "long"] }
          },
          required: ["location"],
        },
      },
      {
        name: "save_lead_to_sheet",
        description: "Save a potential customer lead to Google Sheets. Use when user shares name, phone, or interest.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Customer name" },
            phone: { type: "STRING", description: "Customer phone number" },
            email: { type: "STRING", description: "Customer email (optional)" },
            message: { type: "STRING", description: "Customer query or message" },
            interest: { type: "STRING", description: "Product/service interest category" }
          },
          required: ["name", "phone", "message"],
        },
      },
      {
        name: "calculate",
        description: "Perform mathematical calculations",
        parameters: {
          type: "OBJECT",
          properties: {
            expression: { type: "STRING", description: "Mathematical expression to evaluate" }
          },
          required: ["expression"]
        }
      }
    ],
  },
];

const model = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview", // free model
  tools: tools,
  generationConfig: {
    temperature: 0.7,
    topK: 1,
    topP: 0.8,
    maxOutputTokens: 500,
  }
});

// --- 4. Chat Session Management ---
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Cleanup old sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccessed > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// --- 5. Enhanced Health & Wake Endpoints ---
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running!', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    sessions: sessions.size,
    memory: process.memoryUsage(),
    sheetsReady: isSheetsReady
  });
});

app.get('/api/wake', (req, res) => {
  console.log('🔔 Wake-up signal received at', new Date().toISOString());
  res.json({ 
    status: 'waking', 
    message: 'Server is ready!',
    timestamp: new Date().toISOString()
  });
});

// --- 6. Session Management Endpoint ---
app.post('/api/session/init', (req, res) => {
  const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  sessions.set(sessionId, {
    history: [
      {
        role: "user",
        parts: [{ text: "Main Rajkumar hu. Hinglish me baat karna. Agar lead mile toh save_lead_to_sheet tool use karna." }],
      },
      {
        role: "model",
        parts: [{ text: "Samajh gaya Rajkumar! Main leads save karunga." }],
      }
    ],
    lastAccessed: Date.now()
  });
  
  res.json({ sessionId, message: "Session initialized" });
});

// --- 7. Main Chat Endpoint with Performance Optimizations ---
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    // Get or create session
    let session = sessionId ? sessions.get(sessionId) : null;
    if (!session) {
      session = {
        history: [
          {
            role: "user",
            parts: [{ text: "Main Rajkumar hu. Hinglish me baat karna. Agar lead mile toh save_lead_to_sheet tool use karna." }],
          },
          {
            role: "model",
            parts: [{ text: "Samajh gaya Rajkumar! Main leads save karunga." }],
          }
        ],
        lastAccessed: Date.now()
      };
      if (sessionId) sessions.set(sessionId, session);
    } else {
      session.lastAccessed = Date.now();
    }

    // Check cache for identical query in this session
    const cacheKey = `${sessionId || 'default'}:${message}`;
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse && (Date.now() - cachedResponse.timestamp < CACHE_TTL)) {
      session.history.push({ role: "user", parts: [{ text: message }] });
      session.history.push({ role: "model", parts: [{ text: cachedResponse.reply }] });
      return res.json({ 
        reply: cachedResponse.reply, 
        sessionId: sessionId || Date.now().toString(),
        cached: true,
        responseTime: Date.now() - startTime
      });
    }

    // User message add to history
    session.history.push({ role: "user", parts: [{ text: message }] });

    const chat = model.startChat({ history: session.history });
    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      let toolResponseText = "";

      // Tool 1: Get Current Time (Optimized)
      if (call.name === "get_current_time") {
        const now = new Date();
        const location = call.args.location || 'India';
        const format = call.args.format || 'long';
        
        const options = format === 'short' 
          ? { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }
          : { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
        
        toolResponseText = `⏰ ${location} mein samay: ${now.toLocaleString('en-IN', options)}`;
      } 
      // Tool 2: Save Lead to Google Sheets (Enhanced)
      else if (call.name === "save_lead_to_sheet" && isSheetsReady) {
        try {
          const { name, phone, email = 'Not provided', message: userMsg, interest = 'General' } = call.args;
          const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

          // Append to sheet asynchronously (don't await to improve response time)
          sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[timestamp, name, phone, email, userMsg, interest]],
            },
          }).catch(err => console.error("Background sheet save error:", err));

          toolResponseText = `✅ Lead save ho gayi! Dhanyavaad ${name} ji. Hum jald hi aapko contact karenge.`;
          console.log("✅ Lead saved:", { name, phone, email, interest });
        } catch (error) {
          console.error("❌ Sheet Error:", error.message);
          toolResponseText = "❌ Lead save karne mein error aaya. Kripya baad mein try karein.";
        }
      } 
      // Tool 3: Calculator
      else if (call.name === "calculate") {
        try {
          const result = eval(call.args.expression);
          toolResponseText = `🧮 Result: ${result}`;
        } catch (e) {
          toolResponseText = "❌ Invalid expression";
        }
      }
      else if (call.name === "save_lead_to_sheet" && !isSheetsReady) {
        toolResponseText = "⚠️ Google Sheets setup pending hai. Developer ko batayein.";
      }

      // Send tool response back to AI for final answer
      const finalResult = await chat.sendMessage([
        {
          functionResponse: {
            name: call.name,
            response: { result: toolResponseText },
          },
        },
      ]);

      const finalText = finalResult.response.text();
      session.history.push({ role: "model", parts: [{ text: finalText }] });
      
      // Cache the response
      responseCache.set(cacheKey, { reply: finalText, timestamp: Date.now() });
      
      return res.json({ 
        reply: finalText, 
        sessionId: sessionId || Date.now().toString(),
        toolUsed: call.name,
        responseTime: Date.now() - startTime
      });

    } else {
      // Normal conversation
      const text = response.text();
      session.history.push({ role: "model", parts: [{ text: text }] });
      
      // Cache the response
      responseCache.set(cacheKey, { reply: text, timestamp: Date.now() });
      
      return res.json({ 
        reply: text, 
        sessionId: sessionId || Date.now().toString(),
        responseTime: Date.now() - startTime
      });
    }

  } catch (error) {
    console.error("❌ Chat Error:", error.message);
    res.status(500).json({ 
      error: "Server error: " + error.message,
      responseTime: Date.now() - startTime
    });
  }
});

// --- 8. Batch operations for leads (Admin) ---
app.get('/api/leads/recent', async (req, res) => {
  if (!isSheetsReady) {
    return res.status(503).json({ error: "Sheets not configured" });
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Leads!A:F',
    });

    const rows = response.data.values || [];
    const leads = rows.slice(1).map(row => ({
      timestamp: row[0],
      name: row[1],
      phone: row[2],
      email: row[3],
      message: row[4],
      interest: row[5]
    })).slice(-20).reverse(); // Last 20 leads, newest first

    res.json({ leads });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- 9. Server Start with Optimizations ---
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/api/health`);
  console.log(`🔗 Wake: http://localhost:${PORT}/api/wake`);
  console.log(`🔗 Chat: http://localhost:${PORT}/api/chat`);
  console.log(`🔗 Sessions: ${sessions.size}`);
});



// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const bodyParser = require('body-parser');
// const { GoogleGenerativeAI } = require("@google/generative-ai");
// const { google } = require('googleapis');
// const path = require('path');
// const { z } = require('zod');

// const app = express();
// const PORT = process.env.PORT || 5000;

// // Middleware
// app.use(cors({
//   origin: process.env.FRONTEND_URL || 'http://localhost:5173',
//   credentials: true
// }));
// app.use(bodyParser.json({ limit: '10mb' }));
// app.use(bodyParser.urlencoded({ extended: true }));

// // Response caching
// const responseCache = new Map();
// const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// // Validation schemas using Zod
// const MessageSchema = z.object({
//   message: z.string().min(1, "Message required"),
//   sessionId: z.string().optional()
// });

// const LeadSchema = z.object({
//   name: z.string().min(1),
//   phone: z.string().min(10),
//   email: z.string().email().optional(),
//   message: z.string().min(1),
//   interest: z.string().optional()
// });

// // --- 1. AI Setup ---
// const apiKey = process.env.GEMINI_API_KEY;
// if (!apiKey) {
//   console.error("❌ GEMINI_API_KEY not found in .env");
//   process.exit(1);
// }
// const genAI = new GoogleGenerativeAI(apiKey);

// // --- 2. Google Sheets Setup ---
// const keyFilePath = path.resolve(__dirname, './serviceAccountKey.json');
// let sheets = null;
// let isSheetsReady = false;

// try {
//   const auth = new google.auth.GoogleAuth({
//     keyFile: keyFilePath,
//     scopes: ['https://www.googleapis.com/auth/spreadsheets'],
//   });
//   sheets = google.sheets({ version: 'v4', auth });
//   isSheetsReady = true;
//   console.log('✅ Google Sheets auth loaded');
// } catch (err) {
//   console.warn('⚠️ Google Sheets not configured:', err.message);
// }

// const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID || 'YAHAN_APNI_SHEET_ID_PASTE_KARO';
// const RANGE = 'Sheet1!A:F';

// // --- 3. Enhanced Tools ---
// const tools = [
//   {
//     functionDeclarations: [
//       {
//         name: "get_current_time",
//         description: "Get the current date and time for a specific location.",
//         parameters: {
//           type: "OBJECT",
//           properties: {
//             location: { type: "STRING", description: "City name" },
//             format: { type: "STRING", description: "Time format (short/long)", enum: ["short", "long"] }
//           },
//           required: ["location"],
//         },
//       },
//       {
//         name: "save_lead_to_sheet",
//         description: "Save a potential customer lead to Google Sheets. Use when user shares name, phone, or interest.",
//         parameters: {
//           type: "OBJECT",
//           properties: {
//             name: { type: "STRING", description: "Customer name" },
//             phone: { type: "STRING", description: "Customer phone number" },
//             email: { type: "STRING", description: "Customer email (optional)" },
//             message: { type: "STRING", description: "Customer query or message" },
//             interest: { type: "STRING", description: "Product/service interest category" }
//           },
//           required: ["name", "phone", "message"],
//         },
//       },
//       {
//         name: "calculate",
//         description: "Perform mathematical calculations",
//         parameters: {
//           type: "OBJECT",
//           properties: {
//             expression: { type: "STRING", description: "Mathematical expression to evaluate" }
//           },
//           required: ["expression"]
//         }
//       }
//     ],
//   },
// ];

// const model = genAI.getGenerativeModel({
//   model: "gemini-3-flash-preview",
//   tools: tools,
//   generationConfig: {
//     temperature: 0.7,
//     topK: 1,
//     topP: 0.8,
//     maxOutputTokens: 500,
//   }
// });

// // --- 4. Session Management ---
// const sessions = new Map();
// const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// // Cleanup old sessions
// setInterval(() => {
//   const now = Date.now();
//   for (const [sessionId, session] of sessions.entries()) {
//     if (now - session.lastAccessed > SESSION_TIMEOUT) {
//       sessions.delete(sessionId);
//     }
//   }
// }, 5 * 60 * 1000);

// // --- 5. Health & Wake Endpoints ---
// app.get('/api/health', (req, res) => {
//   res.json({ 
//     status: 'ok', 
//     message: 'Server is awake!', 
//     timestamp: new Date().toISOString(),
//     uptime: process.uptime(),
//     sessions: sessions.size,
//     memory: process.memoryUsage(),
//     sheetsReady: isSheetsReady
//   });
// });

// app.get('/api/wake', (req, res) => {
//   console.log('🔔 Wake-up signal received at', new Date().toISOString());
//   res.json({ 
//     status: 'waking', 
//     message: 'Server is ready!',
//     timestamp: new Date().toISOString()
//   });
// });

// // --- 6. Session Init ---
// app.post('/api/session/init', (req, res) => {
//   const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
//   sessions.set(sessionId, {
//     history: [
//       {
//         role: "user",
//         parts: [{ text: "Main Rajkumar hu. Hinglish me baat karna. Agar lead mile toh save_lead_to_sheet tool use karna." }],
//       },
//       {
//         role: "model",
//         parts: [{ text: "Samajh gaya Rajkumar! Main leads save karunga." }],
//       }
//     ],
//     lastAccessed: Date.now()
//   });
  
//   res.json({ sessionId, message: "Session initialized" });
// });

// // --- 7. Main Chat Endpoint ---
// app.post('/api/chat', async (req, res) => {
//   const startTime = Date.now();
  
//   try {
//     // Validate input
//     const { message, sessionId } = MessageSchema.parse(req.body);

//     // Get or create session
//     let session = sessionId ? sessions.get(sessionId) : null;
//     if (!session) {
//       session = {
//         history: [
//           {
//             role: "user",
//             parts: [{ text: "Main Rajkumar hu. Hinglish me baat karna. Agar lead mile toh save_lead_to_sheet tool use karna." }],
//           },
//           {
//             role: "model",
//             parts: [{ text: "Samajh gaya Rajkumar! Main leads save karunga." }],
//           }
//         ],
//         lastAccessed: Date.now()
//       };
//       if (sessionId) sessions.set(sessionId, session);
//     } else {
//       session.lastAccessed = Date.now();
//     }

//     // Check cache
//     const cacheKey = `${sessionId || 'default'}:${message}`;
//     const cachedResponse = responseCache.get(cacheKey);
//     if (cachedResponse && (Date.now() - cachedResponse.timestamp < CACHE_TTL)) {
//       session.history.push({ role: "user", parts: [{ text: message }] });
//       session.history.push({ role: "model", parts: [{ text: cachedResponse.reply }] });
//       return res.json({ 
//         reply: cachedResponse.reply, 
//         sessionId: sessionId || Date.now().toString(),
//         cached: true,
//         responseTime: Date.now() - startTime
//       });
//     }

//     // Add user message to history
//     session.history.push({ role: "user", parts: [{ text: message }] });

//     const chat = model.startChat({ history: session.history });
//     const result = await chat.sendMessage(message);
//     const response = await result.response;
//     const functionCalls = response.functionCalls();

//     if (functionCalls && functionCalls.length > 0) {
//       const call = functionCalls[0];
//       let toolResponseText = "";

//       // Tool 1: Get Current Time
//       if (call.name === "get_current_time") {
//         const now = new Date();
//         const location = call.args.location || 'India';
//         const format = call.args.format || 'long';
        
//         const options = format === 'short' 
//           ? { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }
//           : { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
        
//         toolResponseText = `⏰ ${location} mein samay: ${now.toLocaleString('en-IN', options)}`;
//       } 
//       // Tool 2: Save Lead to Google Sheets
//       else if (call.name === "save_lead_to_sheet" && isSheetsReady) {
//         try {
//           // Validate lead data
//           const leadData = LeadSchema.parse(call.args);
//           const { name, phone, email = 'Not provided', message: userMsg, interest = 'General' } = leadData;
//           const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

//           // Append to sheet
//           await sheets.spreadsheets.values.append({
//             spreadsheetId: SPREADSHEET_ID,
//             range: RANGE,
//             valueInputOption: "USER_ENTERED",
//             requestBody: {
//               values: [[timestamp, name, phone, email, userMsg, interest]],
//             },
//           });

//           toolResponseText = `✅ Lead save ho gayi! Dhanyavaad ${name} ji. Hum jald hi aapko contact karenge.`;
//           console.log("✅ Lead saved:", { name, phone, email, interest });
//         } catch (error) {
//           console.error("❌ Sheet Error:", error.message);
//           toolResponseText = "❌ Lead save karne mein error aaya. Kripya baad mein try karein.";
//         }
//       } 
//       // Tool 3: Calculator
//       else if (call.name === "calculate") {
//         try {
//           // Safe evaluation
//           const result = Function('"use strict";return (' + call.args.expression + ')')();
//           toolResponseText = `🧮 Result: ${result}`;
//         } catch (e) {
//           toolResponseText = "❌ Invalid expression";
//         }
//       }
//       else if (call.name === "save_lead_to_sheet" && !isSheetsReady) {
//         toolResponseText = "⚠️ Google Sheets setup pending hai. Developer ko batayein.";
//       }

//       // Send tool response back to AI
//       const finalResult = await chat.sendMessage([
//         {
//           functionResponse: {
//             name: call.name,
//             response: { result: toolResponseText },
//           },
//         },
//       ]);

//       const finalText = finalResult.response.text();
//       session.history.push({ role: "model", parts: [{ text: finalText }] });
      
//       // Cache response
//       responseCache.set(cacheKey, { reply: finalText, timestamp: Date.now() });
      
//       return res.json({ 
//         reply: finalText, 
//         sessionId: sessionId || Date.now().toString(),
//         toolUsed: call.name,
//         responseTime: Date.now() - startTime
//       });

//     } else {
//       // Normal conversation
//       const text = response.text();
//       session.history.push({ role: "model", parts: [{ text: text }] });
      
//       responseCache.set(cacheKey, { reply: text, timestamp: Date.now() });
      
//       return res.json({ 
//         reply: text, 
//         sessionId: sessionId || Date.now().toString(),
//         responseTime: Date.now() - startTime
//       });
//     }

//   } catch (error) {
//     if (error.name === 'ZodError') {
//       return res.status(400).json({ error: error.errors[0].message });
//     }
//     console.error("❌ Chat Error:", error.message);
//     res.status(500).json({ 
//       error: "Server error: " + error.message,
//       responseTime: Date.now() - startTime
//     });
//   }
// });

// // --- 8. Get Recent Leads (Admin) ---
// app.get('/api/leads/recent', async (req, res) => {
//   if (!isSheetsReady) {
//     return res.status(503).json({ error: "Sheets not configured" });
//   }

//   try {
//     const response = await sheets.spreadsheets.values.get({
//       spreadsheetId: SPREADSHEET_ID,
//       range: 'Sheet1!A:F',
//     });

//     const rows = response.data.values || [];
//     const leads = rows.slice(1).map(row => ({
//       timestamp: row[0],
//       name: row[1],
//       phone: row[2],
//       email: row[3] || 'Not provided',
//       message: row[4],
//       interest: row[5] || 'General'
//     })).slice(-20).reverse();

//     res.json({ leads });
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });

// // --- 9. Server Start ---
// app.listen(PORT, () => {
//   console.log(`✅ Server running on port ${PORT}`);
//   console.log(`🔗 Health: http://localhost:${PORT}/api/health`);
//   console.log(`🔗 Wake: http://localhost:${PORT}/api/wake`);
//   console.log(`🔗 Chat: http://localhost:${PORT}/api/chat`);
//   console.log(`🔗 Sessions: ${sessions.size}`);
// });