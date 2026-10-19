// 面板设置里的「网络助手」两张卡：动态 DNS 与 frp 客户端托管（实验功能）。
//
// 单独成文件的原因：这两块的状态（表单、密钥、运行状态）比其它设置卡多得多，
// 塞进 panel-settings.tsx 会让那个文件更难读。共用原语见 components/settings-card.tsx。

import { useCallback, useEffect, useState } from 'react';
import { RadioTower, Waypoints } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Field, SettingsCard, StateChip, type Accent } from '@/components/settings-card';
import {
  checkDdnsIp,
  errText,
  frpAction,
  getDdns,
  getFrp,
  runDdns,
  saveDdns,
  saveFrp,
  timeago,
  type DdnsConfig,
  type DdnsStatus,
  type FrpConfig,
  type FrpStatus,
} from '@/lib/api';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

// ---------- 动态 DNS ----------
export function DdnsCard({ accent, className = '' }: { accent?: Accent; className?: string }) {
  const { success, error } = useToastHelpers();
  const [cfg, setCfg] = useState<DdnsConfig | null>(null);
  const [status, setStatus] = useState<DdnsStatus | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
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
      icon={<Waypoints className="h-4 w-4" />}
      accent={accent}
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

  if (loadErr) return wrap(<p className="text-xs text-destructive">{loadErr}</p>);
  if (!cfg) return wrap(<p className="text-xs text-muted-foreground">{$('common.loading')}</p>);

  return wrap(
    <>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={cfg.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
        <span>{$('panelSettings.ddns.enabled')}</span>
      </label>

      <div className="grid gap-3 md:grid-cols-2">
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
      </div>

      <div className="grid gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-5 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={cfg.ipv4} onCheckedChange={(v) => patch({ ipv4: v === true })} />
            {$('panelSettings.ddns.ipv4')}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={cfg.ipv6} onCheckedChange={(v) => patch({ ipv6: v === true })} />
            {$('panelSettings.ddns.ipv6')}
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
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
          {cfg.source === 'api' && (
            <Field label={$('panelSettings.ddns.sourceUrl')} htmlFor="ddns-src-url">
              <Input
                id="ddns-src-url"
                value={cfg.sourceUrl}
                onChange={(e) => patch({ sourceUrl: e.target.value })}
                placeholder="https://api.ipify.org"
              />
            </Field>
          )}
          {cfg.source === 'command' && (
            <Field label={$('panelSettings.ddns.command')} htmlFor="ddns-src-cmd">
              <Input
                id="ddns-src-cmd"
                value={cfg.command}
                onChange={(e) => patch({ command: e.target.value })}
                placeholder="curl -4 -s ifconfig.me"
              />
            </Field>
          )}
        </div>
      </div>

      {cfg.provider === 'cloudflare' && (
        <div className="grid gap-3 md:grid-cols-2">
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
        </div>
      )}

      {cfg.provider === 'dnspod' && (
        <div className="grid gap-3 md:grid-cols-2">
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
        </div>
      )}

      {cfg.provider === 'duckdns' && (
        <Field
          label={$('panelSettings.ddns.token')}
          hint={cfg.duckdns.hasToken ? $('panelSettings.ddns.tokenSaved') : undefined}
          htmlFor="ddns-dd-token"
        >
          <Input id="ddns-dd-token" type="password" value={ddToken} onChange={(e) => setDdToken(e.target.value)} />
        </Field>
      )}

      {cfg.provider === 'callback' && (
        <div className="grid gap-3 md:grid-cols-2">
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
        </div>
      )}

      <div className="grid gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
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
          <span className="whitespace-pre-wrap break-all font-mono opacity-80">
            {status.log
              .slice(-5)
              .map((l) => l.text)
              .join('\n')}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{$('panelSettings.ddns.natHint')}</p>

      <div className="mt-auto flex flex-wrap justify-end gap-2">
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
      </div>
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

export function FrpCard({ accent, className = '' }: { accent?: Accent; className?: string }) {
  const { success, error } = useToastHelpers();
  const [cfg, setCfg] = useState<FrpConfig | null>(null);
  const [status, setStatus] = useState<FrpStatus | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sakuraToken, setSakuraToken] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [proxiesText, setProxiesText] = useState('');

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
      icon={<RadioTower className="h-4 w-4" />}
      accent={accent}
      className={className}
      status={
        <StateChip
          ok={!!status?.running}
          okText={$('panelSettings.frp.running')}
          badText={$('panelSettings.frp.stopped')}
        />
      }
    >
      {body}
    </SettingsCard>
  );

  if (loadErr) return wrap(<p className="text-xs text-destructive">{loadErr}</p>);
  if (!cfg) return wrap(<p className="text-xs text-muted-foreground">{$('common.loading')}</p>);

  return wrap(
    <>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={cfg.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
        <span>{$('panelSettings.frp.enabled')}</span>
      </label>

      <div className="grid gap-3 md:grid-cols-2">
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
      </div>

      {cfg.mode === 'sakura' ? (
        <div className="grid gap-3 md:grid-cols-2">
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
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
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
          </div>
          <Field
            label={$('panelSettings.frp.proxies')}
            hint={$('panelSettings.frp.proxiesHint')}
            htmlFor="frp-proxies"
          >
            <textarea
              id="frp-proxies"
              rows={3}
              value={proxiesText}
              onChange={(e) => setProxiesText(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="survival,25565,30001"
            />
          </Field>
        </>
      )}

      <div className="grid gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          {$('panelSettings.frp.running')}：{status?.running ? `pid ${status.pid}` : $('panelSettings.frp.stopped')}
        </span>
        {!!status?.log?.length && (
          <span className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono opacity-80">
            {status.log.slice(-12).join('\n')}
          </span>
        )}
      </div>

      <div className="mt-auto flex flex-wrap justify-end gap-2">
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
      </div>
    </>,
  );
}
