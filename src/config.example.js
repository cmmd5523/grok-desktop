// 配置模板(提交到仓库)。
// 克隆后复制本文件为 config.local.js 并填写你的 grok2api 网关地址与 API Key,
// 或直接在应用「设置」中填写(密钥将使用 Windows DPAPI 加密保存)。
module.exports = {
  DEFAULT_BASE_URL: '', // 例如 http://127.0.0.1:8000/v1
  DEFAULT_API_KEY: '',
  DEFAULT_AUTH_URL: '', // 例如 http://127.0.0.1:8001(登录服务器,可留空仅用网页版)
};
