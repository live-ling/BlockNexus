// 登录页 + 忘记密码（邮箱验证码）+ 重置密码页
// 三页共用同一套全屏背景（login-bg.jpg）：图片铺满 + 轻渐变遮罩，卡片毛玻璃浮在上面

import { useEffect, useRef, useState } from 'react';
import { LanguageToggle } from '@/components/language-toggle';
import { TextReveal } from '@/components/motion/text-reveal';
import { OTPInput, type OTPStatus } from '@/components/motion/otp-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errText } from '@/lib/api';
import { $ } from '@/lib/i18n';

/** 「记住我」记忆的用户名（localStorage；只存账号，不存密码） */
const REMEMBER_KEY = 'blocknexus.rememberUser';

/** 全屏背景容器：登录 / 找回 / 重置 三页共用，保证切换模式时背景不闪 */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      {/* 背景图 + 遮罩：左上压暗一点保证 logo 区对比度，整体保持画面清透 */}
      <img
        src="/login-bg.jpg"
        alt=""
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-background/35 via-background/15 to-background/5" />
      {/* 语言切换放在登录之前可达：否则英文用户连登录页都读不懂 */}
      <LanguageToggle className="absolute right-4 top-4 z-10" />
      {children}
    </div>
  );
}

/** 毛玻璃卡片：半透明底 + 背景模糊 + 细描边，在浅色插画上仍能看清文字 */
function GlassCard({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <Card
      className={`w-full max-w-[22rem] border-white/40 bg-white/65 shadow-xl shadow-sky-900/10 ring-1 ring-white/50 backdrop-blur-xl [--card-spacing:1.25rem] dark:border-white/10 dark:bg-card/70 dark:shadow-black/30 dark:ring-white/10 ${className}`}
    >
      {children}
    </Card>
  );
}

/** 卡片头部：logo + 标题 + 说明（三页共用，切换模式时不跳动） */
function AuthHeader({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <CardHeader>
      <div className="flex items-center gap-3">
        <img src="/logo.png" alt="BlockNexus" className="h-10 w-10 rounded-xl object-cover ring-1 ring-border" />
        <TextReveal as="span" text={title} split="char" stagger={0.06} className="text-xl font-bold tracking-tight" />
      </div>
      {description ? <CardDescription className="pt-1.5">{description}</CardDescription> : null}
    </CardHeader>
  );
}

/** 表单统一尺寸：输入框高一点、内边距宽一点；整体收在 19rem 列里（与验证码六格同宽，不撑满卡片） */
const FORM = 'mx-auto grid w-full max-w-[19rem] gap-5';
const FIELD = 'h-10 px-3.5 text-sm';

/** 表单行：标签在输入框上方，两者各占一行 */
function FieldRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  // 「记住我」：勾选时上次的用户名回填并保持登录（持久 Cookie）；仅存账号名，不存密码
  const [username, setUsername] = useState(() => localStorage.getItem(REMEMBER_KEY) ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => localStorage.getItem(REMEMBER_KEY) !== null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const goLogin = () => {
    setMode('login');
    setErr('');
  };

  if (mode === 'forgot') {
    return (
      <AuthShell>
        <ForgotFlow onBack={goLogin} onDone={goLogin} />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <GlassCard>
        <AuthHeader title={$('login.title')} description={$('login.subtitle')} />
        <CardContent>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setErr('');
              setBusy(true);
              try {
                await api('/login', { method: 'POST', body: { username, password, remember } });
                if (remember) localStorage.setItem(REMEMBER_KEY, username.trim());
                else localStorage.removeItem(REMEMBER_KEY);
                onLogin();
              } catch (ex) {
                setErr(errText(ex));
              } finally {
                setBusy(false);
              }
            }}
            className={FORM}
          >
            <FieldRow label={$('login.username')} htmlFor="un">
              <Input
                id="un"
                className={FIELD}
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </FieldRow>
            <FieldRow label={$('login.password')} htmlFor="pw">
              <Input
                id="pw"
                className={FIELD}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FieldRow>
            <label
              htmlFor="rm"
              className="-mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
              title={$('login.remember.tooltip')}
            >
              <Checkbox
                id="rm"
                checked={remember}
                onCheckedChange={(v) => setRemember(v === true)}
              />
              {$('login.remember')}
            </label>
            {err && <p className="text-center text-xs text-destructive">{err}</p>}
            <Button type="submit" className="h-10 w-full" disabled={busy}>
              {busy ? $('login.submitting') : $('login.submit')}
            </Button>
            {/* 「忘记密码」放在提交按钮之后：Tab 顺序保持 用户名 → 密码 → 登录 → 忘记密码 */}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="mx-auto h-auto px-0 text-xs text-muted-foreground"
              onClick={() => setMode('forgot')}
            >
              {$('login.forgot')}
            </Button>          </form>
        </CardContent>
      </GlassCard>
    </AuthShell>
  );
}

/** 忘记密码三步走：填邮箱 → 验证码校验通过 → 才出现新密码输入 */
function ForgotFlow({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [stage, setStage] = useState<'email' | 'code' | 'password'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [otpStatus, setOtpStatus] = useState<OTPStatus>('idle');
  const [ticket, setTicket] = useState('');
  const [cooldown, setCooldown] = useState(0); // 重发倒计时（秒），与后端限流对齐
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const verifying = useRef(false);
  const switchTimer = useRef<number | null>(null);

  // 倒计时：每秒减 1，归零后允许重新发送
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(
    () => () => {
      if (switchTimer.current) window.clearTimeout(switchTimer.current);
    },
    [],
  );

  const sendCode = async () => {
    setErr('');
    setBusy(true);
    try {
      // 响应不区分「邮箱是否匹配」（防枚举，见后端 /forgot-password 的说明），
      // 所以前端一律用中性文案，不据此判断邮箱是否存在。
      const r = await api<{ cooldownSec?: number }>('/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
      });
      setCooldown(r.cooldownSec ?? 60);
      setCode('');
      setOtpStatus('idle');
      setStage('code');
    } catch (ex) {
      setErr(errText(ex));
    } finally {
      setBusy(false);
    }
  };

  // 校验验证码：通过后拿一次性票据，进入设置新密码
  const verifyCode = async (value: string) => {
    if (verifying.current || value.length !== 6) return;
    verifying.current = true;
    setErr('');
    setBusy(true);
    try {
      const r = await api<{ ticket: string }>('/verify-reset-code', {
        method: 'POST',
        body: { code: value },
      });
      setTicket(r.ticket);
      setOtpStatus('success');
      // 让打勾动画播完再切页
      switchTimer.current = window.setTimeout(() => setStage('password'), 450);
    } catch (ex) {
      setOtpStatus('error');
      setErr(errText(ex));
    } finally {
      setBusy(false);
      verifying.current = false;
    }
  };

  if (stage === 'password') {
    return (
      <NewPasswordCard
        description={$('login.reset.description', email.trim())}
        submit={(pw) => api('/reset-password', { method: 'POST', body: { ticket, password: pw } })}
        onBack={onBack}
        onDone={onDone}
      />
    );
  }

  if (stage === 'code') {
    return (
      <GlassCard>
        <AuthHeader
          title={$('login.code.title')}
          description={
            // 两句各占一行（块级），避免 JSX 跨行文本折叠出多余空格。
            //
            // 这里**刻意不区分「邮箱是否匹配」**：后端现在对该分支的响应完全一致
            // （sent 恒为 true、且不等待发信），所以前端也只能给中性文案。
            // 原先「验证码已发往 <email>」那支已删除——邮箱不匹配时它就是谎报，
            // 而且它依赖后端把匹配结果告诉我，那正是被消除的枚举通道。
            <>
              <span className="block">{$('login.code.sentGeneric')}</span>
              <span className="block">{$('login.code.checkInbox')}</span>
            </>
          }
        />
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verifyCode(code);
            }}
            className={FORM}
          >
            {/* 验证码框居中，数字变化即清掉上一次的校验反馈 */}
            <div className="flex justify-center">
              <OTPInput
                length={6}
                value={code}
                status={otpStatus}
                autoFocus
                aria-label={$('login.code.aria')}
                slotClassName="h-12 w-11"
                onChange={(v) => {
                  setCode(v);
                  if (otpStatus !== 'idle') setOtpStatus('idle');
                  setErr('');
                }}
                onComplete={(v) => verifyCode(v)}
                hint={$('login.code.hint')}
              />
            </div>
            {err && <p className="text-center text-xs text-destructive">{err}</p>}
            <Button type="submit" className="h-10 w-full" disabled={busy || code.length !== 6}>
              {$('login.code.verifyAndContinue')}
            </Button>
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                disabled={busy || cooldown > 0}
                onClick={sendCode}
              >
                {cooldown > 0 ? $('login.forgot.resend.countdown', cooldown) : $('login.code.resend')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={() => {
                  setErr('');
                  setStage('email');
                }}
              >
                {$('login.code.changeEmail')}
              </Button>
            </div>
          </form>
        </CardContent>
      </GlassCard>
    );
  }

  return (
    <GlassCard>
      <AuthHeader
        title={$('login.forgot.heading')}
        description={$('login.forgot.description')}
      />
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendCode();
          }}
          className={FORM}
        >
          <FieldRow label={$('login.forgot.email')} htmlFor="fp-email">
            <Input
              id="fp-email"
              className={FIELD}
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FieldRow>
          {err && <p className="text-center text-xs text-destructive">{err}</p>}
          <Button type="submit" className="h-10 w-full" disabled={busy || !email.trim()}>
            {$('login.forgot.send')}
          </Button>
          <Button type="button" variant="ghost" className="h-10 w-full" onClick={onBack}>
            {$('login.forgot.back')}
          </Button>
        </form>
      </CardContent>
    </GlassCard>
  );
}

/** 设置新密码：邮箱验证码流程第三步与 #/reset 旧链接共用 */
function NewPasswordCard({
  description,
  submit,
  onBack,
  onDone,
}: {
  description: React.ReactNode;
  /** 提交新密码；失败时抛错，由本卡片展示 */
  submit: (password: string) => Promise<unknown>;
  onBack: () => void;
  onDone: () => void;
}) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const pwOk = pw1.length >= 6 && pw1 === pw2;
  const mismatch = pw2.length > 0 && pw1 !== pw2;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!pwOk) {
      setErr($('login.reset.error'));
      return;
    }
    setBusy(true);
    try {
      await submit(pw1);
      setDone(true);
    } catch (ex) {
      setErr(errText(ex));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <GlassCard>
        <AuthHeader title={$('login.reset.doneTitle')} description={$('login.reset.doneDesc')} />
        <CardContent>
          <Button className="h-10 w-full" onClick={onDone}>
            {$('login.reset.goLogin')}
          </Button>
        </CardContent>
      </GlassCard>
    );
  }

  return (
    <GlassCard>
      <AuthHeader title={$('login.reset.title')} description={description} />
      <CardContent>
        <form onSubmit={onSubmit} className={FORM}>
          <FieldRow label={$('login.forgot.newPassword')} htmlFor="rp-pw1">
            <Input
              id="rp-pw1"
              className={FIELD}
              type="password"
              autoComplete="new-password"
              autoFocus
              value={pw1}
              onChange={(e) => setPw1(e.target.value)}
            />
          </FieldRow>
          <FieldRow label={$('login.reset.confirm')} htmlFor="rp-pw2">
            <Input
              id="rp-pw2"
              className={FIELD}
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
          </FieldRow>
          {mismatch && !err ? (
            <p className="text-center text-xs text-destructive">{$('login.reset.mismatch')}</p>
          ) : null}
          {err && <p className="text-center text-xs text-destructive">{err}</p>}
          <Button type="submit" className="h-10 w-full" disabled={busy || !pwOk}>
            {$('login.forgot.reset')}
          </Button>
          <Button type="button" variant="ghost" className="h-10 w-full" onClick={onBack}>
            {$('login.forgot.back')}
          </Button>
        </form>
      </CardContent>
    </GlassCard>
  );
}

/** 重置密码页（#/reset?token=…，旧版邮件链接直达）；链接没带 token 时退回三步找回流程 */
export function ResetPasswordPage({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <AuthShell>
      {token ? (
        <NewPasswordCard
          description={$('login.reset.directDesc')}
          submit={(pw) => api('/reset-password', { method: 'POST', body: { token, password: pw } })}
          onBack={onDone}
          onDone={onDone}
        />
      ) : (
        <ForgotFlow onBack={onDone} onDone={onDone} />
      )}
    </AuthShell>
  );
}
