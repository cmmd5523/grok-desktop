const XAI_BASE_FALLBACK = 'https://api.x.ai/v1';
const CONNECT_TIMEOUT_MS = 20000;

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(baseUrl) {
  let url = (baseUrl || '').trim();
  if (!url) url = XAI_BASE_FALLBACK;
  return url.replace(/\/+$/, '');
}

async function jsonOrText(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function friendlyStatus(status, body) {
  let detail = '';
  if (body && typeof body === 'object' && body.error) {
    detail =
      typeof body.error === 'string' ? body.error : body.error.message || JSON.stringify(body.error);
  }
  if (typeof body === 'string' && body && body !== 'OK') detail = body;
  if (status === 401) return `API Key 无效或已过期${detail ? `(${detail})` : ''}`;
  if (status === 403) return `没有访问权限(${status})${detail ? `: ${detail}` : ''}`;
  if (status === 404) return `接口或路径不存在(${status}),请检查 API 地址是否正确`;
  if (status === 429) return `请求过于频繁,已触发限流(${status}),请稍后再试`;
  if (status >= 500) return `服务器错误(${status}),请稍后重试`;
  return `API 请求失败(${status})${detail ? `: ${detail}` : ''}`;
}

/**
 * fetch with a connect timeout; the user's AbortSignal keeps working
 * after the headers have arrived (used for cancelling long streams).
 */
async function fetchWithConnectTimeout(url, options, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error('连接 API 服务器超时,请检查网络或 API 地址')),
    CONNECT_TIMEOUT_MS
  );
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function parseSseDataLine(line, onDelta, onUsage, onError) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return;
  }
  // grok2api surfaces upstream failures as {"error": {...}} SSE chunks.
  if (chunk.error) {
    if (onError) onError(chunk.error);
    return;
  }
  const choice = chunk.choices && chunk.choices[0];
  const delta = choice && choice.delta;
  if (delta && typeof delta.content === 'string' && delta.content) onDelta(delta.content);
  if (chunk.usage) onUsage(chunk.usage);
}

async function listModels(baseUrl, apiKey) {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const res = await fetchWithConnectTimeout(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await jsonOrText(res).catch(() => null);
    throw new ApiError(friendlyStatus(res.status, body), res.status, body);
  }
  const json = await res.json();
  return (json.data || [])
    .map((m) => m.id)
    .filter((id) => typeof id === 'string' && id.trim());
}

async function streamChat({ baseUrl, apiKey, model, messages, signal, onDelta }) {
  if (!apiKey) throw new Error('缺少 API Key');
  if (!model) throw new Error('未选择模型');

  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const res = await fetchWithConnectTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    },
    signal
  );

  if (!res.ok) {
    const body = await jsonOrText(res).catch(() => null);
    throw new ApiError(friendlyStatus(res.status, body), res.status, body);
  }
  if (!res.body) throw new Error('响应没有可读流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let deltaCount = 0;
  let streamError = null;

  const handleLine = (line) =>
    parseSseDataLine(
      line,
      (d) => {
        deltaCount += 1;
        onDelta(d);
      },
      (u) => (usage = u),
      (e) => {
        streamError = streamError || e;
      }
    );

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  }
  // flush a trailing line without a newline
  if (buffer.trim()) handleLine(buffer);

  if (streamError) {
    // Upstream rejected the request mid-stream (e.g. Console API 403 for
    // reasoning-tier models). Surface the real message instead of pretending
    // the response was empty.
    const msg = typeof streamError === 'string' ? streamError : streamError.message || '上游服务错误';
    const code = streamError && typeof streamError === 'object' ? streamError.code : '';
    throw new ApiError(
      `上游服务返回错误:${msg}${code ? `(${code})` : ''}。该模型(推理等级)可能被网关或上游限制,请尝试将推理等级设为「关」(使用 grok-4.3-fast)后再试`,
      null,
      streamError
    );
  }
  if (deltaCount === 0 && !usage) {
    throw new Error('服务器返回了空响应,请检查 API 地址是否正确指向 grok2api 服务');
  }
  return usage;
}

async function completeChat({ baseUrl, apiKey, model, messages, signal }) {
  if (!apiKey) throw new Error('缺少 API Key');
  if (!model) throw new Error('未选择模型');
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const res = await fetchWithConnectTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: false }),
    },
    signal
  );
  if (!res.ok) {
    const body = await jsonOrText(res).catch(() => null);
    throw new ApiError(friendlyStatus(res.status, body), res.status, body);
  }
  const json = await res.json();
  const choice = json.choices && json.choices[0];
  return choice && choice.message ? choice.message.content : '';
}

module.exports = { streamChat, completeChat, listModels, ApiError };
