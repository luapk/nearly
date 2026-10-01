// Nearly: server side.
//
// GET  /api/map  -> {ready, protected, reason}  so the page knows whether it can map words
// POST /api/map  -> streams Claude's reply back as plain text, one chunk at a time
//
// Environment variables (set these in Vercel, Project Settings > Environment Variables):
//   ANTHROPIC_API_KEY   required. From https://platform.claude.com
//   ACCESS_CODE         optional. If set, the page must send the same code before it can map.
//   NEARLY_MODEL        optional. Defaults to claude-sonnet-5-5.
//   NEARLY_MODEL_QUICK  optional. Defaults to claude-haiku-4-5-20251001.

export const config = { runtime: 'edge' };

const MAX_PROMPT = 24000;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

export default async function handler(req) {
  const key = process.env.ANTHROPIC_API_KEY;
  const accessCode = process.env.ACCESS_CODE || '';

  if (req.method === 'GET') {
    return json({ ready: !!key, protected: !!accessCode, reason: key ? '' : 'no_key' }, 200);
  }
  if (req.method !== 'POST') return json({ code: 'method_not_allowed' }, 405);
  if (!key) return json({ code: 'no_key' }, 500);
  if (accessCode && req.headers.get('x-access-code') !== accessCode) {
    return json({ code: 'unauthorised' }, 401);
  }

  let body;
  try { body = await req.json(); } catch (e) { return json({ code: 'invalid_request' }, 400); }

  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return json({ code: 'invalid_request' }, 400);
  if (prompt.length > MAX_PROMPT) return json({ code: 'prompt_too_large' }, 413);

  const quick = body.modelTier === 'quick';
  const model = quick
    ? (process.env.NEARLY_MODEL_QUICK || 'claude-haiku-4-5-20251001')
    : (process.env.NEARLY_MODEL || 'claude-sonnet-5-5');

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: quick ? 1500 : 8000,
        stream: true,
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch (e) {
    return json({ code: 'upstream_error' }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const s = upstream.status;
    const code = s === 429 ? 'rate_limited' : (s === 401 || s === 403) ? 'no_key' : 'upstream_error';
    return json({ code, status: s }, s === 429 ? 429 : 502);
  }

  // Claude streams server-sent events. The page only wants the words, so pull the
  // text out of each delta and pass it through as plain text.
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buffer = '';
  const toText = new TransformStream({
    transform(chunk, controller) {
      buffer += dec.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
          controller.enqueue(enc.encode(ev.delta.text));
        }
      }
    }
  });

  return new Response(upstream.body.pipeThrough(toText), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    }
  });
}
