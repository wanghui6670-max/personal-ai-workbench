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

test('install validates replacement plist before bootout and protects every cutover failure with explicit recovery',async()=>{
  const source=await fsp.readFile(new URL('../scripts/macos-launch-agent.mjs',import.meta.url),'utf8');
  const install=source.match(/async function install\(\)\{([\s\S]*?)\n\}\n\nasync function status/)?.[1]||'';
  const lintIndex=install.indexOf("execResult('plutil',['-lint',temp])");
  const bootoutIndex=install.indexOf('await bootout();cutoverStarted=true;');
  assert.ok(lintIndex>=0&&bootoutIndex>lintIndex,'replacement plist must be linted before old service is stopped');
  assert.match(install,/if\(!\(await waitForPortFree/);
  assert.match(install,/restorePreviousLaunchAgent\(\{previous,wasLoaded,binding\}\)/);
  assert.match(source,/expectedVersion:null/,'rollback health accepts the previous product version');
  assert.match(source,/transitionRecoveryError\('LaunchAgent 安装'/);
  assert.doesNotMatch(install,/bootstrap\(\)\.catch\(\(\)=>undefined\)/,'rollback bootstrap failure must never be swallowed');
});

test('restart attempts to restore a previously loaded service when cutover fails',async()=>{
  const source=await fsp.readFile(new URL('../scripts/macos-launch-agent.mjs',import.meta.url),'utf8');
  const restart=source.match(/async function restart\(\)\{([\s\S]*?)\n\}\n\nasync function uninstall/)?.[1]||'';
  assert.match(restart,/const wasLoaded=await loaded\(\)/);
  assert.match(restart,/await bootout\(\);cutoverStarted=true;/);
  assert.match(restart,/recoverCurrentLaunchAgent\(binding\)/);
  assert.match(source,/transitionRecoveryError\('LaunchAgent 重启'/);
});
