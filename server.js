/**
 * 🤖 AI Chatbot Backend - Rajkumar's AI Agent
 * Features: OpenRouter + Qwen Model + Google Sheets + Language Preference + Wake System
 * Author: Rajkumar Chourasiya
 * Language: Hinglish comments for easy understanding 😊
 */

import 'dotenv/config';  // ✅ Sabse pehle .env load karein
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

// __dirname fix for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// ===========================================
// 🛡️ Middleware Setup
// ===========================================
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logger (debugging ke liye useful)
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// ===========================================
// 🗄️ Response Caching (5 minutes TTL)
// ===========================================
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ===========================================
// 🔐 Security Variables
// ===========================================
const WAKE_TOKEN = process.env.WAKE_TOKEN || 'change-me-in-env';
const SELF_URL = process.env.SELF_URL || 'http://localhost:5000';

// ===========================================
// 🤖 OpenRouter Setup (Qwen Model)
// ===========================================
if (!process.env.OPENROUTER_API_KEY) {
  console.error('❌ CRITICAL: OPENROUTER_API_KEY not set in .env!');
  console.error('💡 Solution: Add your key from https://openrouter.ai/keys');
  process.exit(1);
}

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': process.env.APP_URL || 'http://localhost:5000',
    'X-Title': process.env.APP_NAME || 'Rajkumar AI Chatbot',
  }
});

const modelName = process.env.OPENROUTER_MODEL || 'qwen/qwen-2.5-72b-instruct';
console.log('✅ OpenRouter initialized');
console.log(`📦 Using model: ${modelName}`);

// ===========================================
// 📝 Validation Schemas (Zod)
// ===========================================
const MessageSchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
  sessionId: z.string().optional(),
  preferredLanguage: z.enum(['eng', 'hin', 'hin-eng']).optional().default('hin-eng')
});

const LeadSchema = z.object({
  name: z.string().min(1, "Name required"),
  phone: z.string().min(10, "Valid phone required"),
  email: z.string().email().optional(),
  message: z.string().min(1, "Message required"),
  interest: z.string().optional()
});

// ===========================================
// 📊 Google Sheets Setup (Optional)
// ===========================================
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
  console.warn('⚠️ Google Sheets not configured (optional feature)');
  console.warn('💡 To enable: Setup service account from Google Cloud Console');
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const RANGE = 'Sheet1!A:F';

// ===========================================
// 🛠️ Tool Definitions for Function Calling
// ===========================================
const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get current date/time for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name, e.g., 'Indore'" },
          format: { type: "string", enum: ["short", "long"], default: "long" }
        },
        required: ["location"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_lead_to_sheet",
      description: "Save customer lead to Google Sheets. Use when user shares contact info.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Customer name" },
          phone: { type: "string", description: "Phone number" },
          email: { type: "string", description: "Email (optional)" },
          message: { type: "string", description: "Customer query" },
          interest: { type: "string", description: "Product interest" }
        },
        required: ["name", "phone", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Perform math calculations",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Math expression, e.g., '2+2'" }
        },
        required: ["expression"]
      }
    }
  }
];

// ===========================================
// 👥 Session Management
// ===========================================
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
let lastActivityTime = Date.now();

// Cleanup old sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccessed > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
      console.log(`🧹 Cleaned up session: ${sessionId}`);
    }
  }
}, 5 * 60 * 1000);

// Update last activity on any request
app.use((req, res, next) => {
  lastActivityTime = Date.now();
  next();
});

// ===========================================
// 🏥 Health & Wake Endpoints
// ===========================================

// Health check - frontend uses this to detect server status
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is awake! 🚀',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: sessions.size,
    memoryUsage: process.memoryUsage(),
    sheetsReady: isSheetsReady,
    model: modelName,
    lastActivity: new Date(lastActivityTime).toISOString()
  });
});

// Simple wake endpoint (no auth - for Render auto-wake)
app.get('/api/wake', (req, res) => {
  console.log('🔔 Wake signal received');
  res.json({
    status: 'waking',
    message: 'Server is ready!',
    timestamp: new Date().toISOString()
  });
});

// Keep-alive endpoint (called by frontend every 10 mins)
app.post('/api/keep-alive', (req, res) => {
  console.log('❤️ Keep-alive received');
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString()
  });
});

// Secure wake trigger (with token verification)
app.get('/api/trigger-wake', (req, res) => {
  const { token } = req.query;
  
  if (token !== WAKE_TOKEN) {
    console.warn('🔐 Unauthorized wake attempt from:', req.ip);
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
  
  console.log('🚀 Authorized wake trigger received');
  res.json({
    status: 'waking',
    message: 'Server wake sequence initiated',
    timestamp: new Date().toISOString()
  });
});

// ===========================================
// 🎯 Session Initialization (POST)
// ===========================================
app.post('/api/session/init', (req, res) => {
  try {
    const { preferredLanguage = 'hin-eng' } = req.body;
    
    // Generate unique session ID
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    
    // Language-specific system prompt
    const getSystemPrompt = (lang) => {
      const prompts = {
        'eng': `You are Rajkumar, a helpful AI assistant. Respond in English. Be friendly and concise. If user shares lead info (name/phone), use save_lead_to_sheet tool.`,
        'hin': `आप राजकुमार हैं, एक सहायक AI असिस्टेंट। हिंदी में जवाब दें। मित्रवत और संक्षिप्त रहें। अगर यूजर लीड जानकारी (नाम/फोन) शेयर करे, तो save_lead_to_sheet टूल का उपयोग करें।`,
        'hin-eng': `You are Rajkumar, a friendly AI assistant. Default to Hinglish (Hindi+English mix). If user prefers pure Hindi/English, switch accordingly. Save leads using save_lead_to_sheet tool when contact info is shared. Be helpful and concise.`
      };
      return prompts[lang] || prompts['hin-eng'];
    };

    sessions.set(sessionId, {
      messages: [
        { role: "system", content: getSystemPrompt(preferredLanguage) }
      ],
      lastAccessed: Date.now(),
      language: preferredLanguage
    });
    
    console.log(`✅ Session created: ${sessionId} (lang: ${preferredLanguage})`);
    res.json({ 
      sessionId, 
      message: "Session initialized successfully",
      language: preferredLanguage
    });
    
  } catch (error) {
    console.error("❌ Session init error:", error);
    res.status(500).json({ error: "Failed to initialize session", details: error.message });
  }
});

// ===========================================
// 🛠️ Tool Handler Functions
// ===========================================
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
        : { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
      
      return `⏰ ${location} time: ${now.toLocaleString('en-IN', options)}`;
    }
    
    case "save_lead_to_sheet": {
      if (!isSheetsReady || !SPREADSHEET_ID) {
        return "⚠️ Google Sheets not configured. Please contact developer.";
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

        console.log(`✅ Lead saved: ${name} (${phone})`);
        return `✅ Lead saved successfully! Thank you ${name} ji. We'll contact you soon. 🙏`;
        
      } catch (error) {
        console.error("❌ Sheet save error:", error.message);
        return "❌ Error saving lead. Please try again later.";
      }
    }
    
    case "calculate": {
      try {
        // Safe math evaluation (no eval!)
        const sanitized = parsedArgs.expression.replace(/[^0-9+\-*/().]/g, '');
        const result = Function(`"use strict"; return (${sanitized})`)();
        return `🧮 Result: ${result}`;
      } catch (e) {
        return "❌ Invalid mathematical expression";
      }
    }
    
    default:
      return `⚠️ Unknown tool: ${name}`;
  }
}

// ===========================================
// 💬 Main Chat Endpoint (POST)
// ===========================================
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  const MAX_RETRIES = 3;
  
  try {
    // Validate request body
    const { message, sessionId, preferredLanguage = 'hin-eng' } = MessageSchema.parse(req.body);

    // Get or create session
    let session = sessionId ? sessions.get(sessionId) : null;
    
    if (!session) {
      // Create new session if not exists
      const newSessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
      
      const getSystemPrompt = (lang) => {
        const prompts = {
          'eng': `You are Rajkumar, helpful AI. Respond in English. Save leads with save_lead_to_sheet.`,
          'hin': `आप राजकुमार हैं, सहायक AI। हिंदी में जवाब दें। लीड सेव करने के लिए save_lead_to_sheet टूल उपयोग करें।`,
          'hin-eng': `You are Rajkumar, friendly AI. Use Hinglish by default. Switch language if user prefers. Save leads when contact info shared.`
        };
        return prompts[lang] || prompts['hin-eng'];
      };
      
      session = {
        messages: [{ role: "system", content: getSystemPrompt(preferredLanguage) }],
        lastAccessed: Date.now(),
        language: preferredLanguage
      };
      sessions.set(newSessionId, session);
      // Return new session ID to frontend
      sessionId = newSessionId;
    } else {
      session.lastAccessed = Date.now();
      // Update language if changed
      if (preferredLanguage && session.language !== preferredLanguage) {
        session.language = preferredLanguage;
        // Add system message for language switch
        session.messages.push({
          role: "system",
          content: `User now prefers ${preferredLanguage}. Respond accordingly.`
        });
      }
    }

    // Check cache first (avoid duplicate API calls)
    const cacheKey = `${sessionId}:${message}`;
    const cached = responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      session.messages.push({ role: "user", content: message });
      session.messages.push({ role: "assistant", content: cached.reply });
      return res.json({
        reply: cached.reply,
        sessionId,
        cached: true,
        responseTime: Date.now() - startTime
      });
    }

    // Add user message to history
    session.messages.push({ role: "user", content: message });

    // Keep context window manageable (last 20 messages)
    const conversationHistory = session.messages.slice(-20);

    // Retry logic for API resilience
    let completion, retryCount = 0, lastError;
    
    while (retryCount < MAX_RETRIES) {
      try {
        completion = await openai.chat.completions.create({
          model: modelName,
          messages: conversationHistory,
          tools: tools,
          tool_choice: "auto",
          max_tokens: 1000,
          temperature: 0.7,
          // Qwen-specific params (if supported)
          extra_body: {
            top_p: 0.9,
            frequency_penalty: 0.1
          }
        });
        break; // Success!
        
      } catch (error) {
        lastError = error;
        
        // Retry on rate limit / overload
        if (error.status === 429 || error.status === 503 || error.message?.includes('overloaded')) {
          retryCount++;
          if (retryCount < MAX_RETRIES) {
            const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
            console.log(`⚠️ API busy. Retry ${retryCount}/${MAX_RETRIES} after ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        } else {
          throw error; // Non-retryable error
        }
      }
    }

    if (retryCount >= MAX_RETRIES) {
      throw new Error(`API unavailable after ${MAX_RETRIES} retries: ${lastError?.message}`);
    }

    const responseMessage = completion.choices[0].message;
    
    // Handle tool calls (function calling)
    if (responseMessage.tool_calls?.length > 0) {
      const toolResponses = [];
      
      for (const toolCall of responseMessage.tool_calls) {
        const result = await handleToolCall(toolCall);
        toolResponses.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result
        });
      }

      // Add assistant + tool messages to history
      session.messages.push(responseMessage);
      session.messages.push(...toolResponses);

      // Get final response with tool results
      const finalCompletion = await openai.chat.completions.create({
        model: modelName,
        messages: session.messages.slice(-20),
        max_tokens: 1000,
        temperature: 0.7
      });

      const finalText = finalCompletion.choices[0].message.content;
      session.messages.push({ role: "assistant", content: finalText });

      // Cache the response
      responseCache.set(cacheKey, { reply: finalText, timestamp: Date.now() });

      return res.json({
        reply: finalText,
        sessionId,
        toolUsed: responseMessage.tool_calls[0].function.name,
        responseTime: Date.now() - startTime
      });

    } else {
      // Normal text response (no tools)
      const text = responseMessage.content;
      session.messages.push({ role: "assistant", content: text });
      
      // Cache response
      responseCache.set(cacheKey, { reply: text, timestamp: Date.now() });
      
      return res.json({
        reply: text,
        sessionId,
        responseTime: Date.now() - startTime
      });
    }

  } catch (error) {
    // Zod validation errors
    if (error.name === 'ZodError') {
      return res.status(400).json({ 
        error: "Invalid request", 
        details: error.errors.map(e => e.message) 
      });
    }
    
    // OpenRouter API errors
    if (error.status === 401) {
      console.error('🔐 OpenRouter Auth Error:', {
        message: error.message,
        keyPrefix: process.env.OPENROUTER_API_KEY?.substring(0, 10) + '...'
      });
      return res.status(401).json({ 
        error: "Invalid API key",
        hint: "Check OPENROUTER_API_KEY in environment variables"
      });
    }
    
    if (error.status === 429) {
      return res.status(429).json({ 
        error: "Rate limit exceeded", 
        retryAfter: 5,
        message: "Please wait a moment and try again"
      });
    }
    
    if (error.status === 402) {
      return res.status(402).json({ 
        error: "Out of credits",
        help: "Add funds at https://openrouter.ai/keys"
      });
    }
    
    if (error.status === 404) {
      return res.status(404).json({ 
        error: `Model "${modelName}" not found`,
        check: "https://openrouter.ai/models?q=qwen"
      });
    }
    
    // Generic server error
    console.error("❌ Chat endpoint error:", {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    res.status(500).json({ 
      error: "Server error", 
      message: process.env.NODE_ENV === 'development' ? error.message : "Something went wrong",
      responseTime: Date.now() - startTime
    });
  }
});

// ===========================================
// 📋 Admin: Get Recent Leads (GET)
// ===========================================
app.get('/api/leads/recent', async (req, res) => {
  if (!isSheetsReady || !SPREADSHEET_ID) {
    return res.status(503).json({ 
      error: "Google Sheets not configured",
      setup: "Add GOOGLE_SHEET_ID and serviceAccountKey.json"
    });
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:F',
    });

    const rows = response.data.values || [];
    
    if (rows.length <= 1) { // Only header row
      return res.json({ leads: [], message: "No leads yet" });
    }

    // Parse rows (skip header), limit to last 20, reverse for newest first
    const leads = rows.slice(1).map(row => ({
      timestamp: row[0] || new Date().toISOString(),
      name: row[1] || 'Unknown',
      phone: row[2] || 'Not provided',
      email: row[3] || 'Not provided',
      message: row[4] || 'No message',
      interest: row[5] || 'General'
    })).slice(-20).reverse();

    res.json({ leads, count: leads.length });
    
  } catch (error) {
    console.error("❌ Failed to fetch leads:", error.message);
    res.status(500).json({ 
      error: "Failed to fetch leads", 
      details: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
});

// ===========================================
// 🧪 Test Endpoint (GET)
// ===========================================
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'Backend is working! 🎉',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    model: modelName,
    sheetsReady: isSheetsReady
  });
});

// ===========================================
// 🏠 Root Endpoint (GET)
// ===========================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'Rajkumar AI Chatbot API',
    version: '2.0.0',
    model: modelName,
    endpoints: {
      health: 'GET /api/health',
      wake: 'GET /api/wake',
      keepAlive: 'POST /api/keep-alive',
      triggerWake: 'GET /api/trigger-wake?token=YOUR_TOKEN',
      test: 'GET /api/test',
      sessionInit: 'POST /api/session/init',
      chat: 'POST /api/chat',
      leads: 'GET /api/leads/recent'
    },
    docs: 'https://github.com/rajkumar/ai-chatbot'
  });
});

// ===========================================
// ❌ 404 Handler
// ===========================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    method: req.method,
    hint: `Use ${req.method === 'GET' ? 'POST' : 'GET'} for this endpoint`,
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

// ===========================================
// 🚨 Global Error Handler
// ===========================================
app.use((err, req, res, next) => {
  console.error("💥 Unhandled error:", {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method
  });
  
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message: process.env.NODE_ENV === 'development' ? err.message : "Something went wrong"
  });
});

// ===========================================
// 🚀 Server Start
// ===========================================
const server = app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 Rajkumar AI Chatbot Backend`);
  console.log(`📍 Running on: http://localhost:${PORT}`);
  console.log(`📦 Model: ${modelName}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  console.log(`📊 Sheets: ${isSheetsReady ? '✅ Ready' : '❌ Not configured'}`);
  console.log(`🔐 Wake Token: ${WAKE_TOKEN.substring(0, 6)}...`);
  console.log('='.repeat(60) + '\n');
  
  console.log('📚 Available Endpoints:');
  console.log(`   GET    http://localhost:${PORT}/`);
  console.log(`   GET    http://localhost:${PORT}/api/health`);
  console.log(`   GET    http://localhost:${PORT}/api/wake`);
  console.log(`   POST   http://localhost:${PORT}/api/keep-alive`);
  console.log(`   GET    http://localhost:${PORT}/api/trigger-wake?token=XXX`);
  console.log(`   GET    http://localhost:${PORT}/api/test`);
  console.log(`   POST   http://localhost:${PORT}/api/session/init  ← Requires POST!`);
  console.log(`   POST   http://localhost:${PORT}/api/chat         ← Requires POST!`);
  console.log(`   GET    http://localhost:${PORT}/api/leads/recent`);
  console.log('');
});

// ===========================================
// 🛑 Graceful Shutdown
// ===========================================
const gracefulShutdown = (signal) => {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('❌ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// ===========================================
// 💤 Self-Ping for Render Free Tier (Every 14 mins)
// ===========================================
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes (Render sleeps after 15 mins)

setInterval(async () => {
  // Only ping if no recent activity
  if (Date.now() - lastActivityTime > 5 * 60 * 1000) {
    try {
      console.log('🔄 Self-ping to prevent sleep...');
      const res = await fetch(`http://localhost:${PORT}/api/health`, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (res.ok) console.log('✅ Self-ping successful');
    } catch (err) {
      console.log('⚠️ Self-ping failed (server may be sleeping):', err.message);
    }
  }
}, PING_INTERVAL);

export default app;