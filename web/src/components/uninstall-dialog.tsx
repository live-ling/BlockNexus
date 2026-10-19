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
import { $ } from '@/lib/i18n';
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
  const [failed, setFailed] = useState(false);
  const log = useSyncExternalStore(installLogStore.subscribe, () =>
    installLogStore.get(uninstallLogKey(server.id)),
  );
  const isLocal = !!server.isLocal;

  useEffect(() => {
    if (open) {
      setBusy(false);
      setFailed(false);
      setRemoveServer(false);
      if (!stopOnly) setDeleteInstances(false);
    } else {
      setBusy(false);
      setFailed(false);
    }
  }, [open, stopOnly]);

  // 卸载完成（SSE 写入 done 标记）→ 成功才自动关闭；失败保持打开并把原因摊在用户面前，
  // 否则「卸载失败」会在 600ms 后随弹窗一起消失，用户只看到服务器还是连不上。
  useEffect(() => {
    if (!busy || log?.done == null) return;
    if (log.done === false) {
      setFailed(true);
      setBusy(false);
      // 失败也可能已经停掉了服务/进程：刷新一次页面，别让卡片继续显示「在线」
      onDone();
      return;
    }
    const t = window.setTimeout(() => {
      onOpenChange(false);
      onDone();
    }, 600);
    return () => window.clearTimeout(t);
  }, [busy, log?.done, onOpenChange, onDone]);

  const start = async () => {
    setBusy(true);
    setFailed(false);
    installLogStore.open(uninstallLogKey(server.id));
    try {
      // 本机「停止」单独走 /local-agent/stop，语义就是停进程保留数据
      await api(stopOnly ? `/servers/${server.id}/local-agent/stop` : `/servers/${server.id}/uninstall`, {
        method: 'POST',
        body: stopOnly ? {} : { keepBackups, deleteInstances, removeServer },
      });
      if (stopOnly) success($('uninstall.toast.stopping'));
      else if (isLocal)
        success(
          deleteInstances ? $('uninstall.toast.startedLocalDelete') : $('uninstall.toast.started'),
        );
      else success(removeServer ? $('uninstall.toast.startedRemoteRemove') : $('uninstall.toast.started'));
    } catch (e) {
      error(stopOnly ? $('serverSettings.error.stop') : $('uninstall.error.start'), errText(e));
      setBusy(false);
      return;
    }
    // 结束由上面的 effect 判断（成功自动关闭，失败留在原地）
  };

  const title = stopOnly
    ? $('uninstall.title.stop')
    : isLocal
      ? $('uninstall.title.local')
      : $('uninstall.title.remote');
  const confirmText = stopOnly ? $('uninstall.confirm.stop') : $('uninstall.confirm.uninstall');

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
                {$('uninstall.stopDesc.pre')}
                {server.localAgent?.pid || $('common.unknown')}
                {$('uninstall.stopDesc.mid')}
                <strong>{$('uninstall.stopDesc.strong')}</strong>
                {$('uninstall.stopDesc.post')}
              </>
            ) : isLocal ? (
              <>
                {$('uninstall.localDesc.pre')}
                <strong>{$('uninstall.localDesc.strongStop')}</strong>
                {$('uninstall.localDesc.mid')}
                <strong>{$('uninstall.localDesc.strongKeep')}</strong>
                {$('uninstall.localDesc.post')}
                <span className="block text-xs text-muted-foreground mt-1">
                  {$('uninstall.localDesc.dir')}
                  <code className="font-mono">{server.localAgent?.dir || 'data/local-agents/<id>'}</code>
                </span>
              </>
            ) : (
              <>
                {$('uninstall.remoteDesc.pre')}
                <strong>{$('uninstall.remoteDesc.strong')}</strong>
                {$('uninstall.remoteDesc.mid')}
                {$('uninstall.remoteDesc.post')}
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
                {$('uninstall.opt.deleteInstances')}
                <span className="block text-xs text-muted-foreground">
                  {$('uninstall.opt.deleteInstancesHint.pre')}
                  <code className="font-mono">{server.localAgent?.instancesDir || 'instances/'}</code>
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
                {$('uninstall.opt.keepBackups')}
                <span className="block text-xs text-muted-foreground">
                  {$('uninstall.opt.keepBackupsHint.pre')}
                  <code className="font-mono">{$('uninstall.opt.keepBackupsHint.code')}</code>
                  {$('uninstall.opt.keepBackupsHint.post')}
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
                {$('uninstall.opt.removeServer')}
                <span className="block text-xs text-muted-foreground">
                  {$('uninstall.opt.removeServerHint')}
                </span>
              </span>
            </label>
          )}

          {failed && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">
                <strong>{$('uninstall.failed.title')}</strong>
                <span className="mt-0.5 block text-muted-foreground">{$('uninstall.failed.hint')}</span>
              </span>
            </div>
          )}

          {log?.lines && <LogViewer lines={log.lines} />}
        </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {busy
              ? stopOnly
                ? $('uninstall.busy.stop')
                : $('uninstall.busy.uninstall')
              : $('common.cancel')}
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
