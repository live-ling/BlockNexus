// 轻量 history 路由：/settings、/server/<id>/instance/<name> 等路径直达
// （面板端对未知 GET 路径回退 index.html；旧式 #/hash 链接进入时一次性迁移为路径）

export type Route =
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
  return { name: 'servers' };
}

/** 编程式导航：pushState 不会触发 popstate，需自行广播 routechange */
export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new Event('routechange'));
}
