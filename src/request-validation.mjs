function badRequest(message){
  return Object.assign(new Error(message),{statusCode:400,code:'INVALID_REQUEST'});
}

export function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

const nonEmptyString={type:'string',nonEmpty:true};
const nullableNonEmptyString={type:'string',nonEmpty:true,nullable:true};
const string={type:'string'};
const boolean={type:'boolean'};
const nonNegativeInteger={type:'number',integer:true,min:0};

function validateValue(value,spec,field){
  if(value===null&&spec.nullable)return;
  if(spec.type==='object'){
    validateRequestBody(value,{...spec.schema,label:field});
    return;
  }
  if(typeof value!==spec.type)throw badRequest(`${field} 类型无效。`);
  if(spec.type==='string'&&spec.nonEmpty&&!value.trim())throw badRequest(`${field} 必须是非空字符串。`);
  if(spec.type==='number'){
    if(!Number.isFinite(value)||(spec.integer&&!Number.isInteger(value)))throw badRequest(`${field} 必须是整数。`);
    if(spec.min!==undefined&&value<spec.min)throw badRequest(`${field} 不能小于 ${spec.min}。`);
  }
}

export function validateRequestBody(body,{fields={},required=[],allowEmpty=true,label='请求体',allowUnknown=false}={}){
  if(!isPlainObject(body))throw badRequest(`${label}必须是 JSON 对象。`);
  const keys=Object.keys(body);
  const unknown=allowUnknown?null:keys.find(key=>!Object.hasOwn(fields,key));
  if(unknown)throw badRequest(`${label}包含不支持的字段：${unknown}。`);
  if(!allowEmpty&&!keys.length)throw badRequest(`${label}不能为空。`);
  for(const field of required){
    if(!Object.hasOwn(body,field))throw badRequest(`${field} 为必填字段。`);
  }
  for(const key of keys){if(allowUnknown&&!Object.hasOwn(fields,key))continue;validateValue(body[key],fields[key],key);}
  return body;
}

const settings={type:'object',schema:{fields:{recentDays:nonNegativeInteger,dueSoonDays:nonNegativeInteger},allowEmpty:false}};
const dataSource={type:'object',nullable:true,schema:{fields:{provider:nonEmptyString,documentUrl:nonEmptyString,inboxHeading:nonEmptyString,inboxPrefix:nonEmptyString},required:['provider','documentUrl'],allowEmpty:false}};
const arbitraryObject={type:'object',schema:{fields:{},allowUnknown:true}};

export const requestSchemas={
  empty:{fields:{}},
  login:{fields:{password:nonEmptyString},required:['password'],allowEmpty:false},
  capture:{fields:{captureId:nonEmptyString,text:nonEmptyString,source:nonEmptyString},required:['text'],allowEmpty:false},
  config:{fields:{workspaceRoot:nonEmptyString,settings,dataSource},allowEmpty:false},
  business:{fields:{name:nonEmptyString},required:['name'],allowEmpty:false},
  inbox:{fields:{text:nonEmptyString},required:['text'],allowEmpty:false},
  inboxCommand:{fields:{itemId:nonEmptyString,command:nonEmptyString,targetProjectId:nullableNonEmptyString},required:['itemId','command'],allowEmpty:false},
  projectCreate:{fields:{description:nonEmptyString,endDate:nonEmptyString,businessId:nullableNonEmptyString,sourceInboxId:nonEmptyString},required:['description','endDate','sourceInboxId'],allowEmpty:false},
  classify:{fields:{businessId:nonEmptyString},required:['businessId'],allowEmpty:false},
  projectPatch:{fields:{intro:string,git:string,feishu:string,completed:boolean,archived:boolean,endDate:nonEmptyString},allowEmpty:false},
  today:{fields:{todoId:nonEmptyString,add:boolean},required:['todoId','add'],allowEmpty:false},
  todoPatch:{fields:{title:nonEmptyString,context:string,dueDate:nonEmptyString,done:boolean,businessId:nullableNonEmptyString},allowEmpty:false},
  morning:{fields:{message:nonEmptyString,sessionId:nullableNonEmptyString},required:['message'],allowEmpty:false},
  confirmationClear:{fields:{id:nonEmptyString},required:['id'],allowEmpty:false},
  note:{fields:{text:nonEmptyString},required:['text'],allowEmpty:false},
  aiPlan:{fields:{message:nonEmptyString,view:nonEmptyString,id:nullableNonEmptyString},required:['message'],allowEmpty:false},
  aiExecute:{fields:{planId:nonEmptyString,confirmed:boolean},required:['planId','confirmed'],allowEmpty:false},
  diaryExtractionApply:{fields:{planId:nonEmptyString},required:['planId'],allowEmpty:false},
  harnessNavigator:{fields:{message:nonEmptyString,sessionId:nullableNonEmptyString,view:nonEmptyString,id:nullableNonEmptyString},required:['message'],allowEmpty:false},
  harnessSwitchModel:{fields:{model:nonEmptyString},required:['model'],allowEmpty:false},
  joycrewActionPrepare:{fields:{type:nonEmptyString,payload:arbitraryObject,source:nonEmptyString},required:['type','payload'],allowEmpty:false},
  joycrewActionExecute:{fields:{confirmed:boolean},required:['confirmed'],allowEmpty:false},
  mcp:{fields:{jsonrpc:nonEmptyString,id:{type:'string',nullable:true},method:nonEmptyString,params:{type:'object',schema:{fields:{},allowUnknown:true},nullable:true}},required:['jsonrpc','method'],allowEmpty:false}
};
