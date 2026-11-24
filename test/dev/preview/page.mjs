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


/** Host chrome around the real ImageEditorTab in the sidebar-only harness. */
const SIDEBAR_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;
    color: #22211d;
    background: #eef0f3;
    display: flex;
    justify-content: flex-end;
    overflow: hidden;
  }
  .pv-sidebar {
    width: 420px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: #fffdf8;
    border-left: 1px solid #ded8cb;
  }
  .pv-sidebar-head {
    height: 58px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-bottom: 1px solid #ded8cb;
    background: #fffdf8;
  }
  .pv-sidebar-mark {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: #e66a3a;
    color: #fff;
    font-weight: 800;
    font-size: 12px;
  }
  .pv-sidebar-copy { min-width: 0; }
  .pv-sidebar-title { display: block; font-size: 13px; font-weight: 650; line-height: 1.2; }
  .pv-sidebar-kicker { display: block; margin-top: 2px; color: #8a8176; font-size: 9px; letter-spacing: .12em; }
  .pv-sidebar-dev { margin-left: auto; color: #8a8176; font-size: 10px; border: 1px solid #ded8cb; border-radius: 999px; padding: 3px 7px; }
  .pv-sidebar-close { border: 0; background: transparent; color: #6f6a60; font-size: 22px; line-height: 1; padding: 4px; }
  .pv-sidebar-body { flex: 1; min-height: 0; overflow: auto; }
  .pv-sidebar-body > * { min-height: 100%; }
  .pv-sidebar-note { display: none; }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; }
    body { background: #181716; color: #f2ece1; }
    .pv-sidebar, .pv-sidebar-head { background: #24221e; border-color: #454139; }
  }
`

/** Mount the descriptor the real client bundle registered with the fake service. */
const SIDEBAR_MOUNT = `
(function () {
  var React = window.__require('react');
  var ReactDOM = window.__require('react-dom/client');
  var state = window.__pvSidebar;
  if (window.__forge === undefined) {
    document.getElementById('pv-sidebar-note').textContent = '客户端 apply 没有被调用：__forge 未注册。';
    return;
  }
  function conversation() {
    var snapshot = { draft: '', phase: 'plain', attachmentIds: [] };
    var listeners = new Set();
    function emit() { listeners.forEach(function (listener) { listener(); }); }
    var input = {
      state: {
        getSnapshot: function () { return snapshot; },
        subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; }
      },
      setDraft: function (text) { snapshot = Object.assign({}, snapshot, { draft: text }); emit(); },
      addAttachments: function (ids) {
        snapshot = Object.assign({}, snapshot, { attachmentIds: snapshot.attachmentIds.concat(ids) });
        emit();
        return true;
      },
      removeAttachment: function (id) {
        snapshot = Object.assign({}, snapshot, { attachmentIds: snapshot.attachmentIds.filter(function (candidate) { return candidate !== id; }) });
        emit();
        return true;
      },
      submit: function () {
        snapshot = Object.assign({}, snapshot, { phase: 'sending' });
        emit();
        setTimeout(function () { snapshot = { draft: '', phase: 'plain', attachmentIds: [] }; emit(); }, 30);
      },
      notify: function () {}
    };
    return {
      input: { for: function () { return input; } },
      createDrafts: function (_sessionId, files) {
        return files.map(function (file, index) { return { id: 'preview-draft-' + index, file: file }; });
      },
      releaseDraftAttachments: function () {}
    };
  }
  var conversationService = conversation();
  state.conversation = conversationService;
  state.setDraft = function (text) {
    var input = conversationService.input.for({});
    input.setDraft(text);
  };
  state.ready = true;

  var slots = [];
  var ctx = {
    slots: {
      inject: function (_name, register) { register(); },
      register: function (options, component) { slots.push({ options: options, component: component }); return function () {}; }
    },
    get: function (name) {
      if (name === 'conversation') return conversationService;
      if (name === 'betterSidebar') return state.sidebarService;
      return undefined;
    },
    effect: function (fn) { return fn(); },
    sessions: { scope: function (sessionId) { return { sessionId: sessionId }; } }
  };
  try {
    window.__forge.apply(ctx);
  } catch (error) {
    document.getElementById('pv-sidebar-note').textContent = 'apply() 抛错：' + (error && error.message ? error.message : String(error));
    return;
  }
  var descriptor = state.tabs.find(function (tab) { return tab.id === 'dsh-image-forge:image-editor'; });
  if (descriptor === undefined) {
    document.getElementById('pv-sidebar-note').textContent = '没有注册 dsh-image-forge:image-editor。已注册：' + state.tabs.map(function (tab) { return tab.id; }).join(', ');
    return;
  }
  state.descriptor = descriptor;
  ReactDOM.createRoot(document.getElementById('pv-sidebar-panel')).render(
    React.createElement(descriptor.component, {
      ctx: ctx,
      scope: { sessionId: 'preview-session' },
      tab: { meta: state.meta },
      visible: true
    })
  );
  var timer = setInterval(function () {
    if (document.querySelector('.dsh-image-forge-sidebar-editor') !== null) {
      state.mounted = true;
      clearInterval(timer);
    }
  }, 50);
})();
`

/**
 * Sidebar-only harness for the real Better Sidebar tab component.
 *
 * @param {{vendorScripts: string[], imagePath: string, boardId: string, itemId: string, layoutId: string}} options
 *   Vendor URLs plus the fixture board/image the tab should open.
 * @returns {string} an HTML page that mounts the registered tab descriptor.
 */
export function sidebarPage(options) {
  const vendorTags = options.vendorScripts.map((src) => `<script src="${src}"></script>`).join('\n')
  const metadata = JSON.stringify({
    boardId: options.boardId,
    itemId: options.itemId,
    imagePath: options.imagePath,
    title: '第 3 版 · 蓝光侧影',
    layoutId: options.layoutId,
    width: 1600,
    height: 900,
  })
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>画面编辑 · Better Sidebar harness</title>
<style>${SIDEBAR_CSS}</style>
<script>${BOOT}</script>
<script>
window.__pvSidebar = {
  ready: false,
  mounted: false,
  tabs: [],
  opened: [],
  meta: ${metadata},
  sidebarService: {
    registerTab: function (descriptor) {
      window.__pvSidebar.tabs.push(descriptor);
      return function () {};
    },
    openTab: function (seed, scope) {
      window.__pvSidebar.opened.push({ seed: seed, scope: scope });
    }
  }
};
</script>
${vendorTags}
</head>
<body>
<aside class="pv-sidebar" aria-label="Better Sidebar 开发夹具">
  <header class="pv-sidebar-head">
    <span class="pv-sidebar-mark" aria-hidden="true">F</span>
    <span class="pv-sidebar-copy"><strong class="pv-sidebar-title">画面编辑</strong><span class="pv-sidebar-kicker">BETTER SIDEBAR</span></span>
    <span class="pv-sidebar-dev">DEV HARNESS</span>
    <button class="pv-sidebar-close" type="button" aria-label="关闭">×</button>
  </header>
  <div class="pv-sidebar-body" id="pv-sidebar-panel"></div>
</aside>
<div class="pv-sidebar-note" id="pv-sidebar-note">真实 Better Sidebar Tab 组件 · 假会话附件</div>
<script src="/client.js"></script>
<script>${SIDEBAR_MOUNT}</script>
</body>
</html>`
}


/** A real tool-result card in a neutral conversation stage. */
export function resultCardPage(options) {
  const vendorTags = options.vendorScripts.map((src) => `<script src="${src}"></script>`).join('\n')
  const payload = JSON.stringify({
    images: [
      { index: 1, path: options.imagePaths[0], width: 1600, height: 900, bytes: 36784 },
      { index: 2, path: options.imagePaths[1], width: 608, height: 1080, bytes: 22913 },
    ],
    board: { id: options.boardId, name: '雨夜东京 · 竖构图', created: true, item_ids: ['node-wide', 'node-tall'] },
    wh_ratio: '16:9',
    steps_used: 8,
    seed: 20261118,
    model: 'Qwen 2.1 Turbo',
    prompt: '雨夜东京街口，霓虹招牌反射在积水上，16:9 横构图，浅景深。',
    size: { width: 1600, height: 900 },
    markdown: '![结果](fixture.png)',
  })
  const mount = `
(function () {
  var React = window.__require('react');
  var ReactDOM = window.__require('react-dom/client');
  var state = window.__pvResult;
  if (window.__forge === undefined) return;
  var slots = [];
  var ctx = {
    slots: {
      inject: function (_name, register) { register(); },
      register: function (options, component) { slots.push({ options: options, component: component }); return function () {}; }
    },
    get: function (name) { return name === 'betterSidebar' ? state.sidebar : undefined; },
    effect: function (fn) { return fn(); }
  };
  window.__forge.apply(ctx);
  var seat = slots.find(function (entry) { return entry.options && entry.options.name === 'tool.call.toolview' && entry.options.key === 'qwen_image_generate'; });
  if (!seat) {
    document.getElementById('pv-result-panel').textContent = '没有注册 qwen_image_generate 工具卡。';
    return;
  }
  state.seat = seat.options;
  ReactDOM.createRoot(document.getElementById('pv-result-panel')).render(
    React.createElement(seat.component, {
      toolName: 'qwen_image_generate',
      phase: 'result',
      sessionId: 'preview-session',
      block: { kind: 'tool-result', name: 'qwen_image_generate', content: [{ type: 'text', text: ${JSON.stringify(payload)} }] }
    })
  );
  var timer = setInterval(function () {
    if (document.querySelector('.dsh-image-forge-result-card')) {
      state.mounted = true;
      clearInterval(timer);
    }
  }, 50);
})();
`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qwen_image_generate · Result Card</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  body { font-family: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif; background: #f6f2e9; color: #22211d; padding: 28px; }
  .pv-result-stage { width: 680px; max-width: 100%; margin: 0 auto; }
  .pv-result-head { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; color: #6f6a60; font-size: 11px; letter-spacing: .08em; }
  .pv-result-mark { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 7px; background: #e66a3a; color: #fff; font-weight: 800; }
  .pv-result-note { margin-top: 14px; color: #6f6a60; font-size: 12px; }
</style>
<script>${BOOT}</script>
<script>
window.__pvResult = {
  mounted: false,
  opened: [],
  sidebar: {
    openTab: function (seed, scope) {
      window.__pvResult.opened.push({ seed: seed, scope: scope });
    },
    registerTab: function () { return function () {}; }
  }
};
</script>
${vendorTags}
</head>
<body>
<div class="pv-result-stage">
  <div class="pv-result-head"><span class="pv-result-mark">F</span><span>真实工具卡组件 · DEV HARNESS</span></div>
  <div id="pv-result-panel"></div>
  <p class="pv-result-note">同批次 2 张图；卡片数据中的 markdown 字段不会渲染成第二份原生图片。</p>
</div>
<script src="/client.js"></script>
<script>${mount}</script>
</body>
</html>`
}

/** A real settings-section mount inside a neutral DSH-like settings shell. */
export function settingsPage(options) {
  const vendorTags = options.vendorScripts.map((src) => `<script src="${src}"></script>`).join('\n')
  const mount = `
(function () {
  var React = window.__require('react');
  var ReactDOM = window.__require('react-dom/client');
  if (window.__forge === undefined) return;
  var seats = [];
  var ctx = {
    slots: {
      inject: function (name, register) { if (name === 'settings.section') register(); },
      register: function (options, component) { seats.push({ options: options, component: component }); return function () {}; }
    },
    get: function (name) { return name === 'configForms' ? window.__pvSettings.forms : undefined; },
    effect: function (fn) { return fn(); }
  };
  window.__forge.apply(ctx);
  var seat = seats.find(function (entry) { return entry.options && entry.options.name === 'settings.section'; });
  if (!seat) {
    document.getElementById('pv-settings-panel').textContent = '没有注册 settings.section。';
    return;
  }
  window.__pvSettings.seat = { name: seat.options.name, id: seat.options.id };
  ReactDOM.createRoot(document.getElementById('pv-settings-panel')).render(
    React.createElement(seat.component, seat.options.inject())
  );
  var timer = setInterval(function () {
    if (document.querySelector('.dsh-image-forge-settings')) {
      window.__pvSettings.mounted = true;
      clearInterval(timer);
    }
  }, 50);
})();
`
  const state = JSON.stringify({
    values: {
      outputDir: 'C:\\Users\\Demeri\\Pictures\\dsh-image-forge',
      timeoutMs: 180000,
      comfyEndpoint: 'http://127.0.0.1:8188',
      comfyPorts: '8000,8188,8189,8190,8191,8192',
      comfyModelsDir: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models',
      defaultSteps: 40,
      comfyuiSteps: null,
      comfyModel: 'qwen21-base',
      mossSampling: 'comfy',
      turboSteps: null,
      executionBackend: 'auto',
      comfyMcpBin: '',
      comfyBin: '',
      backendTimeoutMs: null,
      mcpDebug: false,
      backendTmpDir: '',
    },
    defaults: {
      outputDir: 'C:\\Users\\Demeri\\Pictures\\dsh-image-forge',
      timeoutMs: 180000,
      comfyEndpoint: '',
      comfyPorts: '8000,8188,8189,8190,8191,8192',
      comfyModelsDir: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models',
      defaultSteps: 40,
      comfyuiSteps: null,
      comfyModel: 'qwen21-base',
      mossSampling: 'comfy',
      turboSteps: null,
      executionBackend: 'auto',
      comfyMcpBin: '',
      comfyBin: '',
      backendTimeoutMs: null,
      mcpDebug: false,
      backendTmpDir: '',
    },
  })
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-image-forge · Settings</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  body { font-family: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif; background: #f6f2e9; color: #22211d; }
  .pv-settings-shell { display: grid; grid-template-columns: 208px minmax(0, 1fr); min-height: 100vh; }
  .pv-settings-rail { padding: 22px 12px; border-right: 1px solid rgba(34,33,29,.1); background: #faf8f3; }
  .pv-settings-rail-title { padding: 0 8px 12px; color: #8b857b; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; }
  .pv-settings-rail-row { padding: 8px 10px; border-radius: 8px; color: #6f6a60; font-size: 12px; }
  .pv-settings-rail-row.is-active { background: #efe9de; color: #22211d; font-weight: 650; }
  .pv-settings-rail-row + .pv-settings-rail-row { margin-top: 3px; }
  .pv-settings-main { min-width: 0; padding: 28px clamp(16px, 4vw, 54px) 42px; }
  .pv-settings-top { display: flex; align-items: center; gap: 10px; max-width: 1080px; margin: 0 auto 22px; color: #7c756b; font-size: 11px; letter-spacing: .08em; }
  .pv-settings-mark { display: grid; place-items: center; width: 25px; height: 25px; border-radius: 7px; background: #e66a3a; color: #fff; font-weight: 800; letter-spacing: 0; }
  .pv-settings-dev { margin-left: auto; padding: 3px 7px; border: 1px solid rgba(34,33,29,.12); border-radius: 999px; }
  #pv-settings-panel { max-width: 1080px; margin: 0 auto; }
  @media (max-width: 760px) {
    .pv-settings-shell { grid-template-columns: 1fr; }
    .pv-settings-rail { display: none; }
    .pv-settings-main { padding: 18px 10px 30px; }
  }
</style>
<script>${BOOT}</script>
<script>
window.__pvSettings = {
  mounted: false,
  errors: [],
  values: ${state}.values,
  defaults: ${state}.defaults,
  revision: 1,
  failKey: null,
  mode: 'ready',
  saveCalls: [],
  listeners: [],
  logMode: 'ready'
};
window.__pvSettings.forms = {
  describe: function () {
    return { getSnapshot: function () { return { view: { namespaces: [{ ns: 'dsh-image-forge' }] } }; }, subscribe: function () { return function () {}; } };
  },
  get: function () { return window.__pvSettings.form; }
};
window.__pvSettings.form = {
  getSnapshot: function () {
    return { status: 'ready', value: window.__pvSettings.values, revision: window.__pvSettings.revision, writable: true, mode: 'host' };
  },
  subscribe: function (listener) {
    window.__pvSettings.listeners.push(listener);
    return function () { window.__pvSettings.listeners = window.__pvSettings.listeners.filter(function (item) { return item !== listener; }); };
  },
  notify: function () { window.__pvSettings.listeners.slice().forEach(function (listener) { listener(); }); },
  set: function (key, value) {
    window.__pvSettings.saveCalls.push({ op: 'set', key: key, value: value });
    if (window.__pvSettings.failKey === key && !window.__pvSettings.failedOnce) {
      window.__pvSettings.failedOnce = true;
      return Promise.resolve(false);
    }
    return new Promise(function (resolve) {
      setTimeout(function () {
        window.__pvSettings.values = Object.assign({}, window.__pvSettings.values, { [key]: value });
        window.__pvSettings.revision += 1;
        window.__pvSettings.form.notify();
        resolve(true);
      }, 12);
    });
  },
  unset: function (key) {
    window.__pvSettings.saveCalls.push({ op: 'unset', key: key });
    return new Promise(function (resolve) {
      setTimeout(function () {
        window.__pvSettings.values = Object.assign({}, window.__pvSettings.values, { [key]: window.__pvSettings.defaults[key] });
        window.__pvSettings.revision += 1;
        window.__pvSettings.form.notify();
        resolve(true);
      }, 12);
    });
  }
};
window.__pvSettings.logLines = [
  { number: 41, text: 'Starting server', timestamp: '11:21:01.021', level: 'plain' },
  { number: 42, text: 'Total VRAM 24564 MB, total RAM 65222 MB', timestamp: '11:21:01.230', level: 'plain' },
  { number: 43, text: 'pytorch version: 2.8.0+cu128', timestamp: '11:21:01.310', level: 'plain' },
  { number: 44, text: 'Using device: cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync', timestamp: '11:21:02.120', level: 'info' },
  { number: 45, text: '[WARNING] lowvram patch applied to diffusion model', timestamp: '11:21:03.010', level: 'warn' },
  { number: 46, text: 'To see the GUI go to: http://127.0.0.1:8188', timestamp: '11:21:04.220', level: 'info' },
  { number: 47, text: 'Prompt executed in 9.2 seconds', timestamp: '11:22:14.050', level: 'info' }
];
var nativeFetch = window.fetch;
window.fetch = function (input, init) {
  var url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
  function json(body, status) {
    return Promise.resolve({ ok: status === undefined || status < 400, status: status || 200, json: function () { return Promise.resolve(body); }, text: function () { return Promise.resolve(JSON.stringify(body)); } });
  }
  if (url.indexOf('/studio/environment') >= 0) {
    var action = 'status';
    try { action = JSON.parse(init && init.body ? init.body : '{}').action || 'status'; } catch (_) {}
    if (action === 'start') window.__pvSettings.mode = 'ready';
    if (action === 'stop') window.__pvSettings.mode = 'not-running';
    var external = window.__pvSettings.mode === 'external';
    var readyProcess = window.__pvSettings.mode === 'ready' || external;
    return json({ environment: readyProcess
      ? { state: 'ready', owned: !external, canStop: !external, pid: external ? 9911 : 8188, endpoint: 'http://127.0.0.1:8188', logPath: 'C:\\\\ComfyUI\\\\logs\\\\dsh-image-forge-launch-preview.log', stopBlockedReason: external ? '该实例由用户自行启动，插件不会停止它。' : undefined }
      : { state: 'not-running', owned: false, canStop: false }
    });
  }
  if (url.indexOf('/studio/config') >= 0) {
    return json({
      ready: window.__pvSettings.mode === 'ready' || window.__pvSettings.mode === 'external',
      endpoint: window.__pvSettings.mode === 'not-running' ? undefined : 'http://127.0.0.1:8188',
      reason: window.__pvSettings.mode === 'ready' || window.__pvSettings.mode === 'external' ? undefined : 'ComfyUI 未运行。',
      defaultSteps: 40,
      outputDir: window.__pvSettings.values.outputDir,
      sizes: [],
      optimizeAvailable: false,
      boards: [],
      activeBoard: null
    });
  }
  if (url.indexOf('/studio/log') >= 0) {
    if (window.__pvSettings.logMode === 'error') return json({ error: '预览日志读取失败' }, 500);
    var lines = window.__pvSettings.logMode === 'empty' ? [] : window.__pvSettings.logLines;
    return json({ version: 'studio-log/v1', path: 'C:\\\\ComfyUI\\\\logs\\\\dsh-image-forge-launch-preview.log', source: 'plugin', totalLines: lines.length, fromLine: lines.length ? lines[0].number : 0, toLine: lines.length ? lines[lines.length - 1].number : 0, hasOlder: false, hasNewer: false, modifiedAt: new Date().toISOString(), timestampedLines: lines.length, lines: lines });
  }
  return nativeFetch(input, init);
};
</script>
${vendorTags}
</head>
<body>
<div class="pv-settings-shell">
  <aside class="pv-settings-rail">
    <div class="pv-settings-rail-title">DEEPSEEK HARNESS</div>
    <div class="pv-settings-rail-row">通用</div>
    <div class="pv-settings-rail-row">模型</div>
    <div class="pv-settings-rail-row">插件</div>
    <div class="pv-settings-rail-row is-active">生图配置</div>
  </aside>
  <main class="pv-settings-main">
    <div class="pv-settings-top"><span class="pv-settings-mark">F</span><span>真实设置分区组件</span><span class="pv-settings-dev">DEV HARNESS</span></div>
    <div id="pv-settings-panel"></div>
  </main>
</div>
<script src="/client.js"></script>
<script>${mount}</script>
</body>
</html>`
}
