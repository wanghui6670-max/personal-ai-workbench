import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRecordOperationId } from '../src/project-record-contract.mjs';

test('analysis operation ID ignores previously persisted progress and Feishu pointers',()=>{
  const base={
    project:{id:'p1',name:'项目',endDate:'2026-08-31',feishu:'https://example.feishu.cn/wiki/project',progress:{percent:20,feishuRecordBlockId:'old'}},
    sourceDir:'/workspace/project',filesCount:3,gitRemote:'',lastActivity:'2026-08-13T01:00:00.000Z',scan:{complete:true,reasons:[]}
  };
  const next=structuredClone(base);
  next.project.progress={percent:80,feishuRecordBlockId:'new',feishuOperationId:'pa_previous'};
  next.project.progressBeforeCompletion={percent:20};
  assert.equal(projectRecordOperationId('analysis',base),projectRecordOperationId('analysis',next));
});

test('summary operation ID ignores the previous block pointer but still changes with text or document',()=>{
  const base={projectId:'p1',documentUrl:'https://example.feishu.cn/wiki/project',text:'阶段总结',parentBlockId:'old'};
  const moved={...base,parentBlockId:'new'};
  assert.equal(projectRecordOperationId('summary',base),projectRecordOperationId('summary',moved));
  assert.notEqual(projectRecordOperationId('summary',base),projectRecordOperationId('summary',{...base,text:'不同总结'}));
  assert.notEqual(projectRecordOperationId('summary',base),projectRecordOperationId('summary',{...base,documentUrl:'https://other.feishu.cn/wiki/project'}));
});
