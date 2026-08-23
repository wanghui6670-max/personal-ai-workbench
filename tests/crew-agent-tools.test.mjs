// crew-agent-tools.test.mjs — 测试 crew_agent_list + crew_agent_dispatch MCP 工具
// 覆盖：白名单、工具注册、工具执行（正常+边界）、关键词匹配、skillCalls 记录
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_NAVIGATOR_TOOL_ALLOWLIST,
  HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256,
  isHarnessNavigatorTool
} from '../src/harness-policy.mjs';
import { createJoycrewTools, planJoycrewMessage } from '../src/mcp/joycrew-tools.mjs';
import { summarizeHarnessEvents } from '../src/harness-navigator.mjs';

// ---- Mock 工厂 ----
function mockCrewCatalog(agents) {
  return { catalog: async () => ({ agents: agents || [] }) };
}
function mockJoycrewClient(overviewData) {
  return {
    probe: async () => ({ enabled: true }),
    overview: async () => overviewData || { employees: [] },
    projects: async () => [],
    customers: async () => [],
    tasks: async () => [],
    approvals: async () => [],
    deliverables: async () => [],
    project: async () => ({}),
  };
}
function mockJoycrewActions() {
  const prepared = [];
  return {
    prepare(type, payload, opts) {
      const action = { id: `act_${prepared.length + 1}`, type, payload, opts, createdAt: Date.now() };
      prepared.push(action);
      return action;
    },
    list: () => prepared,
    execute: async (id) => ({ ok: true, id }),
    cancel: (id) => ({ ok: true, id }),
  };
}

const sampleAgents = [
  { id: 'daily_coordinator', title: 'AI日终复盘与任务推进助理', name: 'daily_coordinator', dept: '总经理办公室', description: 'AI日终复盘与任务推进助理。用于每天工作总结。' },
  { id: 'finance_ops', title: 'AI财务运营经理', name: 'finance_ops', dept: '财务管理部', description: 'AI财务运营经理。用于记账。' },
];

const sampleEmployees = [
  { id: 'emp_001', name: 'AI日终复盘助理', version: '1.0.0', readiness: 'ready', role: 'Daily Review' },
];

// ---- 测试组 1：白名单 ----
test('白名单包含 crew_agent_list 和 crew_agent_dispatch', () => {
  assert.ok(isHarnessNavigatorTool('crew_agent_list'), 'crew_agent_list 应在白名单中');
  assert.ok(isHarnessNavigatorTool('crew_agent_dispatch'), 'crew_agent_dispatch 应在白名单中');
});

test('白名单长度为 27', () => {
  assert.equal(HARNESS_NAVIGATOR_TOOL_ALLOWLIST.length, 27, `期望 27，实际 ${HARNESS_NAVIGATOR_TOOL_ALLOWLIST.length}`);
});

test('白名单 SHA256 为合法 64 位 hex', () => {
  assert.match(HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256, /^[a-f0-9]{64}$/);
});

test('非白名单工具被拒绝', () => {
  assert.equal(isHarnessNavigatorTool('crew_agent_delete'), false);
  assert.equal(isHarnessNavigatorTool('shell_exec'), false);
  assert.equal(isHarnessNavigatorTool(''), false);
});

// ---- 测试组 2：工具注册 ----
test('createJoycrewTools 返回包含 crew_agent_list 和 crew_agent_dispatch', () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const names = tools.map(t => t.name);
  assert.ok(names.includes('crew_agent_list'), '应包含 crew_agent_list');
  assert.ok(names.includes('crew_agent_dispatch'), '应包含 crew_agent_dispatch');
});

test('crew_agent_list 和 crew_agent_dispatch 是 readOnly + 无需确认', () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  for (const name of ['crew_agent_list', 'crew_agent_dispatch']) {
    const tool = tools.find(t => t.name === name);
    assert.ok(tool, `工具 ${name} 应存在`);
    assert.equal(tool.readOnly, true, `${name} 应为 readOnly`);
    assert.equal(tool.requiresConfirmation, false, `${name} 应无需确认`);
  }
});

// ---- 测试组 3：crew_agent_list 执行 ----
test('crew_agent_list 有 crewCatalog 时返回 Codex agents', async () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_list');
  const result = await tool.execute({}, {});
  assert.ok(Array.isArray(result.agents), '应返回 agents 数组');
  assert.equal(result.count, 2);
  assert.equal(result.agents[0].id, 'daily_coordinator');
  assert.equal(result.agents[0].name, 'AI日终复盘与任务推进助理');
  assert.equal(result.agents[0].source, 'codex');
  assert.equal(result.agents[0].dept, '总经理办公室');
});

test('crew_agent_list 无 crewCatalog 时不崩溃', async () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient({ employees: sampleEmployees }),
    actions: mockJoycrewActions(),
  });
  const tool = tools.find(t => t.name === 'crew_agent_list');
  const result = await tool.execute({}, {});
  assert.ok(Array.isArray(result.agents), '即使无 crewCatalog 也应返回数组');
  // 无 crewCatalog，只有 Joycrew employees
  assert.equal(result.count, 1);
  assert.equal(result.agents[0].source, 'joycrew');
});

test('crew_agent_list crewCatalog 报错时静默降级', async () => {
  const brokenCatalog = { catalog: async () => { throw new Error('disk error'); } };
  const tools = createJoycrewTools({
    client: mockJoycrewClient({ employees: sampleEmployees }),
    actions: mockJoycrewActions(),
    crewCatalog: brokenCatalog,
  });
  const tool = tools.find(t => t.name === 'crew_agent_list');
  const result = await tool.execute({}, {});
  assert.ok(Array.isArray(result.agents), 'crewCatalog 报错时应静默降级');
  // crewCatalog 报错，仍能返回 Joycrew 侧数据
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].source, 'joycrew');
});

test('crew_agent_list 合并 Codex agents + Joycrew employees', async () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient({ employees: sampleEmployees }),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_list');
  const result = await tool.execute({}, {});
  assert.equal(result.count, 3); // 2 codex + 1 joycrew
  const sources = result.agents.map(a => a.source);
  assert.ok(sources.includes('codex'));
  assert.ok(sources.includes('joycrew'));
});

// ---- 测试组 4：crew_agent_dispatch 执行 ----
test('crew_agent_dispatch 仅传 agentId+task 时返回 codex 命令', async () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_dispatch');
  const result = await tool.execute({}, { agentId: 'daily_coordinator', task: '生成今日工作总结' });
  assert.ok(result.message, '应返回 message');
  assert.ok(result.command, '应返回 command');
  assert.match(result.command, /codex exec --agent 'daily_coordinator'/);
  assert.match(result.command, /'生成今日工作总结'/);
});

test('crew_agent_dispatch task 含单引号时 shell 转义正确', async () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_dispatch');
  const result = await tool.execute({}, { agentId: 'daily_coordinator', task: "it's a test" });
  // shellEscape 将单引号转义为 '\''，整体用单引号包裹
  assert.match(result.command, /'it'\\''s a test'/, "单引号应被 shell 转义");
  // 确保不存在未转义的命令注入点
  assert.ok(!result.command.includes(';'), '命令中不应含分号');
  assert.ok(!result.command.includes('`'), '命令中不应含反引号');
  assert.ok(!result.command.includes('$'), '命令中不应含美元符号');
});

test('crew_agent_dispatch agentId schema 含 pattern 约束', () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_dispatch');
  const agentIdSchema = tool.inputSchema.properties.agentId;
  assert.ok(agentIdSchema.pattern, 'agentId 应有 pattern 约束');
  assert.ok(agentIdSchema.pattern.startsWith('^'), 'pattern 应以 ^ 锚定开头');
  assert.ok(agentIdSchema.pattern.endsWith('$'), 'pattern 应以 $ 锚定结尾');
  // 验证 pattern 拒绝危险字符
  const pattern = new RegExp(agentIdSchema.pattern);
  assert.ok(pattern.test('daily_coordinator'), '合法 ID 应通过');
  assert.ok(pattern.test('finance-ops'), '含连字符应通过');
  assert.ok(!pattern.test('foo;bar'), '含分号应拒绝');
  assert.ok(!pattern.test('foo bar'), '含空格应拒绝');
  assert.ok(!pattern.test('$(cmd)'), '含命令替换应拒绝');
  assert.ok(!pattern.test('; rm -rf'), '命令注入应拒绝');
  assert.ok(!pattern.test('.daily'), '以点开头应拒绝');
});

test('crew_agent_dispatch 传 projectId+sources 时生成 action 预览', async () => {
  const actions = mockJoycrewActions();
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions,
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_dispatch');
  const result = await tool.execute({}, {
    agentId: 'daily_coordinator',
    task: '生成今日工作总结',
    projectId: 'proj_001',
    sources: [{ kind: 'records', sourceId: 'src1', entity: 'todos' }],
  });
  assert.ok(result.action, '应返回 action 预览');
  assert.ok(result.action.id, 'action 应有 id');
  assert.equal(result.action.type, 'run.create');
  assert.match(result.message, /业务执行.*确认/);
});

test('crew_agent_dispatch agentId 为空时抛错', async () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_dispatch');
  await assert.rejects(
    () => tool.execute({}, { agentId: '', task: '任务' }),
    /agentId/,
  );
});

test('crew_agent_dispatch task 为空时抛错', async () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_dispatch');
  await assert.rejects(
    () => tool.execute({}, { agentId: 'daily_coordinator', task: '' }),
    /task/,
  );
});

test('crew_agent_dispatch task 过短（<3 字符）不通过 schema', async () => {
  const tools = createJoycrewTools({
    client: mockJoycrewClient(),
    actions: mockJoycrewActions(),
    crewCatalog: mockCrewCatalog(sampleAgents),
  });
  const tool = tools.find(t => t.name === 'crew_agent_dispatch');
  // task minLength=3，但工具层 string() 只检查非空，schema 校验在 registry 层
  // 传空字符串应被 string() 拒绝
  await assert.rejects(
    () => tool.execute({}, { agentId: 'daily_coordinator', task: '' }),
  );
});

// ---- 测试组 5：planJoycrewMessage 关键词匹配 ----
test('planJoycrewMessage 匹配"列出可用AI员工"', () => {
  const plan = planJoycrewMessage({ message: '请列出可用AI员工' });
  assert.ok(plan, '应匹配到计划');
  assert.equal(plan.toolName, 'crew_agent_list');
});

test('planJoycrewMessage 匹配"有哪些AI员工"', () => {
  const plan = planJoycrewMessage({ message: '有哪些AI员工可以用' });
  assert.ok(plan);
  assert.equal(plan.toolName, 'crew_agent_list');
});

test('planJoycrewMessage 匹配"派单"', () => {
  const plan = planJoycrewMessage({ message: '请派单给AI员工' });
  assert.ok(plan);
  assert.equal(plan.toolName, 'crew_agent_dispatch');
});

test('planJoycrewMessage 匹配"让AI员工做事"', () => {
  const plan = planJoycrewMessage({ message: '让AI员工帮我做今日复盘' });
  assert.ok(plan);
  assert.equal(plan.toolName, 'crew_agent_dispatch');
});

test('planJoycrewMessage 无关消息返回 null', () => {
  const plan = planJoycrewMessage({ message: '今天天气怎么样' });
  assert.equal(plan, null);
});

test('planJoycrewMessage 空消息返回 null', () => {
  const plan = planJoycrewMessage({ message: '' });
  assert.equal(plan, null);
});

// ---- 测试组 6：skillCalls 记录 ----
test('summarizeHarnessEvents 记录 crew_agent_dispatch 调用', () => {
  const events = [
    { type: 'tool/call', data: { name: 'crew_agent_dispatch', callId: 'c1', arguments: JSON.stringify({ agentId: 'daily_coordinator', task: '复盘' }) } },
    { type: 'tool/result', data: { callId: 'c1', message: { content: [{ type: 'text', text: '{"command":"codex exec"}' }] } } },
  ];
  const summary = summarizeHarnessEvents(events);
  assert.ok(summary.skillCalls.length > 0, '应有 skillCalls 记录');
  assert.match(summary.skillCalls[0], /AI员工:daily_coordinator/);
});

test('summarizeHarnessEvents 记录 crew_agent_list 调用', () => {
  const events = [
    { type: 'tool/call', data: { name: 'crew_agent_list', callId: 'c2', arguments: '{}' } },
    { type: 'tool/result', data: { callId: 'c2', message: { content: [{ type: 'text', text: '{"agents":[]}' }] } } },
  ];
  const summary = summarizeHarnessEvents(events);
  assert.ok(summary.skillCalls.includes('AI员工列表'), '应记录 AI员工列表');
});

test('summarizeHarnessEvents 不记录无关工具', () => {
  const events = [
    { type: 'tool/call', data: { name: 'config_read', callId: 'c3', arguments: '{}' } },
    { type: 'tool/result', data: { callId: 'c3', message: { content: [{ type: 'text', text: '{}' }] } } },
  ];
  const summary = summarizeHarnessEvents(events);
  assert.equal(summary.skillCalls.length, 0, 'config_read 不应记入 skillCalls');
});
