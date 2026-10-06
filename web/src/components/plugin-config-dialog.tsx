// 插件配置可视化编辑：自动发现实例目录里的 plugins/、config/ 与根目录配置文件，
// YAML/JSON 生成结构化表单（只改值，注释与键序原样保留；数组支持增删项），
// TOML 与解析失败者降级原文编辑。复用通用文件接口（fs.read/fs.write 的 REST 封装），
// Agent 与面板零改动。解析/diff/回写逻辑见 lib/plugin-config.ts。

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  FolderOpen,
  Plus,
  RotateCw,
  Save,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errText, type Instance, type ServerSummary } from '@/lib/api';
import { $, type TranslationKey } from '@/lib/i18n';
import {
  applyJsonChanges,
  applyYamlChanges,
  assignPaths,
  cloneTree,
  detectFormat,
  diffTree,
  findNode,
  parseJsonConfig,
  parseYamlConfig,
  type ConfigChange,
  type ConfigFormat,
  type ConfigNode,
  type ParseResult,
} from '@/lib/plugin-config';
import { useToastHelpers } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
}

interface ConfigFile {
  path: string; // 相对实例根
  group: 'plugins' | 'config' | 'root';
  format: ConfigFormat | null;
}

const GROUP_ORDER: ConfigFile['group'][] = ['plugins', 'config', 'root'];
/** 模块顶层只存键名（$() 在渲染期取词，避免被语言切换冻结） */
const GROUP_LABEL_KEYS: Record<ConfigFile['group'], TranslationKey> = {
  plugins: 'pluginConfig.group.plugins',
  config: 'pluginConfig.group.config',
  root: 'pluginConfig.group.root',
};

/** 根目录参与发现的常见配置（server.properties 走专用编辑器，排除） */
const ROOT_CONFIG_RE = /^(bukkit|spigot|paper|purpur|commands|permissions|eula|rules|weave|velocity)\.ya?ml$|^(whitelist|banned-players|banned-ips|ops|usercache)\.json$|^[a-z0-9_-]+\.toml$/i;

export function PluginConfigDialog({
  server,
  instance,
  open,
  onOpenChange,
  onRestart,
}: {
  server: ServerSummary;
  instance: Instance | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRestart: () => void;
}) {
  const [files, setFiles] = useState<ConfigFile[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverErr, setDiscoverErr] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ConfigFile | null>(null);

  const base = `/servers/${server.id}/instances/${encodeURIComponent(instance?.name ?? '')}/files`;

  const listDir = useCallback(
    async (dir: string): Promise<FileEntry[]> => {
      try {
        return await api<FileEntry[]>(`${base}?path=${encodeURIComponent(dir)}`);
      } catch {
        return []; // 目录不存在（vanilla 没有 plugins/ 等）静默为空
      }
    },
    [base],
  );

  const discover = useCallback(async () => {
    if (!instance) return;
    setDiscovering(true);
    setDiscoverErr('');
    setFiles([]);
    setSelected(null);
    try {
      const found: ConfigFile[] = [];
      const addFile = (path: string, group: ConfigFile['group']) => {
        const format = detectFormat(path.split('/').pop() ?? path);
        if (format) found.push({ path, group, format });
      };
      // plugins/ 下的 yml（如 plugins/EssentialsXXX.yml）+ config/ 与两者各自子目录的第一层
      const collectDir = (dir: string, group: ConfigFile['group']) => async (entries: FileEntry[]) => {
        for (const e of entries) {
          if (e.type === 'file') addFile(`${dir}/${e.name}`, group);
        }
        const subDirs = entries.filter((e) => e.type === 'dir');
        const subLists = await Promise.all(subDirs.map((d) => listDir(`${dir}/${d.name}`)));
        subDirs.forEach((d, i) => {
          for (const e of subLists[i]) {
            if (e.type === 'file') addFile(`${dir}/${d.name}/${e.name}`, group);
          }
        });
      };

      const [root, plugDir, confDir] = await Promise.all([listDir(''), listDir('plugins'), listDir('config')]);
      await Promise.all([
        collectDir('plugins', 'plugins')(plugDir),
        collectDir('config', 'config')(confDir),
      ]);
      for (const e of root) {
        if (e.type === 'file' && ROOT_CONFIG_RE.test(e.name)) addFile(e.name, 'root');
      }

      found.sort(
        (a, b) =>
          GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.path.localeCompare(b.path),
      );
      setFiles(found);
      if (found.length) setSelected(found[0]);
      else setDiscoverErr($('pluginConfig.discover.none'));
    } catch (e) {
      setDiscoverErr(errText(e));
    } finally {
      setDiscovering(false);
    }
  }, [instance, listDir]);

  useEffect(() => {
    if (open) discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, instance?.name]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, query]);

  const groups = useMemo(() => {
    const map = new Map<ConfigFile['group'], ConfigFile[]>();
    for (const f of filtered) {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, list: map.get(g)! }));
  }, [filtered]);

  const running = instance?.status === 'running' || instance?.status === 'starting';

  if (!instance) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 宽度须在 sm: 变体内覆盖基件的 sm:max-w-sm（512px）；无变体的 max-w-* 会被它压回去 */}
      <DialogContent className="flex max-h-[88vh] flex-col gap-3 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4" /> {$('pluginConfig.title', instance.name)}
          </DialogTitle>
          <DialogDescription>
            {$('pluginConfig.description')}
            {running && <span className="text-amber-600 dark:text-amber-400">{$('pluginConfig.runningNotice')}</span>}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(230px,290px)_minmax(0,1fr)] gap-3 overflow-hidden">
          {/* 左列：文件列表 */}
          <div className="flex min-h-0 flex-col gap-2 rounded-md border bg-muted/20 p-2">
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={$('pluginConfig.searchPlaceholder')}
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                title={$('pluginConfig.rescan')}
                onClick={discover}
                disabled={discovering}
              >
                <RotateCw className={cn('h-3.5 w-3.5', discovering && 'animate-spin')} />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {discoverErr ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">{discoverErr}</p>
              ) : (
                <div className="grid gap-2 pb-1">
                  {groups.map(({ group, list }) => (
                    <div key={group} className="grid gap-0.5">
                      <div className="flex items-center gap-1 px-1 py-0.5 text-[11px] font-medium text-muted-foreground">
                        <FolderOpen className="h-3 w-3" />
                        {$(GROUP_LABEL_KEYS[group])}
                        <span className="ml-auto tabular-nums">{list.length}</span>
                      </div>
                      {list.map((f) => (
                        <button
                          key={f.path}
                          type="button"
                          onClick={() => setSelected(f)}
                          className={cn(
                            'flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent',
                            selected?.path === f.path && 'bg-accent',
                          )}
                        >
                          <FormatIcon format={f.format} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{f.path}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 右列：编辑区 */}
          <div className="min-h-0 min-w-0">
            {selected ? (
              <ConfigEditor
                key={selected.path}
                base={base}
                file={selected}
                running={running}
                onSavedAndRestart={() => {
                  onRestart();
                  onOpenChange(false);
                }}
              />
            ) : (
              <div className="grid h-full place-items-center rounded-md border border-dashed text-xs text-muted-foreground">
                {discovering ? $('pluginConfig.scanning') : $('pluginConfig.pickFile')}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="!justify-end border-t pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {$('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormatIcon({ format }: { format: ConfigFormat | null }) {
  if (format === 'yaml') return <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  if (format === 'json') return <Braces className="h-3.5 w-3.5 shrink-0 text-sky-500" />;
  return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
}

// ---------- 单文件编辑器 ----------

/** 数组项增删操作（由编辑器实现，深层节点透传） */
interface ArrayOps {
  remove: (arrayPath: string, index: number) => void;
  append: (arrayPath: string) => void;
}

function ConfigEditor({
  base,
  file,
  running,
  onSavedAndRestart,
}: {
  base: string;
  file: ConfigFile;
  running: boolean;
  onSavedAndRestart: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [original, setOriginal] = useState('');
  /** 解析结果（冻结的初始树），null = 不可表单化 */
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  /** 工作树（编辑中的克隆），与 parsed 里的 root 同构 */
  const [working, setWorking] = useState<ConfigNode | null>(null);
  /** 每次 load 递增，作为表单容器的 key，强制输入框状态随重载重置 */
  const [gen, setGen] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api<{ content: string }>(
        `${base}/content?path=${encodeURIComponent(file.path)}&maxKB=2048`,
      );
      setOriginal(data.content);
      setRawText(data.content);
      let result: ParseResult;
      if (file.format === 'yaml') result = parseYamlConfig(data.content);
      else if (file.format === 'json') result = parseJsonConfig(data.content);
      else result = { error: $('pluginConfig.tomlReason') };
      if ('error' in result) {
        setParsed(result);
        setWorking(null);
        setShowRaw(true);
      } else {
        setParsed(result);
        setWorking(cloneTree(result.root));
        setShowRaw(false);
      }
      setGen((v) => v + 1);
    } catch (e) {
      setLoadError(errText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, file.path, file.format]);

  useEffect(() => {
    load();
  }, [load]);

  /** 对工作树做一次修改（克隆 → 变更 → 重建路径） */
  const mutate = useCallback((fn: (root: ConfigNode) => void) => {
    setWorking((cur) => {
      if (!cur) return cur;
      const next = cloneTree(cur);
      fn(next);
      assignPaths(next, '');
      return next;
    });
  }, []);

  const setLeaf = useCallback(
    (path: string, value: unknown) =>
      mutate((root) => {
        const n = findNode(root, path);
        if (n && (n.kind === 'bool' || n.kind === 'number' || n.kind === 'string' || n.kind === 'null')) {
          n.value = value as never;
        }
      }),
    [mutate],
  );

  const ops: ArrayOps = useMemo(
    () => ({
      remove: (arrayPath, index) =>
        mutate((root) => {
          const a = findNode(root, arrayPath);
          if (a?.kind === 'array') a.items.splice(index, 1);
        }),
      append: (arrayPath) =>
        mutate((root) => {
          const a = findNode(root, arrayPath);
          if (a?.kind === 'array') a.items.push(defaultItemNode(a.items[0]));
        }),
    }),
    [mutate],
  );

  const changes = useMemo<ConfigChange[]>(() => {
    if (!parsed || 'error' in parsed || !working) return [];
    const out: ConfigChange[] = [];
    diffTree(parsed.root, working, '', out);
    return out;
  }, [parsed, working]);
  const dirty = changes.length > 0;

  const save = async (restartAfter: boolean) => {
    setBusy(true);
    try {
      const p = parsed && !('error' in parsed) ? parsed : null;
      const content =
        showRaw || !p || !working
          ? rawText
          : p.format === 'yaml'
            ? applyYamlChanges(original, changes)
            : applyJsonChanges(original, changes);
      await api(`${base}/content`, { method: 'PUT', body: { path: file.path, content } });
      if (restartAfter) {
        onSavedAndRestart();
      } else {
        success($('common.saved'), file.path);
        await load();
      }
    } catch (e) {
      error($('pluginConfig.error.save'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="grid h-full place-items-center text-xs text-muted-foreground">{$('pluginConfig.loading', file.path)}</div>;
  if (loadError)
    return (
      <div className="grid h-full place-items-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        {$('pluginConfig.error.load', loadError)}
      </div>
    );

  const parseError = parsed && 'error' in parsed ? parsed.error : '';
  const canForm = !!working && !parseError;
  const saveDirty = showRaw || !canForm ? rawText !== original : dirty;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <FormatIcon format={file.format} />
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{file.path}</code>
        {canForm && (
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? $('pluginConfig.backToForm') : $('pluginConfig.rawText')}
          </Button>
        )}
      </div>

      {(file.format === 'toml' || parseError) && (
        <p className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {parseError || $('pluginConfig.tomlReason')}
        </p>
      )}

      {showRaw || !canForm ? (
        <Textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none font-mono text-xs"
        />
      ) : (
        <div key={gen} className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-0.5 pb-2">
            {parsed && !('error' in parsed) && parsed.headerComment && (
              <p className="mb-1 text-[11px] text-muted-foreground">{parsed.headerComment}</p>
            )}
            {working!.kind === 'object' &&
              working!.children.map((child) => (
                <NodeView key={child.path} node={child} depth={0} onChange={setLeaf} ops={ops} />
              ))}
            {working!.kind === 'object' && !working!.children.length && (
              <p className="py-6 text-center text-xs text-muted-foreground">{$('pluginConfig.emptyFile')}</p>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-t pt-2">
        {running && (
          <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" /> {$('pluginConfig.needRestart')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy || !saveDirty} onClick={load}>
            {$('pluginConfig.discard')}
          </Button>
          {running ? (
            <Button size="sm" disabled={busy || !saveDirty} onClick={() => save(true)}>
              <RotateCw className="h-3.5 w-3.5" /> {$('pluginConfig.saveRestart')}
            </Button>
          ) : (
            <Button size="sm" disabled={busy || !saveDirty} onClick={() => save(false)}>
              <Save className="h-3.5 w-3.5" /> {$('pluginConfig.save')}
              {!showRaw && canForm && dirty ? $('pluginConfig.saveChanges', changes.length) : ''}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 标量数组新增项的默认节点（按首项类型推断；对象/嵌套数组不允许新增） */
function defaultItemNode(proto: ConfigNode | undefined): ConfigNode {
  if (proto?.kind === 'bool') return { kind: 'bool', path: '', key: '', value: false };
  if (proto?.kind === 'number') return { kind: 'number', path: '', key: '', value: 0, int: proto.int };
  if (proto?.kind === 'string') return { kind: 'string', path: '', key: '', value: '', multiline: proto.multiline };
  return { kind: 'string', path: '', key: '', value: '', multiline: false };
}

// ---------- 节点渲染 ----------

function NodeView({
  node,
  depth,
  onChange,
  ops,
}: {
  node: ConfigNode;
  depth: number;
  onChange: (path: string, value: unknown) => void;
  ops: ArrayOps;
}) {
  const [open, setOpen] = useState(!(node.kind === 'object' && node.collapsed));

  if (node.kind === 'object') {
    return (
      <section className={cn('grid gap-0.5', depth > 0 && 'border-l pl-3')}>
        {depth > 0 && (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 py-1 text-left hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
            {node.key && <span className="shrink-0 font-mono text-[11px] font-medium">{node.key}</span>}
            {node.comment && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{node.comment}</span>}
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{$('pluginConfig.itemsCount', node.children.length)}</span>
          </button>
        )}
        {(depth === 0 || open) &&
          node.children.map((c) => <NodeView key={c.path} node={c} depth={depth + 1} onChange={onChange} ops={ops} />)}
      </section>
    );
  }

  if (node.kind === 'array') {
    const scalarItems =
      node.items.length === 0 ||
      node.items.every((it) => it.kind === 'bool' || it.kind === 'number' || it.kind === 'string' || it.kind === 'null');
    const tooMany = node.items.length > 30;
    return (
      <section className={cn('grid gap-0.5', depth > 0 && 'border-l pl-3')}>
        {depth > 0 && (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 py-1 text-left hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
            {node.key && <span className="shrink-0 font-mono text-[11px] font-medium">{node.key}</span>}
            {node.comment && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{node.comment}</span>}
            <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
              {$('pluginConfig.itemsCount', node.items.length)}
              {scalarItems && !tooMany && (
                <span
                  role="button"
                  tabIndex={0}
                  className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                  title={$('pluginConfig.append')}
                  onClick={(e) => {
                    e.stopPropagation();
                    ops.append(node.path);
                    setOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation();
                      ops.append(node.path);
                      setOpen(true);
                    }
                  }}
                >
                  <Plus className="h-3 w-3" />
                </span>
              )}
            </span>
          </button>
        )}
        {(depth === 0 || open) &&
          (tooMany ? (
            <p className="py-1 text-[11px] text-muted-foreground">{$('pluginConfig.arrayTooLarge', node.items.length)}</p>
          ) : (
            node.items.map((it, i) => (
              <div key={it.path} className="flex items-start gap-1">
                <span className="pt-1.5 font-mono text-[10px] text-muted-foreground tabular-nums">{i}</span>
                <div className="min-w-0 flex-1">
                  <NodeView node={it} depth={depth + 1} onChange={onChange} ops={ops} />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                  title={$('pluginConfig.remove')}
                  onClick={() => ops.remove(node.path, i)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))
          ))}
      </section>
    );
  }

  return <LeafRow node={node} onChange={onChange} showKey={node.key !== ''} />;
}

type LeafNode = Exclude<ConfigNode, { kind: 'object' } | { kind: 'array' }>;

function LeafRow({
  node,
  onChange,
  showKey,
}: {
  node: LeafNode;
  onChange: (path: string, value: unknown) => void;
  showKey: boolean;
}) {
  const editor = (() => {
    if (node.kind === 'bool') {
      return (
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={node.value} onCheckedChange={(v) => onChange(node.path, v)} />
          <span className="text-[11px] text-muted-foreground">{node.value ? $('pluginConfig.on') : $('pluginConfig.off')}</span>
        </label>
      );
    }
    if (node.kind === 'number') {
      return <NumberInput value={node.value} int={node.int} onChange={(v) => onChange(node.path, v)} />;
    }
    if (node.kind === 'string') {
      return node.multiline ? (
        <Textarea
          value={node.value}
          onChange={(e) => onChange(node.path, e.target.value)}
          rows={3}
          spellCheck={false}
          className="min-h-0 font-mono text-xs"
        />
      ) : (
        <Input value={node.value} onChange={(e) => onChange(node.path, e.target.value)} className="h-7 text-xs" />
      );
    }
    // null：输入内容即转为字符串；清空回存为 null
    return (
      <Input
        value={typeof node.value === 'string' ? node.value : ''}
        placeholder={$('pluginConfig.nullPlaceholder')}
        onChange={(e) => onChange(node.path, e.target.value)}
        className="h-7 text-xs"
      />
    );
  })();

  if (!showKey) {
    return (
      <div className="grid gap-0.5 py-0.5">
        {editor}
        {node.comment && <span className="text-[11px] text-muted-foreground">{node.comment}</span>}
      </div>
    );
  }

  const withLabel =
    node.kind === 'bool' ? (
      <div className="flex items-center gap-2">{editor}</div>
    ) : (
      editor
    );

  return (
    <div className="grid gap-0.5 py-0.5">
      <div className="grid grid-cols-[minmax(7em,13em)_minmax(0,1fr)] items-center gap-2">
        <label className="min-w-0 truncate font-mono text-[11px]" title={node.key}>
          {node.key}
        </label>
        {withLabel}
      </div>
      {node.comment && <span className="col-start-2 text-[11px] text-muted-foreground">{node.comment}</span>}
    </div>
  );
}

/** 数字输入：中间态（"-"、"1." 等）不提交，解析成功才向上冒泡 */
function NumberInput({
  value,
  int,
  onChange,
}: {
  value: number;
  int: boolean;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // 外部值变化（重载/其他入口改动）时在渲染期重置输入框，避免 effect 级联渲染
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setText(String(value));
  }
  return (
    <Input
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const t = raw.trim();
        if (t === '' || t === '-' || t === '.' || t === '-.') return;
        const n = int ? parseInt(t, 10) : parseFloat(t);
        if (!Number.isNaN(n)) onChange(n);
      }}
      className="h-7 w-28 text-xs tabular-nums"
    />
  );
}
