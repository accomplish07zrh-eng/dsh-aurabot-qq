# Aurabot 桌宠客户端（安装说明）

本目录里的 `main.js` / `preload.js` / `index.html` / `physics.js` 是由插件「桌宠」模块生成到数据目录的模板副本
（源码在插件仓库 `src/modules/pet/pet-client/`，可通过面板「重新生成客户端」刷新）。
Electron 由用户本机安装，插件本身不引入任何 npm 依赖。

## 安装与运行（Windows 示例）

```powershell
cd "$env:USERPROFILE\.dsh\plugins-data\aurabot\modules-data\pet\app"
npm init -y
npm i -D electron
npx electron main.js
```

也可以全局装：`npm i -g electron`，然后 `electron <app 目录>\main.js`。

## 它怎么连上插件

- 启动时读上一级目录的 `host.json`（由 pet 模块自动写入/每 120 秒刷新）：
  `{ version, baseUrl, token, api, pluginVersion, updatedAt }`
- `baseUrl` 只认 `http://127.0.0.1:<端口>` 字面量；DSH 面板端口漂移时，插件会从
  请求 Host 头学习端口并重写 host.json，客户端轮询失败也会自动重读 host.json 再试。
- 鉴权：非音频请求带 `x-pet-token` 请求头；素材/音频 URL 用 `?token=`（`<video>`/`<audio>` 标签带不了自定义头）。
- 通信只有 HTTP 长轮询（`GET {baseUrl}{api}/events?since=&wait=25&client=pet-xxxx`），
  客户端不监听任何端口。

## 窗口行为

置顶、透明无边框、JS 拖拽（按住小鲸鱼拖动，松手时按甩出速度抛物线飞行 + 边界反弹 + Q 弹挤压，
物理逻辑在 `physics.js`，纯函数、来自 dsh-pet 的 MIT 物理模块移植）、托盘退出、单实例锁；
专注模式（focus.json）开启时收起气泡且不再弹主动气泡。

## 动画与形象包（可选）

- 没有任何动画素材时显示静态小鲸鱼 + 文字气泡，一切功能照常。
- 想要动画：把 `.webm`（VP9 透明通道，640×360 左右）放到
  `<数据目录>/modules-data/pet/packs/<包名>-animation/`，可选配同名 `<包名>-config.json`
  指定动画池与权重（详见 docs/PET_MODULE_API.md 的 pack 约定）。默认找 `default` 包。
- 客户端从 `GET /asset/<包>/<文件>.webm?token=` 拉素材播（idle 池轮播、说话从 speak 池抽、
  事件可带 `anim` 点播，播完回 idle）。
- **素材版权（重要）**：宠物形象素材（如 dsh-pet 的「大肥鱼」）是 CC BY-NC-SA 4.0 +
  禁止商用，**不随本插件分发，用户自备**；引用 dsh-pet Release 素材请遵守其署名与非商用条款，
  自制素材可参考 dsh-pet 的 MAKE-YOUR-OWN-PET 配方。

## 手动测试气泡（可带动画点播）

```powershell
$h = (Get-Content ..\host.json | ConvertFrom-Json)
Invoke-RestMethod -Method Post -Uri "$($h.baseUrl)$($h.api)/bubble" `
  -Headers @{ 'x-pet-token' = $h.token } -ContentType 'application/json' `
  -Body '{"text":"测试气泡","force":true,"anim":"wave"}'
```
