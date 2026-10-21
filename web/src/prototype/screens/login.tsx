// 原型屏 6：登录。全窗口唯一居中的页面——真实应用里也只有这里值得居中。
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { INPUT_CLASS } from '../proto-ui';
import { ProtoScreenSelect, type ProtoScreen } from '../shell';

export function LoginScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  return (
    <div className="relative grid h-screen place-items-center bg-muted/30">
      <div className="w-[360px] rounded-xl border bg-card p-5">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="size-8 rounded-full object-cover ring-1 ring-border" />
          <div className="grid leading-tight">
            <h1 className="text-[13.5px] font-semibold">{$('proto.login.title')}</h1>
            <p className="text-[11px] text-muted-foreground">{$('proto.login.subtitle')}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3">
          <label className="grid gap-1">
            <span className="text-[11.5px] text-muted-foreground">{$('proto.field.username')}</span>
            <input className={`${INPUT_CLASS} h-9`} defaultValue="admin" />
          </label>
          <label className="grid gap-1">
            <span className="text-[11.5px] text-muted-foreground">{$('proto.field.password')}</span>
            <input className={`${INPUT_CLASS} h-9`} type="password" defaultValue="12345678" />
          </label>

          <div className="flex items-center gap-2">
            <Switch size="sm" />
            <span className="text-[11.5px] text-muted-foreground">{$('proto.login.remember')}</span>
            <button type="button" className="ml-auto text-[11.5px] text-primary hover:underline">
              {$('proto.login.forgot')}
            </button>
          </div>

          <Button size="lg" className="w-full">
            {$('proto.btn.signIn')}
          </Button>

          <p className="text-center text-[10.5px] text-muted-foreground/80">{$('proto.login.tip')}</p>
        </div>
      </div>

      <div className="absolute right-3 bottom-3">
        <ProtoScreenSelect screen="login" onScreen={onScreen} />
      </div>
    </div>
  );
}
