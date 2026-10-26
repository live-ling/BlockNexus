// 面板设置里的「网络助手」两块：动态 DNS 与 frp 客户端托管（实验功能）。
//
// 单独成文件的原因：这两块的状态（表单、密钥、运行状态）比其它设置块多得多，
// 塞进 panel-settings.tsx 会让那个文件更难读。共用原语见 components/settings-card.tsx。
//
// 2026-10-25：跟随设置页去卡中卡——不再画边框/阴影/彩色图标；
// DDNS 的 TTL / 同步间隔 / 取址方式属于低频调参，收进「高级」折叠，首屏只留服务商、域名与凭据。

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Field, FormActions, FormGrid, SettingsCard, StateChip } from '@/components/settings-card';
import { FrpImportDialog } from '@/components/frp-import-dialog';
import {
  checkDdnsIp,
  errText,
  frpAction,
  getDdns,
  getFrp,
  getTelemetry,
  getTelemetryPreview,
  runDdns,
  saveDdns,
  saveFrp,
  saveTelemetry,
  sendTelemetryNow,
  timeago,
  type DdnsConfig,
  type DdnsStatus,
  type FrpConfig,
  type FrpStatus,
  type TelemetryConfig,
  type TelemetryPreview,
  type TelemetryStatus,
} from '@/lib/api';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

// ---------- 动态 DNS ----------
export function DdnsCard({ className = '' }: { className?: string }) {
  const { success, error } = useToastHelpers();
  const [cfg, setCfg] = useState<DdnsConfig | null>(null);
  const [status, setStatus] = useState<DdnsStatus | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  // 低频调参（TTL / 间隔 / 取址方式）默认折叠：首屏只留服务商、域名与凭据
  const [advanced, setAdvanced] = useState(false);
  // 密钥字段：留空 = 保留后端已保存的值（与 SMTP 密码同一约定）
  const [cfToken, setCfToken] = useState('');
  const [dpToken, setDpToken] = useState('');
  const [ddToken, setDdToken] = useState('');

  useEffect(() => {
    let alive = true;
    getDdns()
      .then((r) => {
        if (!alive) return;
        setCfg(r.config);
        setStatus(r.status);
      })
      .catch((e) => {
        if (alive) setLoadErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const patch = (p: Partial<DdnsConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      const r = await saveDdns({
        enabled: cfg.enabled,
        provider: cfg.provider,
        domain: cfg.domain,
        ttl: cfg.ttl,
        intervalSec: cfg.intervalSec,
        ipv4: cfg.ipv4,
        ipv6: cfg.ipv6,
        source: cfg.source,
        sourceUrl: cfg.sourceUrl,
        sourceIPv6: cfg.sourceIPv6,
        command: cfg.command,
        cloudflare: { token: cfToken, zoneId: cfg.cloudflare.zoneId },
        dnspod: { id: cfg.dnspod.id, token: dpToken, root: cfg.dnspod.root, line: cfg.dnspod.line },
        duckdns: { token: ddToken },
        callback: { url: cfg.callback.url, body: cfg.callback.body },
      });
      setCfg(r.config);
      setStatus(r.status);
      setCfToken('');
      setDpToken('');
      setDdToken('');
      success($('panelSettings.ddns.saved'));
    } catch (e) {
      error($('panelSettings.error.save'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  const wrap = (body: React.ReactNode) => (
    <SettingsCard
      title={$('panelSettings.ddns.title')}
      description={$('panelSettings.ddns.desc')}
      className={className}
      status={
        <StateChip
          ok={!!cfg?.enabled}
          okText={$('panelSettings.ddns.running')}
          badText={$('panelSettings.ddns.stopped')}
        />
      }
    >
      {body}
    </SettingsCard>
  );

  if (loadErr) return wrap(<p className="text-[12px] text-destructive">{loadErr}</p>);
  if (!cfg) return wrap(<p className="text-[12px] text-muted-foreground">{$('common.loading')}</p>);

  return wrap(
    <>
      <label className="flex max-w-[620px] items-center gap-2 pb-1 text-[13px]">
        <Switch checked={cfg.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
        <span>{$('panelSettings.ddns.enabled')}</span>
      </label>

      <FormGrid>
        <Field label={$('panelSettings.ddns.provider')}>
          <Select value={cfg.provider} onValueChange={(v) => patch({ provider: v as DdnsConfig['provider'] })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cloudflare">Cloudflare</SelectItem>
              <SelectItem value="dnspod">DNSPod</SelectItem>
              <SelectItem value="duckdns">DuckDNS</SelectItem>
              <SelectItem value="callback">Callback</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={$('panelSettings.ddns.domain')}
          hint={$('panelSettings.ddns.domainHint')}
          htmlFor="ddns-domain"
        >
          <Input
            id="ddns-domain"
            value={cfg.domain}
            onChange={(e) => patch({ domain: e.target.value })}
            placeholder="mc.example.com"
          />
        </Field>

        {cfg.provider === 'cloudflare' && (
          <>
            <Field
              label={$('panelSettings.ddns.token')}
              hint={cfg.cloudflare.hasToken ? $('panelSettings.ddns.tokenSaved') : undefined}
              htmlFor="ddns-cf-token"
            >
              <Input id="ddns-cf-token" type="password" value={cfToken} onChange={(e) => setCfToken(e.target.value)} />
            </Field>
            <Field label={$('panelSettings.ddns.zoneId')} htmlFor="ddns-cf-zone">
              <Input
                id="ddns-cf-zone"
                value={cfg.cloudflare.zoneId}
                onChange={(e) => patch({ cloudflare: { ...cfg.cloudflare, zoneId: e.target.value } })}
              />
            </Field>
          </>
        )}

        {cfg.provider === 'dnspod' && (
          <>
            <Field label={$('panelSettings.ddns.dnspodId')} htmlFor="ddns-dp-id">
              <Input
                id="ddns-dp-id"
                value={cfg.dnspod.id}
                onChange={(e) => patch({ dnspod: { ...cfg.dnspod, id: e.target.value } })}
              />
            </Field>
            <Field
              label={$('panelSettings.ddns.dnspodToken')}
              hint={cfg.dnspod.hasToken ? $('panelSettings.ddns.tokenSaved') : undefined}
              htmlFor="ddns-dp-token"
            >
              <Input id="ddns-dp-token" type="password" value={dpToken} onChange={(e) => setDpToken(e.target.value)} />
            </Field>
            <Field label={$('panelSettings.ddns.root')} htmlFor="ddns-dp-root">
              <Input
                id="ddns-dp-root"
                value={cfg.dnspod.root}
                onChange={(e) => patch({ dnspod: { ...cfg.dnspod, root: e.target.value } })}
                placeholder="example.com"
              />
            </Field>
            <Field label={$('panelSettings.ddns.line')} htmlFor="ddns-dp-line">
              <Input
                id="ddns-dp-line"
                value={cfg.dnspod.line}
                onChange={(e) => patch({ dnspod: { ...cfg.dnspod, line: e.target.value } })}
              />
            </Field>
          </>
        )}

        {cfg.provider === 'duckdns' && (
          <Field
            label={$('panelSettings.ddns.token')}
            hint={cfg.duckdns.hasToken ? $('panelSettings.ddns.tokenSaved') : undefined}
            htmlFor="ddns-dd-token"
            className="sm:col-span-2"
          >
            <Input
              id="ddns-dd-token"
              type="password"
              className="sm:max-w-[320px]"
              value={ddToken}
              onChange={(e) => setDdToken(e.target.value)}
            />
          </Field>
        )}

        {cfg.provider === 'callback' && (
          <>
            <Field label={$('panelSettings.ddns.callbackUrl')} htmlFor="ddns-cb-url">
              <Input
                id="ddns-cb-url"
                value={cfg.callback.url}
                onChange={(e) => patch({ callback: { ...cfg.callback, url: e.target.value } })}
                placeholder="https://example.com/ddns?ip=#{ip}"
              />
            </Field>
            <Field label={$('panelSettings.ddns.callbackBody')} htmlFor="ddns-cb-body">
              <Input
                id="ddns-cb-body"
                value={cfg.callback.body}
                onChange={(e) => patch({ callback: { ...cfg.callback, body: e.target.value } })}
                placeholder='{"ip":"#{ip}"}'
              />
            </Field>
          </>
        )}
      </FormGrid>

      {/* 低频调参收进「高级」：TTL / 间隔 / 协议 / 取址方式都不是日常要改的 */}
      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
        className="flex w-fit items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {$('panelSettings.common.advanced')}
        <ChevronDown className={`size-3 transition-transform ${advanced ? 'rotate-180' : ''}`} />
      </button>
      {advanced && (
        <div className="grid max-w-[620px] gap-3 pl-1">
          <FormGrid>
            <Field label={$('panelSettings.ddns.ttl')} htmlFor="ddns-ttl">
              <Input
                id="ddns-ttl"
                inputMode="numeric"
                value={String(cfg.ttl)}
                onChange={(e) => patch({ ttl: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })}
              />
            </Field>
            <Field
              label={$('panelSettings.ddns.interval')}
              hint={$('panelSettings.ddns.intervalHint')}
              htmlFor="ddns-interval"
            >
              <Input
                id="ddns-interval"
                inputMode="numeric"
                value={String(cfg.intervalSec)}
                onChange={(e) => patch({ intervalSec: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })}
              />
            </Field>
            <Field label={$('panelSettings.ddns.source')}>
              <Select value={cfg.source} onValueChange={(v) => patch({ source: v as DdnsConfig['source'] })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="api">{$('panelSettings.ddns.source.api')}</SelectItem>
                  <SelectItem value="nic">{$('panelSettings.ddns.source.nic')}</SelectItem>
                  <SelectItem value="command">{$('panelSettings.ddns.source.command')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="grid content-start gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">{$('panelSettings.ddns.ipv4')} / IPv6</span>
              <div className="flex flex-wrap items-center gap-5 pt-1 text-[12px]">
                <label className="flex items-center gap-2">
                  <Checkbox checked={cfg.ipv4} onCheckedChange={(v) => patch({ ipv4: v === true })} />
                  {$('panelSettings.ddns.ipv4')}
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={cfg.ipv6} onCheckedChange={(v) => patch({ ipv6: v === true })} />
                  {$('panelSettings.ddns.ipv6')}
                </label>
              </div>
            </div>
            {cfg.source === 'api' && (
              <Field label={$('panelSettings.ddns.sourceUrl')} htmlFor="ddns-src-url" className="sm:col-span-2">
                <Input
                  id="ddns-src-url"
                  value={cfg.sourceUrl}
                  onChange={(e) => patch({ sourceUrl: e.target.value })}
                  placeholder="https://api.ipify.org"
                />
              </Field>
            )}
            {cfg.source === 'command' && (
              <Field label={$('panelSettings.ddns.command')} htmlFor="ddns-src-cmd" className="sm:col-span-2">
                <Input
                  id="ddns-src-cmd"
                  value={cfg.command}
                  onChange={(e) => patch({ command: e.target.value })}
                  placeholder="curl -4 -s ifconfig.me"
                />
              </Field>
            )}
          </FormGrid>
        </div>
      )}

      {/* 同步状态：一行摘要 + 最近几行日志，不再用带边框的灰块 */}
      <div className="grid max-w-none gap-1 text-[11px] leading-5 text-muted-foreground">
        {checkMsg && <span className="text-foreground">{checkMsg}</span>}
        <span>
          {$('panelSettings.ddns.status')}：
          {status?.lastAt ? timeago(status.lastAt) : $('panelSettings.ddns.status.none')}
          {status?.result === 'ok' ? ` · ${$('panelSettings.ddns.status.ok')}` : ''}
          {status?.result === 'error' ? ` · ${$('panelSettings.ddns.status.error')}` : ''}
          {status?.error ? ` · ${status.error}` : ''}
        </span>
        {(status?.ipv4 || status?.ipv6) && (
          <span className="font-mono">
            {status?.ipv4 || '—'} / {status?.ipv6 || '—'}
          </span>
        )}
        {!!status?.log?.length && (
          <LogPanel
            className="mt-1"
            lines={status.log.slice(-20).map((l) => l.text)}
            empty={$('panelSettings.log.empty')}
          />
        )}
        <span className="mt-1">{$('panelSettings.ddns.natHint')}</span>
      </div>

      <FormActions>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await checkDdnsIp({
                ipv4: cfg.ipv4,
                ipv6: cfg.ipv6,
                source: cfg.source,
                sourceUrl: cfg.sourceUrl,
                command: cfg.command,
              });
              const parts: string[] = [];
              if (r.ipv4) {
                parts.push(
                  r.ipv4.ip
                    ? $('panelSettings.ddns.ipFound', r.ipv4.ip)
                    : $('panelSettings.ddns.ipFailed', r.ipv4.error || ''),
                );
              }
              if (r.ipv6) {
                parts.push(
                  r.ipv6.ip
                    ? `${$('panelSettings.ddns.ipFound', r.ipv6.ip)}（IPv6）`
                    : `${$('panelSettings.ddns.ipFailed', r.ipv6.error || '')}（IPv6）`,
                );
              }
              setCheckMsg(parts.join(' · '));
            } catch (e) {
              setCheckMsg($('panelSettings.ddns.ipFailed', errText(e)));
            } finally {
              setBusy(false);
            }
          }}
        >
          {$('panelSettings.ddns.check')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !cfg.enabled}
          onClick={async () => {
            setBusy(true);
            try {
              const st = await runDdns();
              setStatus(st);
              if (st.result === 'ok') success($('panelSettings.ddns.status.ok'));
              else error($('panelSettings.ddns.status.error'), st.error);
            } catch (e) {
              error($('panelSettings.ddns.status.error'), errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {$('panelSettings.ddns.run')}
        </Button>
        <Button size="sm" disabled={busy} onClick={save}>
          {$('common.save')}
        </Button>
      </FormActions>
    </>,
  );
}

// ---------- frp 客户端托管 ----------

// 每行：名称,本地端口,远程端口[,tcp|udp[,转发地址]]
// 转发地址（localIP）默认 127.0.0.1；局域网实例填那台机器的内网 IP。
function serializeProxies(
  list: { name: string; type: string; localPort: number; remotePort: number; localIP?: string }[],
): string {
  return (list || [])
    .map((p) => {
      const ip = String(p.localIP || '').trim();
      const base = `${p.name},${p.localPort},${p.remotePort}`;
      if (ip && ip !== '127.0.0.1') return `${base},${p.type === 'udp' ? 'udp' : 'tcp'},${ip}`;
      return p.type === 'udp' ? `${base},udp` : base;
    })
    .join('\n');
}

function parseProxies(
  text: string,
): { name: string; type: 'tcp' | 'udp'; localPort: number; remotePort: number; localIP: string }[] {
  const out: { name: string; type: 'tcp' | 'udp'; localPort: number; remotePort: number; localIP: string }[] = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [name, local, remote, type, ip] = line.split(',').map((s) => s.trim());
    out.push({
      name: name || '',
      localPort: Number(local) || 0,
      remotePort: Number(remote) || 0,
      type: type === 'udp' ? 'udp' : 'tcp',
      localIP: ip || '127.0.0.1',
    });
  }
  return out;
}

export function FrpCard({ className = '' }: { className?: string }) {
  const { success, error } = useToastHelpers();
  const [cfg, setCfg] = useState<FrpConfig | null>(null);
  const [status, setStatus] = useState<FrpStatus | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sakuraToken, setSakuraToken] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [proxiesText, setProxiesText] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getFrp();
      setCfg(r.config);
      setStatus(r);
      setProxiesText(serializeProxies(r.config.upstream.proxies));
      setLoadErr('');
    } catch (e) {
      setLoadErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 8 秒轮询：frpc 是后台进程，崩溃/重连成功/端口换绑都不会让页面自己知道。
  // 页面隐藏时停止轮询、切回来立刻补拉一次（与实例页 task-log 的做法一致，不额外上 SSE）。
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(tick, 8000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const patch = (p: Partial<FrpConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      const r = await saveFrp({
        enabled: cfg.enabled,
        mode: cfg.mode,
        binaryPath: cfg.binaryPath,
        sakura: { token: sakuraToken, tunnels: cfg.sakura.tunnels },
        upstream: {
          serverAddr: cfg.upstream.serverAddr,
          serverPort: cfg.upstream.serverPort,
          authToken,
          proxies: parseProxies(proxiesText),
        },
      });
      setCfg(r.config);
      setSakuraToken('');
      setAuthToken('');
      if (r.error) error($('panelSettings.error.save'), r.error);
      else success($('panelSettings.frp.saved'));
      await load();
    } catch (e) {
      error($('panelSettings.error.save'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    try {
      await frpAction(action);
      await load();
      success($(`panelSettings.frp.${action}` as 'panelSettings.frp.start'));
    } catch (e) {
      error($('panelSettings.error.save'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  const wrap = (body: React.ReactNode) => (
    <SettingsCard
      title={$('panelSettings.frp.title')}
      description={$('panelSettings.frp.desc')}
      className={className}
      status={
        <StateChip
          ok={status?.state === 'running'}
          okText={$('panelSettings.frp.running')}
          badText={
            status?.state === 'restarting'
              ? $('panelSettings.frp.restarting', String(status.restarts))
              : $('panelSettings.frp.stopped')
          }
        />
      }
    >
      {body}
    </SettingsCard>
  );

  if (loadErr) return wrap(<p className="text-[12px] text-destructive">{loadErr}</p>);
  if (!cfg) return wrap(<p className="text-[12px] text-muted-foreground">{$('common.loading')}</p>);

  return wrap(
    <>
      <label className="flex max-w-[620px] items-center gap-2 pb-1 text-[13px]">
        <Switch checked={cfg.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
        <span>{$('panelSettings.frp.enabled')}</span>
      </label>

      <FormGrid>
        <Field label={$('panelSettings.frp.mode')}>
          <Select value={cfg.mode} onValueChange={(v) => patch({ mode: v as FrpConfig['mode'] })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sakura">{$('panelSettings.frp.mode.sakura')}</SelectItem>
              <SelectItem value="upstream">{$('panelSettings.frp.mode.upstream')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={$('panelSettings.frp.binary')} hint={$('panelSettings.frp.binaryHint')} htmlFor="frp-binary">
          <Input
            id="frp-binary"
            value={cfg.binaryPath}
            onChange={(e) => patch({ binaryPath: e.target.value })}
            placeholder="C:\\frp\\frpc.exe"
          />
        </Field>

        {cfg.mode === 'sakura' ? (
          <>
            <Field
              label={$('panelSettings.frp.sakuraToken')}
              hint={cfg.sakura.hasToken ? $('panelSettings.ddns.tokenSaved') : undefined}
              htmlFor="frp-sakura-token"
            >
              <Input
                id="frp-sakura-token"
                type="password"
                value={sakuraToken}
                onChange={(e) => setSakuraToken(e.target.value)}
              />
            </Field>
            <Field label={$('panelSettings.frp.tunnels')} htmlFor="frp-tunnels">
              <Input
                id="frp-tunnels"
                value={cfg.sakura.tunnels}
                onChange={(e) => patch({ sakura: { ...cfg.sakura, tunnels: e.target.value } })}
                placeholder="12345,67890"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={$('panelSettings.frp.serverAddr')} htmlFor="frp-server">
              <Input
                id="frp-server"
                value={cfg.upstream.serverAddr}
                onChange={(e) => patch({ upstream: { ...cfg.upstream, serverAddr: e.target.value } })}
                placeholder="frps.example.com"
              />
            </Field>
            <Field label={$('panelSettings.frp.serverPort')} htmlFor="frp-port">
              <Input
                id="frp-port"
                inputMode="numeric"
                value={String(cfg.upstream.serverPort)}
                onChange={(e) =>
                  patch({
                    upstream: { ...cfg.upstream, serverPort: Number(e.target.value.replace(/[^\d]/g, '')) || 0 },
                  })
                }
              />
            </Field>
            <Field
              label={$('panelSettings.frp.authToken')}
              hint={cfg.upstream.hasToken ? $('panelSettings.ddns.tokenSaved') : undefined}
              htmlFor="frp-auth"
            >
              <Input id="frp-auth" type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} />
            </Field>
            <Field
              label={$('panelSettings.frp.proxies')}
              hint={$('panelSettings.frp.proxiesHint')}
              htmlFor="frp-proxies"
              className="sm:col-span-2"
            >
              <textarea
                id="frp-proxies"
                rows={3}
                value={proxiesText}
                onChange={(e) => setProxiesText(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2.5 py-2 font-mono text-[12px] outline-none focus-visible:border-ring"
                placeholder="survival,25565,30001"
              />
            </Field>
          </>
        )}
      </FormGrid>

      {status?.exposure?.risky && (
        <p className="max-w-[620px] rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11.5px] leading-5 text-destructive">
          {$('panelSettings.frp.exposureWarning', String(status.exposure.panelPort))}
        </p>
      )}

      <div className="grid max-w-none gap-1 text-[11px] leading-5 text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>
            {status?.state === 'running'
              ? `pid ${status.pid}`
              : status?.state === 'restarting'
                ? $('panelSettings.frp.restarting', String(status.restarts))
                : $('panelSettings.frp.stopped')}
          </span>
          {!!status?.lastExit && status?.state !== 'running' && (
            <span>{$('panelSettings.frp.lastExit', String(status.lastExit.code))}</span>
          )}
          <button type="button" className="underline underline-offset-2" onClick={() => void load()}>
            {$('common.refresh')}
          </button>
        </span>
        {status && (
          <LogPanel
            className="mt-1"
            lines={(status.log ?? []).slice(-40)}
            empty={$('panelSettings.log.empty')}
          />
        )}
      </div>

      <FormActions>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setImportOpen(true)}>
          {$('panelSettings.frp.import')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy || status?.running} onClick={() => act('start')}>
          {$('panelSettings.frp.start')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy || !status?.running} onClick={() => act('stop')}>
          {$('panelSettings.frp.stop')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy || !status?.running} onClick={() => act('restart')}>
          {$('panelSettings.frp.restart')}
        </Button>
        <Button size="sm" disabled={busy} onClick={save}>
          {$('common.save')}
        </Button>
      </FormActions>

      <FrpImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          void load();
        }}
      />
    </>,
  );
}

/**
 * 网络助手的日志面板（DDNS / frp 共用）。
 *
 * 改造前日志是行内 `<span className="max-h-24 overflow-auto">`：
 * `max-height` 对 inline 元素不生效，行数一多就往页面里无限长，而且没有换行/滚动边界。
 * 这里改成固定高度的块级滚动区 + 逐行渲染，并自动滚到最新一行。
 */
function LogPanel({
  lines,
  empty,
  className = '',
}: {
  lines: string[];
  empty: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const tone = (line: string) =>
    /error|failed|失败|错误|refused|timeout/i.test(line)
      ? 'text-red-500'
      : /warn|警告|deprecated/i.test(line)
        ? 'text-amber-500'
        : 'text-muted-foreground';

  // frpc 的日志带 ANSI 颜色控制符（\x1b[0m / \x1b[1;33m …）。
  // 直接渲染会变成满屏「[0m[1;33m」，所以显示前统一剥掉。
  const clean = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');

  return (
    <div className={`grid gap-1.5 ${className}`}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Terminal className="size-3 shrink-0" />
        <span>{$('panelSettings.log.title')}</span>
        {lines.length > 0 && <span className="ml-auto tabular-nums">{$('panelSettings.log.lines', lines.length)}</span>}
      </div>
      <div
        ref={box}
        className="max-h-40 overflow-y-auto rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-5"
      >
        {lines.length === 0 ? (
          <div className="text-muted-foreground/60">{empty}</div>
        ) : (
          lines.map((line, i) => {
            const text = clean(line);
            return (
              <div key={i} className={`whitespace-pre-wrap break-all ${tone(text)}`}>
                {text}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------- 体验改进计划（匿名遥测，默认关闭） ----------
//
// 设计取舍：这个卡片**没有**「保存」按钮——开关即时生效（并立刻删/建 ID）。
// 理由：遥测的正确性不靠表单的完整性，靠「所见即所发」。
//
// 端点刻意**不暴露在 UI 上**：绝大多数用户永远不需要它，一串 URL 只会带来
// 「数据到底传去哪」的不安。真要自建的用户改 data/config.json 的
// settings.telemetry.endpoint（后端 normalizeEndpoint 会校验 https 公网地址）。
//
// 开关是**本地的乐观状态**：不依赖 GET 成功就能拨。老面板后端没有这些路由（404）时，
// 卡片退化为「说明 + 开关 + 提示升级」，而不是整块报错——404 只说明旧后端不认识这个
// 接口，不代表功能坏了，把它渲染成红色错误会吓到用户。

export function TelemetryCard({ className = '' }: { className?: string }) {
  const { success, error } = useToastHelpers();
  const [cfg, setCfg] = useState<TelemetryConfig | null>(null);
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [preview, setPreview] = useState<TelemetryPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 404 = 面板后端还是旧版本（没有这些路由）。与其它加载错误区分开：这不是故障，只是不可用。
  const [unsupported, setUnsupported] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  // 开关的乐观值：GET 失败时仍有值可显示、可操作
  const [switchOn, setSwitchOn] = useState(false);
  // 静默发送中 / 最近一次静默发送的结果（只在模态框里显示，不弹 toast）
  const [sending, setSending] = useState(false);
  const [lastSentResult, setLastSentResult] = useState<'' | 'ok' | 'fail'>('');

  useEffect(() => {
    let alive = true;
    getTelemetry()
      .then((r) => {
        if (!alive) return;
        setCfg(r.config);
        setStatus(r.status);
        setSwitchOn(r.config.enabled);
      })
      .catch((e) => {
        if (!alive) return;
        const msg = errText(e);
        if (/\b404\b/.test(msg)) setUnsupported(true);
        else setLoadErr(msg);
      });
    return () => {
      alive = false;
    };
  }, []);

  const patch = async (body: { enabled?: boolean; endpoint?: string }) => {
    setBusy(true);
    try {
      const r = await saveTelemetry(body);
      setCfg(r.config);
      setStatus(r.status);
      setSwitchOn(r.config.enabled);
      return r;
    } catch (e) {
      error($('panelSettings.error.save'), errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  /**
   * 打开「即将上报的数据」模态框；打开时才拉取，拿到的是此刻真实的 payload。
   * 同时拉一次状态：模态框里要展示上报记录，需要最新的 lastSentAt / fails。
   */
  const openPreview = async () => {
    setPreviewOpen(true);
    try {
      const [p, h] = await Promise.all([getTelemetryPreview(), getTelemetry()]);
      setPreview(p);
      setStatus(h.status);
    } catch (e) {
      error($('panelSettings.error.load'), errText(e));
    }
  };

  /** 静默发送：成功/失败都不弹 toast，结果反映在模态框的上报记录里 */
  const sendSilently = async () => {
    setSending(true);
    try {
      const r = await sendTelemetryNow();
      if (r.status) setStatus(r.status);
      setLastSentResult(r.sent ? 'ok' : 'fail');
      // 静默：不弹 toast。用户在模态框里看到「刚刚发送」这一行，就是全部反馈。
    } catch {
      setLastSentResult('fail');
    } finally {
      setSending(false);
    }
  };

  const wrap = (body: React.ReactNode) => (
    <SettingsCard
      title={$('panelSettings.telemetry.title')}
      description={$('panelSettings.telemetry.desc')}
      className={className}
      status={
        <div className="flex items-center gap-2">
          <Switch
            className="shrink-0"
            checked={switchOn}
            disabled={busy || unsupported}
            onCheckedChange={(v) => {
              setSwitchOn(v); // 乐观更新：后端不支持时 UI 也不至于没反应
              void patch({ enabled: v }).then((r) => {
                if (r) success(r.config.enabled ? $('panelSettings.telemetry.enabled') : $('panelSettings.telemetry.disabled'));
                else setSwitchOn(!v); // 保存失败回滚
              });
            }}
          />
          <StateChip ok={switchOn} okText={$('panelSettings.telemetry.on')} badText={$('panelSettings.telemetry.off')} />
        </div>
      }
    >
      {body}
    </SettingsCard>
  );

  // 旧面板后端：说明 + 开关（禁用）+ 升级提示，不渲染成错误
  if (unsupported) {
    return wrap(
      <div className="grid max-w-[620px] gap-2">
        <p className="text-[12px] text-muted-foreground">
          {$('panelSettings.telemetry.loadFailed')}
        </p>
        <label className="flex items-center gap-2 text-[13px] opacity-60">
          <Switch checked={false} disabled />
          <span>{$('panelSettings.telemetry.enabledLabel')}</span>
        </label>
      </div>,
    );
  }
  if (loadErr) return wrap(<p className="text-[12px] text-destructive">{loadErr}</p>);
  if (!cfg) return wrap(<p className="text-[12px] text-muted-foreground">{$('common.loading')}</p>);

  return wrap(
    <>
      {/* 数据落点：境内存储是用户最关心的合规信息，常驻显示。
          端点地址刻意**不显示也不可改**：绝大多数用户永远不需要它，
          一串 URL 只会带来「数据到底传去哪」的不安；真要改的用户是少数，
          走 data/config.json 的 settings.telemetry.endpoint 即可。 */}
      <p className="text-[11px] text-muted-foreground">{$('panelSettings.telemetry.region')}</p>

      {/* 状态行：上次发送 / 失败次数。失败可见，否则用户以为在发其实一直失败 */}
      {cfg.enabled && status && (status.lastSentAt || status.fails > 0 || status.error) && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {status.lastSentAt
            ? $('panelSettings.telemetry.lastSent', timeago(status.lastSentAt))
            : $('panelSettings.telemetry.neverSent')}
          {status.fails > 0 && ` · ${$('panelSettings.telemetry.fails', status.fails)}`}
          {status.error && <span className="text-destructive"> · {status.error}</span>}
        </p>
      )}

      <FormActions>
        {/* 查看是唯一的动作入口：把「会发什么」原样摆出来，透明化靠可验证不靠承诺 */}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void openPreview()}>
          {$('panelSettings.telemetry.preview')}
        </Button>
      </FormActions>

      {/*
        「即将上报的数据」模态框：payload + 上报记录 + 手动发送。
        三样放在一起是因为它们是同一个问题——「这台机器到底发了什么、什么时候发的」：
        看 payload（将要发的）、看记录（已经发的）、点发送（现在就发一次验证）。
        「重置统计 ID」已从 UI 移除：换 ID 是排查用的低频操作，改 data/config.json 即可，
        常驻按钮反而让用户怀疑自己的数据「能不能被追踪到」。
      */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-[13px]">{$('panelSettings.telemetry.previewTitle')}</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[70vh] gap-3 overflow-y-auto pr-1">
            {/* 上报记录：已经发生了什么 */}
            <div className="grid gap-1.5 rounded-md border bg-muted/20 px-3 py-2.5">
              <b className="text-[12px] font-medium">{$('panelSettings.telemetry.historyTitle')}</b>
              {status ? (
                <div className="grid gap-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  <span>
                    {status.lastSentAt
                      ? $('panelSettings.telemetry.lastSent', timeago(status.lastSentAt))
                      : $('panelSettings.telemetry.neverSent')}
                    {status.sent > 0 && ` · ${$('panelSettings.telemetry.sentCount', status.sent)}`}
                    {status.fails > 0 && ` · ${$('panelSettings.telemetry.fails', status.fails)}`}
                  </span>
                  {status.error && <span className="text-destructive">{status.error}</span>}
                  {lastSentResult === 'ok' && <span className="text-emerald-600 dark:text-emerald-400">{$('panelSettings.telemetry.sentOk')}</span>}
                  {lastSentResult === 'fail' && <span className="text-destructive">{$('panelSettings.telemetry.sentFail', '')}</span>}
                </div>
              ) : (
                <span className="text-[11px] text-muted-foreground">{$('common.loading')}</span>
              )}
            </div>

            {/* 即将上报的数据：将要发生什么（正面展示，不放反向清单——
                反向清单会随代码演进过时，过时的承诺比没有承诺更糟） */}
            {preview?.rejected ? (
              <p className="text-[11px] leading-relaxed text-destructive">
                {$('panelSettings.telemetry.previewRejected', preview.rejected)}
              </p>
            ) : null}
            <pre className="overflow-x-auto rounded-md bg-muted/40 px-3 py-2.5 font-mono text-[11px] leading-5">
              {preview?.payload ? JSON.stringify(preview.payload, null, 2) : $('common.loading')}
            </pre>
          </div>
          <DialogFooter className="gap-2">
            {cfg.enabled ? (
              <Button variant="outline" size="sm" disabled={busy || sending} onClick={() => void sendSilently()}>
                {$('panelSettings.telemetry.sendNow')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>,
  );
}
