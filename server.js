import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Response caching
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Environment variables for wake functionality
const WAKE_TOKEN = process.env.WAKE_TOKEN || 'your-secret-token-here';
const SELF_URL = process.env.SELF_URL || 'http://localhost:5000';

// --- 1. OpenRouter Setup ---
if (!process.env.OPENROUTER_API_KEY) {
  console.error('❌ ERROR: OPENROUTER_API_KEY is not set in .env file!');
  process.exit(1);
}

// Initialize OpenRouter
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': process.env.APP_URL || 'http://localhost:5000',
    'X-Title': process.env.APP_NAME || 'AI Chatbot',
  }
});

const modelName = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
console.log('✅ OpenRouter initialized successfully');
console.log('📦 Using model:', modelName);

// --- 2. Validation Schemas using Zod ---
const MessageSchema = z.object({
  message: z.string().min(1, "Message required"),
  sessionId: z.string().optional()
});

const LeadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(10),
  email: z.string().email().optional(),
  message: z.string().min(1),
  interest: z.string().optional()
});

// --- 3. Google Sheets Setup ---
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
const RANGE = 'Sheet1!A:F';

// --- 4. Tool Definitions for Function Calling ---
const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date and time for a specific location.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
          format: { type: "string", description: "Time format (short/long)", enum: ["short", "long"] }
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_lead_to_sheet",
      description: "Save a potential customer lead to Google Sheets. Use when user shares name, phone, or interest.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Customer name" },
          phone: { type: "string", description: "Customer phone number" },
          email: { type: "string", description: "Customer email (optional)" },
          message: { type: "string", description: "Customer query or message" },
          interest: { type: "string", description: "Product/service interest category" }
        },
        required: ["name", "phone", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Perform mathematical calculations",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Mathematical expression to evaluate" }
        },
        required: ["expression"]
      },
    },
  },
];

// --- 5. Session Management ---
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Track last activity for keep-alive
let lastActivityTime = Date.now();

// Cleanup old sessions
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccessed > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

// Update last activity on any request
app.use((req, res, next) => {
  lastActivityTime = Date.now();
  next();
});

// --- 6. Health & Wake Endpoints ---
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is awake!', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    sessions: sessions.size,
    memory: process.memoryUsage(),
    sheetsReady: isSheetsReady,
    model: modelName,
    lastActivity: new Date(lastActivityTime).toISOString()
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

// Keep-alive endpoint (called by frontend periodically)
app.post('/api/keep-alive', (req, res) => {
  console.log('❤️ Keep-alive received at', new Date().toISOString());
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString() 
  });
});

// Wake-up trigger with token verification (secure endpoint)
app.get('/api/trigger-wake', (req, res) => {
  const { token } = req.query;
  
  // Simple token verification to prevent abuse
  if (token !== WAKE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log('🚀 Wake trigger received at', new Date().toISOString());
  
  res.json({ 
    status: 'waking', 
    message: 'Server wake sequence initiated',
    timestamp: new Date().toISOString()
  });
});

// --- 7. Session Init ---
app.post('/api/session/init', (req, res) => {
  try {
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    sessions.set(sessionId, {
      messages: [
        {
          role: "system",
          content: "Main Rajkumar hu. Hinglish me baat karna. Agar lead mile toh save_lead_to_sheet tool use karna."
        }
      ],
      lastAccessed: Date.now()
    });
    
    res.json({ sessionId, message: "Session initialized" });
  } catch (error) {
    console.error("Session init error:", error);
    res.status(500).json({ error: "Failed to initialize session" });
  }
});

// --- 8. Tool Handlers ---
async function handleToolCall(toolCall) {
  const { name, arguments: args } = toolCall.function;
  const parsedArgs = JSON.parse(args);
  
  switch (name) {
    case "get_current_time": {
      const now = new Date();
      const location = parsedArgs.location || 'India';
      const format = parsedArgs.format || 'long';
      
      const options = format === 'short' 
        ? { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }
        : { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
      
      return `⏰ ${location} mein samay: ${now.toLocaleString('en-IN', options)}`;
    }
    
    case "save_lead_to_sheet": {
      if (!isSheetsReady) {
        return "⚠️ Google Sheets setup pending hai. Developer ko batayein.";
      }
      
      try {
        const leadData = LeadSchema.parse(parsedArgs);
        const { name, phone, email = 'Not provided', message: userMsg, interest = 'General' } = leadData;
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: RANGE,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[timestamp, name, phone, email, userMsg, interest]],
          },
        });

        console.log("✅ Lead saved:", { name, phone, email, interest });
        return `✅ Lead save ho gayi! Dhanyavaad ${name} ji. Hum jald hi aapko contact karenge.`;
      } catch (error) {
        console.error("❌ Sheet Error:", error.message);
        return "❌ Lead save karne mein error aaya. Kripya baad mein try karein.";
      }
    }
    
    case "calculate": {
      try {
        // Safe evaluation
        const result = Function('"use strict";return (' + parsedArgs.expression + ')')();
        return `🧮 Result: ${result}`;
      } catch (e) {
        return "❌ Invalid expression";
      }
    }
    
    default:
      return `Unknown tool: ${name}`;
  }
}

// --- 9. Main Chat Endpoint with OpenRouter ---
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  const MAX_RETRIES = 3;
  
  try {
    // Validate input
    const { message, sessionId } = MessageSchema.parse(req.body);

    // Get or create session
    let session = sessionId ? sessions.get(sessionId) : null;
    if (!session) {
      session = {
        messages: [
          {
            role: "system",
            content: "Main Rajkumar hu. Hinglish me baat karna. Agar lead mile toh save_lead_to_sheet tool use karna."
          }
        ],
        lastAccessed: Date.now()
      };
      if (sessionId) sessions.set(sessionId, session);
    } else {
      session.lastAccessed = Date.now();
    }

    // Check cache
    const cacheKey = `${sessionId || 'default'}:${message}`;
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse && (Date.now() - cachedResponse.timestamp < CACHE_TTL)) {
      session.messages.push({ role: "user", content: message });
      session.messages.push({ role: "assistant", content: cachedResponse.reply });
      return res.json({ 
        reply: cachedResponse.reply, 
        sessionId: sessionId || Date.now().toString(),
        cached: true,
        responseTime: Date.now() - startTime
      });
    }

    // Add user message to history
    session.messages.push({ role: "user", content: message });

    // Keep only last 20 messages to manage context window
    const conversationHistory = session.messages.slice(-20);

    // Implement retry logic with exponential backoff
    let completion;
    let retryCount = 0;
    let lastError;

    while (retryCount < MAX_RETRIES) {
      try {
        completion = await openai.chat.completions.create({
          model: modelName,
          messages: conversationHistory,
          tools: tools,
          tool_choice: "auto",
          max_tokens: 1000,
          temperature: 0.7
        });
        break; // Success - exit retry loop
      } catch (error) {
        lastError = error;
        
        // Check if it's a rate limit or overload error
        if (error.status === 429 || error.status === 503 || error.message?.includes('overloaded')) {
          retryCount++;
          
          if (retryCount < MAX_RETRIES) {
            const waitTime = Math.pow(2, retryCount) * 1000;
            console.log(`⚠️ API overloaded. Retry ${retryCount}/${MAX_RETRIES} after ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        } else {
          throw error;
        }
      }
    }

    if (retryCount >= MAX_RETRIES) {
      throw new Error(`API unavailable after ${MAX_RETRIES} retries: ${lastError.message}`);
    }

    const responseMessage = completion.choices[0].message;
    
    // Check if there are tool calls
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      // Handle each tool call
      const toolResponses = [];
      
      for (const toolCall of responseMessage.tool_calls) {
        const toolResult = await handleToolCall(toolCall);
        toolResponses.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }

      // Add assistant message with tool calls to history
      session.messages.push(responseMessage);
      
      // Add tool responses to history
      session.messages.push(...toolResponses);

      // Get final response from AI with tool results
      const finalCompletion = await openai.chat.completions.create({
        model: modelName,
        messages: [...session.messages.slice(-20)],
        max_tokens: 1000,
        temperature: 0.7
      });

      const finalText = finalCompletion.choices[0].message.content;
      session.messages.push({ role: "assistant", content: finalText });

      // Cache response
      responseCache.set(cacheKey, { reply: finalText, timestamp: Date.now() });

      return res.json({ 
        reply: finalText, 
        sessionId: sessionId || Date.now().toString(),
        toolUsed: responseMessage.tool_calls[0].function.name,
        responseTime: Date.now() - startTime
      });

    } else {
      // Normal conversation (no tool calls)
      const text = responseMessage.content;
      session.messages.push({ role: "assistant", content: text });
      
      // Cache response
      responseCache.set(cacheKey, { reply: text, timestamp: Date.now() });
      
      return res.json({ 
        reply: text, 
        sessionId: sessionId || Date.now().toString(),
        responseTime: Date.now() - startTime
      });
    }

  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors[0].message });
    }
    
    // Handle specific OpenRouter errors
    if (error.status === 429) {
      return res.status(429).json({ 
        error: "Rate limit exceeded. Please try again in a moment.",
        retryAfter: 5
      });
    }
    
    if (error.status === 401) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    
    if (error.status === 402) {
      return res.status(402).json({ error: "Out of credits. Please add funds to your OpenRouter account." });
    }
    
    if (error.status === 404) {
      return res.status(404).json({ error: `Model ${modelName} not found or not available` });
    }
    
    console.error("❌ Chat Error:", error.message);
    res.status(500).json({ 
      error: "Server error: " + error.message,
      responseTime: Date.now() - startTime
    });
  }
});

// --- 10. Get Recent Leads (Admin) ---
app.get('/api/leads/recent', async (req, res) => {
  if (!isSheetsReady) {
    return res.status(503).json({ error: "Sheets not configured" });
  }

  if (!SPREADSHEET_ID) {
    return res.status(503).json({ error: "Google Sheet ID not configured" });
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:F',
    });

    const rows = response.data.values || [];
    
    if (rows.length === 0) {
      return res.json({ leads: [] });
    }

    const leads = rows.slice(1).map(row => ({
      timestamp: row[0] || new Date().toISOString(),
      name: row[1] || 'Unknown',
      phone: row[2] || 'Not provided',
      email: row[3] || 'Not provided',
      message: row[4] || 'No message',
      interest: row[5] || 'General'
    })).slice(-20).reverse();

    res.json({ leads });
  } catch (error) {
    console.error("❌ Failed to fetch leads:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- 11. Test Endpoint ---
app.get('/api/test', (req, res) => {
  res.json({ 
    success: true,
    message: 'Server is working!',
    timestamp: new Date().toISOString()
  });
});

// --- 12. Root Route ---
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'AI Chatbot API Server with OpenRouter',
    version: '1.0.0',
    model: modelName,
    endpoints: {
      chat: 'POST /api/chat',
      health: 'GET /api/health',
      wake: 'GET /api/wake',
      keepAlive: 'POST /api/keep-alive',
      triggerWake: 'GET /api/trigger-wake?token=YOUR_TOKEN',
      test: 'GET /api/test',
      session: 'POST /api/session/init',
      leads: 'GET /api/leads/recent'
    }
  });
});

// --- 13. 404 Handler ---
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    availableRoutes: [
      'GET /',
      'GET /api/health',
      'GET /api/wake',
      'POST /api/keep-alive',
      'GET /api/trigger-wake?token=YOUR_TOKEN',
      'GET /api/test',
      'POST /api/session/init',
      'POST /api/chat',
      'GET /api/leads/recent'
    ]
  });
});

// --- 14. Error handling middleware ---
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.stack);
  res.status(500).json({ 
    error: "Something went wrong!",
    message: err.message 
  });
});

// --- 15. Server Start ---
const server = app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('');
  console.log('📍 Available endpoints:');
  console.log(`   GET   http://localhost:${PORT}/`);
  console.log(`   GET   http://localhost:${PORT}/api/health`);
  console.log(`   GET   http://localhost:${PORT}/api/wake`);
  console.log(`   POST  http://localhost:${PORT}/api/keep-alive`);
  console.log(`   GET   http://localhost:${PORT}/api/trigger-wake?token=YOUR_TOKEN`);
  console.log(`   GET   http://localhost:${PORT}/api/test`);
  console.log(`   POST  http://localhost:${PORT}/api/session/init`);
  console.log(`   POST  http://localhost:${PORT}/api/chat`);
  console.log(`   GET   http://localhost:${PORT}/api/leads/recent`);
  console.log('');
  console.log(`📦 Model: ${modelName}`);
  console.log(`📊 Active Sessions: ${sessions.size}`);
  console.log(`📝 Sheets Ready: ${isSheetsReady ? '✅' : '❌'}`);
  console.log(`🔋 Wake Token: ${WAKE_TOKEN.substring(0, 5)}...`);
  console.log('='.repeat(60));
});

// --- 16. Graceful Shutdown ---
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// --- 17. Self-ping mechanism (optional, for keeping alive) ---
// This will ping itself every 14 minutes to prevent sleep
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes

setInterval(async () => {
  try {
    // Only ping if there's been no activity in the last 5 minutes
    if (Date.now() - lastActivityTime > 5 * 60 * 1000) {
      console.log('🔄 Self-ping to keep server alive...');
      
      // Ping the health endpoint
      const response = await fetch(`http://localhost:${PORT}/api/health`);
      if (response.ok) {
        console.log('✅ Self-ping successful');
      }
    }
  } catch (error) {
    console.log('⚠️ Self-ping failed (server might be sleeping):', error.message);
  }
}, PING_INTERVAL);

export default app;