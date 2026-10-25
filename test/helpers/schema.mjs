/**
 * 镜像 dsh 运行时对工具定义的两道校验（测试专用，零依赖）。
 *
 * 为什么要自己实现一份：
 *   1. `ctx.tools.register()` 拿到工具定义时会先校验 `parameters` 与 `output.schema` 是否落在
 *      dsh **受支持的 JSON Schema 子集**里。只要有一个关键字写错（最经典的是属性级
 *      `required: true`），**整个插件都不会激活**，而这一步只在真实 Loader 里才发生。
 *   2. `execute` 的返回值会按 `output.schema` 校验（`additionalProperties: false` 下多一个
 *      键就是 `tool returned invalid output`），同样只在运行时暴露。
 *   所以单测必须把这两道校验各镜像一遍，才能在离线阶段抓到问题。
 *
 * 权威来源（本机源码，2026-10-24 对读）：
 *
 * | 本文件的实现 | 对应的真实源码 | 行号（2026-10-24 版本） |
 * |---|---|---|
 * | `collectSchemaViolations()` | `packages/core/tools/src/json-schema.ts` → `checkSchemaNode()` | 227-376 |
 * | `assertValidJsonSchema()` | 同文件 → `assertSupportedJsonSchema()` | 385-389 |
 * | `assertObjectJsonSchema()` | 同文件 → `assertObjectJsonSchema()` | 397-405 |
 * | `validateValue()` | 同文件 → `checkValue()` | 487-644 |
 * | `validateToolOutput()` | 同文件 → `validateJsonSchemaValue()` | 654-656 |
 * | `CONSTRAINT_KEYWORDS` / `ANNOTATION_KEYWORDS` | 同文件 | 76-86 |
 * | `ONE_OF_SIBLING_KEYWORDS` | 同文件 | 200 |
 * | `ALLOWED_FOR_TYPE`（各 type 允许的关键字） | 同文件 → `checkSchemaNode()` 的 `allowedFor` | 310-322 |
 * | `checkObjectSchemaTail` 语义（required / additionalProperties） | 同文件 → `checkObjectSchemaTail()` | 203-224 |
 * | `isPlainRecord()` / `isJsonSchemaRecord()` | 同文件 → `isPlainJsonRecord()` / `isJsonSchemaRecord()` | 115-124 / 152-154 |
 * | `isPlainArray()` | 同文件 → `isPlainJsonArray()` | 161-172 |
 * | `isJsonNumber()` | 同文件 → `isJsonNumber()` | 175-177 |
 * | `scalarMatches()` | 同文件 → `scalarMatches()` | 180-190 |
 * | `isLosslessJson()` | `packages/util/values/src/index.ts` → `isJsonValue()` / `walkJsonValue()` | 181-183（实现 60-165） |
 *
 * 升级 dsh 时复核方法：先 diff 上述两个文件，再对照本文件改；**行号会漂移，符号名比行号可靠**。
 *
 * 注意：本文件比 `另一个 dsh 插件的 schema 审计器` 那份审计器**更严格**
 * （那份允许 `additionalProperties` 为对象、允许 `oneOf` 只有 1 个分支、不检查
 * `const ∈ enum`），因为这里逐行对齐的是真实运行时代码。
 *
 * @module test/helpers/schema
 */

/** 受支持的约束关键字（`CONSTRAINT_KEYWORDS`）。 */
export const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);

/** 允许的注解关键字（`ANNOTATION_KEYWORDS`）：忽略校验，但必须是 lossless JSON。 */
export const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);

/** 允许的 `type` 取值（必须单个字符串）。 */
export const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/** 标量类型（`enum` / `const` 只允许出现在这些类型上）。 */
export const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'];

/** `oneOf` 旁边不允许出现的关键字。 */
export const ONE_OF_SIBLING_KEYWORDS = [
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
];

/** 每种 type 允许出现的关键字（对象形式只用于生成更好的报错）。 */
const ALLOWED_FOR_TYPE = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: SCALAR_TYPES,
  const: SCALAR_TYPES,
};

/* ------------------------------------------------------------------ *
 * 基础类型判定（镜像 util/values 与 json-schema 的内部断言）
 * ------------------------------------------------------------------ */

/**
 * 是否是普通 JSON 记录：非 null、非数组、原型为 `Object.prototype` 或 `null`。
 *
 * @param {unknown} value 候选值。
 * @returns {boolean} 结果。
 */
export function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  } catch {
    return false;
  }
}

/**
 * 是否是「字形正常」的数组：内建 `Array.prototype`、稠密、无额外键。
 *
 * @param {unknown} value 候选值。
 * @returns {boolean} 结果。
 */
export function isPlainArray(value) {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录上是否只有「自身可枚举的字符串键」（镜像 `hasOnlyEnumerableStringKeys`）。
 *
 * @param {object} value 候选记录。
 * @returns {boolean} 结果。
 */
function hasOnlyEnumerableStringKeys(value) {
  try {
    return Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key),
    );
  } catch {
    return false;
  }
}

/**
 * 是否是合法的 schema 记录（镜像 `isJsonSchemaRecord`）。
 *
 * @param {unknown} value 候选值。
 * @returns {boolean} 结果。
 */
export function isJsonSchemaRecord(value) {
  return isPlainRecord(value) && hasOnlyEnumerableStringKeys(/** @type {object} */ (value));
}

/**
 * lossless 有限 JSON 数字（排除 `NaN` / `Infinity` / `-0`）。
 *
 * @param {unknown} value 候选值。
 * @returns {boolean} 结果。
 */
export function isJsonNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}

/**
 * 标量是否匹配声明的类型。
 *
 * @param {string} type `string` / `number` / `integer` / `boolean` / `null`。
 * @param {unknown} value 候选值。
 * @returns {boolean} 结果。
 */
export function scalarMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return isJsonNumber(value);
    case 'integer':
      return isJsonNumber(value) && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/**
 * 是否是 lossless JSON（镜像 `isJsonValue`）：null / boolean / string / 有限数（非 -0）/
 * 普通对象 / 稠密数组，且不含 undefined、函数、symbol、bigint 或循环引用。
 *
 * @param {unknown} value 候选值。
 * @param {Set<object>} [ancestors] 循环检测栈。
 * @returns {boolean} 结果。
 */
export function isLosslessJson(value, ancestors = new Set()) {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return isJsonNumber(value);
    case 'object':
      break;
    default:
      // undefined / function / symbol / bigint 都不是 JSON
      return false;
  }
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (!isPlainArray(value)) return false;
      for (const entry of value) {
        if (!isLosslessJson(entry, ancestors)) return false;
      }
      return true;
    }
    if (!isPlainRecord(value)) return false;
    if (!hasOnlyEnumerableStringKeys(/** @type {object} */ (value))) return false;
    for (const key of Object.keys(value)) {
      const entry = /** @type {Record<string, unknown>} */ (value)[key];
      // undefined 属性会被 JSON.stringify 丢掉 → 不 lossless
      if (!isLosslessJson(entry, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

/* ------------------------------------------------------------------ *
 * 第一道：schema 本身是否落在受支持子集里
 * ------------------------------------------------------------------ */

/**
 * 按诊断路径拼接子节点路径（镜像 `checkSchemaNode` 的字符串拼接风格）。
 *
 * @param {string} where 父路径。
 * @param {string} key 子键。
 * @returns {string} 子路径。
 */
function propertyPath(where, key) {
  return `${where}.${key}`;
}

/**
 * 递归收集一个 schema 节点里所有「不符合受支持子集」的点。
 *
 * 逐条镜像 `checkSchemaNode`（`json-schema.ts:227-376`）。返回空数组 = 合法。
 *
 * @param {unknown} node 待检查的 schema 节点。
 * @param {string} [where] 诊断路径（默认 `schema`）。
 * @param {string[]} [violations] 收集器（递归用）。
 * @param {Set<object>} [seen] 循环检测栈。
 * @returns {string[]} 违规列表。
 */
export function collectSchemaViolations(node, where = 'schema', violations = [], seen = new Set()) {
  if (!isJsonSchemaRecord(node)) {
    violations.push(`${where} must be a schema object`);
    return violations;
  }
  if (seen.has(node)) {
    violations.push(`${where} is circular`);
    return violations;
  }
  seen.add(node);
  try {
    const record = /** @type {Record<string, unknown>} */ (node);

    // 1) 关键字白名单 + 注解必须是 lossless JSON
    for (const key of Object.keys(record)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue;
      if (ANNOTATION_KEYWORDS.has(key)) {
        try {
          if (!isLosslessJson(record[key])) {
            violations.push(`${where}.${key} annotation must be lossless JSON data`);
          }
        } catch {
          violations.push(`${where}.${key} annotation must be lossless JSON data`);
        }
        continue;
      }
      violations.push(
        `${where}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
      );
    }
    if (Object.hasOwn(record, 'description') && typeof record.description !== 'string') {
      violations.push(`${where}.description must be a string`);
    }
    if (Object.hasOwn(record, 'title') && typeof record.title !== 'string') {
      violations.push(`${where}.title must be a string`);
    }

    // 2) type / oneOf 二选一（不能都没有，也不能都有）
    const hasType = Object.hasOwn(record, 'type');
    const hasOneOf = Object.hasOwn(record, 'oneOf');
    if (hasType && hasOneOf) {
      violations.push(`${where} cannot declare both type and oneOf`);
      return violations;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(record, key)) violations.push(`${where}.${key} requires type or oneOf`);
      }
      return violations;
    }

    // 3) oneOf：至少两个分支，且旁边不能有约束关键字
    if (hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(record, key)) {
          violations.push(`${where}.${key} is not supported beside oneOf`);
        }
      }
      const branches = record.oneOf;
      if (!isPlainArray(branches) || branches.length < 2) {
        violations.push(`${where}.oneOf must be an array of at least two schemas`);
      } else {
        branches.forEach((branch, index) => {
          collectSchemaViolations(branch, `${where}.oneOf[${index}]`, violations, seen);
        });
      }
      return violations;
    }

    // 4) type 必须是 single string
    const type = record.type;
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(
        Array.isArray(type)
          ? `${where}.type must be a single type string (type arrays are not supported)`
          : `${where}.type must be one of ${SCHEMA_TYPES.join('/')}`,
      );
      return violations;
    }

    // 5) 各关键字只允许出现在匹配的 type 上
    for (const [key, allowedTypes] of Object.entries(ALLOWED_FOR_TYPE)) {
      if (Object.hasOwn(record, key) && !allowedTypes.includes(type)) {
        violations.push(`${where}.${key} is not supported on type "${type}"`);
      }
    }

    // 6) object：properties / required / additionalProperties
    if (type === 'object') {
      const hasProperties = Object.hasOwn(record, 'properties');
      const properties = hasProperties ? record.properties : undefined;
      if (hasProperties) {
        if (!isJsonSchemaRecord(properties)) {
          violations.push(`${where}.properties must be an object of schemas`);
        } else {
          for (const [name, child] of Object.entries(properties)) {
            collectSchemaViolations(child, propertyPath(`${where}.properties`, name), violations, seen);
          }
        }
      }
      if (Object.hasOwn(record, 'required')) {
        const required = record.required;
        if (!isPlainArray(required) || required.some((entry) => typeof entry !== 'string')) {
          violations.push(`${where}.required must be an array of strings`);
        } else {
          const declared = isJsonSchemaRecord(properties) ? properties : {};
          for (const key of required) {
            if (!Object.hasOwn(declared, key)) {
              violations.push(`${where}.required names "${key}" which is not in properties`);
            }
          }
        }
      }
      if (Object.hasOwn(record, 'additionalProperties') && typeof record.additionalProperties !== 'boolean') {
        violations.push(`${where}.additionalProperties must be a boolean`);
      }
    }

    // 7) array：items
    if (type === 'array' && Object.hasOwn(record, 'items')) {
      collectSchemaViolations(record.items, `${where}.items`, violations, seen);
    }

    // 8) 标量：enum / const（const 必须同时属于 enum）
    if (SCALAR_TYPES.includes(type)) {
      const hasEnum = Object.hasOwn(record, 'enum');
      const allowed = hasEnum ? record.enum : undefined;
      const enumValid =
        isPlainArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(type, entry));
      if (hasEnum && !enumValid) {
        violations.push(`${where}.enum must be a non-empty array of ${type} values`);
      }
      const hasConst = Object.hasOwn(record, 'const');
      const declaredConst = hasConst ? record.const : undefined;
      const constValid = scalarMatches(type, declaredConst);
      if (hasConst) {
        if (!constValid) {
          violations.push(`${where}.const must be a ${type} value`);
        } else if (enumValid && !allowed.includes(declaredConst)) {
          violations.push(`${where}.const must be one of ${where}.enum when both are declared`);
        }
      }
    }
    return violations;
  } finally {
    seen.delete(node);
  }
}

/**
 * 断言一个 schema 落在 dsh 受支持的子集里（镜像 `assertSupportedJsonSchema`）。
 *
 * 失败时抛出携带**全部**违规点的 `AssertionError`，便于一次修完。
 *
 * @param {unknown} schema 待校验的 raw schema。
 * @param {string} [label] 诊断用的标签（如 `android_status.parameters`）。
 * @returns {void}
 * @throws {import('node:assert').AssertionError} schema 越界时。
 */
export function assertValidJsonSchema(schema, label = 'schema') {
  const violations = collectSchemaViolations(schema, 'schema');
  if (violations.length > 0) {
    throw new Error(
      `${label} 不符合 dsh 的 JSON Schema 子集（${violations.length} 处）：\n  - ${violations.join('\n  - ')}`,
    );
  }
}

/**
 * 断言 schema 落在子集里**且**是 object 根（镜像 `assertObjectJsonSchema`）。
 *
 * @param {unknown} schema 待校验的 raw schema。
 * @param {string} [label] 诊断标签。
 * @returns {void}
 */
export function assertObjectJsonSchema(schema, label = 'schema') {
  assertValidJsonSchema(schema, label);
  if (!isJsonSchemaRecord(schema) || !Object.hasOwn(schema, 'type') || schema.type !== 'object') {
    throw new Error(`${label} 必须是 object 根 schema（type 必须为 "object"）`);
  }
}

/* ------------------------------------------------------------------ *
 * 第二道：返回值是否满足自己声明的 output.schema
 * ------------------------------------------------------------------ */

/**
 * 按 schema 校验一个值并返回错误数组（镜像 `validateJsonSchemaValue` / `checkValue`）。
 *
 * 语义要点（都逐条对齐运行时）：
 * - `required` 里列出的键**缺失或其值为 undefined** 都算缺失；
 * - `properties` 里值为 undefined 的键直接跳过；
 * - `additionalProperties: false` 只对 object 生效，且真的拒绝多余键；
 * - `oneOf` 必须**恰好命中一个**分支；
 * - `number` 必须是有限数且非 `-0`；`integer` 还要是整数；
 * - 容器节点在自身约束全过后还要过 lossless JSON 检查。
 *
 * @param {unknown} schema 已通过 `assertValidJsonSchema` 的 schema。
 * @param {unknown} value 待校验的返回值。
 * @param {string} [where] 诊断路径（默认 `value`）。
 * @returns {string[]} 违规列表（空 = 通过）。
 */
export function validateValue(schema, value, where = 'value') {
  /** @type {string[]} */
  const violations = [];
  const node = /** @type {Record<string, unknown>} */ (schema);

  // oneOf：恰好命中一个分支
  if (Object.hasOwn(node, 'oneOf')) {
    const branches = /** @type {unknown[]} */ (node.oneOf);
    const matches = branches.filter((branch) => validateValue(branch, value, where).length === 0).length;
    if (matches !== 1) {
      violations.push(
        `"${where}" must match exactly one oneOf branch (matched ${matches})`,
      );
    }
    return violations;
  }

  // 无 type：接受任意 lossless JSON
  if (!Object.hasOwn(node, 'type')) {
    if (!isLosslessJson(value)) violations.push(`"${where}" must be a lossless JSON value`);
    return violations;
  }

  const type = node.type;
  switch (type) {
    case 'object': {
      if (!isPlainRecord(value)) {
        violations.push(`"${where}" must be an object`);
        return violations;
      }
      const record = /** @type {Record<string, unknown>} */ (value);
      const properties = isJsonSchemaRecord(node.properties) ? node.properties : {};
      const required = isPlainArray(node.required) ? /** @type {string[]} */ (node.required) : [];

      for (const key of required) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) {
          violations.push(`missing required property "${where}.${key}"`);
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) continue;
        violations.push(...validateValue(child, record[key], `${where}.${key}`));
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(properties, key)) {
            violations.push(
              `"${where}.${key}" is not a declared property (additionalProperties: false)`,
            );
          }
        }
      }
      if (violations.length === 0 && !isLosslessJson(value)) {
        violations.push(`"${where}" must be a lossless JSON object`);
      }
      return violations;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`"${where}" must be an array`);
        return violations;
      }
      if (Object.hasOwn(node, 'items')) {
        value.forEach((entry, index) => {
          violations.push(...validateValue(node.items, entry, `${where}[${index}]`));
        });
      }
      if (violations.length === 0 && !isLosslessJson(value)) {
        violations.push(`"${where}" must be a dense lossless JSON array`);
      }
      return violations;
    }
    default: {
      if (!SCALAR_TYPES.includes(/** @type {string} */ (type))) {
        violations.push(`"${where}" declares unsupported type ${JSON.stringify(type)}`);
        return violations;
      }
      if (!scalarMatches(/** @type {string} */ (type), value)) {
        violations.push(`"${where}" must be a ${type}`);
        return violations;
      }
      const allowed = node.enum;
      if (Array.isArray(allowed) && !allowed.includes(value)) {
        violations.push(`"${where}" must be one of ${JSON.stringify(allowed)}`);
      }
      if (Object.hasOwn(node, 'const') && value !== node.const) {
        violations.push(`"${where}" must be ${JSON.stringify(node.const)}`);
      }
      return violations;
    }
  }
}

/**
 * 断言一个值严格满足 schema，失败时带上全部违规点抛出。
 *
 * @param {unknown} schema schema。
 * @param {unknown} value 返回值。
 * @param {string} [label] 诊断标签（如 `android_status 的返回值`）。
 * @returns {void}
 */
export function assertValueMatchesSchema(schema, value, label = 'value') {
  const violations = validateValue(schema, value, 'value');
  if (violations.length > 0) {
    throw new Error(
      `${label} 不满足 output.schema（${violations.length} 处）：\n  - ${violations.join('\n  - ')}`,
    );
  }
}

/**
 * 完整镜像一次工具返回值校验：先 lossless 快照，再按 `output.schema` 校验。
 *
 * 运行时在 `execute` 返回后先做 lossless JSON 投影（getter/循环/undefined 都会在这里死），
 * 再走 schema 校验。测试里 `JSON.parse(JSON.stringify(value))` 顺便证明了返回值可以安全序列化。
 *
 * @param {unknown} schema 工具声明的 `output.schema`。
 * @param {unknown} value `execute` 的返回值。
 * @returns {string[]} 违规列表（空 = 通过）。
 */
export function validateToolOutput(schema, value) {
  if (!isLosslessJson(value)) return ['value is not lossless JSON'];
  const detached = JSON.parse(JSON.stringify(value));
  return validateValue(schema, detached, 'value');
}

/**
 * 断言工具返回值合法（`validateToolOutput` 的抛错版本）。
 *
 * @param {unknown} schema `output.schema`。
 * @param {unknown} value `execute` 返回值。
 * @param {string} [label] 诊断标签。
 * @returns {void}
 */
export function assertValidToolOutput(schema, value, label = 'value') {
  const violations = validateToolOutput(schema, value);
  if (violations.length > 0) {
    throw new Error(
      `${label} 不满足 output.schema（${violations.length} 处）：\n  - ${violations.join('\n  - ')}`,
    );
  }
}
