// 子智能体委派：hub.runSubagentTurn 的行为契约 + 一审/复审 #177 的权限边界。
// 模块只能拿到宿主封装的 subagentFor(真实模块 id)：moduleId 由宿主注入、source 由宿主按最近主人活动判断，
// 调用方传的 moduleId / source 一律不认。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'

const OWNER = '10001'
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate) }

/** 起一个真 hub + 假 DSH：默认打开 subagentBackground（模拟允许后台派活）。 */
function setup(t, { subagents, capabilities, config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-subagent-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  const fake = createFakeDsh({ brain: async () => '' })
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: OWNER, subagentBackground: true, workspaceDir: join(root, 'workspace'), ...(config || {}) })
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, (...v) => fake.logs.push(v.join(' '))]))
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    log,
    onebot: {},
    buildTools: () => [{ name: 'system-probe' }],
    // 模拟模块清单：phone 声明了 plugin-internals，别的没声明
    capabilitiesOf: (id) => (typeof capabilities === 'function' ? capabilities(id) : id === 'phone' ? ['network', 'plugin-internals'] : []),
  })
  const calls = []
  const disposed = []
  if (subagents !== null) {
    fake.ctx.subagents = subagents || {
      async startActivation(args) {
        calls.push(args)
        return {
          result: Promise.resolve('子智能体办好了'),
          dispose: async () => { disposed.push(args.label) },
        }
      },
    }
  }
  t.after(() => {
    hub.dispose()
    fake.dispose()
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(root, { recursive: true, force: true })
  })
  // 模块拿到的唯一入口：subagentFor(真实 id)；调用方不能自报 moduleId/source
  const run = (prompt = '任务书', opts = {}) => hub.subagentFor('phone')('手机逛逛', '手机逛逛', prompt, opts)
  return { fake, hub, calls, disposed, cfg, run }
}

test('宿主没有 subagents 服务：明确报 SUBAGENT_UNAVAILABLE，不吞成空结果', async (t) => {
  const s = setup(t, { subagents: null })
  await assert.rejects(s.run(), (error) => {
    assert.equal(error.code, 'SUBAGENT_UNAVAILABLE')
    return true
  })
})

test('委派契约：spawn + delivery:"caller" + 显式 agentPreset，父级常驻并复用', async (t) => {
  const s = setup(t)
  const first = await s.run('打开手机，刷十分钟，回来告诉我看到了什么')
  assert.equal(first, '子智能体办好了')

  const call = s.calls[0]
  assert.equal(call.provider, 'spawn')
  assert.equal(call.delivery, 'caller')
  assert.equal(call.request.agentPreset, 'aurabot-subagent', '不显式指定就会继承 aurabot-social（零本地工具）')
  assert.equal(call.request.prompt[0].text, '打开手机，刷十分钟，回来告诉我看到了什么')
  assert.equal(call.label, '手机逛逛')
  assert.ok(call.signal instanceof AbortSignal)

  const parent = call.request.parent
  assert.ok(parent && typeof parent.id === 'string' && parent.id, 'parent 必须是 agent 句柄')
  const second = await s.run('再刷五分钟')
  assert.equal(second, '子智能体办好了')
  assert.equal(s.calls[1].request.parent.id, parent.id, '父级会话复用，不能每趟新建')
  assert.equal(s.calls[1].request.parent.preset, 'aurabot-social')

  await settle()
  assert.deepEqual(s.disposed, ['手机逛逛', '手机逛逛'])
})

test('结果形状兜底：字符串 / 消息块数组 / 包着 output 的对象，都取最后一段有效文本', async (t) => {
  const shapes = [
    ['纯字符串', '直接给的答案', '直接给的答案'],
    ['消息块数组', [{ type: 'text', text: '先想了下' }, { type: 'text', text: '最终答案' }], '最终答案'],
    ['对象 output', { output: '对象里的答案' }, '对象里的答案'],
    ['对象 text', { text: 'text 字段的答案' }, 'text 字段的答案'],
  ]
  for (const [name, result, want] of shapes) {
    const s = setup(t)
    s.fake.ctx.subagents = { async startActivation() { return { result: Promise.resolve(result), dispose: async () => {} } } }
    assert.equal(await s.run(), want, name)
  }
})

test('子智能体失败：result 带 error 时抛错，但子树仍然释放（不泄漏挂载）', async (t) => {
  const s = setup(t)
  const disposed = []
  s.fake.ctx.subagents = {
    async startActivation() {
      return { result: Promise.resolve({ error: '模型超时' }), dispose: async () => { disposed.push(1) } }
    },
  }
  await assert.rejects(s.run(), /子智能体执行失败：模型超时/)
  await settle()
  assert.equal(disposed.length, 1, '失败路径也要 dispose')
})

// ---------- 一审 / 复审 #177 的权限边界 ----------

test('能力声明：模块没在 module.json 声明 plugin-internals 就不许委派', async (t) => {
  const s = setup(t)
  await assert.rejects(s.hub.subagentFor('other')('别的模块', '别的模块', '任务书'), (error) => {
    assert.equal(error.code, 'CAPABILITY_REQUIRED')
    return true
  })
  assert.equal(s.calls.length, 0, '被拒时不能真的 spawn')
})

test('来源由宿主判断：调用方伪造 source/moduleId 无效，后台开关关着就拒绝', async (t) => {
  const s = setup(t, { config: { subagentBackground: false } })
  // 模块把 moduleId/source 塞进 opts 也没用：subagentFor 固定真实 id、source 由 lastOwnerChatAt 判断
  await assert.rejects(
    s.run('任务书', { moduleId: 'phone', source: { kind: 'owner', chatId: `private:${OWNER}` } }),
    (error) => error.code === 'OWNER_REQUIRED',
  )
  assert.equal(s.calls.length, 0)
})

test('后台开关：config.subagentBackground 打开后才允许无主人活动的派活', async (t) => {
  const s = setup(t) // 默认配置已打开
  const out = await s.run('任务书')
  assert.equal(out, '子智能体办好了')
  assert.equal(s.calls.length, 1)
})

test('模块可见的 core：委派原始入口被遮蔽，原型链也摸不回去（三审 #177）', async (t) => {
  const { scopeCoreForModule } = await import('../src/core/modules.js')
  const s = setup(t)
  const core = { hub: s.hub }
  const scoped = scopeCoreForModule(core, 'phone')

  // 模块拿到的入口能用：固定 phone 身份，走宿主判定
  const out = await scoped.hub.runSubagentTurn('手机逛逛', '手机逛逛', '任务书')
  assert.equal(out, '子智能体办好了')
  assert.equal(s.calls.length, 1)

  // 原始入口不下发
  assert.equal(scoped.hub.subagentFor, undefined, 'subagentFor 不对模块可见')
  // 原型链摸不回去：scopedHub 的原型是 Object.prototype，scopedCore 的原型被掐成 null
  assert.equal(Object.getPrototypeOf(scoped.hub).runSubagentTurn, undefined, '原型链上不能有原始 runSubagentTurn')
  assert.equal(Object.getPrototypeOf(scoped.hub).subagentFor, undefined, '原型链上不能有原始 subagentFor')
  assert.equal(Object.getPrototypeOf(scoped), null, 'core 的原型链要掐断（getPrototypeOf(api.core).hub 绕回）')
  // 其余 hub 能力照常转发、core 的其他属性照常可见
  assert.equal(typeof scoped.hub.sendText, 'function', 'hub 其余方法照常下发')
  assert.equal(scoped.extra, undefined, 'core 上没有的属性不凭空出现')
  // 原始 hub 不受影响
  assert.equal(typeof core.hub.runSubagentTurn, 'function')
  assert.equal(typeof core.hub.subagentFor, 'function')
})

test('cordis.patch.yml 里有专给子级的 aurabot-subagent preset：本机工具 + 无 QQ 人格', () => {
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yml, /id:\s*preset-aurabot-subagent/, 'preset 条目必须存在')
  const block = yml.slice(yml.indexOf('id: preset-aurabot-subagent'))
  const body = block.slice(0, block.indexOf('- id: preset-aurabot-social') > 0 ? block.indexOf('- id: preset-aurabot-social') : block.length)
  assert.match(body, /id:\s*aurabot-subagent/, 'preset id 与 hub 指定的一致')
  assert.match(body, /dsh-tool-pwsh/, 'Windows 上要能跑命令')
  assert.match(body, /dsh-tool-fs/, '要能读写文件')
  assert.doesNotMatch(body, /aurabot_persona/, '子级不带 QQ 人格')
})
