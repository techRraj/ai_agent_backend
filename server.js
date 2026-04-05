/**
 * 🤖 Rajkumar AI Agent Backend - Optimized v2.1
 * ✅ Render Compatible | ✅ Direct APIs | ✅ Hinglish Ready
 * Author: Rajkumar Chourasiya | Indore, MP 🇮🇳
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { z } from 'zod';

const app = express();
const PORT = process.env.PORT || 5000;

// 🛡️ Config & Constants
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

if (!CONFIG.openrouter.key) { console.error('❌ OPENROUTER_API_KEY missing'); process.exit(1); }

// 🚀 Express Setup
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
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// 🗄️ Simple Cache & Sessions
const cache = new Map();
const sessions = new Map();

// 🤖 OpenRouter Client
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

// 📝 Zod Schemas
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

// 📊 Google Sheets Helpers (Direct REST API)
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

// 🛠️ Tool Handlers
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

// 🌐 System Prompt Generator
const getPrompt = (lang) => ({
  eng: "You are Lead Agent, helpful AI. Respond in English. Save leads with save_lead_to_sheet.",
  hin: "आप Lead agent हैं, सहायक AI। हिंदी में जवाब दें। लीड सेव करने के लिए save_lead_to_sheet टूल उपयोग करें।",
  'hin-eng': "You are Lead Agent, friendly AI. Use Hinglish by default. Switch if user prefers. Save leads when contact info shared."
}[lang] || "You are Lead agent AI. Be helpful and concise.");

// 🔁 Session Manager
function getOrCreateSession(sessionId, lang = 'hin-eng') {
 if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.lastAccessed = Date.now();
    return { session, id: sessionId };
  }
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

// Cleanup old sessions
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
app.get('/api/health', (_, res) => res.json({
  status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(),
  sessions: sessions.size, sheetsReady: !!(CONFIG.sheets.id && CONFIG.sheets.token), model: CONFIG.openrouter.model
}));

app.get('/api/wake', (_, res) => res.json({ status: 'waking', timestamp: new Date().toISOString() }));
app.post('/api/keep-alive', (_, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));

app.get('/api/trigger-wake', (req, res) =>
  req.query.token === CONFIG.wakeToken
    ? res.json({ status: 'waking', timestamp: new Date().toISOString() })
    : res.status(401).json({ error: 'Unauthorized' })
);

app.get('/api/test', (_, res) => res.json({
  success: true, message: 'Backend working! 🎉', sheetsReady: !!(CONFIG.sheets.id && CONFIG.sheets.token)
}));

// ===========================================
// 🎯 Session Init (POST)
// ===========================================
app.post('/api/session/init', (req, res) => {
  try {
    const { preferredLanguage = 'hin-eng' } = req.body;
    const { session, id } = getOrCreateSession(null, preferredLanguage);
    res.json({ sessionId: id, message: 'Session initialized', language: session.language });
  } catch (e) { res.status(500).json({ error: 'Init failed', details: e.message }); }
});

// ===========================================
// 💬 Chat Endpoint (POST) - Core Logic
// ===========================================
app.post('/api/chat', async (req, res) => {
  const start = Date.now();
  try {
    // 1. Validate input
    const { message, preferredLanguage = 'hin-eng', sessionId } = MessageSchema.parse(req.body);
    
    // 2. Get/Create session
    const { session, id: sessId } = getOrCreateSession(sessionId, preferredLanguage);
    
    // 3. Cache check
    const key = `${sessId}:${message}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CONFIG.cacheTTL) {
      return res.json({ reply: cached.reply, sessionId: sessId, cached: true, responseTime: Date.now() - start });
    }

    // 4. Add user message to history
    session.messages.push({ role: "user", content: message });
    const history = session.messages.slice(-20);

    // 5. Call OpenRouter with retry
    let completion, retries = 0;
    while (retries < 3) {
      try {
        const response = await openRouter.post('/chat/completions', {
          model: CONFIG.openrouter.model,
          // ✅ FIXED: Proper .map().filter() chaining
          messages: history.map(m => ({
            role: m.role === 'tool' ? 'function' : m.role,
            content: m.content,
            tool_call_id: m.tool_call_id
          })).filter(v => v?.content), // ← ✅ Parentheses fixed!
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: "auto",
          max_tokens: 1000,
          temperature: 0.7
        });
        completion = response.data;
        break;
      } catch (error) {
        if ([429, 503].includes(error.response?.status) && ++retries < 3) {
          await new Promise(r => setTimeout(r, 2 ** retries * 1000));
        } else throw error;
      }
    }

    // 6. Parse response
    const reply = completion?.choices?.[0]?.message;
    if (!reply || (!reply.content && !reply.tool_calls)) {
      throw new Error('Empty AI response');
    }

    // 7. Handle tool calls
    if (reply.tool_calls?.length > 0) {
      const toolResults = await Promise.all(
        reply.tool_calls.map(async (tc) => {
          const args = JSON.parse(tc.function?.arguments || '{}');
          const result = await handleTool(tc.function.name, args);
          return { role: "tool", tool_call_id: tc.id, content: String(result) };
        })
      );

      session.messages.push(reply, ...toolResults);

      // ✅ FIXED: Same parentheses fix for final response call
      const finalResponse = await openRouter.post('/chat/completions', {
        model: CONFIG.openrouter.model,
        messages: session.messages.slice(-20).map(m => ({
          role: m.role === 'tool' ? 'function' : m.role,
          content: m.content,
          tool_call_id: m.tool_call_id
        })).filter(v => v?.content), // ← ✅ Fixed here too!
        max_tokens: 1000,
        temperature: 0.7
      });

      const finalText = finalResponse.data?.choices?.[0]?.message?.content || "Hmm...";
      session.messages.push({ role: "assistant", content: finalText });
      cache.set(key, { reply: finalText, ts: Date.now() });

      return res.json({
        reply: finalText,
        sessionId: sessId,
        toolUsed: reply.tool_calls[0].function.name,
        responseTime: Date.now() - start
      });
    }

    // 8. Normal response
    const text = reply.content || "Hmm...";
    session.messages.push({ role: "assistant", content: text });
    cache.set(key, { reply: text, ts: Date.now() });

    res.json({
      reply: text,
      sessionId: sessId,
      responseTime: Date.now() - start
    });

  } catch (error) {
    console.error('💥 Chat error:', {
      name: error.name,
      message: error.message,
      status: error.response?.status,
       data:error.response?.data
    });

    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid request', details: error.errors.map(e => e.message) });
    }

    const status = error.response?.status;
    if (status === 401) return res.status(401).json({ error: 'Invalid API key' });
    if (status === 402) return res.status(402).json({ error: 'Out of credits' });
    if (status === 404) return res.status(404).json({ error: 'Model not found' });
    if (status === 429) return res.status(429).json({ error: 'Rate limited', retryAfter: 5 });

    res.status(500).json({ 
      error: 'Server error', 
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});
app.get('/api/debug/env', (req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    OPENROUTER_KEY_SET: !!process.env.OPENROUTER_API_KEY,
    OPENROUTER_KEY_PREFIX: process.env.OPENROUTER_API_KEY?.substring(0, 10) + '...',
    MODEL: process.env.OPENROUTER_MODEL,
    SHEETS_ID_SET: !!process.env.GOOGLE_SHEET_ID,
    SHEETS_TOKEN_SET: !!process.env.GOOGLE_SHEETS_ACCESS_TOKEN,
    FRONTEND_URL: process.env.FRONTEND_URL
  });
});
// ===========================================
// 📋 Leads Endpoint (GET) - With Fallback
// ===========================================
app.get('/api/leads/recent', async (_, res) => {
  if (!CONFIG.sheets.id || !CONFIG.sheets.token)
    return res.status(503).json({ error: 'Sheets not configured', setup: 'Add GOOGLE_SHEET_ID & GOOGLE_SHEETS_ACCESS_TOKEN' });
  try {
    const leads = await sheetsApi.getRecent(20);
    res.json({ leads, count: leads.length });
  } catch (e) {
    console.error('❌ Leads fetch error:', e.message);
    res.status(500).json({ error: 'Fetch failed', details: process.env.NODE_ENV === 'development' ? e.message : undefined });
  }
});

// ===========================================
// 🏠 Root & 404
// ===========================================
app.get('/', (_, res) => res.json({
  service: 'Rajkumar AI Agent API', version: '2.1', model: CONFIG.openrouter.model,
  endpoints: { health: 'GET /api/health', chat: 'POST /api/chat', init: 'POST /api/session/init', leads: 'GET /api/leads/recent' }
}));

app.use((req, res) => res.status(404).json({
  error: 'Route not found', path: req.path, method: req.method,
  hint: `Try ${req.method === 'GET' ? 'POST' : 'GET'} for ${req.path}`,
  available: ['GET /', 'GET /api/health', 'POST /api/keep-alive', 'POST /api/session/init', 'POST /api/chat', 'GET /api/leads/recent']
}));

app.use((err, req, res, _) => {
  console.error('💥 Global error:', err.message);
  res.status(500).json({ error: 'Internal error', message: process.env.NODE_ENV === 'development' ? err.message : 'Server issue' });
});

// 🚀 Start Server
const server = app.listen(PORT, () =>
  console.log(`🚀 Rajkumar AI Agent running on http://localhost:${PORT} | Model: ${CONFIG.openrouter.model} | Sheets: ${CONFIG.sheets.id && CONFIG.sheets.token ? '✅' : '❌'}`)
);

// 🔄 Self-ping for Render (every 14 mins)
setInterval(async () => {
  try { await axios.get(`http://localhost:${PORT}/api/health`, { timeout: 5000 }); }
  catch (e) { console.log('⚠️ Self-ping skipped:', e.message); }
}, 14 * 60 * 1000);

// 🛑 Graceful Shutdown
process.on('SIGTERM', () => { console.log('🛑 SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('🛑 SIGINT'); server.close(() => process.exit(0)); });

export default app;