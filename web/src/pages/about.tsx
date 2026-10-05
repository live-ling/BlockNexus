// 关于页：面板信息、开源依赖、引用服务与声明
// 路由 #/about —— 设置页底部进入
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, ExternalLink, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api, type Me } from '@/lib/api';

/** 引用服务：镜像与官方 API（MSL 条款要求在页面注明来源） */
const SERVICES: { name: string; url: string; desc: string }[] = [
  {
    name: 'MSL 开服器',
    url: 'https://www.mslmc.cn',
    desc: '服务端镜像下载（vanilla/paper/purpur/folia/forge/neoforge/fabric），官方源不可用时的兜底解析链',
  },
  {
    name: 'BMCLAPI',
    url: 'https://bmclapi2.bangbang93.com',
    desc: 'Mojang 版本清单与文件的国内镜像',
  },
  {
    name: 'Mojang 官方 API',
    url: 'https://www.minecraft.net',
    desc: '原版版本清单与服务端下载（piston-meta / piston-data）',
  },
  {
    name: 'Adoptium Temurin',
    url: 'https://adoptium.net',
    desc: 'Java 运行时自动安装（清华 TUNA 镜像优先）',
  },
  {
    name: 'PaperMC / PurpurMC / FabricMC / Forge / NeoForge',
    url: 'https://papermc.io',
    desc: '各核心的官方版本 API 与安装器',
  },
];

/** 开源依赖：面板与前端构建在其上 */
const DEPS: { name: string; url: string; desc: string }[] = [
  { name: 'React + Vite + TypeScript', url: 'https://react.dev', desc: '前端框架与构建工具链' },
  { name: 'Tailwind CSS 4 + shadcn/ui (Radix)', url: 'https://tailwindcss.com', desc: '样式系统与无障碍组件底座' },
  { name: 'beUI', url: 'https://beui.dev', desc: '动效组件（FileTree / FileUpload / TiltCard 等）' },
  { name: 'Express + ws', url: 'https://expressjs.com', desc: '面板 HTTP 服务与加密通道 WebSocket' },
  { name: 'ssh2', url: 'https://github.com/mscdex/ssh2.js', desc: 'Agent 远程安装（SSH/SFTP）' },
  { name: 'nodemailer', url: 'https://nodemailer.com', desc: 'SMTP 离线通知与找回密码邮件' },
  { name: 'WebView2', url: 'https://developer.microsoft.com/microsoft-edge/webview2', desc: 'Windows 桌面外壳渲染' },
  { name: 'Node.js 标准库', url: 'https://nodejs.org', desc: 'Agent 为零依赖单文件，全部能力基于标准库' },
];

function RefRow({ name, url, desc }: { name: string; url: string; desc: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/60">
      <div className="min-w-0">
        <p className="text-sm font-medium">{name}</p>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{desc}</p>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        链接 <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

/** 开源信息：仓库地址（许可证全文经 /api/license 直出展示） */
const REPO_URL = 'https://github.com/live-ling/BlockNexus';

export function AboutPage({ onBack }: { onBack: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [licOpen, setLicOpen] = useState(false);
  const [licText, setLicText] = useState<string | null>(null);

  useEffect(() => {
    api<Me>('/me').then(setMe).catch(() => {});
  }, []);

  /** 许可证全文懒加载：首次展开才拉取 */
  const toggleLicense = () => {
    setLicOpen((v) => {
      const next = !v;
      if (next && licText === null) {
        api<{ text: string }>('/license')
          .then((r) => setLicText(r.text))
          .catch(() => setLicText('（LICENSE 读取失败——未随面板部署？）'));
      }
      return next;
    });
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 pb-24 pt-7">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">关于</h2>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">面板信息、开源依赖与引用说明。</p>

      {/* 宽屏双列铺满，窄屏自动堆叠为单列 */}
      <div className="mt-5 grid items-start gap-4 xl:grid-cols-2">
        {/* 面板信息 */}
        <Card className="ring-1 ring-border xl:col-span-2">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <img
                src="/logo.png"
                alt="BlockNexus"
                className="h-14 w-14 rounded-xl object-cover ring-1 ring-border"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold">BlockNexus</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    v{me?.version ?? '…'}
                  </span>
                </div>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                  Minecraft 服务器管理面板:本地 Web 面板通过 SSH 为远程服务器部署
                  Agent,经 token 双向认证的加密通道管理 MC 实例——浏览器即开即用,面板无需公网地址。
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="group flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3.5 py-2.5 transition-colors hover:border-foreground/20 hover:bg-muted/70"
              >
                <span className="shrink-0 text-xs text-muted-foreground">开源地址</span>
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                  <span className="truncate">github.com/live-ling/BlockNexus</span>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-100" />
                </span>
              </a>
              <button
                type="button"
                onClick={toggleLicense}
                className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3.5 py-2.5 text-left transition-colors hover:border-foreground/20 hover:bg-muted/70"
              >
                <span className="text-xs text-muted-foreground">许可证</span>
                <span className="flex items-center gap-1.5 text-xs">
                  MIT
                  {licOpen ? <ChevronUp className="h-3.5 w-3.5 opacity-50" /> : <ChevronDown className="h-3.5 w-3.5 opacity-50" />}
                </span>
              </button>
            </div>
            {licOpen && (
              <pre className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {licText ?? '加载中…'}
              </pre>
            )}
          </CardContent>
        </Card>

        {/* 引用服务 */}
        <Card className="ring-1 ring-border">
          <CardContent className="p-5">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">引用服务</h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              版本目录与下载链路的镜像与官方来源（排名不分先后）：
            </p>
            <div className="mt-3 grid gap-0.5">
              {SERVICES.map((s) => (
                <RefRow key={s.name} {...s} />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 开源依赖 */}
        <Card className="ring-1 ring-border">
          <CardContent className="p-5">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">开源依赖</h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              面板与前端构建在这些项目之上：
            </p>
            <div className="mt-3 grid gap-0.5">
              {DEPS.map((d) => (
                <RefRow key={d.name} {...d} />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 声明 */}
        <Card className="ring-1 ring-border xl:col-span-2">
          <CardContent className="p-5">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">声明</h3>
            </div>
            <ul className="mt-2 grid gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <li>本工具与 Mojang Studios / Microsoft 无关；Minecraft 为 Mojang Synergies AB 的商标。</li>
              <li>
                运行服务端前请阅读并同意{' '}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://aka.ms/MinecraftEULA"
                  target="_blank"
                  rel="noreferrer"
                >
                  Minecraft EULA
                </a>
                。
              </li>
              <li>仅供学习交流与个人服务器管理使用；请遵守所在地法律法规与各镜像服务的使用条款。</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
