import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readyTelegramDb } from '../packages/telegram/src/db.ts';
import { addTelegramSource, extractUrls, normalizeTelegramReference, rotateAllToken, rotateSourceToken,
  toggleTelegramSource, updateTelegramSettings } from '../packages/telegram/src/core.ts';
import { allRss, sourceRss } from '../packages/telegram/src/rss.ts';
import { renderSummary, summarizeJob, SUMMARY_MAX_ATTEMPTS, TELEGRAM_SUMMARY_SCHEMA } from '../packages/telegram/src/summarize.ts';
import { cleanupTelegram, retentionCutoff } from '../packages/telegram/src/maintenance.ts';
import { effectiveMessageText } from '../packages/telegram/src/summarize.ts';
import { runOneVisionTask, TELEGRAM_VISION_SCHEMA, validateVision, visionStats } from '../packages/telegram/src/vision.ts';
import { MockProvider } from '../packages/ai/src/providers/mock.ts';
import { ProviderError } from '../packages/ai/src/types.ts';

const dir=mkdtempSync(join(tmpdir(),'brief-tg-')); const db=readyTelegramDb(join(dir,'telegram.db'));
let fail=0; const ok=(name:string,value:boolean)=>{if(!value)fail++;console.log(`  ${value?'✅':'❌'} ${name}`)};
const throws=(fn:()=>unknown)=>{try{fn();return false}catch{return true}};

console.log('Telegram 地址与 URL：\n');
ok('@username 归一化',normalizeTelegramReference('@HeZu_1').canonical==='@hezu_1');
ok('t.me/s 地址',normalizeTelegramReference('https://t.me/s/HeZu_1').canonical==='@hezu_1');
ok('私群消息链接映射稳定 chat_id',normalizeTelegramReference('t.me/c/12345/9').resolveAs===-1000000012345);
ok('邀请链接仅标记、不解析为公开用户名',normalizeTelegramReference('https://t.me/+secret').kind==='invite');
ok('拒绝查询参数',throws(()=>normalizeTelegramReference('https://t.me/hezu1?x=1')));
const urls=extractUrls('价格 11.30 和 0.85；看 Example.COM/a#part、https://EXAMPLE.com:443/a#x');
ok('排除小数价格',!urls.some(x=>x.includes('11.30')||x.includes('0.85')));
ok('规范化、片段移除并去重',urls.length===1&&urls[0]==='https://example.com/a');

console.log('\n来源状态与 token：\n');
const src=addTelegramSource(db,{reference:'t.me/hezu1',sourceType:'normal'});
ok('新增为 pending',src.status==='pending');
ok('pending 不能启用',throws(()=>toggleTelegramSource(db,src.id,true)));
db.prepare("UPDATE telegram_sources SET status='active',chat_id=-1001,enabled=1 WHERE id=?").run(src.id);
const dupe=addTelegramSource(db,{reference:'@hezu1',sourceType:'normal'});
ok('不同地址可待异步解析去重',dupe.status==='pending');
ok('普通来源 token 为 256 位',rotateSourceToken(db,src.id)?.length===64);
const urlSrc=addTelegramSource(db,{reference:'@urlchan',sourceType:'url'});
ok('URL 渠道拒绝 RSS token',throws(()=>rotateSourceToken(db,urlSrc.id)));
ok('停用不撤销 token',(()=>{const t=rotateSourceToken(db,src.id);toggleTelegramSource(db,src.id,false);return (db.prepare('SELECT rss_token FROM telegram_sources WHERE id=?').get(src.id) as any).rss_token===t})());

console.log('\n设置、RSS 与隔离：\n');
updateTelegramSettings(db,{modelMode:'legacy',timezone:'Asia/Shanghai',schedule:'22:00, 08:00,12:00',provider:'mock',model:'m',credentialRef:'OPENAI_COMPAT_API_KEY',promptRules:'关注发布'});
const settings=db.prepare('SELECT * FROM telegram_settings').get() as any;
ok('时段排序去重',settings.schedule_json==='["08:00","12:00","22:00"]');
ok('主要观点 Schema 最多允许一个段落',(TELEGRAM_SUMMARY_SCHEMA.properties.viewpoints as any).maxItems===1);
ok('图片识别 Schema 拒绝额外字段',(TELEGRAM_VISION_SCHEMA as any).additionalProperties===false&&throws(()=>validateVision({description:'x',key_text:'',uncertainty:'',extra:1})));
ok('图片派生文本与原正文分离拼接',effectiveMessageText({text:'原 caption',description:'画面',key_text:'金额',vision_uncertainty:''})==='原 caption\n\n[图片描述]\n画面\n\n[图片关键文字]\n金额');
const token=rotateSourceToken(db,src.id)!; const allToken=rotateAllToken(db)!;
db.prepare("UPDATE telegram_sources SET status='active',enabled=1 WHERE id=?").run(src.id);
const now=new Date(), start=new Date(now.getTime()-3600000).toISOString(), end=now.toISOString();
const job=db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at) VALUES(?,?,?,'h','mock','m',1,'completed',?,?)`).run(src.id,start,end,end,end);
const html=renderSummary({topics:['<主题>'],important:['讨论中，有人提出A&B（消息 11194397, 11194405）。'],viewpoints:['有人提出套餐价格偏高。','讨论中有人认为按量计费更灵活。','群友表示年付适合长期使用（消息 ID：11194397）'],sources:[{messageId:7,time:start}],uncertainty:['消息中提到仍需核实。']});
db.prepare(`INSERT INTO telegram_summaries(job_id,source_id,window_start,window_end,title,summary_json,rendered_html,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(job.lastInsertRowid,src.id,start,end,'x < y','{}',html,end,new Date(now.getTime()+86400000).toISOString());
ok('RSS XML 转义',sourceRss(db,token,'https://brief.test')!.includes('&amp;lt;主题&amp;gt;'));
ok('新总结不渲染消息来源结构',!html.includes('消息来源')&&!html.includes(`#7 · ${start}`));
ok('新总结正文清理内嵌消息编号',html.includes('A&amp;B。')&&!html.includes('11194397')&&!html.includes('11194405'));
ok('展示字段移除句首和句中引导语',html.includes('<h2>主要观点</h2><p>套餐价格偏高。 讨论中按量计费更灵活。 年付适合长期使用</p>')&&!html.includes('有人')&&!html.includes('群友')&&!html.includes('消息中提到'));
db.prepare('UPDATE telegram_summaries SET rendered_html=? WHERE job_id=?').run(`<h2>主题</h2><ul><li>测试</li></ul><h2>重要信息</h2><ul><li>有人提出价格变化。</li></ul><h2>主要观点</h2><ul><li>有人提出套餐价格偏高。</li><li>有人认为按量计费更灵活。</li></ul><h2>不确定信息</h2><ul><li>消息中提到仍需核实。</li></ul><h2>消息来源</h2><ul><li>#7 · ${start}</li></ul><p>历史文本（消息 11194397、11194405）。</p>`,job.lastInsertRowid);
const historicalFeed=sourceRss(db,token,'https://brief.test')!;
ok('RSS 隐藏历史总结的消息来源结构',!historicalFeed.includes('消息来源')&&!historicalFeed.includes(`#7 · ${start}`));
ok('RSS 清理历史总结内嵌消息编号',historicalFeed.includes('历史文本。')&&!historicalFeed.includes('11194397')&&!historicalFeed.includes('11194405'));
ok('RSS 将历史观点列表合并为一个段落',historicalFeed.includes('&lt;h2&gt;主要观点&lt;/h2&gt;&lt;p&gt;套餐价格偏高。 按量计费更灵活。&lt;/p&gt;')&&!historicalFeed.includes('有人'));
ok('RSS 清理所有历史展示字段的引导语',!historicalFeed.includes('消息中提到')&&!historicalFeed.includes('群友'));
const dateParts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'}).formatToParts(new Date(end)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
const mmdd=`${dateParts.month}-${dateParts.day}`;
db.prepare('UPDATE telegram_sources SET title=? WHERE id=?').run('[合租社群]Netflix|YouTube|Spotify|office365|Hbo|Surge|美剧|等音乐影视聊天机场电影盒子软路由',src.id);
ok('指定群组 RSS 标题精简且不含年份',sourceRss(db,token,'https://brief.test')!.includes(`<title>合租社群 ${mmdd}</title>`));
db.prepare('UPDATE telegram_sources SET title=? WHERE id=?').run('其他群组',src.id);
ok('其他群组 RSS 标题为名称加月日',sourceRss(db,token,'https://brief.test')!.includes(`<title>其他群组 ${mmdd}</title>`));
ok('汇总 feed 包含启用普通来源',allRss(db,allToken,'https://brief.test')!.includes('telegram:'));
db.prepare("UPDATE telegram_sources SET enabled=1,status='active',chat_id=-1002 WHERE id=?").run(urlSrc.id);
ok('汇总 feed 不包含 URL 渠道',!allRss(db,allToken,'https://brief.test')!.includes(`telegram:${urlSrc.id}:`));
const old=token;rotateSourceToken(db,src.id);ok('重置立即撤销旧 token',sourceRss(db,old,'')===null);
ok('数据表不为 URL 渠道提供正文列',!db.prepare("PRAGMA table_info(telegram_urls)").all().some((x:any)=>['text','sender_id','message_id'].includes(x.name)));

console.log('\n总结幂等、故障隔离与保留：\n');
ok('6 个自然日从业务日零点计算',retentionCutoff(new Date('2026-09-07T10:00:00Z'),'Asia/Shanghai',6).toISOString()==='2026-09-01T16:00:00.000Z');
const start2=new Date(now.getTime()+1000).toISOString(),end2=new Date(now.getTime()+3601000).toISOString();
db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src.id,-1001,7,start2,'仅供测试的消息','h',start2);
const j2=db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at) VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src.id,start2,end2,start2,start2);
ok('单窗口结构化总结成功',await summarizeJob(db,Number(j2.lastInsertRowid),{provider:'mock',model:'m',promptRules:'',promptVersion:1,summaryRetentionDays:30},new MockProvider({provider:'mock',model:'m'})));
ok('完成任务不可被规则变化重写',!(await summarizeJob(db,Number(j2.lastInsertRowid),{provider:'mock',model:'m',promptRules:'变化',promptVersion:2,summaryRetentionDays:30},new MockProvider({provider:'mock',model:'m'}))));

console.log('\n图片识别队列：\n');
const mediaDir=join(dir,'telegram-media');
const imagePath=join(mediaDir,'opaque-test-file');
await import('node:fs').then(fs=>fs.mkdirSync(mediaDir,{recursive:true,mode:0o700}));
writeFileSync(imagePath,Buffer.from([1,2,3]),{mode:0o600});
db.prepare(`INSERT INTO telegram_media_tasks(source_id,chat_id,message_id,media_fingerprint,mime_type,original_caption,
  telegram_size_bytes,temp_path,temp_state,actual_size_bytes,status,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(src.id,-1001,7,'fp-vision','image/png','原 caption',3,imagePath,'ready',3,'pending',start2,start2);
const visionProvider=new MockProvider({provider:'mock',model:'gemini-3.8-flash-high'});
ok('视觉 worker 完成单张识别',await runOneVisionTask(db,{provider:visionProvider,mediaDir})==='done');
const visionRow=db.prepare(`SELECT status,temp_path,temp_state,description,requested_model,response_model,response_id,input_tokens,output_tokens
  FROM telegram_media_tasks WHERE media_fingerprint='fp-vision'`).get() as any;
ok('成功后删除临时图片且保留审计字段',visionRow.status==='completed'&&!existsSync(imagePath)&&visionRow.temp_path===null&&visionRow.temp_state==='deleted'&&visionRow.description&&visionRow.response_id&&visionRow.input_tokens>0);
ok('视觉监控统计今日调用',visionStats(db).today===1);
const makeMedia=(messageId:number,fingerprint:string,path:string)=>{
  const at=new Date(Date.now()+messageId*1000).toISOString();
  db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at)
    VALUES(?,?,?,?,?,?,?)`).run(src.id,-1001,messageId,at,'',fingerprint,at);
  writeFileSync(path,Buffer.from([1,2,3]),{mode:0o600});
  db.prepare(`INSERT INTO telegram_media_tasks(source_id,chat_id,message_id,media_fingerprint,mime_type,original_caption,
    temp_path,temp_state,actual_size_bytes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(src.id,-1001,messageId,fingerprint,'image/png','',path,'ready',3,'pending',at,at);
};
const deferredPath=join(mediaDir,'deferred');makeMedia(70,'fp-deferred',deferredPath);
db.prepare('UPDATE telegram_settings SET vision_daily_limit=1').run();
ok('每日 300 配额机制只顺延新任务、不删除图片',await runOneVisionTask(db,{provider:visionProvider,mediaDir})==='deferred'&&existsSync(deferredPath));
db.prepare("UPDATE telegram_settings SET vision_daily_limit=300").run();
ok('顺延任务可在配额恢复后完成',await runOneVisionTask(db,{provider:visionProvider,mediaDir})==='done'&&!existsSync(deferredPath));
const authPath=join(mediaDir,'auth');makeMedia(71,'fp-auth',authPath);
const authProvider={name:'mock',model:'m',strictness:'strict',complete:async()=>{throw new ProviderError('auth','bad key',401)}} as any;
ok('401/403 暂停整个队列并保留待恢复任务',await runOneVisionTask(db,{provider:authProvider,mediaDir})==='failed'&&
  (db.prepare('SELECT vision_paused FROM telegram_settings').get() as any).vision_paused===1&&existsSync(authPath));
db.prepare("UPDATE telegram_settings SET vision_paused=0,vision_pause_reason=NULL").run();
ok('修复鉴权后原任务可继续',await runOneVisionTask(db,{provider:visionProvider,mediaDir})==='done'&&!existsSync(authPath));
const ratePath=join(mediaDir,'rate');makeMedia(72,'fp-rate',ratePath);
const rateProvider={name:'mock',model:'m',strictness:'strict',complete:async()=>{throw new ProviderError('rate_limited','slow',429)}} as any;
ok('429 按退避重试且不提前删除临时图',await runOneVisionTask(db,{provider:rateProvider,mediaDir})==='failed'&&
  (db.prepare("SELECT status,attempts,next_attempt_at FROM telegram_media_tasks WHERE media_fingerprint='fp-rate'").get() as any).status==='retry'&&existsSync(ratePath));
const imageWindowStart=new Date(now.getTime()-4*3600_000).toISOString();
const imageWindowEnd=new Date(now.getTime()-3*3600_000).toISOString();
const imageSent=new Date(now.getTime()-3.5*3600_000).toISOString();
db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at)
  VALUES(?,?,?,?,?,?,?)`).run(src.id,-1001,80,imageSent,'图片 caption','img-summary',imageSent);
db.prepare(`INSERT INTO telegram_media_tasks(source_id,chat_id,message_id,media_fingerprint,mime_type,original_caption,temp_state,status,
  description,key_text,uncertainty,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,'deleted','completed',?,?,?,?,?,?)`)
  .run(src.id,-1001,80,'fp-summary','image/png','图片 caption','账单截图','应付 88 元','金额边缘模糊',imageSent,imageSent,imageSent);
const imageJob=db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
  VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src.id,imageWindowStart,imageWindowEnd,imageSent,imageSent);
let capturedPrompt='';
const captureProvider={name:'mock',model:'m',strictness:'strict',complete:async(req:any)=>{
  capturedPrompt=req.userContent;return {data:{topics:['图'],important:[],viewpoints:[],sources:[{messageId:80,time:imageSent}],uncertainty:[]},
    usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0,cacheWriteTokens:0},responseId:'capture',model:'m'};
}} as any;
ok('图片描述和关键文字进入总结并保留真实消息 ID',await summarizeJob(db,Number(imageJob.lastInsertRowid),
  {provider:'mock',model:'m',promptRules:'',promptVersion:1,summaryRetentionDays:30},captureProvider)&&
  capturedPrompt.includes('[图片描述]\n账单截图')&&capturedPrompt.includes('[图片关键文字]\n应付 88 元')&&capturedPrompt.includes('id="80"'));

const waitStart=new Date(now.getTime()-30*60_000).toISOString();
const waitEnd=new Date(now.getTime()-60_000).toISOString();
const waitSent=new Date(now.getTime()-20*60_000).toISOString();
db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at)
  VALUES(?,?,?,?,?,?,?)`).run(src.id,-1001,81,waitSent,'窗口内其他文字','wait-text',waitSent);
db.prepare(`INSERT INTO telegram_media_tasks(source_id,chat_id,message_id,media_fingerprint,mime_type,original_caption,temp_state,status,
  created_at,updated_at) VALUES(?,?,?,?,?,?,'ready','pending',?,?)`)
  .run(src.id,-1001,81,'fp-wait','image/png','窗口内其他文字',waitSent,waitSent);
const waitJob=db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
  VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src.id,waitStart,waitEnd,waitEnd,waitEnd);
ok('窗口关闭后有图片任务时暂缓且不改变任务状态',!(await summarizeJob(db,Number(waitJob.lastInsertRowid),
  {provider:'mock',model:'m',promptRules:'',promptVersion:1,summaryRetentionDays:30},visionProvider))&&
  (db.prepare('SELECT status FROM telegram_summary_jobs WHERE id=?').get(waitJob.lastInsertRowid) as any).status==='pending');
db.prepare('UPDATE telegram_summary_jobs SET window_end=? WHERE id=?').run(new Date(now.getTime()-11*60_000).toISOString(),waitJob.lastInsertRowid);
ok('等待满 10 分钟后失败图片不阻塞整份总结',await summarizeJob(db,Number(waitJob.lastInsertRowid),
  {provider:'mock',model:'m',promptRules:'',promptVersion:1,summaryRetentionDays:30},visionProvider));
const failedStart=new Date(now.getTime()+7201000).toISOString(),failedEnd=new Date(now.getTime()+10801000).toISOString();
const jf=db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at) VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src.id,failedStart,failedEnd,start2,start2);
db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src.id,-1001,8,failedStart,'失败隔离测试','h2',failedStart);
const bad={name:'mock',model:'m',strictness:'strict',complete:async()=>{throw new Error('isolated')}} as any;
ok('单群失败返回且不抛出阻塞其他群组',!(await summarizeJob(db,Number(jf.lastInsertRowid),{provider:'mock',model:'m',promptRules:'',promptVersion:1,summaryRetentionDays:30},bad)));
ok('失败任务保留有限重试',(db.prepare('SELECT status,next_attempt_at FROM telegram_summary_jobs WHERE id=?').get(jf.lastInsertRowid) as any).status==='failed');
{
  const row=()=>db.prepare('SELECT status,attempts,next_attempt_at FROM telegram_summary_jobs WHERE id=?').get(jf.lastInsertRowid) as any;
  const delays:number[]=[];
  for(let i=row().attempts;i<SUMMARY_MAX_ATTEMPTS;i++){
    const before=Date.now(); await summarizeJob(db,Number(jf.lastInsertRowid),{provider:'mock',model:'m',promptRules:'',promptVersion:1,summaryRetentionDays:30},bad);
    const r=row(); if(r.next_attempt_at) delays.push(Math.round((Date.parse(r.next_attempt_at)-before)/60000));
  }
  ok('失败重试按 5/10/20/40/80 分钟退避，覆盖约 2.5 小时的中转故障',JSON.stringify(delays)==='[10,20,40,80]'&&row().attempts===SUMMARY_MAX_ATTEMPTS);
  ok('重试用完后不再排队',row().status==='failed'&&row().next_attempt_at===null);
}
{
  // 重复消息折叠 + 内容被模型过滤时不退避重试
  const fs0=new Date(now.getTime()+14401000).toISOString(),fe0=new Date(now.getTime()+18001000).toISOString();
  const jd=db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at) VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src.id,fs0,fe0,start2,start2);
  for(let i=0;i<6;i++) db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src.id,-1001,9100+i,new Date(Date.parse(fs0)+i*1000).toISOString(),i%2?'  重复广告  ':'重复广告','dup'+i,fs0);
  db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src.id,-1001,9200,new Date(Date.parse(fs0)+9000).toISOString(),'唯一消息','uniq',fs0);
  let prompt='';
  const filteredProvider={name:'mock',model:'m',strictness:'strict',complete:async(r:any)=>{prompt=r.userContent;const e=new ProviderError('bad_request','内容被模型过滤（响应无 choices，补全 0 token）');e.contentFiltered=true;throw e}} as any;
  await summarizeJob(db,Number(jd.lastInsertRowid),{provider:'mock',model:'m',promptRules:'',promptVersion:1,summaryRetentionDays:30},filteredProvider);
  const r=db.prepare('SELECT status,attempts,next_attempt_at,error FROM telegram_summary_jobs WHERE id=?').get(jd.lastInsertRowid) as any;
  ok('总结提示词里重复消息折叠为一条并标 ×6',(prompt.match(/<message /g)??[]).length===2&&prompt.includes('重复广告\n（×6）'));
  ok('内容被过滤：第 1 次即结束，不排重试',r.status==='failed'&&r.attempts===1&&r.next_attempt_at===null&&r.error.startsWith('内容被模型过滤'));
}
{
  // 长文本重复 ≥5 次视为垃圾刷屏，不送模型；短文本高频重复只折叠
  const fs1=new Date(now.getTime()+21601000).toISOString(),fe1=new Date(now.getTime()+25201000).toISOString();
  const js=db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at) VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src.id,fs1,fe1,start2,start2);
  const ins=db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`);
  const spamText='点击链接领取限时福利资源，立即免费观看，名额有限先到先得，不要错过！';
  for(let i=0;i<6;i++) ins.run(src.id,-1001,9300+i,new Date(Date.parse(fs1)+i*1000).toISOString(),spamText,'sp'+i,fs1);
  for(let i=0;i<6;i++) ins.run(src.id,-1001,9310+i,new Date(Date.parse(fs1)+10000+i*1000).toISOString(),'哈哈','sh'+i,fs1);
  ins.run(src.id,-1001,9320,new Date(Date.parse(fs1)+20000).toISOString(),'正常消息内容','nm',fs1);
  let prompt='';
  const capture={name:'mock',model:'m',strictness:'strict',complete:async(r:any)=>{prompt=r.userContent;throw new Error('stop')}} as any;
  const logs:string[]=[];const origLog=console.log;console.log=(...a:any[])=>{logs.push(a.join(' '))};
  try{await summarizeJob(db,Number(js.lastInsertRowid),{provider:'mock',model:'m',promptRules:'',promptVersion:1,summaryRetentionDays:30},capture)}finally{console.log=origLog}
  ok('总结提示词不含被丢弃的垃圾重复消息',!prompt.includes('福利资源'));
  ok('高频短消息只折叠保留（×6）',prompt.includes('哈哈\n（×6）')&&prompt.includes('正常消息内容')&&(prompt.match(/<message /g)??[]).length===2);
  ok('丢弃垃圾消息写日志，只含条数/长度/哈希，不含原文',logs.some(l=>l.includes('丢弃重复垃圾消息')&&l.includes('6 条'))&&!logs.join('').includes('福利资源'));
}
db.prepare(`INSERT INTO telegram_urls(normalized_url,first_source_id,last_source_id,first_discovered_at,last_discovered_at,expires_at) VALUES('https://expired.test/',?,?,?,?,?)`).run(urlSrc.id,urlSrc.id,start,start,new Date(now.getTime()-1).toISOString());
const oldMessageAt=new Date(now.getTime()-20*86400000).toISOString();
db.prepare('UPDATE telegram_sources SET retain_all_history=1 WHERE id=?').run(src.id);
db.prepare("UPDATE telegram_sources SET status='active',enabled=1,chat_id=-1003 WHERE id=?").run(dupe.id);
db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src.id,-1001,9001,oldMessageAt,'永久保留测试','retain',oldMessageAt);
db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(dupe.id,-1003,9002,oldMessageAt,'普通清理测试','expire',oldMessageAt);
const cleaned=cleanupTelegram(db,new Date(now.getTime()+86400000));
ok('URL 按最后发现后的过期时间清理',cleaned.urls===1);
ok('全历史频道不受原始消息保留期清理',Boolean(db.prepare('SELECT 1 FROM telegram_messages WHERE source_id=? AND message_id=9001').get(src.id)));
ok('普通频道仍按原始消息保留期清理',!db.prepare('SELECT 1 FROM telegram_messages WHERE source_id=? AND message_id=9002').get(dupe.id));
db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(dupe.id,-1003,9003,oldMessageAt,'全局永久保留测试','keep-all',oldMessageAt);
db.prepare('UPDATE telegram_settings SET keep_messages_forever=1 WHERE singleton=1').run();
const kept=cleanupTelegram(db,new Date(now.getTime()+2*86400000));
ok('全局永久保留配置禁止删除任何原始消息',kept.messages===0&&Boolean(db.prepare('SELECT 1 FROM telegram_messages WHERE source_id=? AND message_id=9003').get(dupe.id)));
ok('integrity_check=ok',db.pragma('integrity_check',{simple:true})==='ok');
db.close();rmSync(dir,{recursive:true,force:true});
console.log(fail?`\n❌ ${fail} 项失败`:'\n✅ 全部通过');process.exit(fail?1:0);
