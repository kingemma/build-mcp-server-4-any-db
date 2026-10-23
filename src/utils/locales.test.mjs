import test from 'node:test';
import assert from 'node:assert/strict';

import zhCn from '../locales/zh-CN.js';
import enUs from '../locales/en-US.js';

/**
 * 文案一致性。
 *
 * 为什么值得进 CI：zh-CN.js 的注释写着「新增 key 时必须同步 en-US.js」——
 * 但这类约定只靠人记，漏一次就是英文界面里冒出一句中文。把它变成断言之后，
 * 漏翻译会在 `npm run test:frontend` 里当场失败。
 *
 * @param {Object} tree 语言包对象
 * @param {string} [prefix]
 * @returns {Map<string, string>} 扁平化后的 key → 文案
 */
function flatten(tree, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(tree ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, text] of flatten(value, path)) out.set(inner, text);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/** 取文案里的占位符（vue-i18n 的 `{name}` 形式），顺序无关 */
function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

const zh = flatten(zhCn);
const en = flatten(enUs);

test('语言包：中英 key 集合完全一致', () => {
  const missingInEn = [...zh.keys()].filter((key) => !en.has(key));
  const missingInZh = [...en.keys()].filter((key) => !zh.has(key));

  assert.deepEqual(missingInEn, [], `en-US 缺少这些 key：${missingInEn.join(', ')}`);
  assert.deepEqual(missingInZh, [], `zh-CN 缺少这些 key：${missingInZh.join(', ')}`);
});

test('语言包：同 key 的占位符必须一致，否则一边塞不进去值', () => {
  const mismatched = [];
  for (const [key, text] of zh) {
    if (!en.has(key)) continue;
    const a = placeholders(text);
    const b = placeholders(en.get(key));
    if (a.join(',') !== b.join(',')) {
      mismatched.push(`${key}: zh{${a.join(',')}} vs en{${b.join(',')}}`);
    }
  }
  assert.deepEqual(mismatched, []);
});

test('语言包：没有空文案', () => {
  const empty = [...zh.entries()]
    .filter(([, text]) => String(text).trim() === '')
    .map(([key]) => key);
  assert.deepEqual(empty, []);
});

test('语言包：本体论体检的文案齐全（新增功能漏翻译的回归点）', () => {
  const keys = [
    'ontology.lint.title',
    'ontology.lint.hint',
    'ontology.lint.run',
    'ontology.lint.again',
    'ontology.lint.clean',
    'ontology.lint.checked',
    'ontology.lint.skipped',
    'ontology.lint.levels.error',
    'ontology.lint.levels.warn',
    'ontology.lint.levels.info',
  ];

  for (const [name, pack] of [
    ['zh-CN', zh],
    ['en-US', en],
  ]) {
    for (const key of keys) {
      assert.ok(pack.has(key), `${name} 缺少 ${key}`);
      assert.notEqual(String(pack.get(key)).trim(), '', `${name} 的 ${key} 是空的`);
    }
  }
});
