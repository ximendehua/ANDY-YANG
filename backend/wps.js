'use strict';
// 保存到金山文档（WPS 多维表格）。
//
// 说明：要在 APP 内“自动保存为 WPS 表格”，需要你在金山文档开放平台申请应用并拿到访问令牌，
// 配置到 backend/config.json 的 kdocsToken（或环境变量 KDOCS_TOKEN）。
// 下方给出与金山文档开放平台对接的骨架实现（UNTESTED，需按官方文档补全字段），
// 调试期间也可直接在本 WorkBuddy 会话里用已连接的“金山文档”连接器一键建表（见 README）。
//
// 参考：金山文档开放平台 https://open.wps.cn / https://www.kdocs.cn

const https = require('https');

async function saveToKdocs(table, title, token, apiBase) {
  // TODO: 依据金山文档开放平台文档实现：创建多维表格 -> 写入字段 -> 批量写入记录 -> 返回可访问链接。
  // 典型流程（伪代码，字段名以官方文档为准）：
  //   1. POST {apiBase}/v3/opensheet/files  (创建文件，带 title)
  //   2. POST {apiBase}/v3/.../sheets        (创建数据表/字段)
  //   3. POST {apiBase}/v3/.../records       (批量写入 table 的每一行)
  //   4. 返回文件 URL
  throw new Error('saveToKdocs 未实现：请在 backend/wps.js 中按金山文档开放平台文档补全（需 kdocsToken）。');
}

module.exports = { saveToKdocs };
