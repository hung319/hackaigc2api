/**
 * =================================================================================
 * Project: HackAIGC-2API (Bun Edition)
 * Role: API Gateway / Proxy
 * Runtime: Bun v1.x
 * * [Chức năng]
 * 1. API Only: Loại bỏ Web UI, chỉ phục vụ JSON/Stream.
 * 2. Middleware: Intercept Midjourney requests -> convert to Markdown images.
 * 3. Auth: Bearer Token verification.
 * =================================================================================
 */

const CONFIG = {
  PORT: Bun.env.PORT || 3000,
  API_MASTER_KEY: Bun.env.API_MASTER_KEY || "sk-hackaigc-free",
  UPSTREAM_URL: Bun.env.UPSTREAM_URL || "https://chat.hackaigc.com",
  USER_AGENT: Bun.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  
  // Model Mapping
  MODEL_MAP: {
    "gpt-4o": "gpt-4o",
    "o1-mini": "o3-mini",
    "claude-3-opus": "mistral",
    "midjourney": "midjourney" 
  }
};

Bun.serve({
  port: CONFIG.PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') return handleCors();

    // 2. Health Check (Thay thế Web UI cũ)
    if (url.pathname === '/' || url.pathname === '/health') {
        return new Response(JSON.stringify({ status: "ok", service: "HackAIGC-2API Bun Adapter" }), {
            headers: corsHeaders({ "Content-Type": "application/json" })
        });
    }

    // 3. Authentication
    if (!verifyAuth(request)) {
      return new Response(JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }), { 
        status: 401, 
        headers: corsHeaders({ "Content-Type": "application/json" }) 
      });
    }

    // 4. Routing (Strip /v1 prefix if present)
    const path = url.pathname.replace('/v1', '');

    try {
        if (path.endsWith('/chat/completions')) return await handleChat(request);
        if (path.endsWith('/images/generations')) return await handleImage(request);
        if (path.endsWith('/models')) return handleModels();
    } catch (e) {
        console.error(`[Error] ${path}:`, e);
        return new Response(JSON.stringify({ error: "Internal Server Error", details: e.message }), { status: 500, headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders() });
  },
});

console.log(`🚀 Server running at http://localhost:${CONFIG.PORT}`);

// --- [Logic Chat & Interceptor] ---
async function handleChat(request) {
  try {
    const body = await request.json();
    let { messages, model, stream } = body;
    
    // Interceptor: Nếu model là midjourney, chuyển sang xử lý ảnh trả về markdown
    if (model && model.includes('midjourney')) {
        return handleImageAsChat(messages, stream);
    }

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
      usedVoiceInput: false,
      deviceId: guestId
    };

    const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/chat`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Upstream Error: ${response.status}`, details: errText }), { 
          status: response.status, 
          headers: corsHeaders({ "Content-Type": "application/json" }) 
      });
    }

    // Proxy Stream
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Background processing without blocking return
    (async () => {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunkText = decoder.decode(value, { stream: true });
          // Filter citation artifacts if necessary
          if (chunkText.includes('"type":"citations"')) continue;

          if (chunkText) {
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: { content: chunkText },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        console.error("Stream Error:", err);
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
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

// --- [Logic Image to Markdown (Chat Adapter)] ---
async function handleImageAsChat(messages, stream) {
    const lastUserMsg = messages.reverse().find(m => m.role === 'user');
    const prompt = lastUserMsg ? lastUserMsg.content : "A cute cat";

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
                    choices: [{ index: 0, delta: { content: markdownContent }, finish_reason: "stop" }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
            })();

            return new Response(readable, {
                headers: corsHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
            });
        } else {
            return new Response(JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "midjourney",
                choices: [{ index: 0, message: { role: "assistant", content: markdownContent }, finish_reason: "stop" }]
            }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
    }
}

// --- [Logic Standard Image API] ---
async function handleImage(request) {
  try {
    const body = await request.json();
    const prompt = body.prompt;
    
    const base64Image = await fetchImageBase64(prompt);

    const openAIResponse = {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: base64Image, revised_prompt: prompt }]
    };

    return new Response(JSON.stringify(openAIResponse), {
      headers: corsHeaders({ "Content-Type": "application/json" })
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: corsHeaders() });
  }
}

// --- [Core Logic: Upstream Fetch] ---
async function fetchImageBase64(prompt) {
    const guestId = generateGuestId();
    const headers = getFakeHeaders(guestId);

    const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/image`, {
      method: "POST",
      headers: { ...headers, "Accept": "image/png,image/jpeg,*/*" },
      body: JSON.stringify({
        prompt: prompt,
        user_id: guestId,
        device_id: guestId,
        user_level: "free"
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Upstream Error (${response.status}): ${errText.substring(0, 100)}`);
    }

    const imageBuffer = await response.arrayBuffer();
    if (imageBuffer.byteLength === 0) throw new Error("Empty image received");
    
    return Buffer.from(imageBuffer).toString('base64');
}

// --- [Utilities] ---
function handleModels() {
  const models = Object.keys(CONFIG.MODEL_MAP).map(id => ({
    id: id, object: "model", created: 1677610602, owned_by: "hackaigc"
  }));
  return new Response(JSON.stringify({ object: "list", data: models }), { headers: corsHeaders() });
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
    "Origin": CONFIG.UPSTREAM_URL,
    "Referer": `${CONFIG.UPSTREAM_URL}/`,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip
  };
}

function verifyAuth(req) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return false;
  const token = authHeader.replace('Bearer ', '').trim();
  return token === CONFIG.API_MASTER_KEY;
}

function handleCors() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}
