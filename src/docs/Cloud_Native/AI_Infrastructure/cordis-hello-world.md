# Cordis Hello World：跑通可逆副作用与响应式依赖

> 概念与原理见 [Cordis：时空可组合性元框架](./cordis.md)。本文是它的「上手」配套页——用 ~70 行可运行代码把两个核心保证各演示一遍：
> 1. **时间可组合（Temporal）**：卸载一个插件，它注册过的所有 effect（事件、服务、资源）被完整回收；
> 2. **空间可组合（Spatial）**：插件声明依赖后，依赖出现/消失时它被**自动**激活/停用，无需手写任何重连逻辑。
>
> 示例基于 `cordis@4.0.0-rc.9`（[README](https://github.com/cordiverse/cordis) 明示 API 仍在演进、可能变更）。

## 本地 build & run

demo 不是散装单文件，而是本页 assets 目录里的**完整 npm 工程**（自带 `package.json` / `tsconfig.json` / `README.md`，纯 ESM，核心只依赖 `cordis`）：

```bash
# 1. 进入 demo 工程目录（仓库内路径）：
cd src/docs/Cloud_Native/AI_Infrastructure/cordis-hello-world.assets

# 2. 安装依赖（cordis 运行时 + tsx/typescript 构建工具）
npm install

# 3a. 开发模式直接跑 TS（tsx，Node >= 22 均可）：
npm run dev

# 3b. 或正式构建后运行（tsc 编译到 dist/，node 跑产物）：
npm run build
npm start
```

也支持 Node >= 23.6 的内置 type-stripping 直接执行源码（本工程 `package.json` 已声明 `"type": "module"`）：

```bash
node hello-world.ts
```

三种跑法输出一致，见下方「预期输出」。

> 若之后要构建整个 wiki（仓库根目录 `make build`），请先删除本目录的 `node_modules/` 与 `dist/`——mdBook 会把 src 下非 markdown 文件整体拷进 `book/`（Latest updates 扫描已跳过 `.assets` 与 `node_modules`）。

## 完整代码

源码文件：[hello-world.ts](./cordis-hello-world.assets/hello-world.ts)（工程内其余文件：`package.json`、`tsconfig.json`、`README.md`）

```ts
// hello-world.ts — Cordis Hello World：可逆副作用 + 响应式依赖最小演示
// 本目录是完整 npm 工程：npm install → npm run build && npm start（或 npm run dev）
// 详见 README.md 与配套 wiki 页 cordis-hello-world.md
import { Context, type Plugin } from 'cordis'

// 类型化（零运行时开销）：告诉 TS ctx.greeter 与 'say/hello' 事件的形状
declare module 'cordis' {
  interface Context {
    greeter: { greet(name: string): void }
  }
  interface Events {
    'say/hello'(name: string): void
  }
}

// 注意：函数插件请写成箭头函数（或 { apply(ctx) {} } 对象）——
// 具名 function 声明带 prototype，会被 Cordis 当作"类插件"用 new 实例化，
// 此时 apply 的 return disposer 不会被收集（见配套页面「踩坑」一节）。

// ── 插件 A：提供 greeter 服务 ────────────────────────────────────────────────
const greeter: Plugin = (ctx) => {
  ctx.provide('greeter', {
    greet(name: string) {
      console.log(`[greeter] Hello, ${name}!`)
    },
  })
  ctx.effect(() => {
    console.log('[greeter] timer started')
    return () => console.log('[greeter] timer stopped')
  })
  console.log('[greeter] service up')
  return () => console.log('[greeter] service down')
}

// ── 插件 B：依赖 greeter 服务，订阅 'say/hello' 事件 ─────────────────────────
const hello: Plugin = (ctx) => {
  console.log('[hello] activated')
  ctx.on('say/hello', (name: string) => ctx.greeter.greet(name)) // effect：卸载自动摘除
  return () => console.log('[hello] deactivated')
}
hello.inject = ['greeter'] // coeffect 声明：greeter 不在就绝不执行

async function main() {
  const root = new Context()

  // 1) 先装依赖方 —— 服务还没出现，插件停在 PENDING，什么都不做
  const helloFiber = await root.plugin(hello)
  console.log('[main] step 1 — hello installed while greeter missing:')
  root.emit('say/hello', 'nobody') // 无输出：listener 尚未注册

  // 2) 装提供者 —— 依赖出现，hello 被自动激活（空间可组合 / spatial composability）
  const greeterFiber = await root.plugin(greeter)
  await helloFiber
  console.log('[main] step 2 — greeter provided, hello auto-activated:')
  root.emit('say/hello', 'Cordis') // [greeter] Hello, Cordis!

  // 3) 卸载提供者 —— 依赖消失，hello 自动停用，双方 effect 全部逆序回收
  await greeterFiber.dispose()
  console.log('[main] step 3 — greeter withdrawn, hello auto-deactivated:')
  root.emit('say/hello', 'nobody') // 无输出：listener 已被回收

  // 4) 服务恢复 —— hello 无需重装，自动复活
  await root.plugin(greeter)
  await helloFiber
  console.log('[main] step 4 — greeter back, hello auto-reactivated:')
  root.emit('say/hello', 'again') // [greeter] Hello, again!

  // 5) 显式卸载 hello（时间可组合 / temporal composability；dispose 幂等）
  await helloFiber.dispose()
  await helloFiber.dispose()
  console.log('[main] step 5 — done')
}

// 顶层 await：失败时 Node 会打印错误并以非 0 退出
await main()
```

## 预期输出

```
[main] step 1 — hello installed while greeter missing:
[greeter] timer started
[greeter] service up
[hello] activated
[main] step 2 — greeter provided, hello auto-activated:
[greeter] Hello, Cordis!
[greeter] service down
[greeter] timer stopped
[hello] deactivated
[main] step 3 — greeter withdrawn, hello auto-deactivated:
[greeter] timer started
[greeter] service up
[hello] activated
[main] step 4 — greeter back, hello auto-reactivated:
[greeter] Hello, again!
[hello] deactivated
[main] step 5 — done
```

## 逐步拆解：五步各对应什么机制

### Step 1 — `inject` 不满足 = coeffect 未满足，插件不执行

`hello` 声明了 `inject: ['greeter']`（响应式 coeffect）。此时 `greeter` 还没被提供，依赖求值结果为「不该运行」，fiber 停在 PENDING：`apply` 不执行、事件监听没注册，所以 `emit('say/hello')` 没有任何输出——这是**结构性保证**，不是插件作者自己写的 if 判断。

### Step 2 — `provide` 一个服务，依赖者被自动激活（空间可组合）

`greeter` 的 `ctx.provide('greeter', ...)` 本身就是一个 **effect**（注册进 fiber 的效果树）。提供者进入 ACTIVE 后，`ReflectService.notify(['greeter'])` 找出所有声明了该依赖的 fiber 并触发 `refresh`：

- `hello` 的 fiber 自动 `reload`，`apply` 执行：`ctx.on('say/hello', ...)`（也是 effect）注册成功；
- apply 内直接 `ctx.greeter.greet(...)`——Proxy 解析沿已提交视图找到提供者实现。

### Step 3 — 卸载提供者，一切自动逆序回收（时间可组合 + 依赖级联）

`await greeterFiber.dispose()` 触发的回收顺序（输出即证据）：

1. `[greeter] service down` —— apply **return 的 disposer**；
2. `[greeter] timer stopped` —— `ctx.effect(() => { ...; return () => ... })` 的逆（注册顺序倒序 = LIFO）；
3. `[hello] deactivated` —— provide 的逆先**摘除服务再通知依赖者**：`hello` 的依赖不满足了，被自动 unload，它自己的 `ctx.on` 与 return disposer 一并回收。

这之后 `emit('say/hello', ...)` 再次静默——监听器确实没了，**不需要手动退订**。

### Step 4 — 服务恢复，依赖者自动复活

再次 `root.plugin(greeter)`，同一套 notify 机制把 `hello` 拉回 ACTIVE，事件监听重新挂上。`hello` 从头到尾只安装过一次，生命周期完全由依赖状态驱动。

### Step 5 — dispose 幂等

同一个 fiber `dispose()` 两次，第二次是 no-op（`[hello] deactivated` 只出现一次）。

## 两个容易踩的坑

1. **函数插件用箭头函数或 `{ apply }` 对象，不要用 `function` 声明。** Cordis 靠「是否有 `prototype`」区分函数插件与类插件：具名 `function` 声明是可构造的，会被当成**类插件**用 `new` 实例化——构造器模式的清理语义走 `ctx.effect`/`ctx.provide` 而非 return 值，因此 `return () => {...}` 的 disposer 会被静默丢弃。核心包测试中的函数插件也普遍写作 `const plugin = (ctx) => ...` 或 `{ apply(ctx) {} }`。想用类/`extends Service` 写服务插件没问题，但清理要落在构造器里注册的 effect 上。
2. **`ctx.effect` 回调与插件 apply 的 return 是两种等价的 disposer 写法**，但前者更通用：生成器形式（`yield` 逆）还能表达顺序敏感的清理，且与注册顺序无关地可靠回收。Hello World 两种都演示了（greeter 的 timer 用 `ctx.effect`，service down 用 return）。

## 概念对照

| 代码 | 概念（见 [cordis.md](./cordis.md)） |
|---|---|
| `new Context()` | 根 Context，自带 `events/logger/reflect/registry` 服务 |
| `root.plugin(plugin, config?)` | 实例化插件 → 返回 Fiber（可 await） |
| `hello.inject = ['greeter']` | coeffect 声明（响应式依赖） |
| `ctx.provide('greeter', impl)` | 安装服务；本身是 effect，卸载自动回收并 notify 依赖者 |
| `ctx.on / ctx.effect` | 事件监听 / 通用副作用；注册即返回逆（disposer） |
| `ctx.greeter` | Proxy 属性访问 = 对当前视图解析服务（未激活时访问会抛错） |
| `await fiber.dispose()` | 卸载：LIFO 逆序回收全部 effect，幂等 |
| `declare module 'cordis'` | 类型化事件与服务（Events / Context 接口增强，零运行时开销） |

## 相关页面

- [Cordis：时空可组合性元框架](./cordis.md) — 概念、架构、Fiber 状态机、HMR 引擎与选型理由
- [kagent](./kagent.md) — 对比：K8s 声明式编排 vs Cordis 运行时动态组合
- [Agent Substrate](./agent-substrate.md) / [Agent Sandbox](./agent-sandbox.md) — effect 化资源管理之外的沙箱隔离路线
