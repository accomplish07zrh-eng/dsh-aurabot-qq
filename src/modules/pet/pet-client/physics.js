// Aurabot 桌宠拖拽物理（纯逻辑，零依赖）—— 从 dsh-pet（MIT License，
// https://github.com/nicepkg/dsh-pet 的 src/shared/physics/{spring,throw,release,squash,constants}.ts）
// 去 TypeScript 化移植的单文件版；只保留单屏场景用得上的部分：
//   · springStep / softClampSpeed   跟手弹簧与软钳速
//   · throwBounds / throwStep       抛掷边界与「重力积分 + 地面/侧壁反弹」单步积分
//   · estimateReleaseVelocity / trimTrail   拖拽轨迹 → 松手初速
//   · landingSquash / squashScale   落地挤压幅度与 Q 弹曲线
// 本文件是模板/生成物（由 pet 模块 POST /client/install 拷进数据目录）。
// UMD：Electron 主进程 require('./physics.js')、渲染页 <script> 与 node:test 都能用。
// 形象/动画素材的许可与代码无关（dsh-pet 代码 MIT；宠物形象素材 CC BY-NC-SA 4.0，用户自备）。
;(function (global) {
  'use strict'

  // ---- 常量（与 dsh-pet src/shared/physics/constants.ts 一致的默认值；可被 pack 配置 physics 段覆盖） ----
  var SPRING_K = 200            // 拖拽弹簧刚度
  var SPRING_C = 30             // 拖拽弹簧阻尼（过阻尼，不 overshoot）
  var TRAIL_KEEP_MS = 200       // 拖拽轨迹保留窗口
  var RELEASE_WINDOW_MS = 150   // 初速估算窗口
  var RELEASE_STALE_MS = 150    // 松手前停顿超过它 = 温柔放下
  var MIN_SPAN_MS = 20          // 窗口太短视为不可估算
  var SEG_MIN_DT_MS = 8         // 分段速度的最小 dt（防高回报率鼠标抖动放大）
  var DEAD_ZONE_SPEED = 500     // 低于此速度不抛（原地放下）
  var MAX_THROW_SPEED = 3600    // 甩出速度软上限
  var PEAK_WEIGHT = 0.5         // 端点均值与窗口峰值的加权
  var ACCEL_REF = 8000          // 参考加速度
  var ACCEL_GAIN_MAX = 0.6      // 加速度增益上限
  var REST_VY = 40              // 落地 |vy| 小于它直接停竖直
  var REST_VX = 15              // 地面 |vx| 小于它认为已静止
  var MAX_STEP_DT = 0.05        // 单步最大 dt（防巨帧跳变）
  var SQ_SQUASH = 0.55          // 默认下压幅度
  var SQ_SOFT_SPEED = 300       // 轻落基准
  var SQ_HARD_SPEED = 1500      // 重砸上限
  var SQ_MAX_SQUASH = 0.55      // 最大下压幅度
  var THROW_SPEED_ANCHOR = 1200 // power=1 的参考初速
  var SUBSTEP_PX = 8            // 单步最大位移（超过拆步）
  var SUBSTEP_MAX = 64          // 单帧最多拆几步
  var DEFAULT_THROW_POWER = 1

  var DEFAULT_PHYSICS = {
    gravity: 1400,        // 重力 px/s²
    restitution: 0.78,    // 碰边恢复系数
    groundFriction: 2.5,  // 地面水平摩擦 /s
    ceilingBounce: true,  // 顶部要不要弹
    throwPower: 1,        // 总力度（K/C 与初速同乘）
  }

  // ---- spring.ts ----
  /** 过阻尼弹簧单轴速度步进：调用方随后 x += v*dt。 */
  function springStep(v, x, target, dt, power) {
    var p = power == null ? DEFAULT_THROW_POWER : power
    return v + ((target - x) * SPRING_K - v * SPRING_C) * p * dt
  }
  /** 软钳速：cap×(1-e^(-s/cap))，任意速度下单调可区分、渐近不超过 cap。 */
  function softClampSpeed(speed) {
    if (speed <= 0) return 0
    return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED))
  }

  // ---- throw.ts ----
  /** 由窗口宽高与宠物包围盒尺寸算抛掷边界（包围盒左上角允许范围）。 */
  function throwBounds(o) {
    var h = (o.size * 9) / 16
    return { minX: -o.sideAllow, minY: 0, maxX: o.W - o.size + o.sideAllow, maxY: o.H - h }
  }
  /** 抛体单步积分与边界反弹。返回 {x,y,vx,vy,bounced,atRest}。 */
  function throwStep(s, dtRaw, b, physics) {
    var ph = physics || DEFAULT_PHYSICS
    var dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT)
    var x = s.x, y = s.y, vx = s.vx, vy = s.vy
    vy += ph.gravity * dt
    x += vx * dt
    y += vy * dt
    var bounced = false
    if (x < b.minX) { x = b.minX; vx = Math.abs(vx) * ph.restitution; bounced = true }
    else if (x > b.maxX) { x = b.maxX; vx = -Math.abs(vx) * ph.restitution; bounced = true }
    if (y < b.minY) {
      if (ph.ceilingBounce) { y = b.minY; vy = Math.abs(vy) * ph.restitution; bounced = true }
    } else if (y >= b.maxY) {
      y = b.maxY
      vx *= Math.max(0, 1 - ph.groundFriction * dt)
      if (Math.abs(vy) < REST_VY) vy = 0
      else vy = -Math.abs(vy) * ph.restitution
      bounced = true
    }
    var speed = Math.hypot(vx, vy)
    var atRest = (y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX) ||
      (bounced && speed < REST_VY && Math.abs(vy) < 1)
    return { x: x, y: y, vx: vx, vy: vy, bounced: bounced, atRest: atRest }
  }
  /** 一帧该积几步（整数 ≥ 1）：位移超过 SUBSTEP_PX 就拆步，防跳过落地/反弹帧。 */
  function throwSubsteps(vx, vy, dt) {
    var travel = Math.hypot(vx, vy) * Math.min(Math.max(dt, 0), MAX_STEP_DT)
    if (!(travel > SUBSTEP_PX)) return 1
    return Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX))
  }

  // ---- release.ts ----
  /** 剔除保留窗口外的旧采样。 */
  function trimTrail(trail, now) {
    var cutoff = now - TRAIL_KEEP_MS
    var i = 0
    while (i < trail.length && trail[i].t < cutoff) i++
    return i === 0 ? trail : trail.slice(i)
  }
  /** 由拖拽轨迹估算松手初速 {vx,vy} px/s；返回 null = 温柔放下（不抛）。 */
  function estimateReleaseVelocity(trail, now, physics) {
    var ph = physics || DEFAULT_PHYSICS
    if (!trail || trail.length === 0) return null
    var last = trail[trail.length - 1]
    if (now - last.t > RELEASE_STALE_MS) return null
    var win = trail.filter(function (s) { return now - s.t <= RELEASE_WINDOW_MS })
    if (win.length < 2) return null
    var t0 = win[0].t, x0 = win[0].x, y0 = win[0].y
    var t1 = win[win.length - 1].t, x1 = win[win.length - 1].x, y1 = win[win.length - 1].y
    var spanMs = t1 - t0
    if (spanMs < MIN_SPAN_MS) return null
    var baseVx = ((x1 - x0) / spanMs) * 1000
    var baseVy = ((y1 - y0) / spanMs) * 1000
    var baseSpeed = Math.hypot(baseVx, baseVy)
    if (baseSpeed < 1e-6) return null
    var segSpeeds = []
    var px = x0, py = y0, pt = t0
    for (var i = 1; i < win.length; i++) {
      var s = win[i]
      var dt = s.t - pt
      if (dt >= SEG_MIN_DT_MS) {
        segSpeeds.push({ speed: (Math.hypot(s.x - px, s.y - py) / dt) * 1000, tEnd: s.t })
        px = s.x; py = s.y; pt = s.t
      }
    }
    var peakSpeed = segSpeeds.length ? Math.max.apply(null, segSpeeds.map(function (v) { return v.speed })) : baseSpeed
    var accel = 0
    if (segSpeeds.length >= 2) {
      var lastSeg = segSpeeds[segSpeeds.length - 1]
      var firstSeg = segSpeeds[0]
      accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, MIN_SPAN_MS / 1000)
    }
    var speedBeforeClamp =
      ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) *
      (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX)
    var speed = softClampSpeed(speedBeforeClamp) * (ph.throwPower == null ? 1 : ph.throwPower)
    if (speed < DEAD_ZONE_SPEED) return null
    return { vx: (baseVx / baseSpeed) * speed, vy: (baseVy / baseSpeed) * speed }
  }

  // ---- squash.ts ----
  /** 落地冲击速度 → 下压幅度（速度越大压得越狠）。 */
  function landingSquash(impactSpeed) {
    var t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1)
    return Math.min(0.8, 1 - t * (1 - SQ_MAX_SQUASH))
  }
  /** Q 弹挤压曲线：u∈[0,1] 进度 → scaleY（下压段 ease-in，回弹段 easeOutBack 约 4% 过冲）。 */
  function squashScale(u, squash) {
    var sq = squash == null ? SQ_SQUASH : squash
    if (u < 0.45) {
      var p = u / 0.45
      return 1 - (1 - sq) * p * p
    }
    var p2 = (u - 0.45) / 0.55
    var c1 = 1.70158
    var c3 = c1 + 1
    var f = 1 + c3 * Math.pow(p2 - 1, 3) + c1 * Math.pow(p2 - 1, 2)
    return Math.min(1.12, sq + (1 - sq) * Math.max(f, 0))
  }

  var api = {
    // 常量（pack 配置可参考）
    DEFAULT_PHYSICS: DEFAULT_PHYSICS,
    DEFAULT_THROW_POWER: DEFAULT_THROW_POWER,
    THROW_SPEED_ANCHOR: THROW_SPEED_ANCHOR,
    SQ_SQUASH: SQ_SQUASH,
    SQ_DURATION_MS: 220,
    // 函数
    springStep: springStep,
    softClampSpeed: softClampSpeed,
    throwBounds: throwBounds,
    throwStep: throwStep,
    throwSubsteps: throwSubsteps,
    trimTrail: trimTrail,
    estimateReleaseVelocity: estimateReleaseVelocity,
    landingSquash: landingSquash,
    squashScale: squashScale,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.PetPhysics = api
})(typeof window !== 'undefined' ? window : globalThis)
