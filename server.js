/**
 * 🤖 Rajkumar AI Agent Backend - v2.3 Universal Auth
 * ✅ File Path + Render Secret File Support | ✅ Auto-Refresh Tokens | ✅ Hinglish Ready
 * Author: Rajkumar Chourasiya | Indore, MP 🇮🇳
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { z } from 'zod';
import { GoogleAuth } from 'google-auth-library';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// 🛡️ Production-Ready Config
const CONFIG = {
  allowedOrigins: [
    'http://localhost:5173',
    'http://localhost:3000', 
    'https://ai-agent-ui-fawn.vercel.app',
    'https://ai-agent-ui-fawn-git-main.vercel.app',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  
  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    credentialsSource: process.env.GOOGLE_SERVICE_ACCOUNT_KEY, // File path OR JSON string
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

// 🔐 Critical checks
if (!CONFIG.openrouter.key) {
  console.error('❌ FATAL: OPENROUTER_API_KEY not set in environment variables');
  process.exit(1);
}

// 📊 Universal Credentials Loader - Works with File Path OR JSON String OR Render Secret File
function loadGoogleCredentials() {
  const source = CONFIG.sheets.credentialsSource;
  
  if (!source) {
    console.warn('⚠️ GOOGLE_SERVICE_ACCOUNT_KEY not set - Sheets features disabled');
    return null;
  }
  
  // 🎯 Case 1: It's a file path (starts with ./ or / or ~)
  if (source.startsWith('./') || source.startsWith('/') || source.startsWith('~')) {
    const resolvedPath = source.startsWith('~') 
      ? join(process.env.HOME || '', source.slice(2))
      : isAbsolute(source) 
        ? source 
        : join(__dirname, source);
    
    if (!existsSync(resolvedPath)) {
      console.warn(`⚠️ Service account file not found: ${resolvedPath}`);
      return null;
    }
    
    try {
      const credentials = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
      console.log(`✅ Loaded Google credentials from file: ${resolvedPath}`);
      return credentials;
    } catch (error) {
      console.error(`❌ Failed to parse credentials file: ${error.message}`);
      return null;
    }
  }
  
  // 🎯 Case 2: It's a JSON string (production/Render env var)
  try {
    const credentials = JSON.parse(source);
    console.log('✅ Loaded Google credentials from environment variable (JSON string)');
    return credentials;
  } catch (parseError) {
    // 🎯 Case 3: Render Secret File - source is the file CONTENT as string
    // Try parsing it directly (Render mounts secret files as env var content)
    try {
      const credentials = JSON.parse(source.trim());
      console.log('✅ Loaded Google credentials from Render secret file content');
      return credentials;
    } catch (e) {
      console.warn('⚠️ Could not parse GOOGLE_SERVICE_ACCOUNT_KEY as JSON');
      console.warn('💡 Expected: file path (./key.json) OR valid JSON string');
      return null;
    }
  }
}

// Load credentials once at startup
const SHEETS_CREDENTIALS = loadGoogleCredentials();

// 🚀 Express Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalized = origin.replace(/\/$/, '');
    const isAllowed = CONFIG.allowedOrigins.some(o => o?.replace(/\/$/, '') === normalized);
    
    if (isAllowed) {
      console.log(`✅ CORS allowed: ${origin}`);
      return callback(null, true);
    }
    console.warn(`🚫 CORS blocked: ${origin}`);
    callback(new Error(`CORS policy: ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'X-Requested-With', 'Accept', 'Origin']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 📝 Request Logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// 🗄️ Cache & Sessions
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
  validateStatus: status => status < 500
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

// 📊 Google Sheets Auth Client Manager (Auto-Refresh Tokens)
let sheetsAuthClient = null;

async function getSheetsAuthClient() {
  if (!SHEETS_CREDENTIALS) {
    throw new Error('Google Sheets credentials not configured. Add GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_KEY');
  }
  
  if (!sheetsAuthClient) {
    const auth = new GoogleAuth({
      credentials: SHEETS_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsAuthClient = await auth.getClient();
    console.log('✅ Google Sheets auth client initialized');
  }
  
  // Auto-refresh token if expired (google-auth-library handles this)
  await sheetsAuthClient.getAccessToken();
  return sheetsAuthClient;
}

// 📊 Google Sheets API Helper
const sheetsApi = {
  isConfigured: () => !!CONFIG.sheets.spreadsheetId && !!SHEETS_CREDENTIALS,
  
  async append(values) {
    if (!this.isConfigured()) {
      throw new Error('Google Sheets not configured: Add GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_KEY');
    }
    
    const client = await getSheetsAuthClient();
    const token = await client.getAccessToken();
    
    if (!token?.token) throw new Error('Failed to get access token');
    
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheets.spreadsheetId}/values/${CONFIG.sheets.range}:append?valueInputOption=USER_ENTERED`;
    
    const { data } = await axios.post(url, { values: [values] }, {
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    return data;
  },
  
  async getRecent(limit = 20) {
    if (!this.isConfigured()) {
      throw new Error('Google Sheets not configured');
    }
    
    const client = await getSheetsAuthClient();
    const token = await client.getAccessToken();
    
    if (!token?.token) throw new Error('Failed to get access token');
    
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheets.spreadsheetId}/values/${CONFIG.sheets.range}`;
    
    const { data } = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token.token}` },
      timeout: 10000
    });
    
    const rows = data.values || [];
    if (rows.length <= 1) return [];
    
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

// 🛠️ Tool Definitions
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
      description: "Perform math calculations",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"]
      }
    }
  }
];

// 🛠️ Tool Handler
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
      if (!sheetsApi.isConfigured()) {
        return "⚠️ Google Sheets not configured. Contact developer.";
      }
      
      try {
        const lead = LeadSchema.parse(toolArgs);
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        
        await sheetsApi.append([timestamp, lead.name, lead.phone, lead.email || 'N/A', lead.message, lead.interest || 'General']);
        console.log(`✅ Lead saved: ${lead.name} (${lead.phone})`);
        return `✅ Lead saved! Thank you ${lead.name} ji 🙏`;
      } catch (error) {
        console.error("❌ Lead save error:", error.message);
        return `❌ Error: ${error.message}`;
      }
    }
    
    case "calculate": {
      try {
        const sanitized = toolArgs.expression.replace(/[^0-9+\-*/().]/g, '');
        if (!sanitized) throw new Error('Empty');
        const result = Function(`"use strict";return(${sanitized})`)();
        return `🧮 Result: ${result}`;
      } catch { return `❌ Invalid: ${toolArgs.expression}`; }
    }
    
    default: return `⚠️ Unknown tool: ${toolName}`;
  }
}

// 🌐 System Prompts
const getSystemPrompt = (lang) => ({
  eng: "You are Rajkumar, helpful AI. Respond in English. Save leads with save_lead_to_sheet.",
  hin: "आप राजकुमार हैं, सहायक AI। हिंदी में जवाब दें। लीड सेव करने के लिए save_lead_to_sheet टूल उपयोग करें।",
  'hin-eng': "You are Rajkumar, friendly AI. Use Hinglish by default. Save leads when contact info shared."
}[lang] || "You are Rajkumar AI. Be helpful.");

// 🔁 Session Manager
function getOrCreateSession(sessionId, lang = 'hin-eng') {
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    s.lastAccessed = Date.now();
    return { session: s, id: sessionId };
  }
  const newId = sessionId || Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  const session = {
    messages: [{ role: "system", content: getSystemPrompt(lang) }],
    lastAccessed: Date.now(),
    language: lang
  };
  sessions.set(newId, session);
  return { session, id: newId };
}

// 🧹 Cleanup sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.lastAccessed > CONFIG.sessionTimeout) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ===========================================
// 🏥 Endpoints
// ===========================================

app.get('/api/health', (_, res) => res.json({
  status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(),
  sessions: sessions.size, sheetsReady: sheetsApi.isConfigured(), model: CONFIG.openrouter.model
}));

app.get('/api/wake', (_, res) => res.json({ status: 'waking', timestamp: new Date().toISOString() }));
app.post('/api/keep-alive', (_, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));

app.get('/api/trigger-wake', (req, res) =>
  req.query.token === CONFIG.wakeToken
    ? res.json({ status: 'waking', timestamp: new Date().toISOString() })
    : res.status(401).json({ error: 'Unauthorized' })
);

app.get('/api/test', (_, res) => res.json({
  success: true, message: 'Backend working! 🎉', sheetsReady: sheetsApi.isConfigured()
}));

// 🔍 Debug: Check Sheets Config
app.get('/api/debug/sheets', async (_, res) => {
  try {
    const configured = sheetsApi.isConfigured();
    if (!configured) {
      return res.status(503).json({ 
        configured: false, 
        error: 'Missing GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_KEY',
        hint: 'Ensure env vars are set correctly'
      });
    }
    
    const client = await getSheetsAuthClient();
    const token = await client.getAccessToken();
    
    res.json({
      configured: true,
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      credentialsLoaded: !!SHEETS_CREDENTIALS,
      tokenValid: !!token?.token,
      tokenExpiry: client.credentials?.expiry_date ? new Date(client.credentials.expiry_date).toISOString() : 'N/A',
      message: '✅ Google Sheets authentication working!'
    });
  } catch (error) {
    res.status(500).json({ configured: false, error: error.message });
  }
});

app.get('/api/debug/env', (_, res) => res.json({
  NODE_ENV: process.env.NODE_ENV,
  SHEETS_ID: CONFIG.sheets.spreadsheetId ? '✅ Set' : '❌ Missing',
  SHEETS_KEY_SOURCE: CONFIG.sheets.credentialsSource?.startsWith('./') ? '📁 File Path' : '📝 JSON/String',
  SHEETS_CREDENTIALS_LOADED: !!SHEETS_CREDENTIALS,
  OPENROUTER_KEY_SET: !!CONFIG.openrouter.key,
  MODEL: CONFIG.openrouter.model,
  FRONTEND_URL: CONFIG.urls.frontend,
  ALLOWED_ORIGINS: CONFIG.allowedOrigins
}));

// ===========================================
// 🎯 Session Init
// ===========================================
app.post('/api/session/init', (req, res) => {
  try {
    const { preferredLanguage = 'hin-eng' } = req.body;
    const { session, id } = getOrCreateSession(null, preferredLanguage);
    res.json({ sessionId: id, message: 'Session initialized', language: session.language });
  } catch (e) { res.status(500).json({ error: 'Init failed', details: e.message }); }
});

// ===========================================
// 💬 Chat Endpoint
// ===========================================
app.post('/api/chat', async (req, res) => {
  const start = Date.now();
  try {
    const { message, preferredLanguage = 'hin-eng', sessionId } = MessageSchema.parse(req.body);
    const { session, id: sessId } = getOrCreateSession(sessionId, preferredLanguage);
    
    // Cache check
    const key = `${sessId}:${message}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CONFIG.cacheTTL) {
      return res.json({ reply: cached.reply, sessionId: sessId, cached: true, responseTime: Date.now() - start });
    }

    session.messages.push({ role: "user", content: message });
    const history = session.messages.slice(-20);

    // OpenRouter call with retry
    let completion, retries = 0;
    while (retries < 3) {
      try {
        const response = await openRouter.post('/chat/completions', {
          model: CONFIG.openrouter.model,
          messages: history.map(m => ({
            role: m.role === 'tool' ? 'function' : m.role,
            content: m.content,
            tool_call_id: m.tool_call_id
          })).filter(v => v?.content),
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

    const reply = completion?.choices?.[0]?.message;
    if (!reply || (!reply.content && !reply.tool_calls)) throw new Error('Empty AI response');

    // Tool handling
    if (reply.tool_calls?.length > 0) {
      const results = await Promise.all(reply.tool_calls.map(async tc => {
        const args = JSON.parse(tc.function?.arguments || '{}');
        const result = await handleTool(tc.function.name, args);
        return { role: "tool", tool_call_id: tc.id, content: String(result) };
      }));

      session.messages.push(reply, ...results);

      const finalResponse = await openRouter.post('/chat/completions', {
        model: CONFIG.openrouter.model,
        messages: session.messages.slice(-20).map(m => ({
          role: m.role === 'tool' ? 'function' : m.role,
          content: m.content,
          tool_call_id: m.tool_call_id
        })).filter(v => v?.content),
        max_tokens: 1000, temperature: 0.7
      });

      const finalText = finalResponse.data?.choices?.[0]?.message?.content || "Hmm...";
      session.messages.push({ role: "assistant", content: finalText });
      cache.set(key, { reply: finalText, ts: Date.now() });

      return res.json({ reply: finalText, sessionId: sessId, toolUsed: reply.tool_calls[0].function.name, responseTime: Date.now() - start });
    }

    // Normal response
    const text = reply.content || "Hmm...";
    session.messages.push({ role: "assistant", content: text });
    cache.set(key, { reply: text, ts: Date.now() });

    res.json({ reply: text, sessionId: sessId, responseTime: Date.now() - start });

  } catch (error) {
    console.error('💥 Chat error:', { name: error.name, message: error.message, status: error.response?.status });
    
    if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: error.errors.map(e => e.message) });
    const status = error.response?.status;
    if (status === 401) return res.status(401).json({ error: 'Invalid API key' });
    if (status === 402) return res.status(402).json({ error: 'Out of credits' });
    if (status === 404) return res.status(404).json({ error: 'Model not found' });
    if (status === 429) return res.status(429).json({ error: 'Rate limited', retryAfter: 5 });

    res.status(500).json({ error: 'Server error', message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong' });
  }
});

// ===========================================
// 📋 Leads Endpoint
// ===========================================
app.get('/api/leads/recent', async (_, res) => {
  if (!sheetsApi.isConfigured()) {
    return res.status(503).json({ error: 'Sheets not configured', setup: 'Add GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_KEY' });
  }
  try {
    const leads = await sheetsApi.getRecent(20);
    res.json({ leads, count: leads.length });
  } catch (e) {
    console.error('❌ Leads error:', e.message);
    res.status(500).json({ error: 'Fetch failed', details: process.env.NODE_ENV === 'development' ? e.message : undefined });
  }
});

// ===========================================
// 🏠 Root & 404
// ===========================================
app.get('/', (_, res) => res.json({
  service: 'Rajkumar AI Agent API', version: '2.3', model: CONFIG.openrouter.model,
  endpoints: { health: 'GET /api/health', chat: 'POST /api/chat', init: 'POST /api/session/init', leads: 'GET /api/leads/recent', debug: 'GET /api/debug/sheets' }
}));

app.use((req, res) => res.status(404).json({
  error: 'Route not found', path: req.path, method: req.method,
  hint: `Try ${req.method === 'GET' ? 'POST' : 'GET'} for ${req.path}`,
  available: ['GET /', 'GET /api/health', 'POST /api/keep-alive', 'POST /api/session/init', 'POST /api/chat', 'GET /api/leads/recent', 'GET /api/debug/sheets']
}));

app.use((err, req, res, _) => {
  console.error('💥 Global error:', err.message);
  res.status(500).json({ error: 'Internal error', message: process.env.NODE_ENV === 'development' ? err.message : 'Server issue' });
});

// ===========================================
// 🚀 Server Start
// ===========================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  console.log(`🚀 Rajkumar AI Agent Backend v2.3`);
  console.log(`📍 Server: ${CONFIG.urls.self}`);
  console.log(`📦 Model: ${CONFIG.openrouter.model}`);
  console.log(`🔐 OpenRouter: ${CONFIG.openrouter.key ? '✅' : '❌'}`);
  console.log(`📊 Sheets: ${sheetsApi.isConfigured() ? '✅ Ready' : '❌ Not configured'}`);
  console.log(`🔗 CORS: ${CONFIG.allowedOrigins.join(', ')}`);
  console.log('='.repeat(70) + '\n');
});

// 🔄 Self-ping for Render
setInterval(async () => {
  try {
    await axios.get(`${CONFIG.urls.self.replace('localhost', '127.0.0.1')}/api/health`, { timeout: 5000 });
  } catch (e) { console.log('⚠️ Self-ping skipped'); }
}, 14 * 60 * 1000);

// 🛑 Graceful Shutdown
process.on('SIGTERM', () => { console.log('🛑 SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('🛑 SIGINT'); server.close(() => process.exit(0)); });

export default app;