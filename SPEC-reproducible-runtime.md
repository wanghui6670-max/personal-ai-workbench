# Spec: reproducible-runtime

## Objective

`reproducible-runtime` 为 Personal AI Workbench R1 提供可复现、不可变、可审计且可回滚的本机正式运行环境。

正式运行必须能够证明：当前 Git 提交、安装计划、LaunchAgent、实际 Node 进程和浏览器收到的静态资源属于同一个构建。开发模式可以继续直接运行工作树，但必须显式标记为未验证，不能冒充正式构建。

本模块服务于 `local_single_user` 发布画像：单用户、单 Mac、单进程、单 `DATA_DIR`、LaunchAgent 常驻、默认仅监听 loopback。

## Tech Stack

- Node.js `24.19.0`
- npm `11.17.0`
- ECMAScript modules
- macOS LaunchAgent
- detached Git worktree 或等价的版本化不可变 release 目录
- release 外的版本化运行配置 revision（权限 `0600`）
- JSON build manifest
- SHA-256 资产摘要
- Node built-in test runner
- Puppeteer browser smoke

## Commands

```bash
node --version
npm --version
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix harness --ignore-scripts --no-audit --no-fund
node --test tests/build-identity.test.mjs
node --test tests/doctor.test.mjs tests/host-p0.test.mjs
npm test
npm run verify
npm run p0:host
npm run service:macos -- status
```

正式 LaunchAgent 的 `install`、`restart`、`uninstall` 和真实 cutover 不属于普通测试命令；只有进入已确认的部署任务后才执行。

## Project Structure

```text
src/build-identity.mjs          build identity 与 manifest 纯核心
src/production-entry.mjs        正式服务启动前 fail-closed 门
src/http.mjs                    冻结静态资产响应与请求级版本保护
src/server.mjs                  health 和业务服务组合
src/health.mjs                  本地数据 readiness
src/host-p0.mjs                 LaunchAgent 与主机合同纯函数
scripts/p0-host-preflight.mjs   结构化主机预检
scripts/macos-launch-agent.mjs  release 准备、切换、状态和回滚
scripts/browser-boot-smoke.mjs  浏览器启动与版本不一致 smoke
tests/*.test.mjs                单元、集成和 CLI fixture 测试
```

## Code Style

沿用仓库现有的简洁 ESM 风格；校验失败使用稳定安全错误码，不在错误中包含凭证、正文或不必要的绝对路径。

```js
export function assertBuildMatch(expected,actual){
  if(expected.commit!==actual.commit){
    throw Object.assign(new Error('Workbench build mismatch.'),{
      code:'WORKBENCH_BUILD_MISMATCH'
    });
  }
}
```

规则：

- 一个函数只承担一个合同。
- manifest 只包含可复现字段，不包含绝对路径、mtime、权限或环境值。
- 正式模式缺字段、字段不一致或资产校验失败时一律 fail closed。
- 开发模式和正式模式不得通过隐式猜测互相降级。

## Testing Strategy

所有行为变更执行 RED → GREEN → 回归。

1. **纯单元测试**：身份字段、规范哈希、路径安全、重复/缺失/额外资产、manifest 篡改。
2. **静态资产集成测试**：正式资产只来自 Git tracked allowlist；服务启动后修改工作树不能改变 HTTP 响应。
3. **启动门测试**：错误 SHA、dirty tracked runtime、未跟踪运行文件、错误 manifest 在加载 `server.mjs` 前退出。
4. **health/status 测试**：HEAD、release manifest、plist、service manifest、runtime health 任一不一致均失败。
5. **浏览器测试**：版本不一致时不加载业务入口、不读取业务状态、不允许写请求；旧页面写入新后端返回 `409 WORKBENCH_BUILD_MISMATCH`。
6. **安装 fixture 测试**：在隔离目录验证 staging、原子切换和回滚；不触碰真实 LaunchAgent。
7. **现场验收**：只有正式部署任务才执行真实 LaunchAgent cutover、重启和读回。

每个测试必须命名它能捕获的生产缺陷，并断言真实可观察行为，不用源码字符串断言代替执行结果。

## Boundaries

### Always

- 以 `.node-version`、`packageManager` 和 lockfile 为唯一工具链合同。
- 正式 release 只包含 Git 已跟踪的运行文件。
- 生成 release 前拒绝 tracked runtime dirty；正式资产通过 allowlist 生成。
- 静态资产在启动时完整验证并冻结。
- health、安装清单和 status 使用同一个 build identity schema。
- 保留至少一个可读回的旧 release 作为回滚点。
- 正式配置通过显式 `WORKBENCH_ENV_FILE` 指向 release 外的不可变 revision；release 内不保存 `.env`。
- 保留用户未跟踪的 `CLAUDE.md`、`docs/HANDOFF_20260820.md`、`public/preview.html`，但不得把它们复制进正式 release。

### Ask First

- 切换、重启或卸载真实 LaunchAgent。
- 修改真实 `.env`、`DATA_DIR`、登录态或凭证。
- 真实外部调用、外部写入、Git push 或托管平台设置。

### Never

- 直接在 live checkout 上执行 `git pull` 后继续让旧进程读取该目录。
- 把未跟踪文件、凭证、Cookie、token 或 `.env` 内容打入 release。
- 仅凭 health `200`、SemVer 或 plist 中的 SHA 声称运行版本一致。
- 版本不一致时继续加载业务前端或接受浏览器写请求。
- 为了通过状态检查而修改或删除用户原有未跟踪文件。

## Success Criteria

1. 干净检出在 Node `24.19.0`、npm `11.17.0` 下可使用根/Harness lockfile完成安装和全量验证。
2. 正式 release 位于独立版本化目录，不从可变开发工作树提供代码或静态资产。
3. 正式配置位于 release 外的版本化 `0600` revision；新旧 plist 分别绑定自己的配置 revision，代码回滚同时恢复对应配置。
4. build identity 至少包含完整 Git SHA、产品版本、固定构建时间、精确 Node/npm、根/Harness lock 摘要、静态资产数量和规范 manifest SHA-256。
5. 正式静态 manifest 只根据 Git tracked `public/**` 生成；未跟踪 `public/preview.html` 不进入 release 且 HTTP 返回 404。
6. 正式入口在加载业务服务前验证提交、tracked runtime clean 状态、manifest 和全部静态资产。
7. 静态资源从启动时冻结的 Buffer/allowlist 提供，运行中修改源工作树不会改变响应。
8. `/api/health` 返回固定且完整的运行 build identity，不在每次请求时读取 Git。
9. LaunchAgent plist、service manifest、runtime health 和浏览器 manifest 的 build identity 完全一致。
10. 浏览器身份不一致时锁定；旧页面向新后端写入时收到 `409 WORKBENCH_BUILD_MISMATCH`，且业务状态不变。
11. 安装、重启或验证失败时能恢复上一个完整 build identity 和对应配置；原错误和恢复错误均可安全读回。
12. `npm run service:macos -- status` 只有在 source、installed、runtime、toolchain、lock 和 static identities 全部一致时退出 `0`。

## Open Questions

- release/config/runtime 根目录的最终默认位置需在安装切片中确定，但必须与可变 Git checkout、业务 `DATA_DIR` 和 `WORKSPACE_ROOT` 分离。
- Node runtime 首版记录并校验精确外部二进制；是否在后续版本打包自带 Node，不阻塞 R1。
- 完整运行代码的可重复证明首版使用 detached worktree + clean tracked runtime gate；若未来出现运行期动态加载代码，再扩展为 runtime file manifest。
