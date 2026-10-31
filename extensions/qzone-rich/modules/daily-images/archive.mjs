import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,statSync,lstatSync} from 'node:fs'
import {join,resolve,relative,sep,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createAssets} from './assets.mjs'
const clip=(v,n=200)=>String(v||'').replace(/[\r\n\t]+/g,' ').trim().slice(0,n)
const imageFolder=value=>{if(!isAbsolute(value))throw Error('请填写完整的图库路径');const root=resolve(value);if(!statSync(root).isDirectory())throw Error('日常图片目录无效');return root}
export const dateKey=at=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at)).replaceAll('-','')
export function createArchive(api,injected={}){
 const file=api.dataDir('archive.json'),assets=injected.assets||createAssets(api),now=injected.now||Date.now
 let state={items:[],retry:{},lastAt:0,lastError:''},busy=false,disposed=false
 try{state={...state,...JSON.parse(readFileSync(file,'utf8'))}}catch(e){if(e.code!=='ENOENT')throw Error('日常图归档记录损坏，原文件已保留')}
 const save=()=>{const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(state,null,2),'utf8');renameSync(tmp,file)}
 const folder=()=>String(api.settings().folder||api.config().ext?.['diary-rich']?.folder||'').trim()
 function candidates(){
  const list=[...(api.use('diary-rich')?.browsingSources?.()||[])]
  const bili=api.use('bili');let shots=[];try{shots=bili?.libraryShots?.()?.items||[]}catch{}
  for(const shot of shots.slice(0,40)){
   const at=Number(shot.at)||0;if(at>now()||at<now()-48*3600000)continue
   const src=bili.shotFileOf?.(shot.file);if(!src)continue
   list.push({id:'bili-shot:'+shot.file,kind:'browsing',src,caption:'B站视频画面摘记《'+clip(shot.title,70)+'》',title:clip(shot.title,100),platform:'B站',url:/^BV[a-z0-9]+$/i.test(shot.bvid||'')?'https://www.bilibili.com/video/'+shot.bvid:'',at})
  }
  return list.filter(p=>p.at<=now()&&p.at>=now()-48*3600000)
 }
 async function run({force=false}={}){
  if(disposed||busy)return {ok:false,message:'正在收集日常图片'}
  if(!folder())return {ok:false,message:'请先在日记配图里设置日常图片文件夹'}
  if(!force&&(!api.settings().enabled||!api.config().enabled||api.config().dryRun))return {ok:false,message:'自动收集当前未开启'}
  busy=true;let added=0,skipped=0,failed=0
  try{
   const root=imageFolder(folder()),pool=candidates()
   let attempted=0
   for(const p of pool){
    if(disposed)break
    if(state.items.some(x=>x.root===root&&x.sourceId===p.id&&existsSync(x.path))){skipped++;continue}
    const retryKey=root+'|'+p.id;if(!force&&(state.retry[retryKey]||0)>now()){skipped++;continue}
    if(attempted++>=Math.max(1,Math.min(20,Number(api.settings().perRun)||8)))break
    try{
     const image=await assets.materialize(p);if(disposed)break
     const bytes=assets.read(image.id),hash=createHash('sha256').update(bytes).digest('hex')
     const duplicate=state.items.find(x=>x.root===root&&x.hash===hash&&existsSync(x.path))
     if(duplicate){state.items.unshift({...duplicate,sourceId:p.id});skipped++;continue}
     const day=dateKey(p.at||now()),dir=join(root,day);mkdirSync(dir,{recursive:true})
     if(lstatSync(dir).isSymbolicLink())throw Error('日期目录不能是链接')
     const ext=image.id.split('.').pop(),name=`浏览图_${hash.slice(0,20)}.${ext}`,target=resolve(dir,name)
     if(relative(root,target).startsWith('..'+sep))throw Error('目标超出图库')
     const meta={schema:1,kind:'browsing',sourceId:p.id,title:clip(p.title,120),platform:clip(p.platform,30),author:clip(p.author,60),url:p.url||'',caption:p.caption,at:p.at,collectedAt:now(),hash}
     // Sidecar first: a discovered image always has its source attribution.
     writeFileSync(target+'.json',JSON.stringify(meta,null,2),'utf8');if(!existsSync(target))writeFileSync(target,bytes,{flag:'wx'})
     state.items.unshift({root,path:target,hash,sourceId:p.id,day,at:now()});delete state.retry[retryKey];added++
    }catch(e){failed++;state.lastError=clip(e.message,160);state.retry[retryKey]=now()+30*60000}
   }
   if(!disposed){state.items=state.items.slice(0,3000);state.retry=Object.fromEntries(Object.entries(state.retry).filter(([,t])=>t>now()));state.lastAt=now();if(!failed&&!Object.keys(state.retry).length)state.lastError='';save();api.use('diary-rich')?.invalidate?.()}
   return {ok:true,added,skipped,failed,message:`已保存 ${added} 张浏览图，跳过 ${skipped} 张，${failed} 张未取得。按浏览日期归档。`}
  }catch(e){if(!disposed){state.lastError=clip(e.message);save()}return {ok:false,message:clip(e.message)}}finally{busy=false}
 }
 api.onDispose(()=>{disposed=true})
 return {run,state:()=>({ok:true,busy,folder:folder(),enabled:api.settings().enabled!==false,lastAt:state.lastAt,lastError:state.lastError,count:state.items.filter(x=>x.root===folder()&&existsSync(x.path)).map(x=>x.path).filter((x,i,a)=>a.indexOf(x)===i).length,recent:state.items.slice(0,8).map(x=>({day:x.day,file:x.path,at:x.at}))})}
}
