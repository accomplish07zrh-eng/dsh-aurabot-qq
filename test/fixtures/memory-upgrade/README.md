这些是依据只读的 v1.1.24 / v1.2.0-beta.2 源码手工整理的升级样本，不是真实用户数据，也没有复制旧源码。

- 两版 add() 都写 id/text/about/aboutName/tags/importance/source/chatId/at/hits；更早的数据或导入数据可能缺 tags、chatId、hits。当时没有 saidAt、speaker、status、gists/chats/relations/shortTerm。
- 当时的 profiles 是 {text,name,at}，不是现在的拆分画像；另放只含 text 的最小旧画像，覆盖缺失可选字段。
- insights 的条目是 {id,text,at}，styles 是字符串数组；另有 insightNames、history、invalidAt、supersededBy、rev、runs、lastConsolidate。
- v1.1.24 的 processed[day] 是一个数字；beta.2 已改为 {offset,end,chats}，新代码仍可读取。样本保留两种形状。
- 所参考的两版 memory.js 都不主动生成 tier；样本里标为“导入兼容字段”的字符串 tier（core/detail）和 legacyLabel 是额外的兼容性压力数据，不能据此说旧版会原生写这些字段。数字 tier 的行为另在测试中验证。
- 时间基准为 2026-06-01 UTC（1780272000000），跨越数月。业务整理测试整体平移时间，防止样本随测试日期老化，误撞正常的半年过时清理。纯迁移测试逐字段比较原始时间，不平移。
- .config.json 的 raw 用于调用旧版 normalize，normalizedMemory 是根据对应源码逐项列出的记忆配置输出。测试在旧源码可访问时会实际核对输出；源码不在机器上时只跳过这项溯源核对，固定输出交给新版 normalize 的测试仍然执行。未运行代码生成这些 fixture。
- beta.2 的 keepChatlogDays=-1 应保留；另测当时默认的 0 升级为 7，这是当前 normalize 已有的有意迁移规则，不算值丢失。
