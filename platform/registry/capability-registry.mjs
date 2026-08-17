import {validatePackManifest} from '../contracts/manifest.mjs';

export class CapabilityRegistry{
  #packs=new Map();
  #capabilities=new Map();
  #tools=new Map();
  #agents=new Map();
  #schedules=new Map();
  #skills=new Map();
  #methods=new Map();
  #views=new Map();

  install(rawPack){
    const pack=validatePackManifest(rawPack);
    if(this.#packs.has(pack.id))throw new Error(`pack already installed: ${pack.id}`);
    const staged=[
      ['capability',this.#capabilities,pack.capabilities],
      ['tool',this.#tools,pack.tools.map(item=>({id:item.name,value:item}))],
      ['agent',this.#agents,pack.agents],
      ['schedule',this.#schedules,pack.schedules],
      ['skill',this.#skills,pack.skills],
      ['method',this.#methods,pack.methods],
      ['view',this.#views,pack.views]
    ];
    for(const [kind,map,items] of staged){
      for(const item of items){
        const id=item.id;
        if(map.has(id))throw new Error(`${kind} already registered: ${id}`);
      }
    }
    this.#packs.set(pack.id,pack);
    for(const item of pack.capabilities)this.#capabilities.set(item.id,{...item,packId:pack.id});
    for(const item of pack.tools)this.#tools.set(item.name,{...item,packId:pack.id});
    for(const item of pack.agents)this.#agents.set(item.id,{...item,packId:pack.id});
    for(const item of pack.schedules)this.#schedules.set(item.id,{...item,packId:pack.id});
    for(const item of pack.skills)this.#skills.set(item.id,{...item,packId:pack.id});
    for(const item of pack.methods)this.#methods.set(item.id,{...item,packId:pack.id});
    for(const item of pack.views)this.#views.set(item.id,{...item,packId:pack.id});
    return pack;
  }

  getPack(id){return this.#packs.get(id)??null;}
  getCapability(id){return this.#capabilities.get(id)??null;}
  getTool(name){return this.#tools.get(name)??null;}
  getAgent(id){return this.#agents.get(id)??null;}
  getSchedule(id){return this.#schedules.get(id)??null;}
  getSkill(id){return this.#skills.get(id)??null;}
  getMethod(id){return this.#methods.get(id)??null;}
  getView(id){return this.#views.get(id)??null;}
  listPacks(){return [...this.#packs.values()];}
  listCapabilities({kind=null}={}){return [...this.#capabilities.values()].filter(item=>!kind||item.kind===kind);}
  listTools(){return [...this.#tools.values()];}
  listAgents(){return [...this.#agents.values()];}
  listSchedules(){return [...this.#schedules.values()];}
  listSkills(){return [...this.#skills.values()];}
  listMethods(){return [...this.#methods.values()];}
  listViews(){return [...this.#views.values()];}
}
