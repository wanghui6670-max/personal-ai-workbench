#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot';

const NAME='joycrew-harness-navigator';
installFailLoud(NAME);

const requested=process.env.DSH_CORDIS_CONFIG||process.argv[2];
const configPath=requested?resolveConfigPath(requested,undefined):undefined;
if(!configPath||!existsSync(configPath)){
  process.stderr.write(`usage: ${NAME} <path/to/cordis.yml>\n`);
  process.exit(1);
}

const ctx=await boot(NAME,configPath);
let exiting=false;
async function disposeAndExit(code){
  if(exiting)return;
  exiting=true;
  try{await ctx.fiber.dispose();}
  finally{process.exit(code);}
}
process.stdin.on('end',()=>{void disposeAndExit(0);});
process.on('SIGTERM',()=>{void disposeAndExit(0);});
process.on('SIGINT',()=>{void disposeAndExit(130);});
