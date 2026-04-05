/**
 * 🤖 Rajkumar AI Agent Backend - Production v2.2
 * ✅ Render Fixed | ✅ CORS Secure | ✅ Better Errors | ✅ Hinglish Ready
 * Author: Rajkumar Chourasiya | Indore, MP 🇮🇳
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { z } from 'zod';

const app = express();
const PORT = process.env.PORT || 5000;

// 🛡️ Production-Ready Config
const CONFIG = {
  // CORS: Allow localhost + your Vercel URLs + env var
  allowedOrigins: [
    'http://localhost:5173',
    'http://localhost:3000', 
    'https://ai-agent-ui-fawn.vercel.app',
    'https://ai-agent-ui-fawn-git-main.vercel.app',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  
  sheets: {
    id: process.env.GOOGLE_SHEET_ID,
    token: process.env.GOOGLE_SHEETS_ACCESS_TOKEN,
    range: 'Sheet1!A:F'
  },
  
  openrouter: {
    key: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || 'qwen/qwen-2.5-72b-instruct'
  },
  
  urls: {
    self: process.env.SELF_URL || process.env.APP_URL || `http://localhost:${PORT}`,
    frontend: process.env.FRONTEND_URL
  },
  
  wakeToken: process.env.WAKE_TOKEN || 'change-me',
  sessionTimeout: 30 * 60 * 1000,
  cacheTTL: 5 * 60 * 1000
};

// 🔐 Critical: Exit if API key missing
if (!CONFIG.openrouter.key) {
  console.error('❌ FATAL: OPENROUTER_API_KEY not set in environment variables');
  process.exit(1);
}

// 🚀 Express Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    // Check against allowed list (normalize trailing slashes)
    const normalized = origin.replace(/\/$/, '');
    const isAllowed = CONFIG.allowedOrigins.some(o => 
      o?.replace(/\/$/, '') === normalized
    );
    
    if (isAllowed) {
      console.log(`✅ CORS allowed: ${origin}`);
      return callback(null, true);
    }
    
    console.warn(`🚫 CORS blocked: ${origin} (allowed: ${CONFIG.allowedOrigins.join(', ')})`);
    callback(new Error(`CORS policy: ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 📝 Request Logger (Production Safe)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// 🗄️ In-Memory Cache & Sessions (Render free tier compatible)
const cache = new Map();
const sessions = new Map();

// 🤖 OpenRouter HTTP Client (Direct API - No SDK)
const openRouter = axios.create({
  baseURL: 'https://openrouter.ai/api/v1',
  headers: {
    'Authorization': `Bearer ${CONFIG.openrouter.key}`,
    'HTTP-Referer': CONFIG.urls.self,
    'X-Title': 'Rajkumar AI Agent',
    'Content-Type': 'application/json'
  },
  timeout: 30000,
  validateStatus: status => status < 500 // Handle 4xx errors manually
});

// 📝 Zod Validation Schemas
const MessageSchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
  sessionId: z.string().optional(),
  preferredLanguage: z.enum(['eng', 'hin', 'hin-eng']).optional().default('hin-eng')
});

const LeadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(10),
  email: z.string().email().optional().or(z.literal('')).optional(),
  message: z.string().min(1),
  interest: z.string().optional()
});

// 📊 Google Sheets Direct REST API Helper
const sheetsApi = {
  async append(values) {
    if (!CONFIG.sheets.id || !CONFIG.sheets.token) {
      throw new Error('Google Sheets not configured: Missing GOOGLE_SHEET_ID or GOOGLE_SHEETS_ACCESS_TOKEN');
    }
    
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheets.id}/values/${CONFIG.sheets.range}:append?valueInputOption=USER_ENTERED`;
    
    const { data } = await axios.post(url, { values: [values] }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.sheets.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    return data;
  },
  
  async getRecent(limit = 20) {
    if (!CONFIG.sheets.id || !CONFIG.sheets.token) {
      throw new Error('Google Sheets not configured');
    }
    
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheets.id}/values/${CONFIG.sheets.range}`;
    
    const { data } = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${CONFIG.sheets.token}` },
      timeout: 10000
    });
    
    const rows = data.values || [];
    if (rows.length <= 1) return []; // Only header
    
    return rows.slice(1).slice(-limit).reverse().map(r => ({
      timestamp: r[0] || new Date().toISOString(),
      name: r[1] || 'Unknown',
      phone: r[2] || 'Not provided',
      email: r[3] || 'Not provided', 
      message: r[4] || 'No message',
      interest: r[5] || 'General'
    }));
  }
};

// 🛠️ Tool Definitions for Function Calling
const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get current date/time for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
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
      description: "Perform math calculations safely",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Math expression like '2+2'" }
        },
        required: ["expression"]
      }
    }
  }
];

// 🛠️ Tool Execution Handler
async function handleTool(toolName, toolArgs) {
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
      if (!CONFIG.sheets.id || !CONFIG.sheets.token) {
        return "⚠️ Google Sheets not configured. Contact developer to setup env vars.";
      }
      
      try {
        const lead = LeadSchema.parse(toolArgs);
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        
        await sheetsApi.append([
          timestamp,
          lead.name,
          lead.phone, 
          lead.email || 'Not provided',
          lead.message,
          lead.interest || 'General'
        ]);
        
        console.log(`✅ Lead saved: ${lead.name} (${lead.phone})`);
        return `✅ Lead saved successfully! Thank you ${lead.name} ji. We'll contact you soon. 🙏`;
        
      } catch (error) {
        console.error("❌ Lead save error:", error.message);
        return `❌ Error saving lead: ${error.message}`;
      }
    }
    
    case "calculate": {
      try {
        // Safe math: only allow numbers and basic operators
        const sanitized = toolArgs.expression.replace(/[^0-9+\-*/().]/g, '');
        if (!sanitized) throw new Error('Empty expression');
        
        const result = Function(`"use strict"; return (${sanitized})`)();
        return `🧮 Result: ${result}`;
      } catch (e) {
        return `❌ Invalid expression: ${toolArgs.expression}`;
      }
    }
    
    default:
      return `⚠️ Unknown tool: ${toolName}`;
  }
}

// 🌐 System Prompt by Language
const getSystemPrompt = (lang) => {
  const prompts = {
    'eng': "You are Rajkumar, a helpful AI assistant. Respond in English. Be friendly and concise. If user shares contact info (name/phone), use save_lead_to_sheet tool.",
    'hin': "आप राजकुमार हैं, एक सहायक AI असिस्टेंट। हिंदी में जवाब दें। मित्रवत और संक्षिप्त रहें। अगर यूजर लीड जानकारी (नाम/फोन) शेयर करे, तो save_lead_to_sheet टूल का उपयोग करें।",
    'hin-eng': "You are Rajkumar, a friendly AI assistant. Default to Hinglish (Hindi+English mix). If user prefers pure Hindi/English, switch accordingly. Save leads using save_lead_to_sheet tool when contact info is shared. Be helpful and concise."
  };
  return prompts[lang] || prompts['hin-eng'];
};

// 🔁 Session Manager with Auto-Cleanup
function getOrCreateSession(sessionId, lang = 'hin-eng') {
  // Return existing session
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.lastAccessed = Date.now();
    return { session, id: sessionId };
  }
  
  // Create new session
  const newId = sessionId || Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  const session = {
    messages: [{ role: "system", content: getSystemPrompt(lang) }],
    lastAccessed: Date.now(),
    language: lang
  };
  
  sessions.set(newId, session);
  console.log(`🆕 Session created: ${newId} (lang: ${lang})`);
  return { session, id: newId };
}

// 🧹 Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastAccessed > CONFIG.sessionTimeout) {
      sessions.delete(id);
      cleaned++;
    }
  }
  
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} expired sessions`);
}, 5 * 60 * 1000);

// ===========================================
// 🏥 Health & Utility Endpoints
// ===========================================

app.get('/api/health', (_, res) => {
  res.json({
    status: 'ok',
    message: 'Server is awake! 🚀',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: sessions.size,
    sheetsReady: !!(CONFIG.sheets.id && CONFIG.sheets.token),
    model: CONFIG.openrouter.model,
    corsAllowed: CONFIG.allowedOrigins,
    env: process.env.NODE_ENV || 'development'
  });
});

app.get('/api/wake', (_, res) => {
  console.log('🔔 Wake signal received');
  res.json({ status: 'waking', message: 'Server ready!', timestamp: new Date().toISOString() });
});

app.post('/api/keep-alive', (_, res) => {
  console.log('❤️ Keep-alive ping received');
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/api/trigger-wake', (req, res) => {
  const token = (req.query.token || '').toString().trim();
  
  if (token !== CONFIG.wakeToken) {
    console.warn(`🔐 Unauthorized wake attempt from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
  
  console.log('🚀 Authorized wake trigger');
  res.json({ status: 'waking', message: 'Wake sequence initiated', timestamp: new Date().toISOString() });
});

app.get('/api/test', (_, res) => {
  res.json({
    success: true,
    message: 'Backend working! 🎉',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    model: CONFIG.openrouter.model,
    sheetsReady: !!(CONFIG.sheets.id && CONFIG.sheets.token),
    corsOrigins: CONFIG.allowedOrigins
  });
});

// 🔍 Debug Endpoint - Check Environment Config
app.get('/api/debug/env', (_, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    OPENROUTER_KEY_SET: !!CONFIG.openrouter.key,
    OPENROUTER_KEY_PREFIX: CONFIG.openrouter.key ? CONFIG.openrouter.key.substring(0, 10) + '...' : undefined,
    MODEL: CONFIG.openrouter.model,
    SHEETS_CONFIGURED: !!(CONFIG.sheets.id && CONFIG.sheets.token),
    FRONTEND_URL: CONFIG.urls.frontend,
    SELF_URL: CONFIG.urls.self,
    ALLOWED_ORIGINS: CONFIG.allowedOrigins,
    WAKE_TOKEN_SET: !!CONFIG.wakeToken
  });
});

// 🔍 Debug Endpoint - Check Active Sessions
app.get('/api/debug/sessions', (_, res) => {
  const sessionList = Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    language: s.language,
    messageCount: s.messages.length,
    lastAccessed: new Date(s.lastAccessed).toISOString(),
    age: Math.floor((Date.now() - s.lastAccessed) / 1000) + 's'
  }));
  
  res.json({
    total: sessions.size,
    sessions: sessionList,
    cacheSize: cache.size
  });
});

// ===========================================
// 🎯 Session Initialization (POST)
// ===========================================
app.post('/api/session/init', (req, res) => {
  try {
    const { preferredLanguage = 'hin-eng' } = req.body;
    const { session, id } = getOrCreateSession(null, preferredLanguage);
    
    res.json({ 
      sessionId: id, 
      message: 'Session initialized successfully',
      language: session.language,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("❌ Session init error:", error.message);
    res.status(500).json({ 
      error: "Failed to initialize session", 
      details: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
});

// ===========================================
// 💬 Main Chat Endpoint (POST) - Production Ready
// ===========================================
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // 1️⃣ Validate request body
    const { message, preferredLanguage = 'hin-eng', sessionId } = MessageSchema.parse(req.body);
    
    // 2️⃣ Get or create session
    const { session, id: sessId } = getOrCreateSession(sessionId, preferredLanguage);
    
    // 3️⃣ Check cache (avoid duplicate API calls)
    const cacheKey = `${sessId}:${message}`;
    const cached = cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CONFIG.cacheTTL)) {
      session.messages.push({ role: "user", content: message });
      session.messages.push({ role: "assistant", content: cached.reply });
      
      return res.json({
        reply: cached.reply,
        sessionId: sessId,
        cached: true,
        responseTime: Date.now() - startTime
      });
    }
    
    // 4️⃣ Add user message to history
    session.messages.push({ role: "user", content: message });
    const history = session.messages.slice(-20); // Keep context manageable
    
    // 5️⃣ Call OpenRouter with retry logic
    let completion, lastError, retryCount = 0;
    const MAX_RETRIES = 3;
    
    while (retryCount < MAX_RETRIES) {
      try {
        const response = await openRouter.post('/chat/completions', {
          model: CONFIG.openrouter.model,
          messages: history
            .map(m => ({
              role: m.role === 'tool' ? 'function' : m.role,
              content: m.content,
              tool_call_id: m.tool_call_id
            }))
            .filter(v => v?.content), // ✅ Fixed: .filter() on array, not object
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: "auto",
          max_tokens: 1000,
          temperature: 0.7
        });
        
        completion = response.data;
        break; // Success!
        
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        
        // Retry on rate limit / service unavailable
        if (status === 429 || status === 503 || error.message?.includes('overloaded')) {
          retryCount++;
          if (retryCount < MAX_RETRIES) {
            const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
            console.log(`⚠️ API busy. Retry ${retryCount}/${MAX_RETRIES} after ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        }
        throw error; // Non-retryable
      }
    }
    
    if (!completion) {
      throw new Error(`OpenRouter unavailable after ${MAX_RETRIES} retries: ${lastError?.message}`);
    }
    
    // 6️⃣ Parse AI response (handle new OpenRouter format)
    const choice = completion?.choices?.[0];
    const reply = choice?.message;
    
    if (!reply || (!reply.content && !reply.tool_calls)) {
      console.error('❌ Invalid OpenRouter response:', JSON.stringify(completion).slice(0, 300));
      throw new Error('Empty or invalid AI response');
    }
    
    // 7️⃣ Handle tool calls (function calling)
    if (reply.tool_calls?.length > 0) {
      console.log(`🔧 Tool calls detected: ${reply.tool_calls.map(t => t.function.name).join(', ')}`);
      
      // Execute all tools in parallel
      const toolResults = await Promise.all(
        reply.tool_calls.map(async (tc) => {
          const toolName = tc.function?.name;
          const toolArgs = JSON.parse(tc.function?.arguments || '{}');
          const result = await handleTool(toolName, toolArgs);
          
          return {
            role: "tool",
            tool_call_id: tc.id,
            content: String(result)
          };
        })
      );
      
      // Add assistant response + tool results to history
      session.messages.push(reply, ...toolResults);
      
      // Get final response after tool execution
      const finalResponse = await openRouter.post('/chat/completions', {
        model: CONFIG.openrouter.model,
        messages: session.messages
          .slice(-20)
          .map(m => ({
            role: m.role === 'tool' ? 'function' : m.role,
            content: m.content,
            tool_call_id: m.tool_call_id
          }))
          .filter(v => v?.content), // ✅ Fixed parentheses
        max_tokens: 1000,
        temperature: 0.7
      });
      
      const finalText = finalResponse.data?.choices?.[0]?.message?.content || "Hmm, let me process that...";
      session.messages.push({ role: "assistant", content: finalText });
      
      // Cache the final response
      cache.set(cacheKey, { reply: finalText, timestamp: Date.now() });
      
      return res.json({
        reply: finalText,
        sessionId: sessId,
        toolUsed: reply.tool_calls[0].function.name,
        responseTime: Date.now() - startTime
      });
    }
    
    // 8️⃣ Normal text response (no tools)
    const text = reply.content || "Hmm...";
    session.messages.push({ role: "assistant", content: text });
    
    // Cache response
    cache.set(cacheKey, { reply: text, timestamp: Date.now() });
    
    return res.json({
      reply: text,
      sessionId: sessId,
      responseTime: Date.now() - startTime
    });
    
  } catch (error) {
    // 🔥 Production-safe error logging
    const errorInfo = {
      name: error.name,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      path: req.path,
      method: req.method,
      ip: req.ip
    };
    
    console.error('💥 Chat endpoint error:', JSON.stringify(errorInfo, null, 2));
    
    // User-friendly error responses
    if (error.name === 'ZodError') {
      return res.status(400).json({ 
        error: "Invalid request", 
        details: error.errors.map(e => e.message) 
      });
    }
    
    const status = error.response?.status;
    
    if (status === 401) {
      return res.status(401).json({ 
        error: "Invalid OpenRouter API key",
        hint: "Check OPENROUTER_API_KEY in environment variables"
      });
    }
    
    if (status === 402) {
      return res.status(402).json({ 
        error: "Out of credits",
        help: "Add funds at https://openrouter.ai/keys"
      });
    }
    
    if (status === 404) {
      return res.status(404).json({ 
        error: `Model "${CONFIG.openrouter.model}" not found`,
        check: "https://openrouter.ai/models?q=qwen"
      });
    }
    
    if (status === 429) {
      return res.status(429).json({ 
        error: "Rate limit exceeded", 
        retryAfter: 5,
        message: "Please wait a moment and try again"
      });
    }
    
    // Generic 500 error
    return res.status(500).json({ 
      error: "Server error", 
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
      debug: process.env.NODE_ENV === 'development' ? { 
        stack: error.stack,
        config: error.config 
      } : undefined,
      responseTime: Date.now() - startTime
    });
  }
});

// ===========================================
// 📋 Admin: Get Recent Leads (GET)
// ===========================================
app.get('/api/leads/recent', async (_, res) => {
  if (!CONFIG.sheets.id || !CONFIG.sheets.token) {
    return res.status(503).json({ 
      error: "Google Sheets not configured",
      setup: "Add GOOGLE_SHEET_ID and GOOGLE_SHEETS_ACCESS_TOKEN to environment variables",
      docs: "https://github.com/rajkumar/ai-agent#google-sheets-setup"
    });
  }

  try {
    const leads = await sheetsApi.getRecent(20);
    res.json({ leads, count: leads.length, timestamp: new Date().toISOString() });
    
  } catch (error) {
    console.error("❌ Failed to fetch leads:", error.message);
    res.status(500).json({ 
      error: "Failed to fetch leads", 
      details: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
});

// ===========================================
// 🏠 Root Endpoint
// ===========================================
app.get('/', (_, res) => {
  res.json({
    success: true,
    service: 'Rajkumar AI Agent API',
    version: '2.2.0',
    author: 'Rajkumar Chourasiya',
    location: 'Indore, MP, India 🇮🇳',
    model: CONFIG.openrouter.model,
    endpoints: {
      health: 'GET /api/health',
      wake: 'GET /api/wake',
      keepAlive: 'POST /api/keep-alive',
      triggerWake: 'GET /api/trigger-wake?token=YOUR_TOKEN',
      test: 'GET /api/test',
      debug: {
        env: 'GET /api/debug/env',
        sessions: 'GET /api/debug/sessions'
      },
      sessionInit: 'POST /api/session/init',
      chat: 'POST /api/chat',
      leads: 'GET /api/leads/recent'
    },
    docs: 'https://github.com/rajkumar/ai-agent',
    status: 'Running 🚀'
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
      'GET /api/debug/env',
      'GET /api/debug/sessions',
      'POST /api/session/init',
      'POST /api/chat',
      'GET /api/leads/recent'
    ]
  });
});

// ===========================================
// 🛑 Global Error Handler
// ===========================================
app.use((err, req, res, next) => {
  console.error("💥 Unhandled error:", {
    message: err.message,
    name: err.name,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message: process.env.NODE_ENV === 'development' ? err.message : "Something went wrong",
    debug: process.env.NODE_ENV === 'development' ? { name: err.name, stack: err.stack } : undefined
  });
});

// ===========================================
// 🚀 Server Start
// ===========================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  console.log(`🚀 Rajkumar AI Agent Backend v2.2`);
  console.log(`📍 Server: http://localhost:${PORT} | ${CONFIG.urls.self}`);
  console.log(`🌐 Frontend: ${CONFIG.urls.frontend || 'Not set'}`);
  console.log(`📦 Model: ${CONFIG.openrouter.model}`);
  console.log(`🔐 API Key: ${CONFIG.openrouter.key ? '✅ Set' : '❌ Missing!'}`);
  console.log(`📊 Sheets: ${CONFIG.sheets.id && CONFIG.sheets.token ? '✅ Ready' : '❌ Not configured'}`);
  console.log(`🔗 CORS: ${CONFIG.allowedOrigins.join(', ')}`);
  console.log(`🌍 Env: ${process.env.NODE_ENV || 'development'}`);
  console.log('='.repeat(70) + '\n');
  
  console.log('📚 Available Endpoints:');
  console.log(`   GET    ${CONFIG.urls.self}/`);
  console.log(`   GET    ${CONFIG.urls.self}/api/health`);
  console.log(`   GET    ${CONFIG.urls.self}/api/debug/env  ← Check env vars!`);
  console.log(`   POST   ${CONFIG.urls.self}/api/chat       ← Main chat endpoint`);
  console.log(`   POST   ${CONFIG.urls.self}/api/session/init`);
  console.log(`   GET    ${CONFIG.urls.self}/api/leads/recent`);
  console.log('');
});

// ===========================================
// 🔄 Self-Ping for Render Free Tier
// ===========================================
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes (Render sleeps after 15)

setInterval(async () => {
  // Only ping if no recent activity
  const recentActivity = Array.from(sessions.values()).some(s => 
    Date.now() - s.lastAccessed < 5 * 60 * 1000
  );
  
  if (!recentActivity) {
    try {
      console.log('🔄 Self-ping to prevent Render sleep...');
      
      // Use public URL for self-ping (not localhost!)
      const pingUrl = `${CONFIG.urls.self.replace('localhost', '127.0.0.1')}/api/health`;
      
      const response = await axios.get(pingUrl, { 
        timeout: 5000,
        headers: { 'Cache-Control': 'no-cache' },
        validateStatus: () => true // Don't throw on error
      });
      
      if (response.status === 200) {
        console.log('✅ Self-ping successful');
      } else {
        console.warn(`⚠️ Self-ping returned ${response.status}`);
      }
    } catch (err) {
      console.log('⚠️ Self-ping failed:', err.message);
    }
  }
}, PING_INTERVAL);

// ===========================================
// 🛑 Graceful Shutdown
// ===========================================
const gracefulShutdown = (signal) => {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
  
  server.close(() => {
    console.log('✅ HTTP server closed');
    console.log(`🧹 Cleaned ${sessions.size} sessions, ${cache.size} cache entries`);
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('❌ Could not close connections in time, forcing shutdown');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('🚨 UNHANDLED REJECTION:', reason);
  process.exit(1);
});

export default app;