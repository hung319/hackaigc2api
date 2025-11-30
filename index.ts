/**
 * =================================================================================
 * HackAIGC-2API (Bun Edition) - Fixed Chat Logic
 * =================================================================================
 */

// Xử lý URL config để tránh lỗi 2 dấu gạch chéo (//api/chat)
const RAW_UPSTREAM = Bun.env.UPSTREAM_URL || "https://chat.hackaigc.com";
const UPSTREAM_URL = RAW_UPSTREAM.replace(/\/+$/, ""); 

const CONFIG = {
  PORT: Bun.env.PORT || 3000,
  API_MASTER_KEY: Bun.env.API_MASTER_KEY || "sk-hackaigc-free",
  USER_AGENT: Bun.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  
  MODEL_MAP: {
    "gpt-4o": "gpt-4o",
    "gpt-4o-mini": "gpt-4o-mini",
    "gpt-4-turbo": "gpt-4-turbo",
    "claude-3-5-sonnet": "claude-3-5-sonnet",
    "midjourney": "midjourney" 
  }
};

Bun.serve({
  port: CONFIG.PORT,
  async fetch(request) {
    const url = new URL(request.url);
    
    // 1. CORS Preflight
    if (request.method === 'OPTIONS') return handleCors();

    // 2. Routing Normalization
    let pathname = url.pathname;
    if (pathname.startsWith('/v1/')) pathname = pathname.substring(3);
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    // 3. Health Check
    if (pathname === '/' || pathname === '/health') {
        return new Response(JSON.stringify({ status: "ok", mode: "bun-adapter" }), { headers: corsHeaders() });
    }

    // 4. Auth
    if (!verifyAuth(request) && pathname !== '/models') {
      return new Response(JSON.stringify({
        error: { message: "Invalid API Key", type: "auth_error", code: "401" }
      }), { status: 401, headers: corsHeaders() });
    }

    try {
        if (pathname === '/chat/completions') return await handleChat(request);
        if (pathname === '/images/generations') return await handleImage(request);
        if (pathname === '/models') return handleModels(); 
        
        return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders() });
    } catch (e) {
        console.error(`❌ Global Error:`, e);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
    }
  },
});

console.log(`🚀 Server running on port ${CONFIG.PORT}`);
console.log(`🔗 Upstream: ${UPSTREAM_URL}`);

// --- [Logic: Chat Completion] ---
async function handleChat(request) {
  try {
    const body = await request.json();
    let { messages, model, stream } = body;

    // 1. Midjourney Interceptor
    if (model && model.toLowerCase().includes('midjourney')) {
        return handleImageAsChat(messages, stream);
    }

    // 2. Prepare Payload (Sao chép chính xác logic file gốc)
    const internalModel = CONFIG.MODEL_MAP[model] || "gpt-3.5-turbo";
    const filteredMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const guestId = generateGuestId(); // <--- Đã fix độ dài ID
    const headers = getFakeHeaders(guestId);

    const upstreamPayload = {
      user_id: guestId,
      user_level: "free",
      model: internalModel,
      messages: filteredMessages,
      prompt: "",
      temperature: body.temperature || 0.7,
      enableWebSearch: false,
      usedVoiceInput: false,
      deviceId: guestId
    };

    console.log(`Sending to Upstream [${internalModel}]...`);

    // 3. Fetch Upstream
    const response = await fetch(`${UPSTREAM_URL}/api/chat`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ Upstream Error ${response.status}:`, errText);
        return new Response(JSON.stringify({ error: `Upstream Error: ${response.status}`, details: errText }), { 
            status: response.status, headers: corsHeaders() 
        });
    }

    // 4. Stream Handling
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Chạy nền để không block request
    (async () => {
      const reader = response.body.getReader();
      let hasReceivedData = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunkText = decoder.decode(value, { stream: true });
          
          // Debug dòng đầu tiên để xem nó trả về cái gì
          if (!hasReceivedData) {
            console.log(`✅ First chunk received (${chunkText.length} bytes):`, chunkText.substring(0, 50));
            hasReceivedData = true;
          }

          // Filter rác (file gốc có đoạn này)
          if (chunkText.includes('"type":"citations"')) continue;

          if (chunkText) {
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{ index: 0, delta: { content: chunkText }, finish_reason: null }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        console.error("Stream Loop Error:", err);
        await writer.write(encoder.encode(`data: {"error": "${err.message}"}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      })
    });

  } catch (e) {
    console.error("HandleChat Exception:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

// --- [Logic: Standard Models] ---
function handleModels() {
  const modelsData = Object.keys(CONFIG.MODEL_MAP).map(id => ({
    id: id, object: "model", created: 1677610602, owned_by: "openai", permission: []
  }));
  return new Response(JSON.stringify({ object: "list", data: modelsData }), { headers: corsHeaders() });
}

// --- [Logic: Image Handlers] ---
async function handleImageAsChat(messages, stream) {
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    const prompt = lastMsg ? lastMsg.content : "A cute cat";
    try {
        const b64 = await fetchImageBase64(prompt);
        const md = `🎨 **Generated Image**\n\n![Img](data:image/png;base64,${b64})`;
        
        if (stream) {
            const encoder = new TextEncoder();
            const s = new ReadableStream({
                async start(c) {
                    const chunk = { choices: [{ delta: { content: md }, finish_reason: "stop" }] };
                    c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    c.enqueue(encoder.encode("data: [DONE]\n\n"));
                    c.close();
                }
            });
            return new Response(s, { headers: corsHeaders({ "Content-Type": "text/event-stream" }) });
        } else {
            return new Response(JSON.stringify({ choices: [{ message: { content: md } }] }), { headers: corsHeaders() });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
    }
}

async function handleImage(request) {
    try {
        const body = await request.json();
        const b64 = await fetchImageBase64(body.prompt);
        return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { headers: corsHeaders() });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
    }
}

// --- [Helpers] ---
async function fetchImageBase64(prompt) {
    const guestId = generateGuestId();
    const res = await fetch(`${UPSTREAM_URL}/api/image`, {
        method: "POST", headers: getFakeHeaders(guestId),
        body: JSON.stringify({ prompt, user_id: guestId, device_id: guestId, user_level: "free" })
    });
    if (!res.ok) throw new Error(`Upstream Image Error: ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
}

// ★★★ QUAN TRỌNG: Hàm tạo ID giống hệt bản gốc (32 ký tự hex) ★★★
function generateGuestId() {
  const randomHex = Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `guest_${randomHex}`;
}

function getFakeHeaders(guestId) {
  // Tạo IP ngẫu nhiên để tránh rate limit theo IP
  const ip = `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer anonymous_${guestId}`,
    "User-Agent": CONFIG.USER_AGENT,
    "Origin": UPSTREAM_URL,
    "Referer": `${UPSTREAM_URL}/`,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip
  };
}

function verifyAuth(req) {
    const auth = req.headers.get("Authorization");
    if (!auth) return false;
    return auth.replace('Bearer ', '').trim() === CONFIG.API_MASTER_KEY;
}

function handleCors() {
    return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
    return {
        ...headers,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
        "Content-Type": "application/json"
    };
}
