# 对话原话与微信历史资料接入

基于 release/1.3.0，验证基线为 7628628983e6fb3143f420381517d80f692e9f03（1.3.0-beta.1）。
原话档案补充核心上下文接口，沿用 1.3.0 的记忆存储、向量检索、事实版本、权限判断与生命周期，不替换这些实现。

## 开启与保留范围

conversationContext.enabled 默认 false。使用者明确开启后，核心才保存、检索原话并向 prompt 挂钩提供 recentMessages。
关闭时停止追加和注入，recentMessagesOf 返回空数组；已有文件保留，须由使用者管理保留期限。

数据位于 Aurabot 数据目录的 conversation-context/，按人格标识和聊天标识生成独立文件。
记录用户正文及模型完成轮次的最终 assistant 正文，包含 id、role、text、speakerId、at（Unix 毫秒）。
群聊逐条保存实际发送者，避免把整批消息归给第一个人。
assistant 记录表示模型的最终文本，不证明消息已成功送达，也不证明用户或原型人物经历过这些事。

追加日志是原话来源；checkpoint 仅为检查信息。损坏或不完整的日志会报错并保留，不静默重建空库。
不会自动导入旧聊天流水，不调用外部模型，不改 QQ 账号、网关、发送权限或宿主授权。
沿用上游 forgetChatLog 的用户范围：忘记请求对本人私聊及本人在群里的原话生效，保留排除规则；
关闭再开启、切换人物或重启后也不会重新注入匹配的旧内容；仍在生成的回复按本轮上下文时间过滤。原始日志仍保留，物理清理需另行管理。
损坏的排除规则会停止档案召回，不用空规则替代。

## 模块接口

- prompt(content, info) 新增 info.recentMessages，类型见 src/modules/aurabot.d.ts 的 ConversationMessage。
- recentMessages 仅含同一人物、同一聊天的近期原话，不含当前尚未交给模型的输入；关闭或无档案时为空数组。
- api.core.hub.recentMessagesOf(chatId, limit) 返回当前人物的原话副本，默认 32 条，最多 256 条；limit <= 0 返回空数组。
- 后台 system 会话不进入原话档案。排队轮次在提交时捕获人物标识，避免切换人物后把上一轮回复记到新人格。

模块与内核在同一信任边界，能访问核心 API。私人历史的用户授权和跨平台身份关联仍由扩展显式核对；
不能只因某人在群里是主人就把私人微信资料提供给全群。

## 检索与出口

当前问题优先；省略指代可使用近期用户线索，明确转题不扩展旧主题。
使用中文二元切词、BM25 和多线索排序合并，不增加模型或 embedding 调用。
按完整消息与序列化长度拆分较早片段，超长粘贴不挤掉相邻小事实；原日志不按注入预算截断。

近期记录在会话恢复时补入，相关旧片段附在当轮输入。
片段预算不代表完整请求的 token 上限；整体窗口和压缩仍由 DSH 管理。
对话资料保留来源和角色，标记为数据；注入外壳接入现有 leak-guard 清洗，原话本身不作为系统规则指纹。

## 微信历史语料

[WeChat Persona Skill](https://github.com/Accelerate11/wechat-persona-skill) 独立负责 JSONL 导入、可选的 Windows 微信 4 只读提取、
发送者核对、证据审计、记忆与情境表达规律。数据库版本相关代码与 Python 依赖不进入 Aurabot 核心。

扩展可用近期原话展开“那后来呢”，再检索已获授权的历史证据。
私人语料只提供给指定用户的私聊，保留 owner/target 和证据 ID；assistant 原话不能提升为原型事实。
本接口不实现微信实时收发。外部模型分析须另行授权，真实聊天、人物资料与密钥不随源码发布。

test/fixtures/wechat-history/bundle.json 全部为虚构数据，测试外部资料经 prompt 接入的契约；
test/context-memory-integration.test.js 验证多轮检索、发送者归属、跨重启、关闭行为、人格/聊天隔离及出口清洗。
实际提取器的 JSONL 筛选、会话划分和离线管线由配套仓库测试；不以合成 fixture 代替微信实机版本兼容验证。

## 验证

目标测试：
node --test test/conversation-context.test.js test/context-memory-integration.test.js

完整回归：
npm test

与上游相同环境对照失败，记录 Node 版本及 TZ；本分支回归使用 TZ=UTC。
本变更不升级正在运行的机器人。旧版 1.1.24 按哈希安装器不适用于此 1.3.0 分支。
