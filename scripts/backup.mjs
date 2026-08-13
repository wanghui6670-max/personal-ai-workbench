import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.mjs';
import { loadWorkbenchEnv } from '../src/env.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));await loadWorkbenchEnv({root});const dataDir=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(root,'data');const store=new JsonStore(dataDir);await store.ensure();console.log(await store.backupNow());
