import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.mjs';
import { resolveWorkspace, ensureBusinessDirs } from '../src/projects.mjs';
import { loadWorkbenchEnv } from '../src/env.mjs';
import { aiRuntimeConfig, aiEnabled } from '../src/ai.mjs';
import { integrationFromConfig } from '../src/task-sync-domain.mjs';
import { createGetnoteReader } from '../src/getnote-runtime.mjs';
import {getnoteCliEnv,larkCliEnv} from '../src/external-cli-env.mjs';
import { localCalendarPath } from '../src/local-calendar.mjs';
import { createJoycrewClient } from '../src/joycrew-client.mjs';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from '../src/product.mjs';

const execFileAsync=promisify(execFile);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await loadWorkbenchEnv({root});
const dataDir=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(root,'data');
const results=[];
const check=(name,ok,detail)=>results.push({name,ok,detail});

const nodeMajor=Number(process.versions.node.split('.')[0]);
check('Node.js >= 24',nodeMajor>=24,`${process.versions.node}${nodeMajor<24?'；v2 统一 Harness 运行时要求 Node 24+':''}`);
try{await execFileAsync('git',['--version'],{timeout:2000});check('Git 可用',true,'已找到 git');}
catch{check('Git 可用',false,'未找到 git；项目 Git 信息将不可用');}

let store=null;
let config=null;
let workspace=null;
try{
  store=new JsonStore(dataDir);
  await store.ensure();
  config=await store.readConfig();
  workspace=resolveWorkspace(root,config);
  await ensureBusinessDirs(root,config);
  const probe=path.join(workspace,`.workbench-write-test-${process.pid}-${randomUUID()}`);
  let probeHandle;
  let probeCreated=false;
  try{
    probeHandle=await fsp.open(probe,'wx');
    probeCreated=true;
    await probeHandle.writeFile('ok','utf8');
  }finally{
    try{await probeHandle?.close();}
    finally{if(probeCreated)await fsp.unlink(probe);}
  }
  check('数据目录可写',true,dataDir);
  check('工作区可写',true,workspace);
  check('业务板块配置',config.businesses.length>0,`${config.businesses.length} 个板块`);
}catch(error){check('文件系统',false,error.message);}

let externalIntegration=null;
let getnoteRuntimeRequired=false;
let feishuJournalRequired=false;
try{
  externalIntegration=config?integrationFromConfig(config):null;
  if(externalIntegration?.enabled){
    getnoteRuntimeRequired=true;
    feishuJournalRequired=Boolean(externalIntegration.journalDocumentUrl);
    check('得到大脑待办管线',true,`最近 ${externalIntegration.noteLimit} 篇 + 未完成旧笔记追踪 · 时区 ${externalIntegration.timeZone} · 飞书${feishuJournalRequired?'已配置':'未配置（可选）'} · ${externalIntegration.calendarEnabled?'ICS 开启':'ICS 关闭'}`);

    try{
      const reader=createGetnoteReader({env:process.env});
      const runtime=reader.status();
      if(runtime.mode==='local_cli'){
        const result=await execFileAsync('getnote',['doctor','-o','json'],{
          timeout:15_000,windowsHide:true,maxBuffer:2*1024*1024,env:getnoteCliEnv(process.env)
        });
        const raw=String(result.stdout||'').trim();
        if(raw){
          const payload=JSON.parse(raw);
          if(payload?.success===false)throw new Error(payload.message||payload.reason||'getnote doctor 返回失败');
        }
        check('GetNote 读取运行时',true,'local_cli：安装、会员、登录和 API 连通性检查通过；未执行写入');
      }else{
        await reader.listNotes({limit:1});
        check('GetNote 读取运行时',true,`private_http：${runtime.origin} 只读连通性与鉴权检查通过`);
      }
    }catch(error){
      const mode=String(process.env.GETNOTE_RUNTIME_MODE||'local_cli').trim()||'local_cli';
      const detail=mode==='private_http'
        ?`private_http 不可用：${error?.message||'请检查 sidecar、service token 和私网地址'}`
        :(error?.code==='ENOENT'||error?.code==='GETNOTE_CLI_MISSING'?'local_cli 未找到 getnote；请在宿主机安装并授权，或改用 private_http Runtime':'local_cli getnote doctor 未通过，请检查安装、会员、登录状态和网络');
      check('GetNote 读取运行时',false,detail);
    }

    if(feishuJournalRequired){
      try{
        await execFileAsync('lark-cli',['--version'],{timeout:3000,windowsHide:true,env:larkCliEnv(process.env)});
        check('飞书每日工作日记',true,'已配置目标且找到 lark-cli；未执行真实文档写入');
      }catch(error){check('飞书每日工作日记',false,error.code==='ENOENT'?'已配置飞书 sink，但未找到 lark-cli 可执行文件':'已配置飞书 sink，但 lark-cli 不可用');}
    }else{
      check('飞书每日工作日记',true,'未配置；核心 GetNote → Workbench 同步不依赖 lark-cli');
    }
    if(store&&externalIntegration.calendarEnabled)check('本机日历路径',true,localCalendarPath(store));
  }else{
    const detail=externalIntegration?.lastSyncStatus==='needs_reconfiguration'
      ?'此前误配置为滴答清单，已停用；请在设置中重新确认得到大脑来源'
      :'未启用；不会调用 GetNote Runtime、飞书 sink 或生成 ICS';
    check('得到大脑待办管线',true,detail);
  }
}catch(error){check('得到大脑待办管线',false,error.message);}

const joycrewClient=createJoycrewClient({env:process.env});
const joycrewConfig=joycrewClient.config();
if(!joycrewConfig.enabled){
  check('Joycrew 业务执行',true,'未启用；个人今日、收件箱、项目文件和飞书记录仍可独立运行');
}else if(!joycrewConfig.ok){
  check('Joycrew 业务执行',false,`配置无效：${joycrewConfig.reason}`);
}else{
  const probe=await joycrewClient.probe();
  check('Joycrew 业务执行',probe.available,probe.available
    ?`${probe.health?.persistence||'unknown'} 持久化 · ${probe.health?.authMode||joycrewConfig.authMode} 身份 · ${probe.health?.runtime||'runtime unknown'}`
    :`${probe.error||'不可访问'}${probe.errorCode?` · ${probe.errorCode}`:''}`);
}

const aiConfig=aiRuntimeConfig();
check('AI 判断配置',aiEnabled(),aiEnabled()?`已配置：${aiConfig.model} / 极高（${aiConfig.reasoningEffort}）；未联网验证 · Provider ${aiConfig.provider} / ${aiConfig.profileId}`:`未配置可用 AI Provider；${aiConfig.model||'模型未配置'} / 极高（${aiConfig.reasoningEffort}）未启用，将使用本地规则`);
check('访问密码',!!process.env.WORKBENCH_PASSWORD,process.env.WORKBENCH_PASSWORD?'已启用':'未启用；仅绑定 localhost 时可接受');

console.log(`\n${PRODUCT_DISPLAY_NAME} v${PRODUCT_VERSION} · 环境自检\n`);
for(const result of results)console.log(`${result.ok?'✓':'!'} ${result.name}: ${result.detail}`);
console.log('');

const required=new Set(['Node.js >= 24','文件系统','数据目录可写','工作区可写','业务板块配置']);
if(externalIntegration?.enabled&&getnoteRuntimeRequired)required.add('GetNote 读取运行时');
if(externalIntegration?.enabled&&feishuJournalRequired)required.add('飞书每日工作日记');
if(joycrewConfig.enabled)required.add('Joycrew 业务执行');
process.exit(results.some(result=>required.has(result.name)&&!result.ok)?1:0);
