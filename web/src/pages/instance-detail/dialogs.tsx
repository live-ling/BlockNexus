/**
 * 实例页的两个「就地弹层」：Java 安装行与玩家操作确认框。
 *
 * 原来内联在 `pages/instance-detail.tsx` 尾部，拆出来是为了让主页面文件只做编排。
 * 行为保持不变（含 500ms 后回调刷新、原因可选的封禁指令拼接）。
 */

import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, errText } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

/** 侧栏内：Java 版本选择 + 安装（缺 Java 或版本低于 21 时显示） */
export function JavaInstallRow({ serverId, onDone }: { serverId: string; onDone: () => void }) {
  const { success, error } = useToastHelpers();
  const [busy, setBusy] = useState(false);
  const [major, setMajor] = useState('21');
  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <Select value={major} onValueChange={setMajor}>
        <SelectTrigger size="sm" className="w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="21">{$('instanceDetail.java.recommended', 21)}</SelectItem>
          <SelectItem value="17">Java 17</SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="secondary"
        className="ml-auto"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ busy?: boolean }>(`/servers/${serverId}/java-install`, {
              method: 'POST',
              body: { major: Number(major) },
            });
            success(r.busy
              ? $('instanceDetail.java.installing')
              : $('instanceDetail.java.queued', major), $('instanceDetail.java.queuedDetail'));
          } catch (e) {
            error(errText(e));
          } finally {
            setBusy(false);
            setTimeout(onDone, 500);
          }
        }}
      >
        {busy ? $('instanceDetail.java.installing.btn') : $('instanceDetail.java.install')}
      </Button>
    </div>
  );
}

/** 玩家操作确认框：踢出 / 封禁 / 封禁 IP 统一走这里，原因可选（随指令下发给服务端） */
export function PlayerActionDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: { name: string; kind: 'kick' | 'ban' | 'ban-ip' };
  onClose: () => void;
  /** 返回是否执行成功；成功后自动关闭 */
  onConfirm: (cmd: string, okText: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const meta = {
    kick: {
      title: $('instanceDetail.ban.kickTitle', target.name),
      cmd: `kick ${target.name}`,
      hint: $('instanceDetail.ban.kickHint'),
    },
    ban: {
      title: $('instanceDetail.ban.banTitle', target.name),
      cmd: `ban ${target.name}`,
      hint: $('instanceDetail.ban.banHint'),
    },
    'ban-ip': {
      title: $('instanceDetail.ban.banIpTitle', target.name),
      cmd: `ban-ip ${target.name}`,
      hint: $('instanceDetail.ban.banIpHint'),
    },
  }[target.kind];
  const cmd = reason.trim() ? `${meta.cmd} ${reason.trim()}` : meta.cmd;
  const okText =
    target.kind === 'kick'
      ? $('instanceDetail.ban.kicked', target.name)
      : target.kind === 'ban'
        ? $('instanceDetail.ban.banned', target.name)
        : $('instanceDetail.ban.bannedIp', target.name);

  const submit = async () => {
    setBusy(true);
    try {
      const ok = await onConfirm(cmd, okText);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{meta.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{cmd}</code>
              <span className="mt-1 block">{meta.hint}</span>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={$('instanceDetail.ban.reasonPlaceholder')}
          maxLength={100}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{$('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              await submit();
            }}
          >
            {busy ? $('instanceDetail.busy') : $('confirm.ok')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
