import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.mjs';
import { loadWorkbenchEnv } from '../src/env.mjs';

const input=process.argv[2];
if(!input){console.error('用法: npm run restore -- /path/to/backup.json');process.exit(1);}
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await loadWorkbenchEnv({root});
const dataDir=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(root,'data');
try{
  const raw=JSON.parse(await fsp.readFile(path.resolve(input),'utf8'));
  const wrapped=raw!==null&&typeof raw==='object'&&!Array.isArray(raw)&&Object.hasOwn(raw,'state');
  const state=wrapped?raw.state:raw;
  const includeConfig=wrapped&&Object.hasOwn(raw,'config');
  const includeCaptureReceipts=wrapped&&Object.hasOwn(raw,'captureReceipts');
  const includeProjectRecordReceipts=wrapped&&Object.hasOwn(raw,'projectRecordReceipts');
  const store=new JsonStore(dataDir);
  const safety=await store.restore({
    state,
    config:raw?.config,
    includeConfig,
    captureReceipts:raw?.captureReceipts,
    includeCaptureReceipts,
    projectRecordReceipts:raw?.projectRecordReceipts,
    includeProjectRecordReceipts
  });
  console.log(`恢复完成。恢复前自动备份：${safety}`);
}catch(error){
  console.error(error.message||'恢复失败。');
  process.exitCode=1;
}
