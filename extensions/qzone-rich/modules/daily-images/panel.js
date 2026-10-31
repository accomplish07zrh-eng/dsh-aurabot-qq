const {useState,useEffect}=React
return function Panel({toast}){
 const [state,setState]=useState(null),[busy,setBusy]=useState(false)
 const load=()=>call('/state').then(setState).catch(()=>{})
 useEffect(()=>{load();const t=setInterval(load,5000);return()=>clearInterval(t)},[])
 const post=async(path,body={})=>{setBusy(true);try{const r=await fetch('/aurabot/api/ext/daily-images'+path,{method:'POST',headers:{'content-type':'application/json','x-aurabot-daily-images':'1'},body:JSON.stringify(body)}).then(r=>r.json());toast(r.message||(r.ok?'已保存':'未完成'));await load()}catch(e){toast(e.message)}finally{setBusy(false)}}
 return h(ui.Card,{title:'日常图片自动收集',desc:'每五分钟保存新浏览的配图和已有 B站视频截图，按浏览日期存入 20261029 这样的文件夹。'},
 h(ui.Row,{label:'自动保存浏览画面'},h(ui.Switch,{on:!!state?.enabled,disabled:busy,onChange:enabled=>post('/settings',{enabled})})),
 h('p',{className:'ab-small ab-muted',style:{overflowWrap:'anywhere'}},'保存位置：'+(state?.folder||'请先设置上面的日常图片文件夹')),
 h('p',{className:'ab-small ab-muted'},`已归档 ${state?.count||0} 张图片${state?.lastAt?' · 最近收集 '+new Date(state.lastAt).toLocaleString():''}`),
 state?.lastError?h('p',{className:'ab-note warn'},state.lastError):null,
 h(ui.Btn,{disabled:busy||state?.busy,onClick:()=>post('/collect')},busy||state?.busy?'正在收集…':'现在收集浏览图'),
 h('p',{className:'ab-small ab-muted'},'只保存真实取得的公开浏览图和已有视频截图，不截取桌面或私人聊天。每张图附来源说明文件，供日记保留署名和链接。关闭本扩展会停止自动收集，已保存图片保留。'))
}
