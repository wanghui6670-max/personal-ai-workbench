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
import {larkCliEnv} from '../src/external-cli-env.mjs';
import { createJoycrewClient } from '../src/joycrew-client.mjs';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from '../src/product.mjs';

const execFileAsync=promisify(execFile);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jsonMode=process.argv.slice(2).includes('--json');
await loadWorkbenchEnv({root});
const dataDir=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(root,'data');
const results=[];
const checkIds=new Map([
  ['Node.js >= 24','node_runtime'],
  ['Git 可用','git_runtime'],
  ['数据目录可写','data_dir'],
  ['工作区可写','workspace_root'],
  ['业务板块配置','business_config'],
  ['文件系统','filesystem'],
  ['个人事项来源合同','task_pipeline'],
  ['飞书明确待办收件箱','feishu_inbox'],
  ['GetNote 内容来源','getnote_runtime'],
  ['Joycrew 业务执行','joycrew'],
  ['AI 判断配置','ai_provider'],
  ['访问密码','access_control']
]);
const check=(name,ok,detail)=>results.push({id:checkIds.get(name),name,ok:Boolean(ok),detail});

const nodeMajor=Number(process.versions.node.split('.')[0]);
check('Node.js >= 24',nodeMajor>=24,`${process.versions.node}${nodeMajor<24?'；v2 统一 Harness 运行时要求 Node 24+':''}`);
try{await execFileAsync('git',['--version'],{timeout:2000});check('Git 可用',true,'已找到 git');}
catch{check('Git 可用',false,'未找到 git；项目 Git 信息将不可用');}

let store=null;
let config=null;
let workspace=null;
let dataDirReady=false;
let workspaceReady=false;
try{
  store=new JsonStore(dataDir);
  await store.ensure();
  config=await store.readConfig();
  dataDirReady=true;
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
  workspaceReady=true;
  check('数据目录可写',true,dataDir);
  check('工作区可写',true,workspace);
  check('业务板块配置',config.businesses.length>0,`${config.businesses.length} 个板块`);
}catch(error){check('文件系统',false,error.message);}

let feishuInboxConfigured=false;
let feishuInboxReady=true;
try{
  check('个人事项来源合同',true,'飞书云文档中的明确待办是个人事项主入口；GetNote 仅作为用户确认后的内容来源。');
  feishuInboxConfigured=config?.dataSource?.provider==='feishu_doc';
  if(feishuInboxConfigured){
    const documentUrl=String(config?.dataSource?.documentUrl||'').trim();
    if(!documentUrl){
      feishuInboxReady=false;
      check('飞书明确待办收件箱',false,'已配置飞书待办来源，但缺少文档地址。');
    }else{
      try{
        await execFileAsync('lark-cli',['--version'],{timeout:3000,windowsHide:true,env:larkCliEnv(process.env)});
        check('飞书明确待办收件箱',true,'已绑定飞书明确待办来源且找到 lark-cli；未读取文档或执行写入。');
      }catch(error){
        feishuInboxReady=false;
        check('飞书明确待办收件箱',false,error.code==='ENOENT'?'已绑定飞书明确待办来源，但未找到 lark-cli 可执行文件':'已绑定飞书明确待办来源，但 lark-cli 不可用。');
      }
    }
  }else{
    check('飞书明确待办收件箱',true,'未配置；手工 Capture/Inbox 仍可作为本地保底入口。');
  }
  check('GetNote 内容来源',true,'可选内容来源；不读取 GetNote，不影响 R1 个人事项 readiness。');
}catch(error){
  feishuInboxReady=false;
  check('飞书明确待办收件箱',false,'飞书明确待办诊断无法完成。');
}

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

let aiConfig=null;
let aiConfigValid=true;
try{
  aiConfig=aiRuntimeConfig();
  const enabled=aiEnabled()&&aiConfig.enabled&&aiConfig.configured;
  check('AI 判断配置',enabled,enabled?`已配置：${aiConfig.model} / 极高（${aiConfig.reasoningEffort}）；未联网验证 · Provider ${aiConfig.provider} / ${aiConfig.profileId}`:`未配置可用 AI Provider；${aiConfig.model||'模型未配置'} / 极高（${aiConfig.reasoningEffort}）未启用，将使用本地规则`);
}catch{
  aiConfigValid=false;
  check('AI 判断配置',false,'AI Provider 配置无效；已停用 AI，将使用本地规则。');
}
check('访问密码',!!process.env.WORKBENCH_PASSWORD,process.env.WORKBENCH_PASSWORD?'已启用':'未启用；仅绑定 localhost 时可接受');

const required=new Set(['Node.js >= 24','文件系统','数据目录可写','工作区可写','业务板块配置']);
if(feishuInboxConfigured)required.add('飞书明确待办收件箱');
if(joycrewConfig.enabled)required.add('Joycrew 业务执行');
const exitCode=results.some(result=>required.has(result.name)&&!result.ok)?1:0;

if(jsonMode){
  const joycrewMode=!joycrewConfig.enabled?'disabled':(!joycrewConfig.ok?'invalid_config':'enabled');
  const machineState=new Map([
    ['node_runtime',{mode:'node'}],
    ['data_dir',{mode:'read_write'}],
    ['workspace_root',{mode:'read_write'}],
    ['feishu_inbox',{mode:feishuInboxConfigured?'configured':'disabled',liveRead:false}],
    ['getnote_runtime',{mode:'optional_content',liveRead:false}],
    ['lark_cli',{mode:feishuInboxConfigured?'configured':'disabled',liveRead:false}],
    ['ai_provider',{mode:aiConfigValid?(aiConfig?.enabled&&aiConfig?.configured?'configured':'local_rules'):'invalid_config',liveRead:false}],
    ['access_control',{mode:process.env.WORKBENCH_PASSWORD?'password':'loopback_only'}],
    ['joycrew',{mode:joycrewMode,liveRead:false}]
  ]);
  const checks=results.map(result=>({
    id:result.id,
    required:required.has(result.name),
    ok:result.ok,
    ...(machineState.get(result.id)||{}),
    ...(result.id==='joycrew'?{liveRead:Boolean(joycrewMode==='enabled'&&result.ok)}:{})
  }));
  const byId=new Map(checks.map(result=>[result.id,result]));
  const addMissing=(id,requiredCheck,ok)=>{
    if(byId.has(id))return;
    const result={id,required:requiredCheck,ok:Boolean(ok),...(machineState.get(id)||{})};
    checks.push(result);
    byId.set(id,result);
  };
  addMissing('data_dir',true,dataDirReady);
  addMissing('workspace_root',true,workspaceReady);
  addMissing('business_config',true,Boolean(config?.businesses?.length));
  addMissing('feishu_inbox',feishuInboxConfigured,feishuInboxReady);
  addMissing('getnote_runtime',false,true);
  addMissing('lark_cli',feishuInboxConfigured,feishuInboxReady);

  const order=[
    'node_runtime','git_runtime','data_dir','workspace_root','business_config','filesystem','task_pipeline',
    'feishu_inbox','getnote_runtime','lark_cli','joycrew','ai_provider','access_control'
  ];
  const rank=new Map(order.map((id,index)=>[id,index]));
  checks.sort((left,right)=>(rank.get(left.id)??order.length)-(rank.get(right.id)??order.length));
  console.log(JSON.stringify({schemaVersion:1,ok:exitCode===0,checks}));
}else{
  console.log(`\n${PRODUCT_DISPLAY_NAME} v${PRODUCT_VERSION} · 环境自检\n`);
  for(const result of results)console.log(`${result.ok?'✓':'!'} ${result.name}: ${result.detail}`);
  console.log('');
}

process.exit(exitCode);
