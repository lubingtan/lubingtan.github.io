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

