/**
 * =================================================================================
 * Project: HackAIGC-2API (Standard OpenAI Edition)
 * Refactored by: CezDev
 * Runtime: Bun v1.x
 * * [Change Log v2]
 * 1. Hỗ trợ đầy đủ Non-Stream (Request đợi generate xong mới trả JSON).
 * 2. Chuẩn hóa format response OpenAI (bao gồm field 'usage').
 * 3. Tự động gom stream từ upstream để trả về Non-stream nếu client yêu cầu.
 * =================================================================================
 */

// 1. Config & Environment
const CONFIG = {
  PORT: parseInt(Bun.env.PORT || "3000"),
  API_MASTER_KEY: Bun.env.API_MASTER_KEY || "sk-hackaigc-free",
  UPSTREAM_URL: Bun.env.UPSTREAM_URL || "https://chat.hackaigc.com",
  USER_AGENT: Bun.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  
  MODEL_MAP: {
    "gpt-4o": "gpt-4o",
    "gpt-4-turbo": "gpt-4o",
    "o1-mini": "o3-mini",
    "claude-3-opus": "mistral",
    "midjourney": "midjourney" 
  }
};

console.log(`🚀 OpenAI Standard Proxy running on port ${CONFIG.PORT}`);

// 2. Server Entry
Bun.serve({
  port: CONFIG.PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // CORS & Health
    if (request.method === 'OPTIONS') return handleCors();
    if (url.pathname === '/health') return new Response("OK", { status: 200 });

    // Auth
    if (!verifyAuth(request)) {
      return errorResponse("Unauthorized", "auth_error", 401);
    }

    // Routing
    const path = url.pathname.replace('/v1', '');

    if (path.endsWith('/chat/completions') && request.method === 'POST') return handleChat(request);
    if (path.endsWith('/images/generations') && request.method === 'POST') return handleImage(request);
    if (path.endsWith('/models')) return handleModels();

    return errorResponse("Not Found", "invalid_request_error", 404);
  }
});

// --- [Logic Core: Chat Completion] ---
async function handleChat(request) {
  try {
    const body = await request.json();
    let { messages, model, stream = false, temperature = 0.7 } = body; // Default stream to false

    // ★ Interceptor: Midjourney as Chat
    if (model.includes('midjourney')) {
        return handleImageAsChat(messages, stream);
    }

    // Prepare Upstream Request
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
        const text = await response.text();
        return errorResponse(`Upstream Error: ${response.status} - ${text}`, "upstream_error", response.status);
    }

    // ★ Fork: Stream vs Non-Stream handling
    // Upstream luôn trả về Stream, nên ta cần xử lý 2 case:
    // 1. Client cần Stream -> Pipe thẳng (Transform).
    // 2. Client cần Non-Stream -> Đọc hết Stream, gom text, trả JSON.
    
    if (stream) {
        return handleStreamProxy(response, model);
    } else {
        return handleNonStreamProxy(response, model);
    }

  } catch (e) {
    console.error(e);
    return errorResponse(e.message, "server_error", 500);
  }
}

// --- [Handler A: Streaming Response (SSE)] ---
async function handleStreamProxy(upstreamResponse, model) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
        const reader = upstreamResponse.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunkText = decoder.decode(value, { stream: true });
                // Filter out upstream noise if needed
                if (chunkText.includes('"type":"citations"')) continue; 

                if (chunkText) {
                    const chunk = createOpenAIChunk(chunkText, model);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
            }
            await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (err) {
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
}

// --- [Handler B: Non-Streaming Response (Standard JSON)] ---
async function handleNonStreamProxy(upstreamResponse, model) {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";

    // 1. Consume the entire stream
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunkText = decoder.decode(value, { stream: true });
        if (chunkText.includes('"type":"citations"')) continue;
        
        if (chunkText) {
            fullContent += chunkText;
        }
    }

    // 2. Construct Standard OpenAI JSON
    const responseId = `chatcmpl-${Date.now()}`;
    const jsonResponse = {
        id: responseId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: fullContent
                },
                finish_reason: "stop"
            }
        ],
        usage: {
            prompt_tokens: 0, // Mock value
            completion_tokens: estimateTokenCount(fullContent),
            total_tokens: estimateTokenCount(fullContent)
        }
    };

    return new Response(JSON.stringify(jsonResponse), {
        headers: corsHeaders({ "Content-Type": "application/json" })
    });
}

// --- [Logic: Midjourney Adapter] ---
async function handleImageAsChat(messages, stream) {
    const lastUserMsg = messages.reverse().find(m => m.role === 'user');
    const prompt = lastUserMsg ? lastUserMsg.content : "Abstract art";

    try {
        const base64Image = await fetchImageBase64(prompt);
        const markdownContent = `🎨 **绘图完成**\n\n![Generated Image](data:image/png;base64,${base64Image})`;
        const model = "midjourney";

        if (stream) {
            // Simulate Streaming
            const encoder = new TextEncoder();
            const { readable, writable } = new TransformStream();
            const writer = writable.getWriter();
            (async () => {
                const chunk = createOpenAIChunk(markdownContent, model);
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
            })();
            return new Response(readable, {
                headers: corsHeaders({ "Content-Type": "text/event-stream" })
            });
        } else {
            // Standard JSON
            return new Response(JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{ 
                    index: 0, 
                    message: { role: "assistant", content: markdownContent }, 
                    finish_reason: "stop" 
                }],
                usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 }
            }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
        }
    } catch (e) {
        return errorResponse(e.message, "image_generation_error", 500);
    }
}

// --- [Logic: Standard Image Endpoint] ---
async function handleImage(request) {
    try {
        const body = await request.json();
        const prompt = body.prompt;
        const base64Image = await fetchImageBase64(prompt);

        return new Response(JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: base64Image, revised_prompt: prompt }]
        }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
    } catch (e) {
        return errorResponse(e.message, "image_error", 500);
    }
}

// --- [Helpers: Network & Utilities] ---

async function fetchImageBase64(prompt) {
    const guestId = generateGuestId();
    const headers = getFakeHeaders(guestId);
    
    // Upstream image API call
    const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/image`, {
        method: "POST",
        headers: { ...headers, "Accept": "image/png,image/jpeg,*/*" },
        body: JSON.stringify({ prompt, user_id: guestId, device_id: guestId, user_level: "free" })
    });

    if (!response.ok) throw new Error(`Upstream Image Error: ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) throw new Error("Empty image received");
    return Buffer.from(buffer).toString('base64');
}

function createOpenAIChunk(content, model) {
    return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            delta: { content: content },
            finish_reason: null
        }]
    };
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

function estimateTokenCount(text) {
    return Math.ceil(text.length / 4); // Rough estimation
}

// --- [API Models Endpoint] ---
function handleModels() {
    const data = Object.keys(CONFIG.MODEL_MAP).map(id => ({
        id: id, object: "model", created: 1677610602, owned_by: "openai"
    }));
    return new Response(JSON.stringify({ object: "list", data }), { headers: corsHeaders() });
}
