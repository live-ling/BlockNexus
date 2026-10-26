/**
 * 服务器卡片上的两个「标记」：系统图标与地区旗帜。
 *
 * 资源来源（已下载到 web/public，运行时不访问外站）：
 *   - 发行版 logo：worldvectorlogo（ubuntu / debian / alpine / rocky / windows，均为方形）
 *     + Simple Icons（centos / fedora / arch / opensuse，24×24 方形，品牌色）
 *   - 国旗：flagpedia 的 flagcdn（cn/hk/tw/jp/kr/sg/us/de/gb）
 * 说明与许可见 web/public/os/README.md、web/public/flags/README.md。
 *
 * ⚠ 所有系统图标都装进 **1:1 容器**（size-7 + img size-full object-contain）：
 *   混用横向 wordmark 会被拉变形，这是这版之前「图标不对」的原因。
 */

import { useEffect, useState } from 'react';
import { Globe, Terminal } from 'lucide-react';
import { cn } from 'cn';
import type { ServerInfo } from '@/lib/api';
import { REGIONS } from '@/lib/regions';

/** 资源版本：改动 /public 下的 svg 时递增，避免浏览器沿用旧缓存（文件名无 hash） */
const ASSET_V = '20261026';

/** distro.id → 资源文件名；没有对应方图标的一律回退终端图标（不猜品牌） */
const OS_SRC: Record<string, string> = {
  ubuntu: '/os/ubuntu.svg',
  debian: '/os/debian.svg',
  centos: '/os/centos.svg',
  fedora: '/os/fedora.svg',
  rocky: '/os/rocky.svg',
  alpine: '/os/alpine.svg',
  arch: '/os/arch.svg',
  opensuse: '/os/opensuse.svg',
  windows: '/os/windows.svg',
};

function normalizeDistro(id: string): string {
  const v = String(id || '').toLowerCase();
  if (v.startsWith('opensuse')) return 'opensuse';
  if (v.startsWith('rocky')) return 'rocky';
  if (v.startsWith('arch')) return 'arch';
  if (v.startsWith('alpine')) return 'alpine';
  return v;
}

/** 系统图标：1:1 方形底 + object-contain，任何源图都不会变形 */
export function OsMark({
  distro,
  className,
}: {
  distro?: ServerInfo['distro'];
  className?: string;
}) {
  const id = normalizeDistro(distro?.id || '');
  const src = OS_SRC[id];
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const title = distro?.name || 'Linux';

  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        'grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border border-border/70 bg-white p-[2px]',
        className,
      )}
    >
      {src && !broken ? (
        <img
          src={`${src}?v=${ASSET_V}`}
          alt=""
          className="size-full object-contain"
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : (
        <Terminal className="size-3.5 text-muted-foreground" />
      )}
    </span>
  );
}

/** 地区旗帜：3:2 小旗，圆角裁切；未设置返回 null，other 用地球占位 */
export function RegionFlag({
  region,
  title,
  className,
}: {
  region?: string;
  title?: string;
  className?: string;
}) {
  const code = String(region || '').toLowerCase();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [code]);

  if (!code || !(REGIONS as readonly string[]).includes(code)) return null;

  // self-center：作为 flex 子项时直接以自身盒子居中，不再被父级行盒/基线往下推
  const box = cn(
    'inline-flex h-[14px] w-5 shrink-0 self-center items-center justify-center overflow-hidden rounded-[2px] bg-muted ring-1 ring-black/10 dark:ring-white/15',
    className,
  );
  const a11y = title ? { title, role: 'img' as const, 'aria-label': title } : { 'aria-hidden': true };

  if (code === 'other' || broken) {
    return (
      <span className={box} {...a11y}>
        <Globe className="size-2.5 text-muted-foreground" />
      </span>
    );
  }

  return (
    <span className={box} {...a11y}>
      <img
        src={`/flags/${code}.svg?v=${ASSET_V}`}
        alt=""
        className="size-full object-cover"
        draggable={false}
        onError={() => setBroken(true)}
      />
    </span>
  );
}
