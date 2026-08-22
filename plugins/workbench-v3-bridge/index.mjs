import { createWorkbenchTools } from '../../src/mcp/tools.mjs';

const CAPABILITY_RULES=[
  ['inbox',name=>name.startsWith('inbox_')||name==='feishu_inbox_sync'],
  ['project',name=>name.startsWith('project_')||name==='projects_sync_all'],
  ['todo',name=>name.startsWith('todo_')],
  ['workbench-navigation',name=>name==='panel_navigate'||name==='workbench_get_state'],
  ['journal',name=>name.startsWith('journal_')],
  ['confirmation',name=>name.startsWith('confirmation_')],
  ['business',name=>name.startsWith('business_')],
  ['workbench-config',name=>name.startsWith('config_')]
];

function capabilityFor(name){
  return CAPABILITY_RULES.find(([,matches])=>matches(name))?.[0]||'workbench-misc';
}

function bridgeTool(legacy,contextProvider){
  const risk=legacy.readOnly===true?'read':legacy.requiresConfirmation===true?'local-write':'read';
  return Object.freeze({
    name:legacy.name,
    description:legacy.description,
    inputSchema:legacy.inputSchema||{type:'object'},
    risk,
    execute:async args=>{
      const context=await contextProvider();
      if(!context||typeof context!=='object')throw new Error('Workbench V3 context provider returned invalid context');
      return legacy.execute(context,args||{});
    }
  });
}

export function createWorkbenchV3BridgePlugin({contextProvider}={}){
  if(typeof contextProvider!=='function')throw new Error('Workbench V3 bridge requires contextProvider');
  const grouped=new Map();
  for(const legacy of createWorkbenchTools()){
    const id=capabilityFor(legacy.name);
    const list=grouped.get(id)||[];
    list.push(bridgeTool(legacy,contextProvider));
    grouped.set(id,list);
  }
  const capabilities=[...grouped.entries()].map(([id,tools])=>Object.freeze({
    id,
    version:'1.0.0',
    kind:id==='project'||id==='inbox'||id==='todo'?'domain':'workbench-support',
    tools:Object.freeze(tools)
  }));
  return Object.freeze({
    manifest:Object.freeze({id:'workbench-v3-bridge',version:'1.0.0',adapter:'./index.mjs'}),
    capabilities:Object.freeze(capabilities)
  });
}
