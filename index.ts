/**
 * =================================================================================
 * Project: HackAIGC-2API (v2.1 Fix Models)
 * Refactored by: CezDev
 * Runtime: Bun v1.x
 * =================================================================================
 */

// 1. Config
const CONFIG = {
  PORT: parseInt(Bun.env.PORT || "3000"),
  API_MASTER_KEY: Bun.env.API_MASTER_KEY || "sk-hackaigc-free",
  UPSTREAM_URL: Bun.env.UPSTREAM_URL || "https://chat.hackaigc.com",
  USER_AGENT: Bun.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  
  // Mapping: Key (Tên hiển thị cho Client) -> Value (Tên model gửi lên Upstream)
  MODEL_MAP: {
    "gpt-4o": "gpt-4o",
    "gpt-4-turbo": "gpt-4o",
    "gpt-3.5-turbo": "gpt-3.5-turbo",
    "o1-mini": "o3-mini",
    "claude-3-opus": "mistral",
    "midjourney": "midjourney" 
  }
};

console.log(`🚀 Service running on port ${CONFIG.PORT} (Models Fixed)`);

// 2. Server Entry
Bun.serve({
  port: CONFIG.PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // CORS Preflight
    if (request.method === 'OPTIONS') return handleCors();
    
    // Health Check
    if (url.pathname === '/health') return new Response("OK", { status: 200 });

    // Authentication
    if (!verifyAuth(request)) {
      return errorResponse("Unauthorized", "auth_error", 401);
    }

    // Routing Logic (Xử lý đường dẫn chuẩn hơn)
    // Loại bỏ /v1 ở đầu nếu có để dễ xử lý
    let path = url.pathname;
    if (path.startsWith('/v1')) {
        path = path.slice(3); // Remove '/v1'
    }

    // --- Routes ---
    
    // 1. GET /models
    if (path === '/models' && request.method === 'GET') {
        return handleModels();
    }

    // 2. POST /chat/completions
    if (path === '/chat/completions' && request.method === 'POST') {
        return handleChat(request);
    }

    // 3. POST /images/generations
    if (path === '/images/generations' && request.method === 'POST') {
        return handleImage(request);
    }

    return errorResponse("Not Found", "invalid_request_error", 404);
  }
});

// --- [Handler: Models List] (ĐÃ SỬA) ---
function handleModels() {
    // Tự động tạo list từ MODEL_MAP
    const data = Object.keys(CONFIG.MODEL_MAP).map(id => ({
        id: id,
        object: "model",
        created: 1715367049, // Timestamp tĩnh
        owned_by: "system", // 'system' hoặc 'openai' đều được
        permission: [],
        root: id,
        parent: null
    }));

    return new Response(JSON.stringify({ object: "list", data: data }), {
        // ★ QUAN TRỌNG: Phải có Content-Type application/json
        headers: corsHeaders({ "Content-Type": "application/json" }) 
    });
}

// --- [Handler: Chat] ---
async function handleChat(request) {
  try {
    const body = await request.json();
    let { messages, model, stream = false, temperature = 0.7 } = body;

    // Interceptor: Midjourney as Chat
    if (model.includes('midjourney')) {
        return handleImageAsChat(messages, stream);
    }

    // Normal Chat Proxy
    const internalModel = CONFIG.MODEL_MAP[model] || "gpt-3.5-turbo";
    const guestId = generateGuestId();
    const headers = getFakeHeaders(guestId);

    const upstreamPayload = {
      user_id: guestId,
      user_level: "free",
      model: internalModel,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      prompt: "",
      temperature: temperature,
      enableWebSearch: false,
      deviceId: guestId
    };

    const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/chat`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
        return errorResponse(`Upstream Error: ${response.status}`, "upstream_error", response.status);
    }

    if (stream) {
        return handleStreamProxy(response, model);
    } else {
        return handleNonStreamProxy(response, model);
    }

  } catch (e) {
    return errorResponse(e.message, "server_error", 500);
  }
}

// --- [Handler: Stream Proxy] ---
async function handleStreamProxy(upstreamResponse, model) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    (async () => {
        const reader = upstreamResponse.body.getReader();
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
        } catch (e) {
            await writer.write(encoder.encode(`data: {"error": "${e.message}"}\n\n`));
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
}

// --- [Handler: Non-Stream Proxy] ---
async function handleNonStreamProxy(upstreamResponse, model) {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        if (!chunkText.includes('"type":"citations"')) {
            fullContent += chunkText;
        }
    }

    const jsonResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: fullContent.length, total_tokens: fullContent.length }
    };

    return new Response(JSON.stringify(jsonResponse), {
        headers: corsHeaders({ "Content-Type": "application/json" })
    });
}

// --- [Handler: Image as Chat (Midjourney)] ---
async function handleImageAsChat(messages, stream) {
    const lastUserMsg = messages.reverse().find(m => m.role === 'user');
    const prompt = lastUserMsg ? lastUserMsg.content : "Abstract art";

    try {
        const base64Image = await fetchImageBase64(prompt);
        const markdownContent = `🎨 **绘图完成**\n\n![Generated Image](data:image/png;base64,${base64Image})`;
        
        if (stream) {
            const encoder = new TextEncoder();
            const { readable, writable } = new TransformStream();
            const writer = writable.getWriter();
            (async () => {
                const chunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: "midjourney",
                    choices: [{ index: 0, delta: { content: markdownContent }, finish_reason: null }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
            })();
            return new Response(readable, { headers: corsHeaders({ "Content-Type": "text/event-stream" }) });
        } else {
            return new Response(JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "midjourney",
                choices: [{ index: 0, message: { role: "assistant", content: markdownContent }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 }
            }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
        }
    } catch (e) {
        return errorResponse(e.message, "image_error", 500);
    }
}

// --- [Handler: Standard Image] ---
async function handleImage(request) {
    try {
        const body = await request.json();
        const base64Image = await fetchImageBase64(body.prompt);
        return new Response(JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: base64Image, revised_prompt: body.prompt }]
        }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
    } catch (e) {
        return errorResponse(e.message, "image_error", 500);
    }
}

// --- [Helpers] ---
async function fetchImageBase64(prompt) {
    const guestId = generateGuestId();
    const headers = getFakeHeaders(guestId);
    const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/image`, {
        method: "POST",
        headers: { ...headers, "Accept": "image/png,image/jpeg,*/*" },
        body: JSON.stringify({ prompt, user_id: guestId, device_id: guestId, user_level: "free" })
    });
    if (!response.ok) throw new Error("Upstream Image Failed");
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) throw new Error("Empty Image");
    return Buffer.from(buffer).toString('base64');
}

function generateGuestId() {
    return `guest_${Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
}

function getFakeHeaders(guestId) {
    const ip = `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer anonymous_${guestId}`,
        "User-Agent": CONFIG.USER_AGENT,
        "Origin": CONFIG.UPSTREAM_URL,
        "Referer": `${CONFIG.UPSTREAM_URL}/`,
        "X-Forwarded-For": ip,
        "X-Real-IP": ip
    };
}

function verifyAuth(req) {
    const auth = req.headers.get("Authorization");
    return auth && auth.replace('Bearer ', '').trim() === CONFIG.API_MASTER_KEY;
}

function errorResponse(message, type, status) {
    return new Response(JSON.stringify({
        error: { message, type, param: null, code: status }
    }), { status, headers: corsHeaders({ "Content-Type": "application/json" }) });
}

function corsHeaders(extra = {}) {
    return {
        ...extra,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*"
    };
}

function handleCors() {
    return new Response(null, { status: 204, headers: corsHeaders() });
}
