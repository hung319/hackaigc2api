/**
 * =================================================================================
 * HackAIGC-2API (Bun Edition) - Fixed Non-Stream Support (n8n Compatible)
 * =================================================================================
 */

// Xử lý URL config
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
    
    if (request.method === 'OPTIONS') return handleCors();

    let pathname = url.pathname;
    if (pathname.startsWith('/v1/')) pathname = pathname.substring(3);
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    console.log(`[${request.method}] ${pathname}`);

    if (pathname === '/' || pathname === '/health') {
        return new Response(JSON.stringify({ status: "ok", mode: "bun-adapter" }), { headers: corsHeaders() });
    }

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

// --- [Logic: Chat Completion (Dual Mode)] ---
async function handleChat(request) {
  try {
    const body = await request.json();
    // Default stream là false nếu client không gửi
    let { messages, model, stream = false } = body;

    // 1. Midjourney Interceptor
    if (model && model.toLowerCase().includes('midjourney')) {
        return handleImageAsChat(messages, stream);
    }

    // 2. Prepare Payload
    const internalModel = CONFIG.MODEL_MAP[model] || "gpt-3.5-turbo";
    const filteredMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const guestId = generateGuestId();
    const headers = getFakeHeaders(guestId);

    const upstreamPayload = {
      user_id: guestId,
      user_level: "free",
      model: internalModel,
      messages: filteredMessages,
      prompt: "",
      temperature: body.temperature || 0.7,
      enableWebSearch: false,
      deviceId: guestId
    };

    console.log(`Requesting [${internalModel}] | Stream: ${stream}`);

    // 3. Fetch Upstream
    const response = await fetch(`${UPSTREAM_URL}/api/chat`, {
      method: "POST", headers: headers, body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
        const errText = await response.text();
        return new Response(JSON.stringify({ error: `Upstream Error: ${response.status}`, details: errText }), { 
            status: response.status, headers: corsHeaders() 
        });
    }

    // 4. Xử lý phản hồi (Chia nhánh Stream vs Buffered)
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    if (stream) {
        // === MODE A: STREAMING (SSE) ===
        // Trả về từng chunk ngay lập tức cho Client (Chat UI)
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunkText = decoder.decode(value, { stream: true });
                    
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
                console.error("Stream Error:", err);
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

    } else {
        // === MODE B: BUFFERED (JSON) ===
        // Gom toàn bộ text lại rồi trả về 1 cục JSON (dành cho n8n, Postman)
        let fullContent = "";
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            
            if (chunkText.includes('"type":"citations"')) continue;
            fullContent += chunkText;
        }

        // Tạo JSON Response chuẩn OpenAI
        const jsonResponse = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: fullContent
                },
                finish_reason: "stop"
            }],
            usage: {
                prompt_tokens: 0,
                completion_tokens: fullContent.length,
                total_tokens: fullContent.length
            }
        };

        return new Response(JSON.stringify(jsonResponse), {
            headers: corsHeaders({ "Content-Type": "application/json" })
        });
    }

  } catch (e) {
    console.error("HandleChat Error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

// --- [Các phần còn lại giữ nguyên] ---
function handleModels() {
  const modelsData = Object.keys(CONFIG.MODEL_MAP).map(id => ({
    id: id, object: "model", created: 1677610602, owned_by: "openai", permission: []
  }));
  return new Response(JSON.stringify({ object: "list", data: modelsData }), { headers: corsHeaders() });
}

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
            return new Response(JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                choices: [{ message: { role: "assistant", content: md }, finish_reason: "stop" }] 
            }), { headers: corsHeaders() });
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

function generateGuestId() {
  const randomHex = Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `guest_${randomHex}`;
}

function getFakeHeaders(guestId) {
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
