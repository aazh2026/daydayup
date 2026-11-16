/**
 * 轻量 JSON Schema 校验器（零依赖）。
 *
 * Gemini 的 responseSchema 是**软约束**——模型仍可能返回不符合结构的内容。
 * 现状 server.ts 直接 JSON.parse 后 res.json(parsed)，没有二次校验。
 *
 * 本模块实现对 Gemini responseSchema 子集的校验：
 * - OBJECT: properties / required
 * - ARRAY: items
 * - 基础类型: STRING / NUMBER / BOOLEAN
 */

import type { AIJsonSchema } from './provider.ts';

export function validateAgainstSchema(value: unknown, schema: AIJsonSchema): boolean {
  if (!schema || typeof schema !== 'object') return false;

  switch (schema.type) {
    case 'OBJECT': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      const required = schema.required ?? [];
      for (const key of required) {
        if (!(key in obj) || obj[key] === undefined) return false;
      }
      const props = schema.properties;
      if (props) {
        for (const [key, propSchema] of Object.entries(props)) {
          if (!(key in obj) || obj[key] === undefined) continue;
          if (!validateAgainstSchema(obj[key], propSchema as AIJsonSchema)) return false;
        }
      }
      return true;
    }
    case 'ARRAY': {
      if (!Array.isArray(value)) return false;
      if (!schema.items) return true;
      for (const item of value) {
        if (!validateAgainstSchema(item, schema.items as AIJsonSchema)) return false;
      }
      return true;
    }
    case 'STRING':
      return typeof value === 'string';
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value);
    case 'BOOLEAN':
      return typeof value === 'boolean';
    default:
      return true;
  }
}
