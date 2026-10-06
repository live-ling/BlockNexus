// 卸载 Agent：确认（含可选保留备份、同时移除服务器）+ 实时日志
//
// 本机服务器（host 为 127.0.0.1 等）与远程服务器语义不同：
//   本机 —— Agent 进程由面板直接托管，卸载 = 停进程，实例目录默认保留（可勾选删除）；
//           不再提 systemd / SSH / 远程删除，也不会打包 tar.gz。
//   远程 —— 走 SSH 停服务 + 递归删除安装目录（含实例与备份），可勾选先打包备份。

import { useEffect, useSyncExternalStore, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LogViewer } from '@/components/log-viewer';
import { api, errText, type ServerSummary } from '@/lib/api';
import { installLogStore } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';

/** 卸载日志在 store 里用独立 key，避免与安装日志混淆 */
export const uninstallLogKey = (serverId: string) => `${serverId}:uninstall`;

/** stopOnly = 只停止本机 Agent（保留实例数据），不删目录、不走卸载流程 */
export function UninstallDialog({
  server,
  open,
  onOpenChange,
  onDone,
  /** true = 只停止本机 Agent（保留实例数据），不删目录 */
  stopOnly = false,
}: {
  server: ServerSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
  stopOnly?: boolean;
}) {
  const { success, error } = useToastHelpers();
  const [keepBackups, setKeepBackups] = useState(true);
  const [deleteInstances, setDeleteInstances] = useState(false);
  const [removeServer, setRemoveServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const log = useSyncExternalStore(installLogStore.subscribe, () =>
    installLogStore.get(uninstallLogKey(server.id)),
  );
  const isLocal = !!server.isLocal;

  useEffect(() => {
    if (open) {
      setBusy(false);
      setRemoveServer(false);
      if (!stopOnly) setDeleteInstances(false);
    } else {
      setBusy(false);
    }
  }, [open, stopOnly]);

  // 卸载完成（SSE 写入 done 标记）→ 稍停一拍让用户看到最后日志，自动关闭弹窗
  useEffect(() => {
    if (!busy || log?.done == null) return;
    const t = window.setTimeout(() => {
      onOpenChange(false);
      onDone();
    }, 600);
    return () => window.clearTimeout(t);
  }, [busy, log?.done, onOpenChange, onDone]);

  const start = async () => {
    setBusy(true);
    installLogStore.open(uninstallLogKey(server.id));
    try {
      // 本机「停止」单独走 /local-agent/stop，语义就是停进程保留数据
      await api(stopOnly ? `/servers/${server.id}/local-agent/stop` : `/servers/${server.id}/uninstall`, {
        method: 'POST',
        body: stopOnly ? {} : { keepBackups, deleteInstances, removeServer },
      });
      if (stopOnly) success('本机 Agent 正在停止');
      else if (isLocal)
        success(deleteInstances ? '卸载任务已开始，完成后将删除实例目录' : '卸载任务已开始');
      else success(removeServer ? '卸载任务已开始，完成后将移出面板' : '卸载任务已开始');
    } catch (e) {
      error(stopOnly ? '停止失败' : '卸载启动失败', errText(e));
      setBusy(false);
      return;
    }
    // 等日志流结束（done 标记由 SSE 写入）
    onDone();
  };

  const title = stopOnly ? '停止本机 Agent' : isLocal ? '卸载本机 Agent' : '卸载 Agent';
  const confirmText = stopOnly ? '确认停止' : '确认卸载';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle className={`flex items-center gap-2 ${stopOnly ? '' : 'text-destructive'}`}>
            <AlertTriangle className="h-4 w-4" /> {title} · {server.name}
          </DialogTitle>
          <DialogDescription>
            {stopOnly ? (
              <>
                只结束本机 Agent 进程（pid {server.localAgent?.pid || '未知'}），
                <strong>实例与存档全部保留</strong>，随时可以重新启动。
              </>
            ) : isLocal ? (
              <>
                本机 Agent 由面板直接托管：将<strong>停止 Agent 进程</strong>（结束时会先停止运行中的 MC
                实例），默认<strong>保留实例与存档</strong>，可勾选删除。
                <span className="block text-xs text-muted-foreground mt-1">
                  专用目录：
                  <code className="font-mono">{server.localAgent?.dir || 'data/local-agents/<id>'}</code>
                </span>
              </>
            ) : (
              <>
                将在服务器上执行：停止并删除<strong>全部 MC 实例（含存档）</strong>、移除 Agent 程序与
                systemd 服务。此操作不可撤销。
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* 选项与日志区自身滚动，底栏固定可见 */}
        <div className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <div className="grid gap-3">
          {!stopOnly && isLocal && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={deleteInstances}
                onCheckedChange={(v) => setDeleteInstances(v === true)}
              />
              <span>
                同时删除专用目录（含实例与存档）
                <span className="block text-xs text-muted-foreground">
                  不勾选仅停止 Agent，数据保留在
                  <code className="font-mono"> {server.localAgent?.instancesDir || 'instances/'}</code>
                </span>
              </span>
            </label>
          )}
          {!stopOnly && !isLocal && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={keepBackups}
                onCheckedChange={(v) => setKeepBackups(v === true)}
              />
              <span>
                卸载前把实例备份打包到安装目录之外
                <span className="block text-xs text-muted-foreground">
                  生成 <code className="font-mono">/opt/blocknexus-backups-&lt;时间&gt;.tar.gz</code>
                  （.backups 为空时跳过）
                </span>
              </span>
            </label>
          )}
          {!stopOnly && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={removeServer}
                onCheckedChange={(v) => setRemoveServer(v === true)}
              />
              <span>
                同时从面板移除该服务器
                <span className="block text-xs text-muted-foreground">
                  不勾选则保留记录（Agent 显示离线），可随时重新安装
                </span>
              </span>
            </label>
          )}

          {log?.lines && <LogViewer lines={log.lines} />}
        </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {busy ? stopOnly ? '停止中…' : '卸载中…' : '取消'}
          </Button>
          <Button
            variant="outline"
            className={
              stopOnly
                ? ''
                : 'border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive'
            }
            disabled={busy}
            onClick={start}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
