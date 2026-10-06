// Mod 管理器：实例 mods 目录的列表 / 启用-禁用 / 删除 / 上传（含整窗拖拽）
// 启停 = 原地改名加/去 .disabled 后缀（Forge/Fabric 通用约定），路径由 Agent 锁定在 mods 内

import { useCallback, useEffect, useRef, useState } from 'react';
import { Power, PowerOff, Puzzle, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/dialogs';
import {
  deleteMod,
  errText,
  listMods,
  timeago,
  toggleMod,
  type ModsList,
} from '@/lib/api';
import { uploadFile } from '@/lib/upload';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

interface Props {
  serverId: string;
  instance: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Mod 列表发生变化（上传/启停/删除）后回调，父级可借此刷新实例信息 */
  onChanged?: () => void;
}

export function ModManagerDialog({ serverId, instance, open, onOpenChange, onChanged }: Props) {
  const { success, error } = useToastHelpers();
  const [list, setList] = useState<ModsList | null>(null);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ name: string; pct: number }[]>([]);
  // 整窗拖拽：dragenter/dragleave 会随子元素反复触发，用计数器判断真正离开
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    listMods(serverId, instance)
      .then(setList)
      .catch((e) => error($('modManager.error.load'), errText(e)));
  }, [serverId, instance, error]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  // 关闭对话框时复位拖拽状态（拖拽中按 Esc 关窗等）
  useEffect(() => {
    if (!open) {
      dragDepth.current = 0;
      setDragging(false);
    }
  }, [open]);

  const doToggle = async (file: string, disable: boolean, label: string) => {
    setBusyFile(file);
    try {
      await toggleMod(serverId, instance, file, disable);
      success(
        disable ? $('modManager.toast.disabled', label) : $('modManager.toast.enabled', label),
        $('modManager.toast.toggleDetail'),
      );
      reload();
      onChanged?.();
    } catch (e) {
      error($('modManager.error.action'), errText(e));
    } finally {
      setBusyFile(null);
    }
  };

  const doDelete = async (file: string) => {
    setBusyFile(file);
    try {
      await deleteMod(serverId, instance, file);
      success($('fileManager.toast.deleted'), file);
      setDeleting(null);
      reload();
      onChanged?.();
    } catch (e) {
      error($('modManager.error.delete'), errText(e));
    } finally {
      setBusyFile(null);
    }
  };

  const doUpload = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    // Mod 只认 .jar（.jar.disabled 也接受，按禁用态放入）；混入的其他文件不静默丢弃
    const jars = arr.filter((f) => /\.jar(\.disabled)?$/i.test(f.name));
    const skipped = arr.length - jars.length;
    if (skipped > 0) error($('modManager.toast.skippedNonJar', skipped), $('modManager.toast.onlyJar'));
    if (!jars.length) return;
    for (const f of jars) {
      setUploading((cur) => [...cur, { name: f.name, pct: 0 }]);
      try {
        await uploadFile(serverId, instance, 'mods', f, (pct) =>
          setUploading((cur) => cur.map((u) => (u.name === f.name ? { ...u, pct } : u))),
        );
      } catch (e) {
        error($('modManager.toast.uploadFailed', f.name), errText(e));
      }
    }
    setUploading([]);
    success($('modManager.toast.uploadDone'), $('modManager.toast.uploadDoneDetail'));
    reload();
    onChanged?.();
  };

  const enabled = list?.mods.filter((m) => !m.disabled).length ?? 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-lg"
          onDragEnter={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            void doUpload(e.dataTransfer.files);
          }}
        >
          {/* 拖拽覆盖层：整窗任意位置松开即上传 */}
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-50 grid place-items-center rounded-lg border-2 border-dashed border-primary bg-background/85">
              <div className="flex flex-col items-center gap-2 text-primary">
                <Upload className="h-8 w-8" />
                <p className="text-sm font-medium">{$('modManager.drop.title')}</p>
                <p className="text-xs text-muted-foreground">{$('modManager.drop.hint')}</p>
              </div>
            </div>
          )}
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Puzzle className="h-4 w-4 text-primary" /> {$('instanceDetail.mods')}
              <span className="font-mono text-xs font-normal text-muted-foreground">{instance}</span>
            </DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {list
                ? $('modManager.stats', enabled, (list.mods.length ?? 0) - enabled)
                : $('common.loading')}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".jar,.disabled"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void doUpload(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" /> {$('fileManager.action.upload')}
              </Button>
              <Button variant="ghost" size="sm" onClick={reload}>
                <RefreshCw className="h-3.5 w-3.5" /> {$('modManager.refresh')}
              </Button>
            </span>
          </div>

          {list && !list.exists && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              {$('modManager.noModsDir')}
            </p>
          )}

          {/* 列表自身滚动（max-h 内收缩、隐藏滚动条），头部与底注固定 */}
          <div className="scrollbar-hide grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto">
            {(list?.mods ?? []).map((m) => (
              <div
                key={m.file}
                className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    m.disabled ? 'bg-muted-foreground/50' : 'bg-emerald-500'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs" title={m.name}>
                    {m.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {fmtSize(m.size)} · {timeago(m.mtime)}
                    {m.disabled ? $('modManager.disabledSuffix') : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={busyFile === m.file}
                  title={m.disabled ? $('modManager.enableTitle') : $('modManager.disableTitle')}
                  onClick={() => void doToggle(m.file, !m.disabled, m.name)}
                >
                  {m.disabled ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={busyFile === m.file}
                  title={$('modManager.deleteTitle')}
                  onClick={() => setDeleting(m.file)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {list?.exists && !list.mods.length && (
              <p className="px-1 py-3 text-center text-xs text-muted-foreground">
                {$('modManager.empty')}
              </p>
            )}
            {uploading.map((u) => (
              <div key={u.name} className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
                <p className="truncate font-mono text-xs">{u.name}</p>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${u.pct}%` }} />
                </div>
              </div>
            ))}
          </div>

          <p className="text-[11px] leading-snug text-muted-foreground">
            {$('modManager.hint')}
          </p>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={$('modManager.deleteConfirmTitle', deleting ?? '')}
        description={$('modManager.deleteConfirmDesc')}
        onConfirm={async () => {
          if (deleting) await doDelete(deleting);
        }}
      />
    </>
  );
}
