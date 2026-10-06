// 插件配置文件（config.yml / *.json / *.toml …）的结构化解析与无损回写。
// 思路同 properties.ts：只改值，未触碰的键、注释、空行、键序全部原样保留。
// YAML 走 `yaml` 的 Document API（parseDocument + 仅对改动路径 setIn）；
// JSON 整体重序列化；TOML 序列化会丢注释，只允许原文编辑。
//
// 编辑模型：解析出「表单树」（ConfigNode，节点自带值），UI 直接改树的克隆，
// 保存时 diff 初始树与工作树得到改动根（纯值变更 → 逐路径 setIn；
// 数组增删项等结构变更 → 对该数组整体 setIn 替换，注释只丢该数组内部的）。

import { parseAllDocuments, parseDocument, visit } from 'yaml';

import { $ } from '@/lib/i18n';

export type ConfigFormat = 'yaml' | 'json' | 'toml';

/** 按扩展名判断格式（未知扩展名返回 null，不参与表单化） */
export function detectFormat(name: string): ConfigFormat | null {
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  if (/\.json$/i.test(name)) return 'json';
  if (/\.toml$/i.test(name)) return 'toml';
  return null;
}

// TOML 无法保留注释的说明文案已迁到 i18n 键 `pluginConfig.tomlReason`，
// 由消费方 plugin-config-dialog.tsx 在**渲染期**取词。
// 原先这里是模块顶层的中文常量——模块顶层的 `$()` 会把语言固化在加载时
// （setLanguage 不刷新页面），所以必须由消费方取词，而不是在这里拼好字符串。

// ---------- 表单树 ----------

export type ConfigNode =
  | { kind: 'bool'; path: string; key: string; value: boolean; comment?: string }
  | { kind: 'number'; path: string; key: string; value: number; int: boolean; comment?: string }
  | { kind: 'string'; path: string; key: string; value: string; multiline: boolean; comment?: string }
  /** 原值为 null 的叶子；value 存编辑中的内容（'' 视回 null） */
  | { kind: 'null'; path: string; key: string; value: unknown; comment?: string }
  | { kind: 'object'; path: string; key: string; children: ConfigNode[]; collapsed?: boolean; comment?: string }
  | { kind: 'array'; path: string; key: string; items: ConfigNode[]; comment?: string };

export type ObjectNode = Extract<ConfigNode, { kind: 'object' }>;

export interface ParsedConfig {
  format: ConfigFormat;
  /** 整棵表单树（根是虚拟 object 节点，path=''） */
  root: ObjectNode;
  eol: string;
  /** 文档级前置注释（显示在表单顶部） */
  headerComment: string;
}

export type ParseResult = ParsedConfig | { error: string };

// key 里的字面 '.' 转义为 '\.'，pathToSteps 按同一规则还原，
// 避免 permissions.yml 这类带点键（"group.member"）把路径拆错。
function escKey(key: string): string {
  return key.replace(/\./g, '\\.');
}

function joinKey(base: string, key: string): string {
  const esc = escKey(key);
  return base === '' ? esc : `${base}.${esc}`;
}

function buildTree(value: unknown, path: string, key: string, comments: Map<string, string>): ConfigNode {
  const comment = path === '' ? undefined : comments.get(path);
  if (typeof value === 'boolean') return { kind: 'bool', path, key, value, comment };
  if (typeof value === 'number') return { kind: 'number', path, key, value, int: Number.isInteger(value), comment };
  if (typeof value === 'string') {
    return { kind: 'string', path, key, value, multiline: value.includes('\n') || value.length > 80, comment };
  }
  if (value === null || value === undefined) return { kind: 'null', path, key, value: null, comment };
  if (Array.isArray(value)) {
    const items = value.map((v, i) => buildTree(v, `${path}[${i}]`, '', comments));
    return { kind: 'array', path, key, items, comment };
  }
  if (typeof value === 'object') {
    const children = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      buildTree(v, joinKey(path, k), k, comments),
    );
    // 深层分组默认折叠，避免一次摊开几百项
    const collapsed = path !== '' && children.length > 12;
    return { kind: 'object', path, key, children, collapsed, comment };
  }
  return { kind: 'null', path, key, value: null, comment };
}

/**
 * 解析 YAML 为表单树（注释挂在对应 path 上）。
 * 锚点/别名/多文档/顶层非映射一律返回 { error }，调用方降级为原文编辑。
 */
export function parseYamlConfig(content: string): ParseResult {
  if (parseAllDocuments(content).length > 1) {
    return { error: $('pluginConfig.error.multiDoc') };
  }
  const doc = parseDocument(content);
  if (doc.errors.length) return { error: doc.errors[0].message ?? $('pluginConfig.error.yamlParse') };
  if (doc.contents === undefined || doc.contents === null) {
    return { format: 'yaml', root: { kind: 'object', path: '', key: '', children: [] }, eol: eolOf(content), headerComment: '' };
  }

  let hasAnchorOrAlias = false;
  visit(doc.contents, (_k, node) => {
    const n = node as { anchor?: unknown; type?: unknown } | null;
    if (n && typeof n === 'object' && (n.type === 'ALIAS' || n.anchor)) hasAnchorOrAlias = true;
  });
  if (hasAnchorOrAlias) return { error: $('pluginConfig.error.anchor') };

  const pojo = doc.toJS() as unknown;
  if (!pojo || typeof pojo !== 'object' || Array.isArray(pojo)) {
    return { error: $('pluginConfig.error.notMapping') };
  }

  const { comments, header } = extractComments(content);
  return {
    format: 'yaml',
    root: buildTree(pojo, '', '', comments) as ObjectNode,
    eol: eolOf(content),
    headerComment: header,
  };
}

/** 解析 JSON 配置为表单树；顶层必须是对象 */
export function parseJsonConfig(content: string): ParseResult {
  let pojo: unknown;
  try {
    pojo = JSON.parse(content);
  } catch (e) {
    return { error: (e as Error).message || $('pluginConfig.error.jsonParse') };
  }
  if (!pojo || typeof pojo !== 'object' || Array.isArray(pojo)) {
    return { error: $('pluginConfig.error.notObject') };
  }
  return { format: 'json', root: buildTree(pojo, '', '', new Map()) as ObjectNode, eol: eolOf(content), headerComment: '' };
}

function eolOf(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 行级扫描提取注释：把注释行关联到其后第一个键/序列项的 path，仅用于表单提示
 * （回写走 setIn，注释保留由 yaml 库本身保证，不依赖这里的准确性）。
 * 路径用缩进栈推算：键帧弹栈条件为 indent >= N，序列项帧为 indent > N（兼容
 * "list:" 与 "- x" 同缩进的写法）；"- key: value" 视为映射项，子键归到 item 路径下。
 */
function extractComments(content: string): { comments: Map<string, string>; header: string } {
  const comments = new Map<string, string>();
  interface Frame {
    indent: number;
    path: string;
    seqIndex: number;
    kind: 'key' | 'item';
  }
  const stack: Frame[] = [{ indent: -1, path: '', seqIndex: 0, kind: 'key' }];
  let pending: string[] = [];
  let header = '';
  let headerDone = false;
  let blockMinIndent: number | null = null;

  const setComment = (path: string, text: string) => {
    if (!text) return;
    const prev = comments.get(path);
    comments.set(path, prev ? `${prev} ${text}` : text);
  };

  for (const line of content.split(/\r?\n/)) {
    if (blockMinIndent !== null) {
      // 块标量（| / >）内容行不参与键与注释解析
      if (line.trim() === '' || line.length - line.trimStart().length >= blockMinIndent) continue;
      blockMinIndent = null;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === '---' || trimmed.startsWith('%')) continue;
    const indent = line.length - line.trimStart().length;

    if (trimmed.startsWith('#')) {
      pending.push(trimmed.replace(/^#\s?/, ''));
      continue;
    }

    // 序列项 "- xxx"（可空）
    const seq = /^-(?:[ \t]+(.*))?$/.exec(trimmed);
    if (seq) {
      while (stack.length > 1) {
        const top = stack[stack.length - 1];
        if (top.indent > indent || (top.indent === indent && top.kind === 'item')) stack.pop();
        else break;
      }
      const parent = stack[stack.length - 1];
      const itemPath = `${parent.path}[${parent.seqIndex++}]`;
      const { body, trail } = splitTrailingComment(seq[1] ?? '');
      setComment(itemPath, pending.join(' '));
      pending = [];
      setComment(itemPath, trail);
      // "- key: value" 形式的映射项：子键归到 item 路径下
      const kv = parseKeyLine(body);
      if (kv && kv.value !== null) {
        if (kv.value === '' || /^[|>][+-]?\d*$/.test(kv.value)) {
          stack.push({ indent: indent + 2, path: itemPath, seqIndex: 0, kind: 'item' });
          if (kv.value !== '') blockMinIndent = indent + 1;
        }
      }
      continue;
    }

    // 键行
    const kv = parseKeyLine(trimmed);
    if (!kv) continue;
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      if (top.indent > indent || (top.indent === indent && top.kind === 'key')) stack.pop();
      else break;
    }
    const parent = stack[stack.length - 1];
    const path = joinKey(parent.path, kv.key);
    if (!headerDone && stack.length === 1 && pending.length) {
      header = pending.join(' ');
      pending = [];
      headerDone = true;
    }
    setComment(path, pending.join(' '));
    pending = [];
    setComment(path, kv.trail);
    if (kv.value === null || kv.value === '' || /^[|>][+-]?\d*$/.test(kv.value)) {
      if (kv.value === null || kv.value === '') {
        // 无值的键：后面跟映射或序列（或为 null，多压的帧不会被命中，无害）
        stack.push({ indent, path, seqIndex: 0, kind: 'key' });
      } else {
        blockMinIndent = indent + 1;
      }
    }
  }
  return { comments, header };
}

/** 解析 "key: value" 行（支持引号键）；value 为 null 表示整行不是键行，'' 表示键后无值 */
function parseKeyLine(text: string): { key: string; value: string | null; trail: string } | null {
  let key: string;
  let rest: string;
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = text.indexOf(text[0], 1);
    if (end === -1) return null;
    key = text.slice(1, end);
    const m = /^[ \t]*:(?:[ \t]+(.*))?$/.exec(text.slice(end + 1));
    if (!m) return null;
    rest = m[1] ?? '';
  } else {
    const m = /^([^:]*?)[ \t]*:(?:[ \t]+(.*))?$/.exec(text);
    if (!m) return null;
    key = m[1].trim();
    rest = m[2] ?? '';
  }
  const { body, trail } = splitTrailingComment(rest);
  return { key, value: body, trail };
}

/** 拆行尾注释（引号外的 " #" 之后）；返回去空格的正文与注释 */
function splitTrailingComment(s: string): { body: string; trail: string } {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return { body: s.slice(0, i).trim(), trail: s.slice(i + 1).trim() };
    }
  }
  return { body: s.trim(), trail: '' };
}

// ---------- 工作树操作 ----------

export function cloneTree(root: ConfigNode): ConfigNode {
  return structuredClone(root);
}

/** 结构变更（数组增删项）后重建整棵树的 path */
export function assignPaths(node: ConfigNode, path: string): void {
  node.path = path;
  if (node.kind === 'object') {
    for (const c of node.children) assignPaths(c, joinKey(path, c.key));
  } else if (node.kind === 'array') {
    node.items.forEach((it, i) => assignPaths(it, `${path}[${i}]`));
  }
}

export function findNode(root: ConfigNode, path: string): ConfigNode | undefined {
  if (root.path === path) return root;
  const inChild = (c: ConfigNode): boolean =>
    path === c.path || path.startsWith(`${c.path}.`) || path.startsWith(`${c.path}[`);
  if (root.kind === 'object') {
    for (const c of root.children) if (inChild(c)) { const hit = findNode(c, path); if (hit) return hit; }
  } else if (root.kind === 'array') {
    for (const it of root.items) if (inChild(it)) { const hit = findNode(it, path); if (hit) return hit; }
  }
  return undefined;
}

function normalizeNull(v: unknown): unknown {
  return v === undefined || v === '' ? null : v;
}

/** 表单树 → 纯 JS 值（供 setIn 整段替换用） */
export function nodeToPojo(node: ConfigNode): unknown {
  switch (node.kind) {
    case 'bool':
    case 'number':
    case 'string':
      return node.value;
    case 'null':
      return normalizeNull(node.value);
    case 'array':
      return node.items.map(nodeToPojo);
    case 'object':
      return Object.fromEntries(node.children.map((c) => [c.key, nodeToPojo(c)]));
  }
}

export interface ConfigChange {
  path: string;
  value: unknown;
}

/**
 * diff 初始树与工作树，产出「改动根」列表：
 * 叶子值变了 → 该叶子路径；数组长度变了 → 该数组路径（整段替换）。
 */
export function diffTree(a: ConfigNode, b: ConfigNode, path: string, out: ConfigChange[]): void {
  if (a.kind !== b.kind) {
    out.push({ path, value: nodeToPojo(b) });
    return;
  }
  switch (b.kind) {
    case 'object': {
      const ao = a as ObjectNode;
      for (const c of b.children) {
        const ac = ao.children.find((x) => x.key === c.key) ?? c;
        diffTree(ac, c, joinKey(path, c.key), out);
      }
      return;
    }
    case 'array': {
      const aa = a as typeof b;
      if (aa.items.length !== b.items.length) {
        out.push({ path, value: nodeToPojo(b) });
        return;
      }
      b.items.forEach((it, i) => diffTree(aa.items[i], it, `${path}[${i}]`, out));
      return;
    }
    case 'null': {
      const an = a as typeof b;
      if (normalizeNull(an.value) !== normalizeNull(b.value)) out.push({ path, value: normalizeNull(b.value) });
      return;
    }
    default: {
      if ((a as { value: unknown }).value !== (b as { value: unknown }).value) {
        out.push({ path, value: (b as { value: unknown }).value });
      }
    }
  }
}

// ---------- 回写 ----------

/**
 * 把改动写回 YAML 原文：仅对改动根 setIn，未触碰的注释/键序/引号风格原样保留。
 * 整段替换的数组内部注释会丢失（键上的注释不受影响）。
 */
export function applyYamlChanges(originalText: string, changed: ConfigChange[]): string {
  if (!changed.length) return originalText;
  const doc = parseDocument(originalText);
  if (doc.errors.length) throw new Error(doc.errors[0].message ?? $('pluginConfig.error.yamlParse'));
  for (const { path, value } of changed) {
    doc.setIn(pathToSteps(path), value === undefined ? null : value);
  }
  return matchEol(originalText, String(doc));
}

/** JSON 整体重序列化（本就无注释），统一 2 空格缩进 */
export function applyJsonChanges(originalText: string, changed: ConfigChange[]): string {
  if (!changed.length) return originalText;
  const pojo = JSON.parse(originalText) as Record<string, unknown>;
  for (const { path, value } of changed) {
    setBySteps(pojo, pathToSteps(path), value === undefined ? null : value);
  }
  return matchEol(originalText, `${JSON.stringify(pojo, null, 2)}\n`);
}

/** path 字符串 → 取值步骤：`a.b\[0].c[2]`（`\.` 为键内字面点）→ ['a','b.0','c',2] */
function pathToSteps(path: string): (string | number)[] {
  if (path === '') return [];
  const steps: (string | number)[] = [];
  // 先按未转义的 '.' 分段（key 里的字面点已被 escKey 转成 '\.'）
  const segs: string[] = [];
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '\\' && path[i + 1] === '.') {
      cur += '\\.';
      i++;
      continue;
    }
    if (path[i] === '.') {
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += path[i];
  }
  segs.push(cur);
  for (const seg of segs) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) continue;
    if (m[1] !== '') steps.push(m[1].replace(/\\([.])/g, '$1'));
    const idxs = m[2].match(/\[\d+\]/g);
    if (idxs) for (const s of idxs) steps.push(parseInt(s.slice(1, -1), 10));
  }
  return steps;
}

function setBySteps(obj: unknown, steps: (string | number)[], value: unknown): void {
  let cur: unknown = obj;
  for (let i = 0; i < steps.length - 1; i++) {
    const s = steps[i];
    const nextIsIndex = typeof steps[i + 1] === 'number';
    if (typeof s === 'number') {
      const arr = cur as unknown[];
      if (!Array.isArray(arr[s])) arr[s] = nextIsIndex ? [] : {};
      cur = arr[s];
    } else {
      const rec = cur as Record<string, unknown>;
      if (rec[s] === undefined || rec[s] === null) rec[s] = nextIsIndex ? [] : {};
      cur = rec[s];
    }
  }
  const last = steps[steps.length - 1];
  if (typeof last === 'number') (cur as unknown[])[last] = value;
  else (cur as Record<string, unknown>)[last as string] = value;
}

/** 输出换行符与原文件保持一致 */
function matchEol(original: string, out: string): string {
  const eol = eolOf(original);
  const normalized = out.replace(/\r?\n/g, '\n');
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}
