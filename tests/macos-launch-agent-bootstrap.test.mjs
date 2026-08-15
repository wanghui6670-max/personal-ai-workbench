import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('LaunchAgent bootstrap relies on RunAtLoad and does not immediately kickstart',async()=>{
  const source=await fsp.readFile(new URL('../scripts/macos-launch-agent.mjs',import.meta.url),'utf8');
  const bootstrap=source.match(/async function bootstrap\(\)\{([\s\S]*?)\n\}/)?.[1]||'';
  assert.match(bootstrap,/\['bootstrap'/);
  assert.doesNotMatch(bootstrap,/execResult\('launchctl',\['kickstart'/);
  assert.match(source,/RunAtLoad=true|RunAtLoad/);
  assert.match(source,/waitForHealth\(binding\)/);
});
