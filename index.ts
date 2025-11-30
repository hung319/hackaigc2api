/**
 * =================================================================================
 * HackAIGC-2API (Bun Edition) - OpenAI Standard Compliant
 * =================================================================================
 */

const CONFIG = {
  PORT: Bun.env.PORT || 3000,
  API_MASTER_KEY: Bun.env.API_MASTER_KEY || "sk-hackaigc-free",
  UPSTREAM_URL: Bun.env.UPSTREAM_URL || "https://chat.hackaigc.com",
  USER_AGENT: Bun.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  
  // Model Mapping: Key là tên model hiển thị cho Client, Value là model gửi đi upstream
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
    
    // 1. CORS Preflight (Bắt buộc cho Web Apps)
    if (request.method === 'OPTIONS') return handleCors();

    // 2. Định tuyến (Routing)
    // Hỗ trợ cả /v1/models và /models, có hoặc không có dấu / ở cuối
    let pathname = url.pathname;
    if (pathname.startsWith('/v1/')) {
        pathname = pathname.substring(3); // Bỏ /v1
    }
    // Bỏ dấu / ở cuối nếu có (trừ root)
    if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
    }

    console.log(`[${request.method}] Path: ${pathname}`); // Debug log

    // 3. Health Check
    if (pathname === '/' || pathname === '/health') {
        return new Response(JSON.stringify({ status: "ok", system: "HackAIGC Gateway" }), {
            headers: corsHeaders({ "Content-Type": "application/json" })
        });
    }

    // 4. Authentication Check
    // Lưu ý: OpenAI yêu cầu Auth cho endpoint Models.
    if (!verifyAuth(request)) {
      return new Response(JSON.stringify({
        error: {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key"
        }
      }), { 
        status: 401, 
        headers: corsHeaders({ "Content-Type": "application/json" }) 
      });
    }

    // 5. API Handlers
    try {
        if (pathname === '/chat/completions') return await handleChat(request);
        if (pathname === '/images/generations') return await handleImage(request);
        if (pathname === '/models') return handleModels(); // <--- Standard Models Handler
        
        return new Response(JSON.stringify({ error: { message: `Path '${pathname}' not found` } }), { status: 404, headers: corsHeaders() });
    } catch (e) {
        console.error(`Error processing ${pathname}:`, e);
        return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: corsHeaders() });
    }
  },
});

console.log(`🚀 Server listening on port ${CONFIG.PORT}`);

// --- [Logic: Standard OpenAI Models] ---
// Trả về danh sách model đúng chuẩn OpenAI Spec
function handleModels() {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  
  const modelsData = Object.keys(CONFIG.MODEL_MAP).map(modelId => ({
    id: modelId,
    object: "model",
    created: 1677610602, // Mốc thời gian cố định hoặc currentTimestamp
    owned_by: "openai",  // GIỮ NGUYÊN "openai" hoặc "system" để client nhận diện tốt nhất
    permission: [        // Một số client cũ yêu cầu trường này
        {
            id: `modelperm-${modelId}`,
            object: "model_permission",
            created: currentTimestamp,
            allow_create_engine: false,
            allow_sampling: true,
            allow_logprobs: true,
            allow_search_indices: false,
            allow_view: true,
            allow_fine_tuning: false,
            organization: "*",
            group: null,
            is_blocking: false
        }
    ],
    root: modelId,
    parent: null
  }));

  return new Response(JSON.stringify({
    object: "list",
    data: modelsData
  }), {
    headers: corsHeaders({ "Content-Type": "application/json" })
  });
}

// --- [Logic: Chat Completion] ---
async function handleChat(request) {
  try {
    const body = await request.json();
    let { messages, model, stream } = body;

    // Midjourney Interceptor
    if (model && model.toLowerCase().includes('midjourney')) {
        return handleImageAsChat(messages, stream);
    }

    const internalModel = CONFIG.MODEL_MAP[model] || "gpt-3.5-turbo";
    const filteredMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const guestId = generateGuestId();
    
    // Upstream Request
    const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/chat`, {
      method: "POST",
      headers: getFakeHeaders(guestId),
      body: JSON.stringify({
        user_id: guestId,
        user_level: "free",
        model: internalModel,
        messages: filteredMessages,
        temperature: body.temperature || 0.7,
        enableWebSearch: false, // Tắt search để nhanh hơn
        deviceId: guestId
      })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Upstream ${response.status}: ${errText}`);
    }

    // Stream Handling
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkText = decoder.decode(value, { stream: true });
          // Filter rác nếu cần
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
        const errChunk = { error: err.message };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
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
    return new Response(JSON.stringify({ error: { message: e.message, type: "server_error" } }), { status: 500, headers: corsHeaders() });
  }
}

// --- [Logic: Image Adapter] ---
async function handleImageAsChat(messages, stream) {
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    const prompt = lastMsg ? lastMsg.content : "A cute cat";
    
    try {
        const b64 = await fetchImageBase64(prompt);
        const md = `🎨 **Generated Image**\n\n![Img](data:image/png;base64,${b64})`;
        
        // Trả về định dạng Stream giả lập để Client tưởng là Chat
        if (stream) {
            const encoder = new TextEncoder();
            const s = new ReadableStream({
                async start(controller) {
                    const chunk = {
                        id: `chatcmpl-${Date.now()}`,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: "midjourney",
                        choices: [{ index: 0, delta: { content: md }, finish_reason: "stop" }]
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                }
            });
            return new Response(s, { headers: corsHeaders({ "Content-Type": "text/event-stream" }) });
        } 
        // Trả về JSON thường
        else {
            return new Response(JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "midjourney",
                choices: [{ index: 0, message: { role: "assistant", content: md }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
            }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: corsHeaders() });
    }
}

// --- [Logic: Standard Image Gen] ---
async function handleImage(request) {
    try {
        const body = await request.json();
        const b64 = await fetchImageBase64(body.prompt);
        return new Response(JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: b64, revised_prompt: body.prompt }]
        }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
    } catch (e) {
        return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: corsHeaders() });
    }
}

// --- [Helpers] ---
async function fetchImageBase64(prompt) {
    const guestId = generateGuestId();
    const headers = getFakeHeaders(guestId);
    // Giả lập gọi upstream
    const res = await fetch(`${CONFIG.UPSTREAM_URL}/api/image`, {
        method: "POST", headers: { ...headers, "Accept": "image/*" },
        body: JSON.stringify({ prompt, user_id: guestId, device_id: guestId, user_level: "free" })
    });
    if (!res.ok) throw new Error(`Upstream Image Error: ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error("Empty image");
    return Buffer.from(buf).toString('base64');
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
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Allow-Credentials": "true"
    };
}

function generateGuestId() { return `guest_${Math.random().toString(36).slice(2)}`; }

function getFakeHeaders(guestId) {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer anonymous_${guestId}`,
        "User-Agent": CONFIG.USER_AGENT,
        "Origin": CONFIG.UPSTREAM_URL,
        "Referer": `${CONFIG.UPSTREAM_URL}/`
    };
}
