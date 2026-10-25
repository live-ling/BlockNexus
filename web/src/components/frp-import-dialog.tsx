// 樱花 frp 配置导入（粘贴 → 解析 → 保存）。
//
// 为什么单独一个组件：真正坑人的不是「填表」，而是樱花后台给的那份 TOML 里有两个
// 面板表单从来没有的字段（user / transport.tls.enable），缺了任意一个都会被节点拒绝登录。
// 让用户整段粘贴、面板挑字段，比对着表单手抄六七个值可靠得多。
//
// 语义（后端 POST /network/frp/import 负责执行）：只覆盖 upstream 段、模式切到 upstream，
// 不改「启用」开关；frpc 正在运行则由后端自动重启应用新配置。

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errText, importSakuraFrp } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

const SAMPLE = `user = "<访问密钥>"
auth.token = "<节点 token>"
serverAddr = "frp-top.com"
serverPort = 8088
transport.tls.enable = false

[[proxies]]
name = "aaa"
type = "tcp"
localIP = "localhost"
localPort = 25565
remotePort = 42399`;

export function FrpImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入成功后回调，调用方据此刷新卡片状态 */
  onImported?: (r: { tunnelIds: string[]; restarted: boolean }) => void;
}) {
  const { success, error } = useToastHelpers();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!text.trim()) {
      setErr($('frpImport.empty'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await importSakuraFrp(text);
      // 保存成功但 frpc 重启失败：不要吞掉，否则用户以为已经在跑
      if (r.error) error($('frpImport.savedButRestartFailed'), r.error);
      else success($('frpImport.saved'), r.tunnelIds.length ? $('frpImport.tunnelCount', String(r.tunnelIds.length)) : undefined);
      setText('');
      onOpenChange(false);
      onImported?.({ tunnelIds: r.tunnelIds, restarted: r.restarted });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? undefined : onOpenChange(v))}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{$('frpImport.title')}</DialogTitle>
          <DialogDescription>{$('frpImport.desc')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={11}
            spellCheck={false}
            placeholder={SAMPLE}
            className="w-full rounded-md border border-input bg-background px-2.5 py-2 font-mono text-[12px] leading-5 outline-none focus-visible:border-ring"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">{$('frpImport.hint')}</p>
          {err && <p className="text-[12px] leading-5 text-destructive">{err}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            {$('common.cancel')}
          </Button>
          <Button size="sm" disabled={busy} onClick={submit}>
            {busy ? $('common.saving') : $('frpImport.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
