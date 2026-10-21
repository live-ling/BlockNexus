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

export function PrototypeApp() {
  const [screen, setScreen] = useState<ProtoScreen>('instances');

  if (screen === 'login') return <LoginScreen onScreen={setScreen} />;

  return (
    <ProtoShell screen={screen} onScreen={setScreen} hideNav={screen === 'instance'}>
      {screen === 'instances' && <InstancesScreen onScreen={setScreen} />}
      {screen === 'servers' && <ServersScreen onScreen={setScreen} />}
      {screen === 'server-settings' && <ServerSettingsScreen onScreen={setScreen} />}
      {screen === 'instance' && <InstanceScreen onScreen={setScreen} />}
      {screen === 'panel-settings' && <PanelSettingsScreen />}
    </ProtoShell>
  );
}
