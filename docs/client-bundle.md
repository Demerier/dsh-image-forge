# 客户端接入与产物格式（详细）

### 客户端加载须知（两个 inject 不是一回事）

这份 `package.json` 里有**两个 `inject`**，它们在不同的层、要填不同的东西 —— 混淆过一次，
症状是 web 客户端启动时报 `import failed` / `did not activate`：

| 位置 | 填什么 | 当前值 |
|---|---|---|
| `package.json` → `dsh.client.inject` | **客户端模块的包名** | `@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-renderer` |
| `src/client.ts` → `export const inject` | **cordis 服务名** | `['slots', 'configForms']` |

- 前者是「先把这些客户端模块加载起来」的清单，只接受**能解析到的包名**（参照实现里 20 个插件的值
  全是 `@deepseek-ai/dsh-client-*` / `@deepseek-ai/dsh-api-*`；写裸服务名如 `"slots"` 会解析失败）。
- 后者是 cordis 的依赖声明：`slots` 是槽注册表，`configForms` 是本分区绑宿主原生表单用的服务
  （**所有**在参照实现里带设置分区的插件都声明了它）。
- 关于 `immediately`：DSH 官方模板里**有**这个字段（`templates/decoration/package.json`），
  但本机已安装的 20 个 `dsh.client` 插件**都没用它**。本仓库**不再使用**它。
  **这里必须说清楚：它既不是病根、也不是禁令** —— 当初删掉它是因为它同时不符合本地惯例，
  而真正导致 `import failed` 的是产物格式（见[下一节](#客户端产物必须是-lazy-cjs-factory否则-web-端直接起不来)）。

### 客户端产物必须是 lazy-CJS factory（否则 web 端直接起不来）

**`lib/client.js` 不是 ESM 模块，`lib/index.js` 才是。** 两个半边是两种不同格式，别一起改：

- **宿主半边** `lib/index.js`：普通 ESM，宿主用 `import()` 加载它。
- **浏览器半边** `lib/client.js`：**只注册一个惰性 factory**，由 web 客户端求值：

  ```js
  window.__ModuleLoader__.load({
    id: "dsh-image-forge",              // 必须 = 包名
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      …
      return module.exports;            // 只发布 apply 与 inject
    }
  });
  ```

  执行 bundle **只注册 factory**；所有模块体副作用（含 CSS 注入）都在 factory 闭包里，等到物化时才跑。
  本插件在 `apply()` 里调用 `injectClientStyles()`（`src/client-styles.ts`）：往 `document.head` 插一根
  `id="dsh-image-forge-client-styles"` 的 `<style>`，幂等。样式跟设置页/工具卡片的 `dsh-image-forge-*`
  类名绑定，布局用**容器查询**（`container-type: inline-size`）按设置栏自身宽度切换标签/控件双栏或堆叠——
  宽 Host 窗口里的窄设置栏也会堆叠，视口 `@media` 看不见这种情况。
  React 来自 shell 预置的**冻结模块表**（`PLATFORM_MODULES`），因此走 factory 的 `require("react")`，
  **既不打包进来、也不写进 `dsh.client.external`**（它已在基线表里）。而且必须**单文件、零相对
  `require`** —— loader 只物化这一个 bundle，不能同步解析同级的 `client*.js`。

  这条由 **`tsdown.client.config.ts`** 负责（CJS 输出 + banner 开 factory + footer 关 factory），
  由 `pnpm build` 跑两趟：`tsdown && tsdown -c tsdown.client.config.ts`（第二条**不能开 `clean`**，
  否则会删掉同一目录里的 `lib/index.js`）。

  > ⚠️ **为什么这件事必须写成断言**：顶层 `import` 的 ESM bundle **什么都不注册**，客户端只会报
  > `import failed` —— 而本仓库的 Node 测试**从不求值浏览器 bundle**，所以这个错误能在 100+ 个
  > 全绿用例下存活到第一次真机加载。`test/settings.test.mjs` 现在钉住：产物含
  > `window.__ModuleLoader__.load`、`id: "dsh-image-forge"`、`require("react")`、`return module.exports`，
  > **恰好只发布 `apply` / `inject`**，且**不含任何顶层 `import`/`export` 语句、不含相对 require、
  > 不含打包进来的 React**。

