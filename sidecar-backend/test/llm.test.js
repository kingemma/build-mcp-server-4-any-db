'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  encrypt,
  decrypt,
  listLlmModels,
  saveLlmModels,
  removeLlmModel,
  getDefaultLlmModel,
  ensureDefaultLlmModels,
} = require('../src/llm');

// 这些用例会真正落盘到数据目录。Node 测试运行器默认并发执行同文件内的用例，
// 而 llm.js 通过共用的 process.env.MCP_BUILDER_DATA_DIR 决定落盘位置，并发会互相踩。
// 所以这里只放一个顶层 test，并用 concurrency: 1 让子用例顺序执行，每个子用例各用独立目录。
const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tests-'));

test('LLM settings', { concurrency: 1 }, (t) => {
  const useDir = () => {
    process.env.MCP_BUILDER_DATA_DIR = fs.mkdtempSync(path.join(parentDir, 'case-'));
  };

  t.test('encrypt / decrypt: 往返一致', () => {
    useDir();
    const token = encrypt('sk-secret-123');
    assert.ok(token && token.startsWith('v1.'));
    assert.equal(decrypt(token), 'sk-secret-123');
  });

  t.test('encrypt: 空值返回 null，decrypt 空值返回空串', () => {
    useDir();
    assert.equal(encrypt(''), null);
    assert.equal(encrypt(null), null);
    assert.equal(decrypt(null), '');
    assert.equal(decrypt('garbage'), '');
  });

  t.test('ensureDefaultLlmModels: 首次写入 Ollama / vLLM 两条默认', () => {
    useDir();
    ensureDefaultLlmModels();
    const models = listLlmModels();
    assert.equal(models.length, 2);
    const ollama = models.find((m) => m.name === 'Ollama');
    assert.equal(ollama.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(ollama.model, 'qwen3.5:9b');
    assert.equal(ollama.kind, 'local');
    assert.equal(ollama.isDefault, true);
    const vllm = models.find((m) => m.name === 'vLLM');
    assert.equal(vllm.baseUrl, 'http://192.168.130.31:38888/v1/');
    assert.equal(vllm.model, 'qwen38');
    assert.equal(vllm.isDefault, false);
  });

  t.test('ensureDefaultLlmModels: 已有配置时不覆盖', () => {
    useDir();
    saveLlmModels({ models: [{ name: 'X', baseUrl: 'https://x/v1', model: 'x' }], defaultId: null });
    ensureDefaultLlmModels();
    assert.equal(listLlmModels().length, 1);
  });

  t.test('save / list: 多个模型与默认标记', () => {
    useDir();
    const saved = saveLlmModels({
      models: [
        { name: 'Ollama', provider: 'ollama', kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3', apiKey: '' },
        { name: 'DeepSeek', provider: 'deepseek', kind: 'remote', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-abc' },
      ],
      defaultId: null,
    });
    assert.equal(saved.length, 2);
    const deep = saved.find((m) => m.name === 'DeepSeek');
    assert.equal(deep.hasApiKey, true);
    assert.equal(deep.isDefault, false);
    // 明文密钥绝不回传
    assert.equal('apiKey' in deep, false);
    assert.equal(listLlmModels().length, 2);
  });

  t.test('save: 设默认后只有一条 isDefault', () => {
    useDir();
    const first = saveLlmModels({
      models: [{ name: 'Ollama', provider: 'ollama', kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3' }],
      defaultId: null,
    })[0];
    saveLlmModels({
      models: listLlmModels().map((m) => ({ ...m })),
      defaultId: first.id,
    });
    const withDefault = listLlmModels().filter((m) => m.isDefault);
    assert.equal(withDefault.length, 1);
    assert.equal(withDefault[0].id, first.id);
    assert.equal(getDefaultLlmModel().id, first.id);
  });

  t.test('save: 编辑不重填密钥时保留原密文', () => {
    useDir();
    saveLlmModels({
      models: [{ name: 'DeepSeek', provider: 'deepseek', kind: 'remote', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-original' }],
      defaultId: null,
    });
    // 模拟「打开编辑又保存」：apiKey 字段留空
    const existing = listLlmModels()[0];
    const after = saveLlmModels({
      models: [{ id: existing.id, name: existing.name, provider: existing.provider, kind: existing.kind, baseUrl: existing.baseUrl, model: existing.model }],
      defaultId: null,
    })[0];
    assert.equal(after.hasApiKey, true, '未重填时原密钥必须保留');
  });

  t.test('save: 重填密钥会覆盖原密文', () => {
    useDir();
    const existing = saveLlmModels({
      models: [{ name: 'DeepSeek', provider: 'deepseek', kind: 'remote', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-original' }],
      defaultId: null,
    })[0];
    const after = saveLlmModels({
      models: [{ id: existing.id, name: existing.name, provider: existing.provider, kind: existing.kind, baseUrl: existing.baseUrl, model: existing.model, apiKey: 'sk-new' }],
      defaultId: null,
    })[0];
    assert.equal(after.hasApiKey, true);
    // 直接读存储文件拿密文，再用同一密钥文件解开，确认覆盖生效
    const settingsFile = path.join(process.env.MCP_BUILDER_DATA_DIR, 'llm-settings.json');
    const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const cipher = stored.models.find((m) => m.id === existing.id).apiKeyCipher;
    assert.equal(decrypt(cipher), 'sk-new');
  });

  t.test('save: 校验拒绝空名称 / 空 baseUrl / 空 model', () => {
    useDir();
    assert.throws(() => saveLlmModels({ models: [{ name: '', baseUrl: 'x', model: 'm' }] }));
    assert.throws(() => saveLlmModels({ models: [{ name: 'n', baseUrl: '', model: 'm' }] }));
    assert.throws(() => saveLlmModels({ models: [{ name: 'n', baseUrl: 'x', model: '' }] }));
  });

  t.test('remove: 删掉后列表变短', () => {
    useDir();
    const [a, b] = saveLlmModels({
      models: [
        { name: 'A', provider: 'custom', kind: 'remote', baseUrl: 'https://x/v1', model: 'a' },
        { name: 'B', provider: 'custom', kind: 'remote', baseUrl: 'https://y/v1', model: 'b' },
      ],
      defaultId: null,
    });
    const after = removeLlmModel(a.id);
    assert.equal(after.find((m) => m.id === a.id), undefined);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, b.id);
  });
});

test.after(() => {
  fs.rmSync(parentDir, { recursive: true, force: true });
});
