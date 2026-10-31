# 提交一个模块

这篇带你从零写一个模块并提交到模块市场。例子是「今日运势」：有人发「运势」，她回一句。

你需要：装好 Aurabot 插件，一个 GitHub 账号，Node.js 22.2 或更高版本。

## 1. 先在自己电脑上写好

打开面板「已安装」页，展开最下面的「写模块的工具」，新建模块，id 填 `fortune`，名字填「今日运势」。

插件会在数据目录建好 `modules/fortune/index.mjs`，改完保存，几秒内自动生效，不用重启。把它改成这样：

```js
const WORDS = ['大吉', '中吉', '小吉', '末吉']

export default {
  id: 'fortune',
  name: '今日运势',
  version: '1.0.0',
  api: 1,
  description: '发「运势」抽一签',
  setup(api) {
    api.on('message', async (msg) => {
      if (msg.text.trim() !== '运势') return
      await api.reply(msg, WORDS[Math.floor(Math.random() * WORDS.length)])
      return true // 这条消息接管了，不再交给她
    })
  },
}
```

能用的接口都在数据目录的 `modules/API.md`。不会写代码也没关系：在「已安装」页点「复制给 DSH 的话」，让 DSH 帮你写。

上线前可以用同一处的「模拟测试」试，消息不会真发到 QQ。

## 2. 放进仓库

在 GitHub 上 Fork 本仓库，克隆到本地，然后把模块文件夹复制到 `modules/fortune/`。一个模块至少要这四个文件：

```
modules/fortune/
├── module.json
├── index.mjs
├── README.md
└── LICENSE
```

- `README.md`：写做什么、怎么用、会访问哪些网址。
- `LICENSE`：许可证，不知道选什么就用 MIT。
- 实现文件多了放 `lib/`，测试放 `test/`，根目录只留入口和说明。

`module.json` 这样写：

```json
{
  "id": "fortune",
  "name": "今日运势",
  "version": "1.0.0",
  "description": "发「运势」抽一签",
  "category": "social",
  "tags": ["运势"],
  "author": "你的名字",
  "license": "MIT",
  "api": 1,
  "minPluginVersion": "1.2.0",
  "requires": [],
  "capabilities": []
}
```

- `id`、`version`、`api` 要和 `index.mjs` 里的一样。
- `category` 从这些里选：`platform` 逛平台、`social` 聊天互动、`creative` 创作、`desktop` 桌面、`manage` 管理、`tool` 工具。
- `capabilities` 写模块用到的能力：联网 `network`、读写文件 `filesystem`、启动程序 `process`、动态执行代码 `dynamic-code`、读写配置 `plugin-config`、用内部对象 `plugin-internals`。用到却没写，检查过不了。

## 3. 本地检查

在仓库根目录运行：

```sh
npm run catalog
npm run check
npm run pack
```

- `catalog` 把你的模块加进模块目录。
- `check` 检查格式和能力声明，看到 `✗` 就照提示改。
- `pack` 试打包，并真的加载一次入口。

## 4. 提 PR

提交后在 GitHub 上提 PR，目标分支 `main`，按模板填写。一个 PR 只放一个模块。

维护者会看这几件事：

- 代码读得懂，没有混淆，运行时不下载并执行代码。
- `capabilities` 和实际行为一致。
- 用户的 Cookie、消息不发到无关地址。
- 不做未经用户同意的群发、加好友、发帖。
- 不绕过验证码，不刷量。

模块和插件在同一进程运行，能接触用户的账号配置，所以每个版本都要审核。

## 5. 合并以后

合并后会自动打包发布，几分钟内就能在模块市场里看到。

以后改模块，记得把 `module.json` 和 `index.mjs` 里的 `version` 一起升上去，已发布的版本不能修改。
