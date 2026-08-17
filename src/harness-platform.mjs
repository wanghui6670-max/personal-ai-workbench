import path from 'node:path';
import {HarnessRuntime,SessionStore,JsonlEventStore,createWorkbenchV3RegistryPack} from '../platform/index.mjs';
import {personalWorkbenchPack} from '../packs/personal-workbench/manifest.mjs';

export function createHarnessPlatform({mcpRegistry,dataDir,packs=[]}={}){
  if(!dataDir)throw new TypeError('createHarnessPlatform requires dataDir');
  if(!Array.isArray(packs))throw new TypeError('createHarnessPlatform packs must be an array');
  const root=path.resolve(dataDir,'harness-platform');
  const sessions=new SessionStore({root:path.join(root,'sessions')});
  const events=new JsonlEventStore(path.join(root,'events.jsonl'));
  const runtime=new HarnessRuntime({sessions,events});
  runtime.install(personalWorkbenchPack);
  runtime.install(createWorkbenchV3RegistryPack({mcpRegistry}));
  for(const pack of packs)runtime.install(pack);
  return runtime;
}

export function harnessPlatformStatus(runtime){
  if(!runtime||typeof runtime.describe!=='function')return {enabled:false};
  return {enabled:true,...runtime.describe()};
}
