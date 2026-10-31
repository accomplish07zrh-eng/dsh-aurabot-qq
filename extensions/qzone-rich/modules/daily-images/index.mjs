import {createArchive} from './archive.mjs'
export default {
 id:'daily-images',name:'日常图片自动归档',version:'0.1.0',api:1,tab:'diary',panel:'panel.js',
 description:'把浏览配图及已有视频截图自动存入 YYYYMMDD 日期目录，保留来源，不重复保存。',
 defaults:{enabled:false,perRun:8,folder:''},
 setup(api){
  const archive=createArchive(api),http=api.core.http
  api.route('/state',()=>archive.state())
  api.route('/collect',req=>req.method==='POST'&&req.headers?.['x-aurabot-daily-images']==='1'?archive.run({force:true}):{ok:false,message:'请从空间日记页收集图片'})
  api.route('/settings',async req=>{if(req.method!=='POST'||req.headers?.['x-aurabot-daily-images']!=='1')return {ok:false,message:'请从日记页修改设置'};const body=await http.body(req);api.saveSettings({enabled:body.enabled===true});return archive.state()})
  api.later(15000,()=>archive.run());api.every(300000,()=>archive.run(),'归档浏览日常图片')
  return archive
 },
}
