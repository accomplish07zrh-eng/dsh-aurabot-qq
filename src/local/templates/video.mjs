// 本地接口 · 生视频：用你电脑上的视频生成服务（ComfyUI 等）做视频。
// 约定见同目录的「README-本地接口.md」。改完保存就生效，不用重启 DSH；面板「本地接口」页打开开关才会用。
//
// 输入：{ prompt, seconds, outDir, log }
//   prompt  视频内容描述
//   seconds 想要的时长（秒），可能没有
//   outDir  输出文件夹，把生成的视频放这里
// 输出：视频文件的完整路径，或 { file: 路径 }
// 出错就 throw，插件会在聊天里告诉对方没做成。
//
// 生视频很慢，插件默认等 20 分钟（面板「本地接口」页可以改），10 秒左右的视频建议调到 30 分钟。
// 接 ComfyUI 时注意：加速 LoRA 要和底模配对，pruned 底模配未裁剪的 LoRA 会被全部跳过，又慢又刷报错；
// 视频底模很吃显存，别和生图同时跑。

export default async function video({ prompt, seconds, outDir, log }) {
  // ↓↓↓ 把这里换成调用你的服务，比如向 ComfyUI 的 /prompt 提交工作流，轮询 /history，再把视频存到 outDir
  log.info(`要生成视频：${prompt.slice(0, 30)}（${seconds || '默认'} 秒）`)
  throw new Error('video.mjs 还没写：照文件开头的说明接上你的视频服务')
}
