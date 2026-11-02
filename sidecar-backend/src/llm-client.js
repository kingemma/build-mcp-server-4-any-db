'use strict';

/**
 * OpenAI 兼容的聊天补全客户端。
 *
 * 为什么统一走 /chat/completions：vLLM / Ollama 都暴露 OpenAI 兼容端点，
 * DeepSeek / Qwen / 智普 / Mimo / Kimi 也全是这套接口，所以本地与远端共用一个调用。
 * 本地模型通常没有密钥，这时就不带 Authorization 头。
 */

/**
 * 调一次聊天补全。
 *
 * @param {Object} modelConfig { baseUrl, model, apiKey }
 * @param {Array<{role: string, content: string}>} messages
 * @param {{json?: boolean, timeoutMs?: number}} [options] json=true 时要求结构化输出
 * @returns {Promise<string>} 模型回复的 content 文本
 */
async function callChatCompletion(modelConfig, messages, { json = false, timeoutMs = 60000 } = {}) {
  const base = String(modelConfig?.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('模型未配置 Base URL');
  const url = `${base}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (modelConfig?.apiKey) headers.Authorization = `Bearer ${modelConfig.apiKey}`;

  const body = { model: modelConfig.model, messages, temperature: 0.2 };
  if (json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // 超时是这里最常见的失败：换成一句人能看懂的话，不要把裸 AbortError 抛给界面
    if (timedOut) {
      throw new Error(
        `LLM 请求超时（${Math.round(timeoutMs / 1000)} 秒）：模型未在预期时间内返回，` +
          '请确认端点可达，或换更快的模型后重试'
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM endpoint ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

module.exports = { callChatCompletion };
