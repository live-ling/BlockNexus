'use strict';
// BlockNexus Agent — 跨模块可变状态
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。
//
// 原单文件的 let INSECURE_TLS 由 loadConfig 写、WSSocket 读，拆分后放这里共享。

let insecureTls = false;

module.exports = {
  /** 自签证书面板：跳过 TLS 校验（由 --insecure / tlsInsecure 置位） */
  get insecureTls() {
    return insecureTls;
  },
  set insecureTls(v) {
    insecureTls = !!v;
  },
};
