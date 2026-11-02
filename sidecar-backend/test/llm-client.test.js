'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callChatCompletion } = require('../src/llm-client');

// 用桩替换全局 fetch，避免真实网络
function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = async (url, init) => handler(url, init);
  return () => {
    global.fetch = original;
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('callChatCompletion: 拼出 /chat/completions 并带 Bearer 头', async () => {
  let captured;
  const restore = mockFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ choices: [{ message: { content: 'hi' } }] });
  });
  try {
    const out = await callChatCompletion(
      { baseUrl: 'http://llm/v1/', model: 'm', apiKey: 'sk-x' },
      [{ role: 'user', content: 'go' }],
      { json: true }
    );
    assert.equal(out, 'hi');
    assert.equal(captured.url, 'http://llm/v1/chat/completions');
    assert.equal(captured.init.headers.Authorization, 'Bearer sk-x');
    assert.match(captured.init.body, /"model":"m"/);
    assert.match(captured.init.body, /"response_format"/); // json=true 默认要求结构化
  } finally {
    restore();
  }
});

test('callChatCompletion: 本地模型无密钥时不带 Authorization', async () => {
  let captured;
  const restore = mockFetch(async (url, init) => {
    captured = init;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });
  try {
    await callChatCompletion({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' }, []);
    assert.equal(captured.headers.Authorization, undefined);
  } finally {
    restore();
  }
});

test('callChatCompletion: 非 2xx 抛出带状态码的错误', async () => {
  const restore = mockFetch(async () => jsonResponse({ error: 'bad key' }, 401));
  try {
    await assert.rejects(
      () => callChatCompletion({ baseUrl: 'http://llm/v1', model: 'm', apiKey: 'x' }, []),
      /401/
    );
  } finally {
    restore();
  }
});

test('callChatCompletion: 超时抛出可读错误而非裸 AbortError', async () => {
  const restore = mockFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        );
      })
  );
  try {
    await assert.rejects(
      () => callChatCompletion({ baseUrl: 'http://llm/v1', model: 'm' }, [], { timeoutMs: 10 }),
      /超时/
    );
  } finally {
    restore();
  }
});

test('callChatCompletion: 缺少 baseUrl 抛错', async () => {
  await assert.rejects(() => callChatCompletion({ model: 'm' }, []), /Base URL/);
});
