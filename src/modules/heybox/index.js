// 内置模块：刷小黑盒。小黑盒（xiaoheihe.cn）的游戏社区客户端——
// 用主人的账号读信息流、帖子正文与热评，点赞、评论、发帖（文章模式，可带图），删自己的帖。
// 接口签名 / cosm 上传等实现在 src/heybox/ 里（api.js 签名与请求，site.js 业务）。
// 写操作各有权限（面板「权限」页），默认仅主人；发帖前有自检清单（见面板与规则）。

import { createHeybox } from '../../heybox/site.js'
import { createVerifier } from '../../heybox/verify.js'
import { defineTool, str } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'

export default {
  id: 'heybox',
  name: '刷小黑盒',
  version: '1.1.0',
  description: '小黑盒游戏社区：看信息流、读帖子热评、点赞、评论、发帖（文章模式可带图）、删自己的帖；发帖前先看热榜找角度（heybox_feed / heybox_watch / heybox_like / heybox_comment / heybox_post / heybox_hot / heybox_search / heybox_topics / heybox_delete）',
  tab: 'heybox',
  files: ['heybox/api.js', 'heybox/site.js', 'heybox/verify.js'],
  setup(api) {
    const { hub, http } = api.core
    // 接口被安全验证挡住时，靠真浏览器过一次（复用抖音那套 CDP 封装）
    const verifier = createVerifier({ browserPath: () => api.config().douyin?.browserPath || '', log: api.log })
    const hb = createHeybox({ getConfig: api.config, hub, memory: api.lazy('memory'), log: api.log, verifier })

    // 定时自己逛一圈（只读，不写）
    api.every(60_000, () => hb.tick({ memory: api.use('memory'), owner: api.config().ownerName || '' }), '刷小黑盒')

    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.heybox.enabled || chat.kind === 'system') return []
      const guarded = (key, run) => async (args) => {
        const c = api.config()
        if (!c.heybox.enabled) return { ok: false, message: '小黑盒没打开' }
        const p = profilePermits(c, key, chat, hub.turnSendersAllOwner(sessionId))
        if (!p.ok) return p
        return run(args)
      }
      const tools = []
      if (profileToolVisible(cfg, 'heyboxBrowse', chat)) {
        tools.push(defineTool({
          name: 'heybox_feed',
          description: '刷小黑盒信息流，看看现在有什么帖子。有人问小黑盒有什么新鲜事、让你去逛逛时用。',
          properties: {},
          execute: guarded('heyboxBrowse', () => hb.feedReport()),
        }))
        tools.push(defineTool({
          name: 'heybox_watch',
          description: '看一个小黑盒帖子的正文和热评，看完再聊。别人发来小黑盒链接时用。',
          properties: { link: str('小黑盒帖子链接或 link_id') },
          required: ['link'],
          execute: guarded('heyboxBrowse', ({ link }) => hb.watch(String(link || ''))),
        }))
        tools.push(defineTool({
          name: 'heybox_hot',
          description: '看小黑盒热搜榜（写帖前必看）。选题从里面挑：优先游戏相关、有数据或争议的；电竞和商业新闻不适合。挑不出来就说今天没合适的，别硬凑。',
          properties: { limit: { type: 'number', description: '看前几条，默认 8' } },
          execute: guarded('heyboxBrowse', ({ limit }) => hb.hot(Number(limit) || 8)),
        }))
        tools.push(defineTool({
          name: 'heybox_search',
          description: '在小黑盒搜帖子，看社区现在在聊什么。写帖前用它找角度：高赞说明这个角度打中了读者，别硬造没人关心的话题。搜索被验证码挡了就改用 heybox_feed 看信息流，别反复重试。',
          properties: { query: str('关键词'), limit: { type: 'number', description: '几条，默认 8' } },
          required: ['query'],
          execute: guarded('heyboxBrowse', ({ query, limit }) => hb.search(String(query || ''), Number(limit) || 8)),
        }))
        tools.push(defineTool({
          name: 'heybox_topics',
          description: '查小黑盒发帖可用的分区（id 和名字）。发帖前不确定分区就用这个。',
          properties: {},
          execute: guarded('heyboxBrowse', () => hb.topicList()),
        }))
      }
      if (profileToolVisible(cfg, 'heyboxLike', chat)) tools.push(defineTool({
        name: 'heybox_like',
        description: '给一个小黑盒帖子点赞。有人明确让你点赞时用。',
        properties: { link: str('帖子链接或 link_id') },
        required: ['link'],
        execute: guarded('heyboxLike', ({ link }) => hb.like(String(link || ''))),
      }))
      if (profileToolVisible(cfg, 'heyboxComment', chat)) tools.push(defineTool({
        name: 'heybox_comment',
        description: '在一个小黑盒帖子下发评论。有人明确让你去评论时用。评论要短（15-40字），抓住对方话里的具体点，别写贴哪都成立的空话。',
        properties: { link: str('帖子链接或 link_id'), text: str('评论内容（100 字以内）') },
        required: ['link', 'text'],
        execute: guarded('heyboxComment', ({ link, text }) => hb.comment(String(link || ''), String(text || ''))),
      }))
      if (profileToolVisible(cfg, 'heyboxPost', chat)) tools.push(defineTool({
        name: 'heybox_post',
        description: '在小黑盒发帖（文章模式，正文空行分段，可带图）。主人明确让你发帖时用。正文 200-800 字，别写 AI 腔，别编造第一人称经历，不碰政治。style 不填用面板设的默认风格。',
        properties: {
          title: str('标题（30 字以内，别和正文第一行重复）'),
          text: str('正文，空行分段。'),
          topic: str('分区 id：7214 盒友杂谈 / 18745 数码硬件 / 806933 AI，不填用默认'),
          style: {
            type: 'string',
            enum: ['diary', 'news', 'mix'],
            description: '写作风格：diary = 大肥鱼日记（第一人称随手记，跟空间日记一个味，120-300字）；news = 热搜文（报道新闻体，200-800字）；mix = 肥鱼热搜（日记口吻写热搜，150-500字）。不填用默认。',
          },
          images: { type: 'array', items: { type: 'string' }, description: '可选：本机图片绝对路径，最多 4 张' },
        },
        required: ['title', 'text'],
        execute: guarded('heyboxPost', ({ title, text, topic, style, images }) =>
          hb.post({ title: String(title || ''), text: String(text || ''), topic: String(topic || ''), style: String(style || ''), images: Array.isArray(images) ? images.slice(0, 4) : [] })),
      }))
      if (profileToolVisible(cfg, 'heyboxPost', chat)) tools.push(defineTool({
        name: 'heybox_delete',
        description: '删掉自己发的一条小黑盒帖子。主人明确要求删时用。',
        properties: { link: str('帖子链接或 link_id') },
        required: ['link'],
        execute: guarded('heyboxPost', ({ link }) => hb.remove(String(link || ''))),
      }))
      return tools
    })

    // 她自己的规则：什么时候用、怎么写、什么不能写
    api.rule(() => [
      '你会刷小黑盒（游戏社区）：heybox_feed 看信息流、heybox_watch 读帖子、heybox_like 点赞、heybox_comment 评论、heybox_post 发帖（可带图）、heybox_hot 看热搜、heybox_search 搜帖子、heybox_topics 查分区、heybox_delete 删帖。别人说小黑盒的事就用这些工具。',
      '在小黑盒发帖前有条固定流程：①先 heybox_hot 看热搜（不许跳过），从里面挑游戏相关、有数据或争议的题；挑不出来就说今天没有合适的，别硬凑。②再 heybox_search 看社区高赞帖在聊什么角度——自己搜新闻容易过时，社区真正在聊的角度才有效，可以借角度但用自己的话。搜索被验证码挡了就用 heybox_feed 看信息流代替，别反复重试。③素材里必须有具体的东西：价格、销量、时长、机制名、star 增速，没具体信息就是水文。',
      '小黑盒发帖有三种风格，面板里选的那个是默认，想单次换就在 heybox_post 里传 style：diary＝大肥鱼日记（第一人称随手记，跟空间日记一个味，可以写今天刷到这条时的反应、想吃白米饭，120-300字，不分小标题）；news＝热搜文（报道新闻体，开门见山讲清楚这事，摆具体数字，钩子→信息3-4段→我的判断→抛问题，200-800字）；mix＝肥鱼热搜（用日记口吻写热搜，新闻信息要真、语气是「我跟你说个事」，150-500字）。',
      '发帖自检（任何一条不过就别发）：标题和正文第一行不重复；不编造第一人称经历（你没经历过的事一律不写）；正文符合所选风格的字数；配图至少 3 张更好；不碰政治、医疗法律建议、评价真人、判断价格是否合理；读一遍像不像人话（转折词堆砌就是 AI 腔）。',
      '小黑盒评论要短：15-40 字，超过 60 字就是在写小作文。抓住对方话里的具体措辞顶回去，别写「闲鱼水深」这种贴哪都成立的空话。自检：这条回复贴到同帖另一条评论下还说得通吗？说得通说明没针对，重写。',
      '定时刷小黑盒跑在独立的后台会话（system:ext-heybox）里，带人格但不会自动带记忆，也不发到 QQ。需要长期记住的逛帖收获会被写进记忆。',
      '小黑盒有风控：工具返回「小黑盒在冷却中」「要求安全验证」「操作太频繁」，说明这会儿不能再用接口了。别换个接口重试、别让主人反复点，等冷却过去（面板「小黑盒」页能看到还要等多久）；实在急着用，让主人在面板里点「去验证」用浏览器过一次。',
    ].join('\n'))

    // 面板：全部只读状态下拉，不带副作用
    api.route('/heybox/state', async () => ({ ok: true, ...hb.state() }))
    api.route('/heybox/feed', async () => hb.feedReport())
    api.route('/heybox/hot', async () => hb.hot(10))
    api.route('/heybox/topics', async () => hb.topicList())
    api.route('/heybox/account', async () => hb.account(true))
    api.route('/heybox/login-cookie', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      const r = hb.saveCookie(String(b?.cookie ?? ''))
      // saveCookie 只负责校验，真正落配置还得经过 setConfig（面板存其他设置时也一样）
      if (r.ok) api.setConfig((cur) => ({ ...cur, heybox: { ...cur.heybox, cookie: r.cookie, enabled: cur.heybox.enabled } }))
      return { ok: r.ok, message: r.message }
    })
    api.route('/heybox/run', async () => hb.browse())
    api.route('/heybox/clear-quota', async () => hb.clearQuota())
    api.route('/heybox/styles', async () => ({ ok: true, styles: hb.POST_STYLES, default: hb.DEFAULT_POST_STYLE }))
    // 风控：看冷却还剩多久 / 手动解除
    api.route('/heybox/risk', async () => ({ ok: true, risk: hb.risk(), verifier: verifier.status() }))
    api.route('/heybox/risk/clear', async () => hb.clearRisk())
    // 安全验证：默认走扫码（不开浏览器）；verifyMode=browser 才开后台浏览器
    api.route('/heybox/verify/start', async () => hb.verifyStart())
    // 扫码登录：拿二维码 / 轮询结果（纯接口，不弹窗）
    api.route('/heybox/qr/start', async () => hb.qrStart())
    api.route('/heybox/qr/poll', async () => {
      const r = await hb.qrPoll()
      if (r.ok && r.cookie) api.setConfig((cur) => ({ ...cur, heybox: { ...cur.heybox, cookie: r.cookie } }))
      return r
    })
    // 浏览器兜底：显示/收回窗口（默认屏幕外，不打扰主人）
    api.route('/heybox/verify/show', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return hb.verifyShow(Boolean(b?.visible))
    })
    api.route('/heybox/verify/finish', async () => {
      const r = await hb.verifyFinish()
      // verifyFinish 收回来的 Cookie 要落配置，不然重启就丢了
      if (r.ok && r.cookie) api.setConfig((cur) => ({ ...cur, heybox: { ...cur.heybox, cookie: r.cookie } }))
      return { ok: r.ok, message: r.message, hasPkey: r.hasPkey, shot: r.shot }
    })
    return hb
  },
}
