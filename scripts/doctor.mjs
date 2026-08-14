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
import { localCalendarPath } from '../src/local-calendar.mjs';

const execFileAsync=promisify(execFile);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await loadWorkbenchEnv({root});
const dataDir=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(root,'data');
const results=[];
const check=(name,ok,detail)=>results.push({name,ok,detail});

check('Node.js >= 20',Number(process.versions.node.split('.')[0])>=20,process.versions.node);
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
try{
  externalIntegration=config?integrationFromConfig(config):null;
  if(externalIntegration?.enabled){
    check('得到大脑待办管线',true,`最近 ${externalIntegration.noteLimit} 篇笔记 · ${externalIntegration.journalDocumentUrl} · ${externalIntegration.calendarEnabled?'本机日历开启':'本机日历关闭'}`);
    try{
      const result=await execFileAsync('getnote',['doctor','-o','json'],{timeout:15_000,windowsHide:true,maxBuffer:2*1024*1024,env:{...process.env}});
      const raw=String(result.stdout||'').trim();
      if(raw){
        const payload=JSON.parse(raw);
        if(payload?.success===false)throw new Error(payload.message||payload.reason||'getnote doctor 返回失败');
      }
      check('getnote CLI',true,'已找到，安装、会员、登录和 API 连通性检查通过；未执行写入');
    }catch(error){
      check('getnote CLI',false,error.code==='ENOENT'?'未找到 getnote；请执行 npx -y @getnote/cli@latest setup':'getnote doctor 未通过，请检查安装、会员、登录状态和网络');
    }
    try{await execFileAsync('lark-cli',['--version'],{timeout:3000,windowsHide:true});check('lark-cli',true,'已找到；未执行真实文档读写');}
    catch(error){check('lark-cli',false,error.code==='ENOENT'?'未找到 lark-cli 可执行文件':'命令不可用，请检查安装和登录状态');}
    if(store&&externalIntegration.calendarEnabled){
      check('本机日历路径',true,localCalendarPath(store));
    }
  }else{
    const detail=externalIntegration?.lastSyncStatus==='needs_reconfiguration'
      ?'此前误配置为滴答清单，已停用；请在设置中重新确认得到大脑 CLI 与飞书日记'
      :'未启用；不会调用 getnote、lark-cli 或生成本机日历';
    check('得到大脑待办管线',true,detail);
  }
}catch(error){
  check('得到大脑待办管线',false,error.message);
}

const aiConfig=aiRuntimeConfig();
check('AI 判断配置',aiEnabled(),aiEnabled()?`已配置：${aiConfig.model} / 极高（${aiConfig.reasoningEffort}）；未联网验证 · Provider ${aiConfig.provider} / ${aiConfig.profileId}`:`未配置可用 AI Provider；${aiConfig.model||'模型未配置'} / 极高（${aiConfig.reasoningEffort}）未启用，将使用本地规则`);
check('访问密码',!!process.env.WORKBENCH_PASSWORD,process.env.WORKBENCH_PASSWORD?'已启用':'未启用；仅绑定 localhost 时可接受');

console.log('\n个人 AI 工作台 · 环境自检\n');
for(const result of results)console.log(`${result.ok?'✓':'!'} ${result.name}: ${result.detail}`);
console.log('');

const required=new Set(['Node.js >= 20','文件系统','数据目录可写','工作区可写','业务板块配置']);
if(externalIntegration?.enabled){required.add('得到大脑待办管线');required.add('getnote CLI');required.add('lark-cli');}
process.exit(results.some(result=>required.has(result.name)&&!result.ok)?1:0);
