import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.mjs';
import { resolveWorkspace, ensureBusinessDirs } from '../src/projects.mjs';
import { loadWorkbenchEnv } from '../src/env.mjs';
const execFileAsync=promisify(execFile);const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));await loadWorkbenchEnv({root});const dataDir=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(root,'data');
const results=[];const check=(name,ok,detail)=>results.push({name,ok,detail});
check('Node.js >= 20',Number(process.versions.node.split('.')[0])>=20,process.versions.node);
try{await execFileAsync('git',['--version'],{timeout:2000});check('Git 可用',true,'已找到 git');}catch{check('Git 可用',false,'未找到 git；项目 Git 信息将不可用');}
try{const store=new JsonStore(dataDir);await store.ensure();const config=await store.readConfig();const ws=resolveWorkspace(root,config);await ensureBusinessDirs(root,config);const probe=path.join(ws,`.workbench-write-test-${process.pid}-${randomUUID()}`);let probeHandle;let probeCreated=false;try{probeHandle=await fsp.open(probe,'wx');probeCreated=true;await probeHandle.writeFile('ok','utf8');}finally{try{await probeHandle?.close();}finally{if(probeCreated)await fsp.unlink(probe);}}check('数据目录可写',true,dataDir);check('工作区可写',true,ws);check('业务板块配置',config.businesses.length>0,`${config.businesses.length} 个板块`);}catch(e){check('文件系统',false,e.message);}
const aiModel=process.env.OPENAI_MODEL||'gpt-5.6-luna';
check('AI 判断配置',!!process.env.OPENAI_API_KEY,process.env.OPENAI_API_KEY?`已配置：${aiModel} / 极高（xhigh）；未联网验证`:`未配置 OPENAI_API_KEY；${aiModel} / 极高（xhigh）未启用，将使用本地规则`);
check('访问密码',!!process.env.WORKBENCH_PASSWORD,process.env.WORKBENCH_PASSWORD?'已启用':'未启用；仅绑定 localhost 时可接受');
console.log('\n个人 AI 工作台 · 环境自检\n');for(const r of results)console.log(`${r.ok?'✓':'!'} ${r.name}: ${r.detail}`);console.log('');
process.exit(results.some(r=>['Node.js >= 20','文件系统','数据目录可写','工作区可写','业务板块配置'].includes(r.name)&&!r.ok)?1:0);
