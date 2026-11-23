/**
 * The preview page — dev only, never shipped.
 *
 * A thin fake host around the **real** client bundle: it declares the `main`
 * keyed slot, lets `lib/client.js` seat the workbench on it through the same
 * `apply(ctx)` call a DSH host makes, and renders whatever the seat registered.
 * Nothing of the panel is re-implemented here; the only things written by this
 * file are the chrome around it (a rail, a title bar) and the module-table shim
 * React needs.
 *
 * The chrome is labelled as fake in the title bar on purpose: a screenshot that
 * looks like the DSH GUI but is not must say so, or the next reader will trust
 * the frame as much as the panel.
 */

/** Module table shim + mount, as one inline script (no build step involved). */
const BOOT = `
window.__defs = {};
window.__cache = {};
window.__define = function (name, factory) { window.__defs[name] = factory; };
window.__require = function (name) {
  if (Object.prototype.hasOwnProperty.call(window.__cache, name)) return window.__cache[name].exports;
  var factory = window.__defs[name];
  if (typeof factory !== 'function') throw new Error('preview host has no module: ' + name);
  var module = { exports: {} };
  window.__cache[name] = module;
  factory(module, module.exports, window.__require);
  return module.exports;
};
window.__ModuleLoader__ = {
  load: function (spec) { window.__forge = spec.factory(window.__require); }
};
window.__pv = {
  ready: false,
  mounted: false,
  seat: null,
  errors: [],
  activateCanvas: function () {
    var tab = document.querySelector('[data-tab-kind="canvas"]');
    if (!tab) return false;
    tab.click();
    return true;
  },
  activateProjects: function () {
    var tab = document.querySelector('[data-tab-kind="projects"]');
    if (!tab) return false;
    tab.click();
    return true;
  }
};
window.addEventListener('error', function (event) {
  window.__pv.errors.push('window.error: ' + (event.message || String(event.error)));
});
window.addEventListener('unhandledrejection', function (event) {
  window.__pv.errors.push('unhandledrejection: ' + String(event.reason && event.reason.message ? event.reason.message : event.reason));
});
`

/** Mount script: the seat lookup and the React root. */
const MOUNT = `
(function () {
  var React = window.__require('react');
  var ReactDOM = window.__require('react-dom/client');
  if (window.__forge === undefined) {
    document.getElementById('pv-boot-note').textContent = '客户端 apply 没有被调用：__forge 未注册。';
    return;
  }
  var seats = [];
  var ctx = {
    slots: {
      inject: function (name, register) { register(); },
      register: function (options, component) {
        seats.push({ options: options, component: component });
        return function () {};
      }
    },
    get: function () { return undefined; }
  };
  try {
    window.__forge.apply(ctx);
  } catch (error) {
    document.getElementById('pv-boot-note').textContent = 'apply() 抛错：' + (error && error.message ? error.message : String(error));
    return;
  }
  var seat = null;
  for (var index = 0; index < seats.length; index += 1) {
    if (seats[index].options && seats[index].options.name === 'main') seat = seats[index];
  }
  window.__pv.seat = seat === null ? null : { name: seat.options.name, key: seat.options.key };
  if (seat === null) {
    document.getElementById('pv-boot-note').textContent = '没有拿到 main 席位，客户端没有注册工作台。席位：' +
      seats.map(function (entry) { return entry.options.name + (entry.options.key ? '/' + entry.options.key : ''); }).join(', ');
    return;
  }
  ReactDOM.createRoot(document.getElementById('panel')).render(React.createElement(seat.component));
  var timer = setInterval(function () {
    if (document.querySelector('.dsh-forge-workbench') !== null) {
      window.__pv.mounted = true;
      clearInterval(timer);
    }
  }, 50);
})();
`

/** The fake host chrome. Neutral greys on purpose: it must read as scaffolding. */
const SHELL_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    color: #1c1e21;
    background: #eef0f3;
    overflow: hidden;
  }
  .pv-app { display: flex; height: 100vh; }
  .pv-rail {
    width: 216px;
    flex: none;
    background: #fafbfc;
    border-right: 1px solid #dfe3e8;
    padding: 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .pv-rail-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8a9099; padding: 0 8px 8px; }
  .pv-rail-item { padding: 7px 10px; border-radius: 7px; color: #5b6169; }
  .pv-rail-item.is-active { background: #e8ecf1; color: #1c1e21; font-weight: 500; }
  .pv-rail-foot { margin-top: auto; font-size: 11px; color: #999; padding: 8px; line-height: 1.5; }
  .pv-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .pv-titlebar {
    height: 42px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    background: #fff;
    border-bottom: 1px solid #dfe3e8;
    font-size: 12.5px;
    color: #5b6169;
  }
  .pv-titlebar b { font-size: 13px; color: #1c1e21; font-weight: 600; }
  .pv-badge {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    background: #fff4e5;
    color: #9a5b00;
    border: 1px solid #f0d9b7;
  }
  .pv-body { flex: 1; min-height: 0; padding: 14px 16px 18px; }
  .pv-panel {
    height: 100%;
    background: #fff;
    border: 1px solid #e1e5ea;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
  }
  .pv-panel > * { flex: 1; min-width: 0; }
  .pv-boot-note { font-size: 12px; color: #b3261e; padding: 10px 2px 0; }
`

/**
 * The whole page.
 *
 * @param {{vendorScripts: string[], mainBoardName: string}} options - vendor URLs, in load order, and the project name shown in the title bar.
 * @returns {string} the HTML document.
 */
export function previewPage(options) {
  const vendorTags = options.vendorScripts.map((src) => `<script src="${src}"></script>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-image-forge · 工作台预览（${options.mainBoardName}）</title>
<style>${SHELL_CSS}</style>
<script>${BOOT}</script>
${vendorTags}
</head>
<body>
<div class="pv-app">
  <aside class="pv-rail">
    <div class="pv-rail-title">DeepSeek Harness</div>
    <div class="pv-rail-item">对话</div>
    <div class="pv-rail-item">插件</div>
    <div class="pv-rail-item is-active">图像工作台</div>
    <div class="pv-rail-item">设置</div>
    <div class="pv-rail-foot">预览外壳：左侧栏与标题栏是假的，中间面板是真实的 <code>lib/client.js</code>。</div>
  </aside>
  <div class="pv-main">
    <div class="pv-titlebar">
      <b>图像工作台</b>
      <span class="pv-badge">预览外壳 · 非真实 DSH 主题</span>
      <span>真实客户端 bundle · 真实 studio 路由 · 假数据（不连 ComfyUI）</span>
    </div>
    <div class="pv-body">
      <div class="pv-panel" id="panel"></div>
    </div>
    <div class="pv-boot-note" id="pv-boot-note"></div>
  </div>
</div>
<script src="/client.js"></script>
<script>${MOUNT}</script>
</body>
</html>`
}
