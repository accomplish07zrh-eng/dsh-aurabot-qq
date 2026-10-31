# B 站弹幕与登录暂停恢复

弹幕位于内置的「B站」页底部，不需要额外安装扩展或配置 catbus 路径。登录沿用 B 站页保存的 Cookie，不另存登录凭证。

## 开关和发送

- `bili.danmakuEnabled`：默认 `false`。控制面板、聊天工具和自动弹幕的实际发送。
- `bili.autoDanmaku`：默认 `false`。两个开关都打开后，刷完视频才会决定是否自动发送。
- `bili.maxDanmakuPerDay`：默认 3，可设 1～20。手动和自动共用提交上限，失败或结果待确认的请求也计数。更换 Cookie 不会重置当天额度。

修改后先保存设置。总开关或 B 站关闭时不发送；试运行不提交、不消耗次数、不写成功记忆。准备请求期间更换登录态、关闭开关或停止模块，会在最终提交前再次检查。

「检查视频」只读标题、当前 CID 和时长，不发弹幕、不消耗额度。支持 BV / av 号、完整视频链接、`ep` 单集和 `ss` 整季链接；短链接需先展开。「分P / 选集序号」的含义：

- 普通单段投稿填 1；多段投稿按分P序号选择，以该分P的 CID 和时长为准。
- `ss` 整季链接按主选集列表选择第几集；`ep` 链接直接定位指定单集。
- 出现时间按当前分P或单集计算，单位为秒，可以填 0.1 等小数。

弹幕为一行有效文字，最多 100 个 Unicode 字符，不截断 emoji。支持滚动、顶部和底部，暂不提供高级弹幕样式。

主人私聊中可通过 `bili_danmaku` 工具指定链接、正文、时间和分P；工具挂载与执行均检查身份，不向群聊或普通用户开放。自动弹幕只使用本轮视频标题和浏览感想，并禁止工具调用；没有合适内容可跳过，每个视频每天最多自动提交一次。

## 结果与重试

弹幕写请求只提交一次。请求前写入待确认记录；相同 CID、时间和内容在 24 小时内不重复提交，两次提交至少间隔 30 秒。平台风控、验证码或频率限制后，暂停弹幕提交 30 分钟，不自动解验证码。

只有平台返回 `code: 0` 和有效弹幕编号时，才记录成功和经历。大整数编号优先使用平台的 `dmid_str`，不会从丢失精度的数字猜测编号。平台接收不等于所有观众立即可见，面板可展开响应查看 `visible` 等平台结果。

超时或未返回编号时提示「结果未确认」，请先到 B 站检查，避免重复发送。面板只展示允许的公开响应字段，不回传请求头或 Cookie。历史写入模块数据目录的 `danmaku.json`，不随源码提交。

## 恢复评论暂停

此前登录失效造成当天暂停后，即使已更换有效 Cookie，评论也要等到次日才恢复。现在保存新 Cookie 后点「检查登录」，确认仍是同一份有效凭证，才解除登录 / CSRF 错误导致的暂停；保留原有次数和历史。同一凭证再次被写接口拒绝，不会反复解除暂停。风控、验证码和频率限制不会因登录核验成功而解除。

## 参数来源

弹幕表单、WBI 的 `dm_img_*` 初始参数参考 catbus 的 `src/platforms/bilibili/web/api.ts` 和 `sign.ts`，整理为本项目的原生接口；没有运行时 catbus 依赖，不读取或修改 catbus 的源码及账号文件。

catbus 的相关代码采用 MIT License，保留其许可如下：

```text
MIT License

Copyright (c) 2026 cv-cat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
