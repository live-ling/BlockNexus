// 轻量 history 路由：/settings、/server/<id>/instance/<name> 等路径直达
// （面板端对未知 GET 路径回退 index.html；旧式 #/hash 链接进入时一次性迁移为路径）

export type Route =
  | { name: 'instances' }
  | { name: 'servers' }
  | { name: 'settings' }
  | { name: 'about' }
  | { name: 'reset'; token: string }
  | { name: 'server'; serverId: string }
  | { name: 'server-settings'; serverId: string }
  | { name: 'instance'; serverId: string; instance: string };

export function routeFromLocation(): Route {
  // 旧式 hash 地址（如 #/reset?token=x）一次性 replaceState 成路径地址，老链接不断
  if (location.hash && location.hash !== '#') {
    const rest = location.hash.replace(/^#/, '');
    history.replaceState(null, '', rest.startsWith('/') ? rest : '/' + rest);
  }
  const query = new URLSearchParams(location.search);
  const parts = location.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  // 默认落地页是**实例总览**（所有服务器的游戏实例），服务器卡片页搬到 /servers。
  // /instances 也认——写全了这个地址的人不会被 404（面板对未知 GET 一律回退 index.html，
  // 但那要靠 SPA 兜底才能渲染，显式认下来更稳）。
  if (parts.length === 0 || parts[0] === 'instances') return { name: 'instances' };
  if (parts[0] === 'servers') return { name: 'servers' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'about') return { name: 'about' };
  if (parts[0] === 'reset') return { name: 'reset', token: query.get('token') || '' };
  if (parts[0] === 'server' && parts[1]) {
    if (parts[2] === 'settings') return { name: 'server-settings', serverId: parts[1] };
    if (parts[2] === 'instance' && parts[3]) {
      return { name: 'instance', serverId: parts[1], instance: decodeURIComponent(parts.slice(3).join('/')) };
    }
    return { name: 'server', serverId: parts[1] };
  }
  // 未知路径（如手打错的 /bogus）也回默认落地页实例总览，与 `/` 保持一致
  return { name: 'instances' };
}

/** 编程式导航：pushState 不会触发 popstate，需自行广播 routechange */
export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new Event('routechange'));
}
