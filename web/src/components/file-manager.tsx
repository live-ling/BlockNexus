// 文件管理器：beUI FileTree（懒加载目录树）+ beUI FileUpload（分块上传队列）
// + 文本预览/编辑 + 下载/删除/新建文件夹 + 复制/剪切/粘贴（移动）/重命名/压缩/解压。
// 所有路径由 Agent 端锁定在实例目录内。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ClipboardPaste,
  Copy,
  Download,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  FolderPlus,
  ListChecks,
  Pencil,
  RefreshCw,
  Save,
  Scissors,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from '@/components/motion/file-tree';
import {
  FileUpload,
  type FileUploadItem,
} from '@/components/motion/file-upload';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, errText, type ServerSummary } from '@/lib/api';
import { abortUpload, uploadFile, uploadFileViaSftp } from '@/lib/upload';
import { UploadChannelSelect, type UploadChannel } from '@/components/upload-channel';
import { useToastHelpers } from '@/lib/toast';
import { ConfirmDialog } from '@/components/dialogs';

interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
}

interface TreeNode {
  value: string;
  name: string;
  type: 'dir' | 'file';
  loaded: boolean;
  children: TreeNode[];
}

/** 剪贴板/批量操作的目标条目 */
interface ClipItem {
  path: string;
  name: string;
  type: 'dir' | 'file';
}

const TEXT_EXT = /\.(txt|log|json|yml|yaml|properties|cfg|conf|md|mcmeta|csv|sh|toml|ini)$/i;
const ARCHIVE_EXT = /\.(zip|tar\.gz|tgz|tar)$/i;

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** exp;
  return `${v >= 10 || exp === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[exp]}`;
}

function parentOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx === -1 ? '' : rel.slice(0, idx);
}

function baseName(rel: string): string {
  return rel.split('/').pop() || rel;
}

/** 目标目录已有同名时自动加 " (n)" 后缀（粘贴/压缩产物不静默覆盖） */
function uniqueName(existing: string[], name: string): string {
  if (!existing.includes(name)) return name;
  const i = name.lastIndexOf('.');
  const stem = i > 0 ? name.slice(0, i) : name;
  const ext = i > 0 ? name.slice(i) : '';
  for (let n = 1; ; n++) {
    const cand = `${stem} (${n})${ext}`;
    if (!existing.includes(cand)) return cand;
  }
}

function iconFor(name: string) {
  if (/\.jar$/i.test(name)) return <FileArchive className="size-4 text-amber-500" />;
  if (/\.(png|jpe?g|gif|webp|ico)$/i.test(name)) return <FileImage className="size-4 text-sky-500" />;
  if (TEXT_EXT.test(name)) return <FileText className="size-4 text-emerald-500" />;
  return <FileCode2 className="size-4" />;
}

function fileUrl(serverId: string, instance: string, rel: string) {
  return `/api/servers/${serverId}/instances/${encodeURIComponent(instance)}/files/download?path=${encodeURIComponent(rel)}`;
}

export function FileManagerDialog({
  server,
  instance,
  open,
  onOpenChange,
}: {
  server: ServerSummary;
  instance: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { success, error } = useToastHelpers();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ value: string; type: 'dir' | 'file' } | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string; size: number; mtime: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [uploads, setUploads] = useState<FileUploadItem[]>([]);
  const [channel, setChannel] = useState<UploadChannel>('channel');
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<string[] | null>(null);
  /** 文件剪贴板：复制/剪切（支持多项），粘贴到当前目录 */
  const [clip, setClip] = useState<{ items: ClipItem[]; mode: 'copy' | 'cut' } | null>(null);
  /** 树上的批量勾选集合（跨目录保留，操作优先作用于勾选项） */
  const [checked, setChecked] = useState<string[]>([]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [extractTarget, setExtractTarget] = useState<string | null>(null);
  const uploadIds = useRef(new Map<string, string>()); // itemId -> uploadId
  const previewSeq = useRef(0);

  const base = `/servers/${server.id}/instances/${encodeURIComponent(instance)}/files`;
  const currentDir = selected ? (selected.type === 'dir' ? selected.value : parentOf(selected.value)) : '';

  // ---------- 树数据 ----------
  const mergeChildren = useCallback((nodes: TreeNode[], rel: string, entries: FileEntry[]): TreeNode[] => {
    if (rel === '') {
      return entries.map((e) => ({
        value: e.name,
        name: e.name,
        type: e.type,
        loaded: false,
        children: [],
      }));
    }
    return nodes.map((n) => {
      if (n.value !== rel) {
        return { ...n, children: mergeChildren(n.children, rel, entries) };
      }
      return {
        ...n,
        loaded: true,
        children: entries.map((e) => ({
          value: `${rel}/${e.name}`,
          name: e.name,
          type: e.type,
          loaded: false,
          children: [],
        })),
      };
    });
  }, []);

  const loadDir = useCallback(
    async (dir: string, quiet = false) => {
      try {
        const entries = await api<FileEntry[]>(`${base}?path=${encodeURIComponent(dir)}`);
        setTree((cur) => mergeChildren(cur, dir, entries));
      } catch (e) {
        if (!quiet) error('目录读取失败', errText(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base],
  );

  useEffect(() => {
    if (!open) return;
    setTree([]);
    setExpanded([]);
    setSelected(null);
    setPreview(null);
    setDraft(null);
    setClip(null);
    setChecked([]);
    loadDir('');
  }, [open, loadDir]);

  const onExpandedChange = useCallback(
    (next: string[]) => {
      const added = next.filter((id) => !expanded.includes(id));
      setExpanded(next);
      for (const dir of added) {
        const found = (() => {
          const walk = (nodes: TreeNode[]): TreeNode | null => {
            for (const n of nodes) {
              if (n.value === dir) return n;
              const hit = walk(n.children);
              if (hit) return hit;
            }
            return null;
          };
          return walk(tree);
        })();
        if (found?.type === 'dir' && !found.loaded) loadDir(dir, true);
      }
    },
    [expanded, tree, loadDir],
  );

  // ---------- 选中 / 预览 ----------
  const selectNode = useCallback(
    (value: string) => {
      const walk = (nodes: TreeNode[]): TreeNode | null => {
        for (const n of nodes) {
          if (n.value === value) return n;
          const hit = walk(n.children);
          if (hit) return hit;
        }
        return null;
      };
      const node = walk(tree);
      setSelected({ value, type: node?.type ?? 'file' });
      if (node?.type === 'file') {
        const seq = ++previewSeq.current;
        setPreview(null);
        setDraft(null);
        setPreviewErr('');
        api<{ content: string; size: number; mtime: number }>(
          `${base}/content?path=${encodeURIComponent(value)}`,
        )
          .then((data) => {
            if (previewSeq.current !== seq) return;
            setPreview({ path: value, content: data.content, size: data.size, mtime: data.mtime });
            setDraft(data.content);
          })
          .catch((e) => {
            if (previewSeq.current !== seq) return;
            setPreviewErr(errText(e));
          });
      } else {
        setPreview(null);
        setDraft(null);
        setPreviewErr('');
      }
    },
    [tree, base],
  );

  const saveFile = async () => {
    if (!preview || draft === null) return;
    try {
      await api(`${base}/content`, { method: 'PUT', body: { path: preview.path, content: draft } });
      success('已保存', preview.path);
      setPreview({ ...preview, content: draft });
    } catch (e) {
      error('保存失败', errText(e));
    }
  };

  // ---------- 上传 ----------
  const uploadOne = useCallback(
    async (item: FileUploadItem, file: File) => {
      const setItem = (patch: Partial<FileUploadItem>) =>
        setUploads((cur) => cur.map((u) => (u.id === item.id ? { ...u, ...patch } : u)));
      try {
        if (channel === 'sftp') {
          await uploadFileViaSftp(server.id, instance, currentDir, file, (pct) => setItem({ progress: pct }));
        } else {
          await uploadFile(
            server.id,
            instance,
            currentDir,
            file,
            (pct) => setItem({ progress: pct }),
            (id) => uploadIds.current.set(item.id, id),
          );
          uploadIds.current.delete(item.id);
        }
        setItem({ status: 'success', progress: 100 });
        loadDir(currentDir, true);
      } catch (e) {
        // 出错不 abort：保留 Agent 侧半成品，点重试即断点续传；只有移除条目才真正取消
        setItem({ status: 'error', error: errText(e) });
        error('上传失败', `${file.name}: ${errText(e)}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, currentDir, loadDir, server.id, instance, channel],
  );

  const onFilesAdded = useCallback(
    (added: FileUploadItem[], files: File[]) => {
      files.forEach((file, i) => uploadOne(added[i], file));
    },
    [uploadOne],
  );

  const onUploadRetry = useCallback(
    (item: FileUploadItem) => {
      if (item.file) uploadOne(item, item.file);
    },
    [uploadOne],
  );

  // 移除上传条目 = 用户明确取消：丢弃 Agent 侧的半成品
  const onUploadRemove = useCallback(
    (item: FileUploadItem) => {
      const uploadId = uploadIds.current.get(item.id);
      if (uploadId) {
        abortUpload(server.id, instance, uploadId).finally(() => uploadIds.current.delete(item.id));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server.id, instance],
  );

  // ---------- 其他操作 ----------
  const mkdir = async (name: string) => {
    try {
      await api(`${base}/mkdir`, { method: 'POST', body: { path: `${currentDir ? currentDir + '/' : ''}${name}` } });
      setMkdirOpen(false);
      success('文件夹已创建');
      loadDir(currentDir, true);
    } catch (e) {
      error('创建失败', errText(e));
    }
  };

  /** 目录树里 dir 下已加载的子项（用于粘贴/压缩产物自动去重与全选） */
  const childNodesOf = useCallback(
    (dir: string): ClipItem[] => {
      if (dir === '') return tree.map((n) => ({ path: n.value, name: n.name, type: n.type }));
      const walk = (nodes: TreeNode[]): ClipItem[] | null => {
        for (const n of nodes) {
          if (n.value === dir) return n.children.map((c) => ({ path: c.value, name: c.name, type: c.type }));
          const hit = walk(n.children);
          if (hit) return hit;
        }
        return null;
      };
      return walk(tree) ?? [];
    },
    [tree],
  );

  // 批量操作目标：优先勾选项，无勾选时回退到单选项
  const checkedEntries = useMemo<ClipItem[]>(() => {
    if (!checked.length) return [];
    const types = new Map<string, 'dir' | 'file'>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        types.set(n.value, n.type);
        walk(n.children);
      }
    };
    walk(tree);
    return checked.map((p) => ({ path: p, name: baseName(p), type: types.get(p) ?? 'file' }));
  }, [checked, tree]);
  const batchTargets = checkedEntries.length
    ? checkedEntries
    : selected
      ? [{ path: selected.value, name: baseName(selected.value), type: selected.type }]
      : [];

  const copyOrCut = (mode: 'copy' | 'cut') => {
    if (!batchTargets.length) return;
    setClip({ items: batchTargets, mode });
    success(mode === 'copy' ? '已复制' : '已剪切', batchTargets.length > 1 ? `${batchTargets.length} 项` : batchTargets[0].name);
  };

  const pasteClip = async () => {
    if (!clip) return;
    const used = new Set(childNodesOf(currentDir).map((c) => c.name));
    const srcDirs = new Set<string>();
    const pasted: string[] = [];
    const failed: string[] = [];
    for (const item of clip.items) {
      const name = uniqueName([...used], item.name);
      const target = `${currentDir ? currentDir + '/' : ''}${name}`;
      try {
        await api(`${base}/${clip.mode === 'copy' ? 'copy' : 'move'}`, {
          method: 'POST',
          body: { from: item.path, to: target },
        });
        used.add(name);
        pasted.push(target);
        srcDirs.add(parentOf(item.path));
      } catch (e) {
        failed.push(`${item.name}：${errText(e)}`);
      }
    }
    if (pasted.length) {
      success(clip.mode === 'copy' ? `已粘贴 ${pasted.length} 项` : `已移动 ${pasted.length} 项`, failed.length ? `另有 ${failed.length} 项失败` : undefined);
      if (clip.mode === 'cut') {
        // 剪切成功的项从剪贴板与勾选集中移除（源路径已不存在）
        const okPaths = new Set(clip.items.filter((it) => !failed.some((f) => f.startsWith(`${it.name}：`))).map((it) => it.path));
        setClip((cur) => (cur ? { ...cur, items: cur.items.filter((it) => !okPaths.has(it.path)) } : null));
        setChecked((cur) => cur.filter((p) => !okPaths.has(p)));
      }
      loadDir(currentDir, true);
      srcDirs.forEach((d) => {
        if (d !== currentDir) loadDir(d, true);
      });
    }
    if (failed.length) error('部分粘贴失败', failed.slice(0, 3).join('；'));
  };

  const renameSelected = async (newName: string) => {
    if (!selected) return;
    const parent = parentOf(selected.value);
    const newPath = `${parent ? parent + '/' : ''}${newName}`;
    try {
      await api(`${base}/move`, { method: 'POST', body: { from: selected.value, to: newPath } });
      setRenameOpen(false);
      success('已重命名', `${baseName(selected.value)} → ${newName}`);
      setSelected({ ...selected, value: newPath });
      if (preview?.path === selected.value) setPreview({ ...preview, path: newPath });
      loadDir(parent, true);
    } catch (e) {
      error('重命名失败', errText(e));
    }
  };

  const compressSelected = async () => {
    if (!batchTargets.length || archiveBusy) return;
    const parent = parentOf(batchTargets[0].path);
    const outName =
      batchTargets.length === 1 ? `${batchTargets[0].name}.tar.gz` : `已选${batchTargets.length}项.tar.gz`;
    const out = uniqueName(childNodesOf(parent).map((c) => c.name), outName);
    setArchiveBusy(true);
    try {
      await api(`${base}/compress`, {
        method: 'POST',
        body: { paths: batchTargets.map((t) => t.path), out: `${parent ? parent + '/' : ''}${out}` },
      });
      success('已压缩', out);
      loadDir(parent, true);
    } catch (e) {
      error('压缩失败', errText(e));
    } finally {
      setArchiveBusy(false);
    }
  };

  const extractSelected = async () => {
    if (!extractTarget) return;
    setArchiveBusy(true);
    try {
      await api(`${base}/extract`, { method: 'POST', body: { path: extractTarget } });
      success('已解压', `到 /${parentOf(extractTarget)}`);
      setExtractTarget(null);
      loadDir(parentOf(extractTarget), true);
    } catch (e) {
      error('解压失败', errText(e));
    } finally {
      setArchiveBusy(false);
    }
  };

  const deleteSelected = async () => {
    const targets = deleteTargets;
    if (!targets?.length) return;
    const failed: string[] = [];
    for (const p of targets) {
      try {
        await api(`${base}/delete`, { method: 'POST', body: { path: p } });
      } catch (e) {
        failed.push(`${baseName(p)}：${errText(e)}`);
      }
    }
    if (!failed.length) {
      success(targets.length > 1 ? `已删除 ${targets.length} 项` : '已删除', baseName(targets[0]));
    } else {
      error('部分删除失败', failed.slice(0, 3).join('；'));
    }
    setDeleteTargets(null);
    setChecked((cur) => cur.filter((p) => !targets.includes(p)));
    if (preview && targets.some((t) => preview.path === t || preview.path.startsWith(t + '/'))) {
      setPreview(null);
      setDraft(null);
      setSelected(null);
    }
    setTree([]); // 简单起见整树重载
    setExpanded([]);
    setSelected(null);
    loadDir('');
  };

  const triggerDownload = () => {
    const files = batchTargets.filter((t) => t.type === 'file');
    if (!files.length) return;
    // 多文件逐个触发下载（间隔一点，避免浏览器合并/拦截）
    files.forEach((f, i) =>
      window.setTimeout(() => {
        const a = document.createElement('a');
        a.href = fileUrl(server.id, instance, f.path);
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 250),
    );
  };

  const renderNodes = useMemo(() => {
    const walk = (nodes: TreeNode[]): React.ReactNode =>
      nodes.map((n) =>
        n.type === 'dir' ? (
          <FileTreeFolder key={n.value} value={n.value} name={n.name}>
            {n.loaded && n.children.length ? walk(n.children) : null}
          </FileTreeFolder>
        ) : (
          <FileTreeFile key={n.value} value={n.value} name={n.name} icon={iconFor(n.name)} />
        ),
      );
    return walk(tree);
  }, [tree]);

  const selectedIsFile = selected?.type === 'file';
  const dirty = preview && draft !== null && draft !== preview.content;
  // 全选当前目录（对勾选集而言）
  const currentChildren = childNodesOf(currentDir);
  const allChecked = currentChildren.length > 0 && currentChildren.every((c) => checked.includes(c.path));
  const toggleSelectAll = () => {
    if (allChecked) {
      setChecked((cur) => cur.filter((p) => !currentChildren.some((c) => c.path === p)));
    } else {
      setChecked((cur) => [...new Set([...cur, ...currentChildren.map((c) => c.path)])]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[82vh] max-h-[82vh] flex-col sm:max-w-4xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>文件管理 · {instance}</DialogTitle>
          <DialogDescription>
            {selected ? (
              <span className="font-mono">/{selected.value}</span>
            ) : (
              '选择左侧文件查看；文件夹会按需加载'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-4">
          {/* 目录树 */}
          <div className="w-60 shrink-0 overflow-auto rounded-lg border p-1">
            {tree.length ? (
              <FileTree
                ariaLabel="实例文件树"
                value={selected?.value ?? null}
                onValueChange={selectNode}
                expandedIds={expanded}
                onExpandedChange={onExpandedChange}
                checkedIds={checked}
                onCheckedChange={setChecked}
              >
                {renderNodes}
              </FileTree>
            ) : (
              <div className="p-4 text-xs text-muted-foreground">加载中…</div>
            )}
          </div>

          {/* 右侧：工具栏 + 预览 */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {currentDir ? `/${currentDir}` : '/（实例根目录）'}
                {checked.length > 0 && (
                  <span className="ml-2 font-sans text-foreground">已勾选 {checked.length} 项</span>
                )}
              </span>
              <Button
                variant={allChecked ? 'secondary' : 'outline'}
                size="sm"
                disabled={!currentChildren.length}
                onClick={toggleSelectAll}
                title={allChecked ? '取消勾选当前目录全部子项' : '勾选当前目录全部子项'}
              >
                <ListChecks className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!batchTargets.length}
                onClick={() => copyOrCut('copy')}
                title="复制选中项（可多选，粘贴到目标目录）"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!batchTargets.length}
                onClick={() => copyOrCut('cut')}
                title="剪切选中项（可多选，粘贴到目标目录 = 移动）"
              >
                <Scissors className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={clip ? 'secondary' : 'outline'}
                size="sm"
                disabled={
                  !clip ||
                  (clip.mode === 'cut' &&
                    clip.items.some(
                      (it) => it.type === 'dir' && (currentDir === it.path || currentDir.startsWith(it.path + '/')),
                    ))
                }
                onClick={pasteClip}
                title={
                  clip
                    ? `粘贴 ${clip.items.length} 项到当前目录${clip.mode === 'cut' ? '（剪切=移动）' : ''}`
                    : '先复制或剪切文件'
                }
              >
                <ClipboardPaste className="h-3.5 w-3.5" />
                {clip && clip.items.length > 1 ? <span className="text-xs">{clip.items.length}</span> : null}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!selected}
                onClick={() => setRenameOpen(true)}
                title="重命名选中项"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!batchTargets.length || archiveBusy}
                onClick={compressSelected}
                title="压缩选中项为 .tar.gz（可多选，放在第一个选中项所在目录）"
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedIsFile || !selected || !ARCHIVE_EXT.test(selected.value) || archiveBusy}
                onClick={() => selected && setExtractTarget(selected.value)}
                title="解压 .zip / .tar.gz / .tgz / .tar 到所在目录"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!batchTargets.some((t) => t.type === 'file')}
                onClick={triggerDownload}
                title="下载选中的文件（可多选，仅文件）"
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={!batchTargets.length}
                onClick={() => setDeleteTargets(batchTargets.map((t) => t.path))}
                title="删除选中项（可多选）"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => mkdirOpen || setMkdirOpen(true)}>
                <FolderPlus className="h-3.5 w-3.5" /> 新建文件夹
              </Button>
              <Button variant="outline" size="sm" onClick={() => loadDir(currentDir, true)}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={showUpload ? 'secondary' : 'default'}
                size="sm"
                onClick={() => setShowUpload((v) => !v)}
              >
                <UploadCloud className="h-3.5 w-3.5" /> 上传
              </Button>
            </div>

            {showUpload && (
              <div className="grid max-h-56 shrink-0 gap-2 overflow-y-auto rounded-lg">
                <UploadChannelSelect server={server} value={channel} onChange={setChannel} />
                <FileUpload
                  value={uploads}
                  onValueChange={setUploads}
                  onFilesAdded={onFilesAdded}
                  onRetry={onUploadRetry}
                  onRemove={onUploadRemove}
                  multiple
                  title="拖拽文件到此处，或点击选择"
                  description={`将上传到 /${currentDir}${
                    channel === 'sftp' ? '（SFTP 直传，无大小限制）' : '（大文件自动分块，单文件上限 200MB）'
                  }`}
                  browseLabel="选择文件"
                />
              </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col rounded-lg border">
              {selectedIsFile && (preview || previewErr) ? (
                <>
                  <div className="flex items-center gap-2 border-b px-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {preview && !previewErr
                        ? `${baseName(preview.path)} · ${fmtBytes(preview.size)}`
                        : baseName(selected.value)}
                    </span>
                    {preview && !previewErr && (
                      <Button size="sm" variant={dirty ? 'default' : 'secondary'} disabled={!dirty} onClick={saveFile}>
                        <Save className="h-3.5 w-3.5" /> {dirty ? '保存修改' : '已同步'}
                      </Button>
                    )}
                  </div>
                  {previewErr ? (
                    <div className="grid flex-1 place-items-center p-4 text-center text-xs text-muted-foreground">
                      {previewErr}
                    </div>
                  ) : (
                    <textarea
                      value={draft ?? ''}
                      onChange={(e) => setDraft(e.target.value)}
                      spellCheck={false}
                      className="h-full min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-relaxed text-foreground outline-none"
                    />
                  )}
                </>
              ) : (
                <div className="grid flex-1 place-items-center p-4 text-center text-xs text-muted-foreground">
                  {selected
                    ? '已选中文件夹（上传/新建将作用于该目录）'
                    : '在左侧选择文件查看与编辑（文本文件）'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 新建文件夹 / 重命名 */}
        <NameDialog
          open={mkdirOpen}
          onOpenChange={setMkdirOpen}
          title="新建文件夹"
          description="在当前选中目录下创建。"
          confirmLabel="创建"
          placeholder="文件夹名称"
          onSubmit={mkdir}
        />
        <NameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          title="重命名"
          description="在所在目录内改名（也可用剪切+粘贴移动到其他目录）。"
          confirmLabel="重命名"
          placeholder="新名称"
          initial={selected ? baseName(selected.value) : ''}
          onSubmit={renameSelected}
        />

        {/* 解压确认 */}
        <ConfirmDialog
          open={extractTarget !== null}
          onOpenChange={(v) => {
            if (!v) setExtractTarget(null);
          }}
          title={`解压 ${baseName(extractTarget ?? '')}？`}
          description={`将解压到 /${extractTarget ? parentOf(extractTarget) : ''}（同名文件会被覆盖）。`}
          onConfirm={extractSelected}
        />

        {/* 删除确认 */}
        <ConfirmDialog
          open={deleteTargets !== null}
          onOpenChange={(v) => {
            if (!v) setDeleteTargets(null);
          }}
          title={
            deleteTargets && deleteTargets.length > 1
              ? `删除 ${deleteTargets.length} 项？`
              : `删除 ${baseName(deleteTargets?.[0] ?? '')}？`
          }
          description={
            <div>
              {deleteTargets && deleteTargets.length > 1 && (
                <p className="mb-1.5 font-mono text-xs">
                  {deleteTargets.slice(0, 5).map((t) => baseName(t)).join('、')}
                  {deleteTargets.length > 5 ? ' 等' : ''}
                </p>
              )}
              <p>所选文件/文件夹（含全部内容）将被永久删除。</p>
            </div>
          }
          onConfirm={deleteSelected}
        />
      </DialogContent>
    </Dialog>
  );
}

/** 通用名称输入对话框（新建文件夹 / 重命名共用）；Enter 提交 */
function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  placeholder,
  initial = '',
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  placeholder: string;
  initial?: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const { error } = useToastHelpers();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && name.trim() && !busy) {
              setBusy(true);
              await onSubmit(name.trim()).finally(() => setBusy(false));
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(name.trim());
              } catch (e) {
                error(errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
