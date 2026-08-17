import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST } from '../harness-policy.mjs';

export function createHarnessPolicy({allowlist=HARNESS_NAVIGATOR_TOOL_ALLOWLIST,mutatingNames=[]}={}){
  const allowed=new Set(allowlist);
  const mutating=new Set(mutatingNames);

  function decide({tool,effect}={}){
    if(mutating.has(tool)){
      const delegate=String(tool).startsWith('joycrew_')&&!String(tool).endsWith('_prepare')
        ?'joycrew-prepare-execute'
        :'mcp-confirmation';
      return {decision:'APPROVAL_REQUIRED',reason:'existing confirmation required',delegate};
    }
    if(allowed.has(tool)&&(effect==='read'||String(tool).endsWith('_prepare')||effect==='unknown'||effect===undefined)){
      return {decision:'ALLOW',reason:'allowlist read or preview',delegate:null};
    }
    if(allowed.has(tool)){
      return {decision:'ALLOW',reason:'allowlist',delegate:null};
    }
    return {decision:'DENY',reason:'not on harness allowlist',delegate:null};
  }

  return Object.freeze({decide});
}
