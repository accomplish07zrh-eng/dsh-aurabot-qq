// 谁能跟她说话、她在每个会话里有多大权限。纯函数。

/** 权限档位：full = DSH 完整工具；social = 只有 QQ 社交工具；chat = 纯聊天，没有工具。 */
export const LEVELS = ['full', 'social', 'chat']

/**
 * @param {object} cfg 插件配置
 * @param {{kind:'private'|'group', userId:string, groupId:string}} msg
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkAllowed(cfg, msg) {
  const owner = String(cfg.ownerQQ || '')
  if (msg.kind === 'private') {
    if (msg.userId === owner) return { allowed: true, reason: '主人' }
    const list = (cfg.allow?.private || []).map(String)
    return list.includes(msg.userId)
      ? { allowed: true, reason: '私聊白名单' }
      : { allowed: false, reason: '不在私聊白名单' }
  }
  const groups = (cfg.allow?.groups || []).map(String)
  return groups.includes(msg.groupId)
    ? { allowed: true, reason: '群白名单' }
    : { allowed: false, reason: '不在群白名单' }
}

/** 这个会话用哪一档权限。群聊永远不超过 social。 */
export function levelFor(cfg, chat) {
  const owner = String(cfg.ownerQQ || '')
  if (chat.kind === 'private' && chat.userId === owner) {
    return LEVELS.includes(cfg.ownerLevel) ? cfg.ownerLevel : 'full'
  }
  return 'social'
}

/** 档位 → agent preset id。 */
export function presetFor(level, cfg) {
  if (level !== 'full') return 'aurabot-social'
  return cfg && cfg.longTasks ? 'aurabot-private-long' : 'aurabot-private'
}

/** 只有主人能做的事（群管、点歌、写文件……）。 */
export function isOwner(cfg, userId) {
  return String(userId || '') !== '' && String(userId) === String(cfg.ownerQQ || '')
}

/** 改资料类操作（改昵称 / 签名 / 头像、改 B 站签名），以及处理好友申请、改白名单的三档权限。 */
export const PROFILE_PERM_LEVELS = ['off', 'owner', 'all']
export const DOUYIN_PERM_KEYS = ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm']
/** 小黑盒：浏览（含热榜/搜索）、点赞、评论、发帖（含删自己的帖）。 */
export const HEYBOX_PERM_KEYS = ['heyboxBrowse', 'heyboxLike', 'heyboxComment', 'heyboxPost']
export const PROFILE_PERM_KEYS = ['qqNickname', 'qqSignature', 'qqAvatar', 'biliSign', 'biliAvatar', 'biliComment', 'qqFriendRequest', 'whitelist', ...DOUYIN_PERM_KEYS, ...HEYBOX_PERM_KEYS]
/** 没设过的档位：一律默认仅主人（含抖音浏览/互动/改资料项；用户要放开自己在面板开）。 */
export const profilePermDefault = (key) => 'owner'
export const permOf = (cfg, key) => {
  const p = cfg?.profilePerms?.[key]
  return PROFILE_PERM_LEVELS.includes(p) ? p : profilePermDefault(key)
}

/** 这一档在这个会话里要不要挂工具。owner = 只在主人私聊里挂；all = 哪都挂；off = 不挂。 */
export function profileToolVisible(cfg, key, chat) {
  const p = permOf(cfg, key)
  if (p === 'all') return chat.kind === 'private' || chat.kind === 'group'
  if (p === 'owner') return chat.kind === 'private' && String(chat.userId) === String(cfg.ownerQQ || '')
  return false
}

/** 执行时再查一遍（面板可能刚改过）。allOwner = 这一轮说话的人全是主人。 */
export function profilePermits(cfg, key, chat, allOwner) {
  const p = permOf(cfg, key)
  if (p === 'off') return { ok: false, message: '这个操作在面板里关掉了' }
  if (!profileToolVisible(cfg, key, chat)) return { ok: false, message: '这里不能做这个操作' }
  if (p === 'owner' && !allOwner) return { ok: false, message: '只有主人私聊让我改才行' }
  return { ok: true }
}
