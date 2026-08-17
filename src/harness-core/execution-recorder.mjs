import {randomUUID} from 'node:crypto';

function defaultId(){return `ex_${randomUUID().replaceAll('-','')}`;}
function defaultClock(){return new Date().toISOString();}

function safeErrorCode(error){
  const code=typeof error?.code==='string'?error.code.trim():'';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(code)?code:'UNCLASSIFIED_ERROR';
}

function completionReceiptFailure(error,executionId){
  return Object.assign(new Error('Execution 已产生结果，但完成收据无法安全持久化；结果状态不确定。'),{
    code:'HARNESS_EXECUTION_RECEIPT_FAILED',
    statusCode:500,
    executionId,
    outcomeUncertain:true,
    cause:error
  });
}

export class ExecutionRecorder{
  constructor({store,idFactory=defaultId,clock=defaultClock}={}){
    if(!store||typeof store.writeStart!=='function'||typeof store.writeFinish!=='function'){
      throw new TypeError('ExecutionRecorder requires an ExecutionReceiptStore');
    }
    if(typeof idFactory!=='function'||typeof clock!=='function')throw new TypeError('ExecutionRecorder requires callable idFactory and clock');
    this.store=store;
    this.idFactory=idFactory;
    this.clock=clock;
  }

  async run({tool,args={},context={}}={},operation){
    if(!tool||typeof tool!=='object'||typeof operation!=='function')throw new TypeError('ExecutionRecorder.run requires tool and operation');
    const executionId=String(this.idFactory());
    const start={
      version:1,
      id:executionId,
      trigger:String(context.trigger||'tool_call'),
      actor:String(context.actor||'harness'),
      sessionId:context.sessionId??null,
      toolName:String(tool.name||''),
      capabilityId:String(tool.capabilityId||''),
      providerId:String(tool.providerId||''),
      argumentKeys:Object.keys(args&&typeof args==='object'&&!Array.isArray(args)?args:{}),
      startedAt:String(this.clock())
    };
    await this.store.writeStart(start);

    try{
      const outcome=await operation();
      try{
        await this.store.writeFinish({
          version:1,
          id:executionId,
          status:'succeeded',
          completedAt:String(this.clock()),
          errorCode:null
        });
      }catch(error){
        throw completionReceiptFailure(error,executionId);
      }
      return{outcome,executionId};
    }catch(error){
      if(error?.code==='HARNESS_EXECUTION_RECEIPT_FAILED')throw error;
      try{
        await this.store.writeFinish({
          version:1,
          id:executionId,
          status:'failed',
          completedAt:String(this.clock()),
          errorCode:safeErrorCode(error)
        });
      }catch{}
      throw error;
    }
  }
}
