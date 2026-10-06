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
import { $ } from '@/lib/i18n';

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
      <Label className="text-xs text-muted-foreground">{$('uploadChannel.label')}</Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as UploadChannel)}
      >
        <SelectTrigger size="sm" className="w-[190px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="channel">{$('uploadChannel.channel')}</SelectItem>
          <SelectItem value="sftp" disabled={!ready}>
            {/* 相邻两个表达式之间 JSX 不留空白：边界空格写在 uploadChannel.sftp.noCreds 的键值里 */}
            {$('uploadChannel.sftp')}{ready ? '' : $('uploadChannel.sftp.noCreds')}
          </SelectItem>
        </SelectContent>
      </Select>
      <span className="text-muted-foreground">
        {value === 'sftp' ? $('uploadChannel.sftp.hint') : $('uploadChannel.channel.hint')}
      </span>
    </div>
  );
}
