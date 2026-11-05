// QQ 通知事件翻成她能看懂的一句话。字段按 SnowLuma 的事件来；这里只管翻译，要不要记由中枢决定。

/** @returns {{chatId:string, text:string}|null} 不用让她知道的事件返回 null。name(qq) 把 QQ 号换成称呼。 */
export function noticeText(ev, { botQQ, name = (qq) => String(qq), ownMessage = () => false } = {}) {
  if (ev?.post_type !== 'notice') return null
  const type = ev.notice_type
  const sub = ev.sub_type
  const bot = String(botQQ || '')
  const who = (qq) => (String(qq) === bot ? '你' : name(qq))
  const group = (text) => ({ chatId: `group:${ev.group_id}`, text })
  const by = (id) => (id && String(id) !== String(ev.user_id) ? `${who(id)}把` : '')
  switch (type) {
    case 'group_recall':
      if (String(ev.operator_id) === bot) return null
      return group(String(ev.operator_id) === String(ev.user_id) ? `${who(ev.user_id)}撤回了一条消息` : `${who(ev.operator_id)}撤回了${who(ev.user_id)}的一条消息`)
    case 'friend_recall':
      return { chatId: `private:${ev.user_id}`, text: '对方撤回了一条消息' }
    case 'group_ban':
      if (sub === 'lift_ban') return group(`${who(ev.operator_id)}解除了${who(ev.user_id)}的禁言`)
      return group(`${who(ev.operator_id)}禁言了${who(ev.user_id)} ${Math.max(1, Math.round((Number(ev.duration) || 0) / 60))} 分钟`)
    case 'group_increase':
      return group(`${who(ev.user_id)}进群了`)
    case 'group_decrease':
      return sub === 'leave' ? group(`${who(ev.user_id)}退群了`) : group(`${by(ev.operator_id)}${who(ev.user_id)}踢出了群`)
    case 'group_admin':
      return group(sub === 'set' ? `${who(ev.user_id)}成了管理员` : `${who(ev.user_id)}不再是管理员`)
    case 'essence':
      return group(`${who(ev.operator_id)}把${who(ev.sender_id ?? ev.user_id)}的消息${sub === 'add' ? '设为精华' : '移出了精华'}`)
    case 'group_card':
      return group(`${who(ev.user_id)}把群名片改成了「${String(ev.card_new || '').slice(0, 30)}」`)
    case 'group_msg_emoji_like':
      return sub === 'add' && ownMessage(ev.message_id) ? group(`${who(ev.user_id)}给你的消息点了表情回应`) : null
    case 'friend_add':
      return { chatId: `private:${ev.user_id}`, text: '你们刚加上好友' }
    case 'notify':
      if (sub === 'title') return group(`${who(ev.user_id)}的头衔变成了「${String(ev.title || '').slice(0, 30)}」`)
      if (sub === 'group_name') return group(`${who(ev.user_id)}把群名改成了「${String(ev.name_new || '').slice(0, 30)}」`)
      return null
    default:
      return null
  }
}
