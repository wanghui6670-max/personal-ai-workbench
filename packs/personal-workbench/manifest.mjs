export const personalWorkbenchPack={
  id:'personal-workbench',name:'Personal AI Workbench',version:'4.0.0-alpha.1',
  capabilities:[
    {id:'workbench.inbox',kind:'business_capability',description:'Personal intake and triage'},
    {id:'workbench.todo',kind:'business_capability',description:'User-confirmed personal tasks'},
    {id:'workbench.project',kind:'business_capability',description:'Project identity and continuity'},
    {id:'workbench.capture',kind:'business_capability',description:'Fast capture entrypoint'}
  ],
  tools:[],agents:[],schedules:[],
  skills:['personal-work-continuity'],
  views:[{id:'workbench.today'},{id:'workbench.inbox'},{id:'workbench.projects'}],
  metadata:{migration:'v3-domain-assets-retained',truthSources:['feishu','local-workspace','git','joycrew']}
};
