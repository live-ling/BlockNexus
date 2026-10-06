// 实例备份：列表 / 创建 / 恢复 / 下载 / 删除（tar.gz，存于服务器 .backups/<instance>/）
// 创建与恢复是异步任务：Agent 先回 started，完成后经 SSE 'backup.updated' 通知刷新。

import { useCallback, useEffect, useState } from 'react';
import { Download, HardDriveDownload, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, errText, fmtBytes, timeago, type ServerSummary } from '@/lib/api';
import { subscribeSSE } from '@/lib/sse';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';
import { ConfirmDialog } from '@/components/dialogs';

interface BackupInfo {
  file: string;
  size: number;
  mtime: number;
}

export function BackupDialog({
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
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [pending, setPending] = useState<string | null>(null); // 'create' | 'restore:<file>'
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const base = `/servers/${server.id}/instances/${encodeURIComponent(instance)}/backups`;

  const load = useCallback(() => {
    api<BackupInfo[]>(base)
      .then(setBackups)
      .catch((e) => error($('backup.error.load'), errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    if (!open) return;
    load();
    // 创建/恢复完成事件 → 刷新列表与解除 pending
    return subscribeSSE((e) => {
      if (e.type !== 'agent-event' || e.serverId !== server.id) return;
      if (e.event !== 'backup.updated' || e.data?.instance !== instance) return;
      setPending(null);
      load();
      if (e.data.done) {
        if (e.data.ok)
          success($('backup.toast.done'), typeof e.data.file === 'string' ? e.data.file : undefined);
        else error($('backup.toast.failed'), typeof e.data.error === 'string' ? e.data.error : undefined);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server.id, instance, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{$('backup.title', instance)}</DialogTitle>
          <DialogDescription>
            {$('backup.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[45vh] min-h-40 overflow-y-auto rounded-lg border">
          {backups === null ? (
            <div className="p-4 text-xs text-muted-foreground">{$('common.loading')}</div>
          ) : backups.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">{$('backup.empty')}</div>
          ) : (
            <ul className="divide-y">
              {backups.map((b) => (
                <li key={b.file} className="flex items-center gap-2 px-3 py-2.5">
                  <HardDriveDownload className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">{b.file}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {fmtBytes(b.size)} · {timeago(b.mtime)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => {
                      const a = document.createElement('a');
                      a.href = `${base}/download?file=${encodeURIComponent(b.file)}`;
                      a.download = b.file;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => setPending(`restore:${b.file}`)}
                  >
                    {$('backup.restore')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={pending !== null}
                    onClick={() => setDeleteTarget(b.file)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            disabled={pending !== null}
            onClick={async () => {
              setPending('create');
              try {
                await api(`${base}/create`, { method: 'POST', body: {} });
                success($('backup.toast.started'), $('backup.toast.startedDetail'));
              } catch (e) {
                setPending(null);
                error($('backup.error.start'), errText(e));
              }
            }}
          >
            <Plus className="h-4 w-4" /> {pending === 'create' ? $('backup.creating') : $('backup.create')}
          </Button>
        </div>

        {/* 恢复确认 */}
        <ConfirmDialog
          open={pending?.startsWith('restore:') ?? false}
          onOpenChange={(v) => {
            if (!v) setPending(null);
          }}
          title={$('backup.restoreConfirmTitle', pending?.slice(8) ?? '')}
          description={$('backup.restoreConfirmDesc')}
          onConfirm={async () => {
            const file = pending?.slice(8) ?? '';
            await api(`${base}/restore`, { method: 'POST', body: { file } });
            success($('backup.toast.restoreStarted'), $('backup.toast.restoreStartedDetail'));
          }}
        />

        {/* 删除确认 */}
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(v) => {
            if (!v) setDeleteTarget(null);
          }}
          title={$('backup.deleteConfirmTitle', deleteTarget ?? '')}
          description={$('backup.deleteConfirmDesc')}
          onConfirm={async () => {
            await api(`${base}/delete`, { method: 'POST', body: { file: deleteTarget } });
            success($('backup.toast.deleted'));
            load();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
