// 布局原型入口：/proto。用真实 shadcn 组件 + 假数据，只为确认「组件、排版、布局、尺寸」。
//
// 刻意不接任何接口、不进导航、不写 localStorage：确认完布局后，这里的原语会抽到
// components/ 供正式页面复用，其余代码随原型删除。

import { useState } from 'react';
import { ProtoShell, type ProtoScreen } from './shell';
import { InstancesScreen } from './screens/instances';
import { ServersScreen } from './screens/servers';
import { ServerSettingsScreen } from './screens/server-settings';
import { InstanceScreen } from './screens/instance';
import { PanelSettingsScreen } from './screens/panel-settings';
import { LoginScreen } from './screens/login';

const SCREENS: ProtoScreen[] = ['instances', 'servers', 'server-settings', 'instance', 'panel-settings', 'login'];

/** 支持 /proto?screen=server-settings 直达某一屏：截图核对、发给别人看布局都方便 */
function initialScreen(): ProtoScreen {
  if (typeof location === 'undefined') return 'instances';
  const want = new URLSearchParams(location.search).get('screen');
  return SCREENS.includes(want as ProtoScreen) ? (want as ProtoScreen) : 'instances';
}

export function PrototypeApp() {
  const [screen, setScreen] = useState<ProtoScreen>(initialScreen);

  const go = (next: ProtoScreen) => {
    setScreen(next);
    if (typeof history !== 'undefined') {
      history.replaceState(null, '', `/proto?screen=${next}`);
    }
  };

  if (screen === 'login') return <LoginScreen onScreen={go} />;

  return (
    <ProtoShell screen={screen} onScreen={go} hideNav={screen === 'instance'}>
      {screen === 'instances' && <InstancesScreen onScreen={go} />}
      {screen === 'servers' && <ServersScreen onScreen={go} />}
      {screen === 'server-settings' && <ServerSettingsScreen onScreen={go} />}
      {screen === 'instance' && <InstanceScreen onScreen={go} />}
      {screen === 'panel-settings' && <PanelSettingsScreen />}
    </ProtoShell>
  );
}
