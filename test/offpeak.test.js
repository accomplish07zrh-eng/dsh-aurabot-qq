// DeepSeek 峰谷省钱模式：纯时间计算 + 配置归一化。
// 峰时 = UTC 01:00–04:00、06:00–10:00 的工作日（北京时间周一~周五、非中国法定节假日）；
// 换成北京时间 = 工作日 09:00–12:00、14:00–18:00；周末和法定节假日全天谷价。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPeak, isOffPeak, nextChange, shouldDeferBackground } from '../src/core/offpeak.js'
import { normalize } from '../src/core/config.js'

// 2026-11-02 是周一，2026-11-06 周五，2026-11-07 周六，2026-11-08 周日。
// 下面都用 UTC 时间戳，注释里给对应的北京时间。
const utc = (y, m, d, hh, mm = 0) => Date.UTC(y, m - 1, d, hh, mm)
const MON = [2026, 11, 2]
const FRI = [2026, 11, 6]
const SAT = [2026, 11, 7]
const SUN = [2026, 11, 8]

test('峰/谷边界：工作日 UTC 01:00–04:00 与 06:00–10:00（左闭右开）', () => {
  const cases = [
    [utc(...MON, 0, 59), false, '北京 08:59 谷'],
    [utc(...MON, 1, 0), true, '北京 09:00 峰（开始）'],
    [utc(...MON, 3, 59), true, '北京 11:59 峰'],
    [utc(...MON, 4, 0), false, '北京 12:00 谷（结束）'],
    [utc(...MON, 5, 59), false, '北京 13:59 谷'],
    [utc(...MON, 6, 0), true, '北京 14:00 峰（开始）'],
    [utc(...MON, 9, 59), true, '北京 17:59 峰'],
    [utc(...MON, 10, 0), false, '北京 18:00 谷（结束）'],
    [utc(...FRI, 2, 0), true, '周五北京 10:00 峰'],
  ]
  for (const [ms, want, label] of cases) {
    assert.equal(isPeak(ms), want, label)
    assert.equal(isOffPeak(ms), !want, label + '（isOffPeak）')
  }
})

test('周末全天谷价（即使 UTC 小时落在峰时段里）', () => {
  assert.equal(isPeak(utc(...SAT, 2, 0)), false, '周六北京 10:00')
  assert.equal(isPeak(utc(...SAT, 7, 0)), false, '周六北京 15:00')
  assert.equal(isPeak(utc(...SUN, 6, 0)), false, '周日北京 14:00')
  // 周五最后一峰到周六第一峰之间连续谷
  assert.equal(isPeak(utc(...FRI, 10, 0)), false, '周五北京 18:00')
  assert.equal(isPeak(utc(...SAT, 1, 0)), false, '周六北京 09:00')
})

test('法定节假日全天谷价（按北京时间日期）', () => {
  const holidays = ['2026-11-02'] // 周一
  assert.equal(isPeak(utc(...MON, 2, 0), { holidays }), false, '节假日北京 10:00 谷')
  assert.equal(isPeak(utc(...MON, 7, 0), { holidays }), false, '节假日北京 15:00 谷')
  // 别的日子不受影响
  assert.equal(isPeak(utc(...FRI, 2, 0), { holidays: ['2026-11-02'] }), true, '周五照样峰')
  // 北京日期与 UTC 日期跨天的边界：UTC 2026-11-01 16:00 = 北京 11-02 00:00（节假日开始）
  assert.equal(isPeak(utc(2026, 11, 1, 16, 0), { holidays }), false)
})

test('nextChange：峰→谷、谷→峰、周末/节假日边界都对', () => {
  // 周一北京 10:00 峰 → 下一次变谷 = 北京 12:00（UTC 04:00）
  assert.deepEqual(nextChange(utc(...MON, 2, 0)), { at: utc(...MON, 4, 0), offPeak: true })
  // 周一北京 12:30 谷 → 下一次变峰 = 北京 14:00（UTC 06:00）
  assert.deepEqual(nextChange(utc(...MON, 4, 30)), { at: utc(...MON, 6, 0), offPeak: false })
  // 周一北京 18:30 谷 → 下一次变峰 = 周二北京 09:00（UTC 01:00）
  assert.deepEqual(nextChange(utc(...MON, 10, 30)), { at: utc(2026, 11, 3, 1, 0), offPeak: false })
  // 周五北京 18:30 谷 → 下一次变峰 = 下周一北京 09:00（UTC 周一 01:00，跳过周末）
  assert.deepEqual(nextChange(utc(...FRI, 10, 30)), { at: utc(2026, 11, 9, 1, 0), offPeak: false })
  // 周一下午谷 → 周二 09:00；周末中 → 周一 09:00
  assert.deepEqual(nextChange(utc(...SAT, 4, 0)), { at: utc(2026, 11, 9, 1, 0), offPeak: false })
  // 节假日（周一）后的第一个峰 = 周二 09:00
  assert.deepEqual(nextChange(utc(...FRI, 10, 30), { holidays: ['2026-11-09'] }), { at: utc(2026, 11, 10, 1, 0), offPeak: false })
  // 峰中：下一次变谷 = 12:00，不是 18:00
  assert.deepEqual(nextChange(utc(...MON, 3, 59), { holidays: [] }), { at: utc(...MON, 4, 0), offPeak: true })
})

test('shouldDeferBackground：配置缺失/关闭永远 false，开着且峰时才 true', () => {
  assert.equal(shouldDeferBackground(undefined, new Date(utc(...MON, 2, 0))), false, '配置缺失')
  assert.equal(shouldDeferBackground({}, new Date(utc(...MON, 2, 0))), false, '没有 cost')
  assert.equal(shouldDeferBackground({ cost: {} }, new Date(utc(...MON, 2, 0))), false, '开关没写 = 关')
  assert.equal(shouldDeferBackground({ cost: { offPeak: false } }, new Date(utc(...MON, 2, 0))), false, '开关关着')
  assert.equal(shouldDeferBackground({ cost: { offPeak: true } }, new Date(utc(...MON, 2, 0))), true, '开着 + 峰时')
  assert.equal(shouldDeferBackground({ cost: { offPeak: true } }, new Date(utc(...MON, 4, 0))), false, '开着 + 谷时')
  assert.equal(shouldDeferBackground({ cost: { offPeak: true } }, new Date(utc(...SAT, 2, 0))), false, '周末谷时')
  assert.equal(shouldDeferBackground({ cost: { offPeak: true, offPeakHolidays: ['2026-11-02'] } }, new Date(utc(...MON, 2, 0))), false, '节假日谷时')
})

test('面板：模型页有峰谷开关和节假日输入（源码契约）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  for (const text of ['DeepSeek 峰谷省钱模式', "f.sw('cost.offPeak')", "f.list('cost.offPeakHolidays'", '下次切换 ', 'isPeakAt', 'nextChangeAt']) {
    assert.ok(src.includes(text), '面板缺：' + text)
  }
})

test('config normalize：cost 默认关、老配置不受影响、脏值清洗', () => {
  const base = normalize({})
  assert.deepEqual(base.cost, { offPeak: false, offPeakHolidays: [] }, '默认关 + 空节假日')
  // 开关只认 boolean（手填 "true" 之类不当真）
  assert.equal(normalize({ cost: { offPeak: true } }).cost.offPeak, true)
  assert.equal(normalize({ cost: { offPeak: 'yes' } }).cost.offPeak, false)
  assert.equal(normalize({ cost: { offPeak: 1 } }).cost.offPeak, false)
  // 节假日：去重、去非法日期（2 月 30 / 乱填 / 非字符串）、排序、接受字符串形式
  const c = normalize({ cost: { offPeakHolidays: ['2026-10-01', '2026-10-01', '2026-02-30', 'bad', 20261001, ' 2026-10-02 '] } })
  assert.deepEqual(c.cost.offPeakHolidays, ['2026-10-01', '2026-10-02'])
  const c2 = normalize({ cost: { offPeakHolidays: '2026-10-01\n2026-10-02,2026-02-30' } })
  assert.deepEqual(c2.cost.offPeakHolidays, ['2026-10-01', '2026-10-02'])
  // 其它配置不受影响
  assert.equal(normalize({ cost: { offPeak: true } }).enabled, false)
})
