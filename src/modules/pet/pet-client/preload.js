// Aurabot 桌宠预加载脚本（模板/生成物）：给渲染页开一个极小的受控桥。
// 只暴露拖拽/抛掷需要的四样东西，不给 Node 能力（contextIsolation 保持开着）。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  /** 把窗口挪到绝对位置（拖拽时按指针位移换算出的左上角）。 */
  moveTo: (x, y) => ipcRenderer.send('pet:move', { x, y }),
  /** 甩抛：主进程接管物理循环，落定后回调 __onThrowEnd。 */
  throwWith: (vx, vy) => ipcRenderer.send('pet:throw', { vx, vy }),
  /** 当前工作区与窗口几何：{W,H,x,y,size}（renderer 算拖拽边界/初速参考系用）。 */
  screenInfo: () => ipcRenderer.invoke('pet:screen'),
  /** 停住主进程的抛掷循环（例如用户在飞行中又按住）。 */
  stopThrow: () => ipcRenderer.send('pet:throw-stop'),
  /** 命中检测上报：true=悬停在宠物/气泡上（窗口恢复交互），false=在透明区（点击穿透）。 */
  setHit: (hit) => ipcRenderer.send('pet:hit', Boolean(hit)),
  /** 右键菜单：渲染页 contextmenu → 主进程弹原生菜单（仿 dsh-pet 的右键菜单）。 */
  showMenu: () => ipcRenderer.send('pet:menu'),
  /** 主动连上插件问一次配置/状态（菜单项「换个动作」等需要确认在线时用，可选）。 */
  ping: () => ipcRenderer.send('pet:ping'),
})
