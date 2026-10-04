// 上传通道选择：加密通道（512KB 分块，单文件 200MB）或 SFTP 直传（需 SSH 凭据，无上限）
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ServerSummary } from '@/lib/api';

export type UploadChannel = 'channel' | 'sftp';

export function sftpAvailable(server: ServerSummary): boolean {
  return server.ssh.hasPassword || server.ssh.hasKey;
}

export function UploadChannelSelect({
  server,
  value,
  onChange,
}: {
  server: ServerSummary;
  value: UploadChannel;
  onChange: (v: UploadChannel) => void;
}) {
  const ready = sftpAvailable(server);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Label className="text-xs text-muted-foreground">传输通道</Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as UploadChannel)}
      >
        <SelectTrigger size="sm" className="w-[190px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="channel">加密通道（分块上传）</SelectItem>
          <SelectItem value="sftp" disabled={!ready}>
            SFTP 直传{ready ? '' : '（未配置 SSH 凭据）'}
          </SelectItem>
        </SelectContent>
      </Select>
      <span className="text-muted-foreground">
        {value === 'sftp'
          ? '用服务器 SSH 凭据直传到实例目录，无 200MB 上限'
          : '经面板加密通道分块传输，单文件上限 200MB'}
      </span>
    </div>
  );
}
