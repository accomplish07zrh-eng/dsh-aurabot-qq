/** 每轮生成一行本机时间；不要注册为常驻上下文（#79）。 */
export function currentTimeLine(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const h = now.getHours()
  const period = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上'
  return `【当前本机时间】${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 星期${'日一二三四五六'[now.getDay()]} ${period} ${pad(h)}:${pad(now.getMinutes())}（以此判断时段，不以图片为准）。`
}
