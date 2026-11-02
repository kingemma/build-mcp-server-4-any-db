'use strict';

/**
 * LLM 连接设置：应用层持久化（与 GraphJin 的 dev.yml 无关）。
 *
 * 一条模型记录包含：id / name / provider / kind(local|remote) / baseUrl / model / apiKey。
 * API Key 是可选非必填项，落盘时按 AES-256-GCM 加密，仅存密文；读回时绝不把明文交回前端，
 * 只给一个 hasApiKey 标记，前端据此显示「已设置 / 未设置」并决定是否要重新填。
 *
 * 加密密钥复用项目既有的「数据目录里生成一次、权限 0600」模式（见 keystore.js / jwt.js 的
 * loadSecret），不依赖任何外部密钥服务。换密钥会让已存密文解不开，所以密钥文件一旦生成就固定。
 *
 * 存储文件：dataDir/llm-settings.json；密钥：dataDir/llm.key。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { dataDir, dataFile } = require('./paths');

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;

// 路径必须在「调用时」解析，不能在模块加载时定死：
// 真实运行里 MCP_BUILDER_DATA_DIR 由主进程在拉起 sidecar 前注入，require 顺序不定；
// 测试里也是在 require 之后才设的。定死会让读写落到默认 data/ 目录，跨目录对不上。
const keyFile = () => dataFile('llm.key');
const settingsFile = () => dataFile('llm-settings.json');

/**
 * 取（必要时生成）32 字节 base64 编码的加密密钥。
 * @returns {string} base64 密钥
 */
function ensureKey() {
  const KEY_FILE = keyFile();
  if (fs.existsSync(KEY_FILE)) {
    const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (Buffer.from(existing, 'base64').length === KEY_BYTES) return existing;
  }
  const key = crypto.randomBytes(KEY_BYTES).toString('base64');
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(KEY_FILE, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  return key;
}

/**
 * 加密明文。空值返回 null（代表「未设置密钥」）。
 * @param {string} plaintext
 * @returns {string|null} 形如 v1.<iv>.<tag>.<cipher> 的 base64 串
 */
function encrypt(plaintext) {
  if (plaintext === '' || plaintext == null) return null;
  const key = Buffer.from(ensureKey(), 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

/**
 * 解密密文。任何异常（密钥不符、格式错）都回落成空串，不抛错——读坏一条密钥不该让整个列表崩。
 * @param {string|null} token
 * @returns {string}
 */
function decrypt(token) {
  if (!token || typeof token !== 'string') return '';
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const key = Buffer.from(ensureKey(), 'base64');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** @returns {{models: Array}} 原始存储结构 */
function readRaw() {
  const SETTINGS_FILE = settingsFile();
  if (!fs.existsSync(SETTINGS_FILE)) return { models: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.models)) return { models: [] };
    return parsed;
  } catch {
    // 文件被改坏只影响 LLM 设置，不该让设置页报错
    return { models: [] };
  }
}

function writeRaw(settings) {
  const SETTINGS_FILE = settingsFile();
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** 原始记录 → 对外视图（绝不带 apiKey 明文，只给标记） */
function toPublic(model) {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider ?? '',
    kind: model.kind,
    baseUrl: model.baseUrl,
    model: model.model,
    hasApiKey: Boolean(model.apiKeyCipher),
    isDefault: Boolean(model.isDefault),
  };
}

/** @returns {Array} 所有模型（对外视图） */
function listLlmModels() {
  return readRaw().models.map(toPublic);
}

/**
 * 写回一批模型。
 *
 * apiKey 处理：前端只在用户真的输入时才把 apiKey 带上来；空着就保留这条记录原本的密文
 * （避免「打开编辑又保存」把已设置的密钥清空）。新记录且不带 key 则记为无密钥。
 *
 * @param {{models?: Array, defaultId?: string|null}} params
 * @returns {Array} 保存后的模型列表（对外视图）
 */
function saveLlmModels({ models = [], defaultId = null } = {}) {
  if (!Array.isArray(models)) throw new Error('models 必须是数组');

  const existingById = new Map(readRaw().models.map((model) => [model.id, model]));
  const cleaned = [];

  for (const incoming of models) {
    const id =
      typeof incoming?.id === 'string' && incoming.id ? incoming.id : crypto.randomUUID();

    if (typeof incoming?.name !== 'string' || incoming.name.trim() === '') {
      throw new Error('模型名称不能为空');
    }
    const kind = incoming.kind === 'local' ? 'local' : 'remote';
    if (typeof incoming?.baseUrl !== 'string' || incoming.baseUrl.trim() === '') {
      throw new Error('Base URL 不能为空');
    }
    if (typeof incoming?.model !== 'string' || incoming.model.trim() === '') {
      throw new Error('模型标识（model）不能为空');
    }

    const apiKeyText = typeof incoming?.apiKey === 'string' ? incoming.apiKey : '';
    const prev = existingById.get(id);
    let cipher;
    if (apiKeyText) {
      cipher = encrypt(apiKeyText);
    } else if (prev) {
      cipher = prev.apiKeyCipher ?? null;
    } else {
      cipher = null;
    }

    cleaned.push({
      id,
      name: incoming.name.trim(),
      provider: typeof incoming?.provider === 'string' ? incoming.provider : '',
      kind,
      baseUrl: incoming.baseUrl.trim(),
      model: incoming.model.trim(),
      apiKeyCipher: cipher,
      isDefault: id === defaultId,
    });
  }

  writeRaw({ models: cleaned });
  return cleaned.map(toPublic);
}

/**
 * 删除一条模型记录。
 * @param {string} id
 * @returns {Array} 删除后的模型列表（对外视图）
 */
function removeLlmModel(id) {
  if (typeof id !== 'string' || id === '') throw new Error('id 不能为空');
  const settings = readRaw();
  settings.models = settings.models.filter((model) => model.id !== id);
  writeRaw(settings);
  return settings.models.map(toPublic);
}

/** @returns {Object|null} 当前默认模型（对外视图），没有则 null */
function getDefaultLlmModel() {
  const found = readRaw().models.find((model) => model.isDefault);
  return found ? toPublic(found) : null;
}

/**
 * 取一条模型的完整配置（含解密后的 apiKey），仅供后端内部调用 LLM 使用。
 * 绝不外传给前端——前端只能拿到 hasApiKey 标记。
 *
 * @param {string|null} id 指定 id；不传则取默认模型，没有默认取第一个
 * @returns {Object|null} { id, name, provider, kind, baseUrl, model, apiKey }
 */
function getLlmModelConfig(id) {
  const models = readRaw().models;
  const model = id
    ? models.find((m) => m.id === id)
    : models.find((m) => m.isDefault) || models[0];
  if (!model) return null;
  let apiKey = '';
  try {
    apiKey = model.apiKeyCipher ? decrypt(model.apiKeyCipher) : '';
  } catch {
    apiKey = '';
  }
  return {
    id: model.id,
    name: model.name,
    provider: model.provider ?? '',
    kind: model.kind,
    baseUrl: model.baseUrl,
    model: model.model,
    apiKey,
  };
}

/** @returns {Object|null} 默认（或第一个）模型的完整配置，没有模型返回 null */
function getDefaultLlmModelConfig() {
  const models = readRaw().models;
  const def = models.find((m) => m.isDefault) || models[0];
  return def ? getLlmModelConfig(def.id) : null;
}

/**
 * 首次启动时写入两条默认模型（Ollama / vLLM），让「设置 → LLM 设置」开箱即用。
 * 只在存储文件不存在时写入：用户删光模型后文件已存在，不会被重新塞回去。
 *
 * @returns {void}
 */
function ensureDefaultLlmModels() {
  // 已有任何模型就不动（用户配置优先）；只有文件缺失 / 为空 / 读坏时才铺默认值
  if (readRaw().models.length > 0) return;
  writeRaw({
    models: [
      {
        id: crypto.randomUUID(),
        name: 'Ollama',
        provider: 'ollama',
        kind: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen3.5:9b',
        apiKeyCipher: null,
        isDefault: true,
      },
      {
        id: crypto.randomUUID(),
        name: 'vLLM',
        provider: 'vllm',
        kind: 'local',
        baseUrl: 'http://192.168.130.31:38888/v1/',
        model: 'qwen38',
        apiKeyCipher: null,
        isDefault: false,
      },
    ],
  });
}

module.exports = {
  encrypt,
  decrypt,
  listLlmModels,
  saveLlmModels,
  removeLlmModel,
  getDefaultLlmModel,
  getLlmModelConfig,
  getDefaultLlmModelConfig,
  ensureDefaultLlmModels,
};
