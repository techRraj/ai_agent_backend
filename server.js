/**
 * 🤖 AI Chatbot Backend - Rajkumar's AI Agent [SENIOR DEV FIX]
 * ✅ Direct OpenRouter API calls via axios (no openai package)
 * ✅ Works reliably on Render | CORS | Production Ready
 * Author: Rajkumar Chourasiya | Senior Backend Engineer
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

// Error handlers
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('🚨 UNHANDLED REJECTION:', reason);
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// ===========================================
// 🛡️ CORS Configuration
// ===========================================
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://ai-agent-ui-fawn.vercel.app',
  process.env.FRONTEND_URL?.trim()
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const normalizedOrigin = origin.replace(/\/$/, '');
    if (ALLOWED_ORIGINS.some(o => o?.replace(/\/$/, '') === normalizedOrigin)) {
      return callback(null, true);
    }
    console.warn(`🚫 CORS rejected origin: ${origin}`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// ===========================================
// 🗄️ Response Caching
// ===========================================
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 000;

// ===========================================
// 🔐 Security Variables
// ===========================================
const WAKE_TOKEN = (process.env.WAKE_TOKEN || 'change-me-in-env').trim();
const SELF_URL = (process.env.SELF_URL || 'http://localhost:5000').trim();

// ===========================================
// 🤖 OpenRouter Setup - DIRECT API CALLS (No openai package)
// ===========================================
if (!process.env.OPENROUTER_API_KEY) {
  console.error('❌ CRITICAL: OPENROUTER_API_KEY not set!');
  process.exit(1);
}

// Axios instance for OpenRouter
const openRouter = axios.create({
  baseURL: 'https://openrouter.ai/api/v1',
  headers: {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'HTTP-Referer': process.env.APP_URL || SELF_URL,
    'X-Title': process.env.APP_NAME || 'Rajkumar AI Chatbot',
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

const modelName = process.env.OPENROUTER_MODEL || 'qwen/qwen-2.5-72b-instruct';
console.log('✅ OpenRouter configured (direct API calls)');
console.log(`📦 Model: ${modelName}`);

// ===========================================
// 📝 Validation Schemas
// ===========================================
const MessageSchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
  sessionId: z.string().optional(),
  preferredLanguage: z.enum(['eng', 'hin', 'hin-eng']).optional().default('hin-eng')
});

const LeadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(10),
  email: z.string().email().optional(),
  message: z.string().min(1),
  interest: z.string().optional()
});

// ===========================================
// 📊 Google Sheets Setup
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
  console.log('✅ Google Sheets ready');
} catch (err) {
  console.warn('⚠️ Google Sheets not configured');
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const RANGE = 'Sheet1!A:F';

// ===========================================
// 🛠️ Tool Definitions
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
          location: { type: "string" },
          format: { type: "string", enum: ["short", "long"] }
        },
        required: ["location"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_lead_to_sheet",
      description: "Save customer lead to Google Sheets",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          message: { type: "string" },
          interest: { type: "string" }
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
          expression: { type: "string" }
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
const SESSION_TIMEOUT = 30 * 60 * 1000;
let lastActivityTime = Date.now();

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccessed > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

app.use((req, res, next) => {
  lastActivityTime = Date.now();
  next();
});

// ===========================================
// 🏥 Health & Wake Endpoints
// ===========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is awake! 🚀',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: sessions.size,
    sheetsReady: isSheetsReady,
    model: modelName
  });
});

app.get('/api/wake', (req, res) => {
  console.log('🔔 Wake signal received');
  res.json({ status: 'waking', message: 'Server is ready!', timestamp: new Date().toISOString() });
});

app.post('/api/keep-alive', (req, res) => {
  console.log('❤️ Keep-alive received');
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/api/trigger-wake', (req, res) => {
  const { token } = req.query;
  const providedToken = (token || '').toString().trim();
  const expectedToken = WAKE_TOKEN;
  
  if (providedToken !== expectedToken) {
    console.warn(`🔐 Unauthorized wake attempt from ${req.ip}`);
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
// 🎯 Session Initialization
// ===========================================
app.post('/api/session/init', (req, res) => {
  try {
    const { preferredLanguage = 'hin-eng' } = req.body;
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    
    const getSystemPrompt = (lang) => {
      const prompts = {
        'eng': `You are Rajkumar, helpful AI assistant. Respond in English. Save leads with save_lead_to_sheet tool.`,
        'hin': `आप राजकुमार हैं, सहायक AI। हिंदी में जवाब दें। लीड सेव करने के लिए save_lead_to_sheet टूल उपयोग करें।`,
        'hin-eng': `You are Rajkumar, friendly AI. Default to Hinglish. Switch language if user prefers. Save leads when contact info shared.`
      };
      return prompts[lang] || prompts['hin-eng'];
    };

    sessions.set(sessionId, {
      messages: [{ role: "system", content: getSystemPrompt(preferredLanguage) }],
      lastAccessed: Date.now(),
      language: preferredLanguage
    });
    
    console.log(`✅ Session: ${sessionId} (${preferredLanguage})`);
    res.json({ sessionId, message: "Session initialized", language: preferredLanguage });
    
  } catch (error) {
    console.error("❌ Session init error:", error);
    res.status(500).json({ error: "Failed to initialize session" });
  }
});

// ===========================================
// 🛠️ Tool Handlers
// ===========================================
async function handleToolCall(toolName, toolArgs) {
  switch (toolName) {
    case "get_current_time": {
      const now = new Date();
      const location = toolArgs.location || 'India';
      const format = toolArgs.format || 'long';
      const options = format === 'short' 
        ? { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }
        : { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
      return `⏰ ${location}: ${now.toLocaleString('en-IN', options)}`;
    }
    
    case "save_lead_to_sheet": {
      if (!isSheetsReady || !SPREADSHEET_ID) {
        return "⚠️ Google Sheets not configured.";
      }
      try {
        const leadData = LeadSchema.parse(toolArgs);
        const { name, phone, email = 'Not provided', message: userMsg, interest = 'General' } = leadData;
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: RANGE,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[timestamp, name, phone, email, userMsg, interest]] }
        });

        console.log(`✅ Lead saved: ${name}`);
        return `✅ Lead saved! Thank you ${name} ji. We'll contact you soon. 🙏`;
      } catch (error) {
        console.error("❌ Sheet error:", error.message);
        return "❌ Error saving lead. Try again later.";
      }
    }
    
    case "calculate": {
      try {
        const sanitized = toolArgs.expression.replace(/[^0-9+\-*/().]/g, '');
        const result = Function(`"use strict"; return (${sanitized})`)();
        return `🧮 Result: ${result}`;
      } catch {
        return "❌ Invalid expression";
      }
    }
    
    default:
      return `⚠️ Unknown tool: ${toolName}`;
  }
}

// ===========================================
// 💬 Main Chat Endpoint - DIRECT OPENROUTER API CALLS
// ===========================================
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  const MAX_RETRIES = 3;
  
  try {
    const parsed = MessageSchema.parse(req.body);
    const { message, preferredLanguage = 'hin-eng' } = parsed;
    let sessionId = parsed.sessionId;

    let session = sessionId ? sessions.get(sessionId) : null;
    
    if (!session) {
      const newSessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
      
      const getSystemPrompt = (lang) => {
        const prompts = {
          'eng': `You are Rajkumar, helpful AI. Respond in English.`,
          'hin': `आप राजकुमार हैं, सहायक AI। हिंदी में जवाब दें।`,
          'hin-eng': `You are Rajkumar, friendly AI. Default to Hinglish.`
        };
        return prompts[lang] || prompts['hin-eng'];
      };
      
      session = {
        messages: [{ role: "system", content: getSystemPrompt(preferredLanguage) }],
        lastAccessed: Date.now(),
        language: preferredLanguage
      };
      sessions.set(newSessionId, session);
      sessionId = newSessionId;
    } else {
      session.lastAccessed = Date.now();
      if (preferredLanguage && session.language !== preferredLanguage) {
        session.language = preferredLanguage;
        session.messages.push({ role: "system", content: `User prefers ${preferredLanguage}. Respond accordingly.` });
      }
    }

    // Cache check
    const cacheKey = `${sessionId}:${message}`;
    const cached = responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      session.messages.push({ role: "user", content: message }, { role: "assistant", content: cached.reply });
      return res.json({ reply: cached.reply, sessionId, cached: true, responseTime: Date.now() - startTime });
    }

    session.messages.push({ role: "user", content: message });
    const conversationHistory = session.messages.slice(-20);

    // Retry logic for OpenRouter API calls
    let completion, retryCount = 0, lastError;
    
    while (retryCount < MAX_RETRIES) {
      try {
        // ✅ DIRECT API CALL - No openai package, no ESM issues
        const response = await openRouter.post('/chat/completions', {
          model: modelName,
          messages: conversationHistory.map(msg => ({
            role: msg.role === 'tool' ? 'function' : msg.role,
            content: msg.content,
            name: msg.name,
            tool_calls: msg.tool_calls,
            tool_call_id: msg.tool_call_id
          }).filter(v => v.content !== undefined)),
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: "auto",
          max_tokens: 1000,
          temperature: 0.7
        });
        
        completion = response.data;
        break;
        
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        
        if (status === 429 || status === 503 || error.message?.includes('overloaded')) {
          retryCount++;
          if (retryCount < MAX_RETRIES) {
            const waitTime = Math.pow(2, retryCount) * 1000;
            console.log(`⚠️ API busy. Retry ${retryCount}/${MAX_RETRIES} after ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        } else {
          throw error;
        }
      }
    }

    if (retryCount >= MAX_RETRIES) {
      throw new Error(`API unavailable after ${MAX_RETRIES} retries: ${lastError?.message}`);
    }

    const responseMessage = completion.choices?.[0]?.message;
    
    if (!responseMessage) {
      throw new Error('Invalid response from OpenRouter');
    }
    
    // Handle tool calls (function calling)
    if (responseMessage.tool_calls?.length > 0) {
      const toolResponses = [];
      
      for (const toolCall of responseMessage.tool_calls) {
        const toolName = toolCall.function?.name;
        const toolArgs = JSON.parse(toolCall.function?.arguments || '{}');
        const result = await handleToolCall(toolName, toolArgs);
        
        toolResponses.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result
        });
      }

      session.messages.push(responseMessage, ...toolResponses);
      
      // Get final response with tool results
      const finalResponse = await openRouter.post('/chat/completions', {
        model: modelName,
        messages: session.messages.slice(-20).map(msg => ({
          role: msg.role === 'tool' ? 'function' : msg.role,
          content: msg.content,
          name: msg.name,
          tool_call_id: msg.tool_call_id
        }).filter(v => v.content !== undefined)),
        max_tokens: 1000,
        temperature: 0.7
      });
      
      const finalText = finalResponse.data.choices?.[0]?.message?.content;
      session.messages.push({ role: "assistant", content: finalText });
      responseCache.set(cacheKey, { reply: finalText, timestamp: Date.now() });
      
      return res.json({ 
        reply: finalText, 
        sessionId, 
        toolUsed: responseMessage.tool_calls[0].function.name, 
        responseTime: Date.now() - startTime 
      });
      
    } else {
      // Normal text response
      const text = responseMessage.content;
      session.messages.push({ role: "assistant", content: text });
      responseCache.set(cacheKey, { reply: text, timestamp: Date.now() });
      
      return res.json({ 
        reply: text, 
        sessionId, 
        responseTime: Date.now() - startTime 
      });
    }

  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: "Invalid request", details: error.errors.map(e => e.message) });
    }
    
    const status = error.response?.status;
    
    if (status === 401) {
      return res.status(401).json({ error: "Invalid API key", hint: "Check OPENROUTER_API_KEY" });
    }
    if (status === 429) {
      return res.status(429).json({ error: "Rate limit exceeded", retryAfter: 5 });
    }
    if (status === 402) {
      return res.status(402).json({ error: "Out of credits", help: "https://openrouter.ai/keys" });
    }
    if (status === 404) {
      return res.status(404).json({ error: `Model "${modelName}" not found` });
    }
    
    console.error("❌ Chat error:", error.message);
    res.status(500).json({ error: "Server error", message: process.env.NODE_ENV === 'development' ? error.message : "Something went wrong" });
  }
});

// ===========================================
// 📋 Get Recent Leads
// ===========================================
app.get('/api/leads/recent', async (req, res) => {
  if (!isSheetsReady || !SPREADSHEET_ID) {
    return res.status(503).json({ error: "Google Sheets not configured" });
  }
  try {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:F' });
    const rows = response.data.values || [];
    if (rows.length <= 1) return res.json({ leads: [] });
    
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
    console.error("❌ Fetch leads error:", error.message);
    res.status(500).json({ error: "Failed to fetch leads" });
  }
});

// ===========================================
// 🧪 Test & Root Endpoints
// ===========================================
app.get('/api/test', (req, res) => {
  res.json({ success: true, message: 'Backend working! 🎉', model: modelName, sheetsReady: isSheetsReady });
});

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'Rajkumar AI Chatbot API v2.0',
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
    }
  });
});

// ===========================================
// ❌ 404 & Error Handlers
// ===========================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    method: req.method,
    hint: `Use ${req.method === 'GET' ? 'POST' : 'GET'} for this endpoint`,
    availableRoutes: ['GET /', 'GET /api/health', 'POST /api/session/init', 'POST /api/chat', 'GET /api/leads/recent']
  });
});

app.use((err, req, res, next) => {
  console.error("💥 Error:", err.message);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// ===========================================
// 🚀 Server Start
// ===========================================
console.log('\n🔍 Startup Check:');
console.log('  PORT:', process.env.PORT || 5000);
console.log('  OPENROUTER_API_KEY:', process.env.OPENROUTER_API_KEY ? '✅ Set' : '❌ MISSING');
console.log('  OPENROUTER_MODEL:', process.env.OPENROUTER_MODEL || 'qwen/qwen-2.5-72b-instruct');
console.log('  FRONTEND_URL:', process.env.FRONTEND_URL || 'http://localhost:5173');

if (!process.env.OPENROUTER_API_KEY) {
  console.error('❌ FATAL: OPENROUTER_API_KEY not set!');
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Rajkumar AI Backend | Port: ${PORT} | Model: ${modelName}\n`);
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`\n🛑 ${signal} received`);
  server.close(() => { console.log('✅ Server closed'); process.exit(0); });
  setTimeout(() => { console.error('❌ Force shutdown'); process.exit(1); }, 10000);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ===========================================
// 💤 Self-Ping for Render
// ===========================================
const PING_INTERVAL = 14 * 60 * 1000;
setInterval(async () => {
  if (Date.now() - lastActivityTime > 5 * 60 * 1000) {
    try {
      console.log('🔄 Self-ping...');
      const res = await axios.get(`http://localhost:${PORT}/api/health`, { timeout: 5000 });
      if (res.status === 200) console.log('✅ Self-ping success');
    } catch (err) {
      console.log('⚠️ Self-ping failed:', err.message);
    }
  }
}, PING_INTERVAL);

export default app;