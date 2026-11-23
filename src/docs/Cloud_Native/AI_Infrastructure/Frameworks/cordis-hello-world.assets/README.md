# Cordis Hello World（本地可 build / run 的最小 demo）

配套 wiki 页：`src/docs/Cloud_Native/AI_Infrastructure/cordis-hello-world.md`
（概念页：[`cordis.md`](../cordis.md)）

> ⚠️ 本目录位于 wiki 的 mdBook 源树内：跑 wiki 构建（`make build`）前请先删除
> `node_modules/` 与 `dist/`，否则它们会被整体拷进 `book/`。
> （本 wiki 的 Latest updates 扫描已跳过 `.assets` 与 `node_modules`。）

## 前置

- Node.js >= 22（用 `npm run dev` 时 tsx 负责跑 TS，不挑 Node 小版本；
  想在 Node >= 23.6 下直接用内置 type-stripping 跑，见下方「直接跑」）

## 安装

```bash
npm install
```

## 运行

```bash
npm run dev      # tsx 直接执行 hello-world.ts（开发最快）
```

## 构建 + 运行（编译产物）

```bash
npm run build    # tsc 编译到 dist/hello-world.js
npm start        # node dist/hello-world.js
```

## 直接跑（可选，Node >= 23.6）

本目录 package.json 已声明 `"type": "module"`，Node 会把 `.ts` 按 ESM 处理：

```bash
node hello-world.ts
```

## 预期输出

见 wiki 页「预期输出」一节（构建/直接跑产物一致）。
