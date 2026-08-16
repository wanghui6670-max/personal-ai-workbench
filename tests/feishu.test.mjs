import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { addInbox, syncFeishuInbox } from '../src/domain.mjs';
import { createFeishuJournalClient, parseFeishuInboxXml } from '../src/feishu.mjs';

function xml(items, { extra = '' } = {}) {
  return `<title id="doc">日记</title><h1 id="heading">收件箱</h1>${items.map((item, index) => `<p id="blk_${index}">${item}</p>`).join('')}<h1 id="journal">每日工作日记</h1><p id="not_inbox">[INBOX] 不得从其他章节读取</p>${extra}`;
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-feishu-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new JsonStore(path.join(root, 'data'));
  await store.ensure();
  const config = await store.readConfig();
  await store.writeConfig({
    ...config,
    dataSource: { provider: 'feishu_doc', documentUrl: 'https://example.feishu.cn/wiki/test', inboxHeading: '收件箱', inboxPrefix: '[INBOX]', lastSyncStatus: 'not_synced', lastImportedCount: 0 }
  });
  return store;
}

test('Feishu parser reads only the 收件箱 h1 section and deduplicates block ids', () => {
  const parsed = parseFeishuInboxXml(xml(['[INBOX] 第一条', '[INBOX] 第二条'], { extra: '<p id="blk_0">[INBOX] 重复块</p>' }));
  assert.equal(parsed.sectionFound, true);
  assert.equal(parsed.headingBlockId, 'heading');
  assert.deepEqual(parsed.items.map(item => [item.blockId, item.text]), [['blk_0', '第一条'], ['blk_1', '第二条']]);
});

test('Feishu todo sync imports a source block once and later remote disappearance does not mutate local routing', async t => {
  const store = await fixture(t);
  let current = xml(['[INBOX] 从飞书来的事项']);
  const client = { fetch: async () => ({ content: current, revisionId: 7, documentId: 'doc', ...parseFeishuInboxXml(current) }) };
  let result = await syncFeishuInbox({ store, client });
  assert.equal(result.imported, 1);
  let state = await store.readState();
  assert.equal(state.inbox.length, 1);
  assert.equal(state.inbox[0].source, 'feishu_todo');
  assert.equal(state.inbox[0].feishuMode, 'todo_only');
  assert.equal(state.inbox[0].feishuExplicitTodo, true);
  assert.equal(state.todos.length, 0);
  assert.deepEqual(state.todayPlan, []);
  result = await syncFeishuInbox({ store, client });
  assert.equal(result.imported, 0);
  assert.equal(result.seenSkipped, 1);
  assert.equal((await store.readState()).inbox.length, 1);

  current = xml([]);
  result = await syncFeishuInbox({ store, client });
  assert.equal(result.removed, 0);
  state = await store.readState();
  assert.equal(state.inbox.length, 1);
  assert.equal(state.inboxAcks.length, 1);
});

test('new local inbox writes explicit [INBOX] todo to Feishu first and only commits local cache after readback', async t => {
  const store = await fixture(t);
  const calls = [];
  const client = {
    appendAndFetch: async (config, text) => {
      calls.push({ config, text });
      return { item: { blockId: 'blk_new', text, explicitInbox:true, explicitTodo:true, todoKind:'inbox_marker' }, mode:'todo_only', revisionId: 8, items: [{ blockId: 'blk_new', text }] };
    }
  };
  const item = await addInbox({ store, text: '先写飞书再缓存', source: 'manual', client });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '先写飞书再缓存');
  assert.equal(item.source, 'feishu_todo');
  assert.equal(item.feishuMode, 'todo_only');
  assert.equal(item.feishuExplicitTodo, true);
  assert.equal(item.feishuBlockId, 'blk_new');
  assert.equal((await store.readState()).inbox[0].feishuBlockId, 'blk_new');
});

test('CLI adapter uses v2 fetch and inserts inside 收件箱 instead of appending outside it', async () => {
  const calls = [];
  let hasNew = false;
  const fakeExec = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('+fetch')) return { stdout: JSON.stringify({ data: { document: { content: xml(hasNew ? ['[INBOX] 现有', '[INBOX] 新增'] : ['[INBOX] 现有'], {}), revision_id: hasNew ? 4 : 3, document_id: 'doc' } } }) };
    hasNew = true;
    return { stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 4 } } }) };
  };
  const client = createFeishuJournalClient({ exec: fakeExec });
  const fetched = await client.fetch({ documentUrl: 'https://example.feishu.cn/wiki/test', inboxHeading: '收件箱', inboxPrefix: '[INBOX]' });
  assert.equal(fetched.mode,'todo_only');
  assert.equal(fetched.items[0].text, '现有');
  await client.appendAndFetch({ documentUrl: 'https://example.feishu.cn/wiki/test', inboxHeading: '收件箱', inboxPrefix: '[INBOX]' }, '新增');
  const update = calls.find(call => call.args.includes('+update'));
  assert.ok(update);
  assert.ok(update.args.includes('block_insert_after'));
  assert.ok(update.args.includes('blk_0'));
  assert.ok(update.args.includes('--api-version') && update.args.includes('v2'));
});
