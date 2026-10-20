/**
 * Visual preview harness for the settings page and tool cards.
 *
 * Not part of `pnpm test`. Builds `test/client-preview.html` from the real
 * `CLIENT_CSS` and the DOM shape `client.ts` renders, so a human (or a
 * screenshot) can check narrow-column wrapping and pill/checklist layout
 * without loading a full DSH host.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const styles = readFileSync(fileURLToPath(new URL('../src/client-styles.ts', import.meta.url)), 'utf8')

/** Pull one `export const NAME = \`…\`` body out of the stylesheet module. */
function extract(name) {
  // `\r?\n` on purpose: this repo is edited on Windows, so a CRLF checkout
  // would otherwise make both constants look absent and the preview empty.
  const match = styles.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`\\r?\\n`))
  return match?.[1]
}

const base = extract('CLIENT_CSS')
const studio = extract('STUDIO_CSS')
if (base === undefined || studio === undefined) {
  console.error('CLIENT_CSS / STUDIO_CSS extract failed')
  process.exit(1)
}
// `CLIENT_CSS` interpolates `${STUDIO_CSS}` so the shipped bundle carries both in
// one sheet. This harness reads the *source* file, so it has to do that
// substitution itself — without it the preview would silently render an
// unstyled Studio panel.
const css = base.replace('${STUDIO_CSS}', studio)

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-image-forge · settings + tool cards preview</title>
<style>${css}</style>
</head>
<body style="margin:16px;font-family:system-ui,sans-serif;background:#f6f7f9;color:#1c1e21">

<p style="max-width:640px;font-size:13px;margin:0 0 4px">
  <strong>这是工作台面板的版式预览</strong>（静态 DOM，不连 ComfyUI）。
  <a href="#studio">跳到工作台 ↓</a> · 上半部分是设置页窄列（360px）的换行检查。
</p>
<p style="max-width:360px;opacity:.6;font-size:12px">窄列预览（容器 360px）— 标签应落到控件上方，长路径 hint 应换行不裁切</p>
<div style="width:100%;max-width:360px" class="dsh-image-forge-settings">
  <p class="dsh-image-forge-settings-lead">改动会立即写入本插件的配置。</p>
  <section class="dsh-image-forge-settings-group" data-group="backend">
    <h3 class="dsh-image-forge-settings-group-title">后端选择</h3>
    <p class="dsh-image-forge-settings-group-hint">一次出图交给谁执行。</p>
    <div class="dsh-image-forge-settings-fields">
      <div class="dsh-image-forge-setting">
        <label class="dsh-image-forge-setting-label" for="f-backend">后端</label>
        <div class="dsh-image-forge-setting-control">
          <select id="f-backend"><option>auto（自动选择）</option></select>
        </div>
        <p class="dsh-image-forge-setting-hint">auto：有 key 就云端，否则 ComfyUI、worker。</p>
        <div class="dsh-image-forge-setting-status"></div>
      </div>
    </div>
  </section>
  <section class="dsh-image-forge-advisory" data-dsh-part="backend-perf">
    <h3 class="dsh-image-forge-advisory-title">8 GB 显存上做参考图编辑，请优先用 comfyui 后端</h3>
    <p class="dsh-image-forge-advisory-p">实测 1312×736 / 6 步：comfyui ≈ 19–23 s，本机 worker ≈ 219 s（纯管线）。</p>
    <p class="dsh-image-forge-advisory-p">文生图每步约 2.77×，但两侧量化档不同，不是纯后端差异；依据见 README 与 docs/configuration.md。</p>
  </section>
  <section class="dsh-image-forge-settings-group" data-group="local">
    <h3 class="dsh-image-forge-settings-group-title">本地运行时</h3>
    <p class="dsh-image-forge-settings-group-hint">本机 worker：目录、端口、显存。</p>
    <div class="dsh-image-forge-settings-fields">
      <div class="dsh-image-forge-setting">
        <label class="dsh-image-forge-setting-label" for="f-modelsDir">权重目录</label>
        <div class="dsh-image-forge-setting-control">
          <input id="f-modelsDir" type="text">
        </div>
        <p class="dsh-image-forge-setting-hint">留空 = 跟随运行时目录：C:\\Users\\Demeri\\.dsh-image-forge\\models\\qwen-image-2.1-bnb4bit。</p>
        <div class="dsh-image-forge-setting-status"></div>
      </div>
      <div class="dsh-image-forge-setting">
        <label class="dsh-image-forge-setting-label" for="f-budget">参考图条件化预算</label>
        <div class="dsh-image-forge-setting-control">
          <input id="f-budget" type="number" value="512">
          <span class="dsh-image-forge-setting-unit">像素/边</span>
        </div>
        <p class="dsh-image-forge-setting-hint">0=按画布推导；调低=降参考图分辨率；896/512 同画布目视无差（n=1）。</p>
        <div class="dsh-image-forge-setting-status"><span class="dsh-image-forge-setting-saved">已保存</span></div>
      </div>
      <div class="dsh-image-forge-setting">
        <label class="dsh-image-forge-setting-label" for="f-allow">允许超预算本地编辑</label>
        <div class="dsh-image-forge-setting-control">
          <input id="f-allow" type="checkbox">
        </div>
        <p class="dsh-image-forge-setting-hint">默认拒绝超尺寸门的本地编辑；开启=放行并自负风险。</p>
        <div class="dsh-image-forge-setting-status"><span class="dsh-image-forge-setting-failure">保存失败：宿主拒绝了这次写入。</span></div>
      </div>
      <div class="dsh-image-forge-setting">
        <label class="dsh-image-forge-setting-label" for="f-key">API Key</label>
        <div class="dsh-image-forge-setting-control">
          <input id="f-key" type="password" placeholder="已保存（留空表示不修改）">
        </div>
        <p class="dsh-image-forge-setting-hint">只写不读：已保存的密钥不会回显。本机环境变量优先于这里。</p>
        <div class="dsh-image-forge-setting-status"><span class="dsh-image-forge-setting-stored">已设置 ••••••••</span></div>
      </div>
    </div>
  </section>
  <section class="dsh-image-forge-settings-group" data-group="python" data-advanced="true">
    <h3 class="dsh-image-forge-settings-group-title">Python、依赖与权重（高级）</h3>
    <p class="dsh-image-forge-settings-group-hint">一般不用改；留空 = 自动。</p>
    <div class="dsh-image-forge-settings-fields">
      <div class="dsh-image-forge-setting">
        <label class="dsh-image-forge-setting-label" for="f-torch">CUDA wheel 标签</label>
        <div class="dsh-image-forge-setting-control">
          <input id="f-torch" type="text">
        </div>
        <p class="dsh-image-forge-setting-hint">留空 = 依次试 cu128、cu126、cu118。</p>
        <div class="dsh-image-forge-setting-status"></div>
      </div>
    </div>
  </section>
</div>

<p style="max-width:900px;opacity:.6;font-size:12px;margin-top:28px">宽列预览 + 工具卡片</p>
<div style="width:100%;max-width:900px;display:flex;flex-direction:column;gap:12px">
  <div class="dsh-image-forge-row">
    <div class="dsh-image-forge-row-head">
      <h4 class="dsh-image-forge-row-title">文生图</h4>
      <span class="dsh-image-forge-row-status">完成：2 张</span>
    </div>
    <div class="dsh-image-forge-row-meta">
      <span class="dsh-image-forge-pill">1664×928</span>
      <span class="dsh-image-forge-pill">api</span>
      <span class="dsh-image-forge-pill">wh_ratio 16:9</span>
      <span class="dsh-image-forge-pill">20 步</span>
    </div>
    <div class="dsh-image-forge-images">
      <img alt="preview-a" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect fill='%23c5d4e8' width='320' height='180'/%3E%3C/svg%3E">
      <img alt="preview-b" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect fill='%23e8d4c5' width='320' height='180'/%3E%3C/svg%3E">
    </div>
  </div>
  <div class="dsh-image-forge-row">
    <div class="dsh-image-forge-row-head">
      <h4 class="dsh-image-forge-row-title">后端健康</h4>
      <span class="dsh-image-forge-row-status">探测完成</span>
    </div>
    <div class="dsh-image-forge-row-meta">
      <span class="dsh-image-forge-pill">配置后端 api</span>
    </div>
    <div class="dsh-image-forge-checklist">
      <div class="dsh-image-forge-check">
        <span class="dsh-image-forge-check-label">云端 API</span>
        <span class="dsh-image-forge-check-value">可达，key 被接受</span>
        <span class="dsh-image-forge-pill dsh-image-forge-pill-ok">OK</span>
      </div>
      <div class="dsh-image-forge-check">
        <span class="dsh-image-forge-check-label">ComfyUI</span>
        <span class="dsh-image-forge-check-value">没找到在跑的实例</span>
        <span class="dsh-image-forge-pill dsh-image-forge-pill-bad">不可用</span>
      </div>
      <div class="dsh-image-forge-check">
        <span class="dsh-image-forge-check-label">本地 worker</span>
        <span class="dsh-image-forge-check-value">不在跑（按需拉起）</span>
        <span class="dsh-image-forge-pill dsh-image-forge-pill-warn">注意</span>
      </div>
      <div class="dsh-image-forge-check">
        <span class="dsh-image-forge-check-label">本地运行时</span>
        <span class="dsh-image-forge-check-value">venv + 权重就绪</span>
        <span class="dsh-image-forge-pill dsh-image-forge-pill-ok">OK</span>
      </div>
    </div>
  </div>
</div>

<hr style="margin:28px 0;border:0;border-top:1px solid #dcdfe3">
<p style="max-width:520px;font-size:12px;opacity:.6">Studio 工作台 — 两栏布局，结果区在 860px 以下应落到表单下方</p>

<div style="width:100%;max-width:880px" class="dsh-image-forge-settings">
  <div class="dsh-image-forge-tabs" role="tablist">
    <button type="button" class="dsh-image-forge-tab dsh-image-forge-tab-active">工作台</button>
    <button type="button" class="dsh-image-forge-tab">通用</button>
    <button type="button" class="dsh-image-forge-tab">本地</button>
  </div>
  <div class="dsh-image-forge-settings-panel" role="tabpanel">
    <div class="dsh-image-forge-studio" id="studio">
      <div class="dsh-forge-studio-head">
        <div class="dsh-forge-studio-status">
          <span class="dsh-forge-dot is-ok"></span>
          <span class="dsh-forge-studio-endpoint">ComfyUI http://127.0.0.1:8188</span>
        </div>
        <button type="button" class="dsh-forge-btn is-ghost">重新检测</button>
      </div>
      <div class="dsh-forge-studio-body">
        <div class="dsh-forge-studio-form">
          <div class="dsh-forge-field">
            <div class="dsh-forge-field-head">
              <label class="dsh-forge-label" for="p">提示词</label>
              <span class="dsh-forge-studio-hint">48/4000</span>
            </div>
            <textarea id="p" class="dsh-forge-textarea" rows="5">一只橘猫坐在窗台上，午后侧光从纱帘透进来，浅景深，暖色木地板。</textarea>
            <div class="dsh-forge-field-actions">
              <div class="dsh-forge-mode" role="group" aria-label="改写风格">
                <button type="button" class="dsh-forge-mode-item is-active" title="一段约 20 句的观察性描写，禁画质空话">长散文</button>
                <button type="button" class="dsh-forge-mode-item" title="官方公式：主体+场景+风格+镜头+氛围+细节">关键词</button>
              </div>
              <button type="button" class="dsh-forge-btn is-ghost">优化提示词</button>
            </div>
            <div class="dsh-forge-studio-hint">补了左侧窗光与景深，主体落到画面下三分之一 · 由 deepseek-chat 改写</div>
          </div>

          <div class="dsh-forge-field">
            <label class="dsh-forge-label">画幅比例</label>
            <div class="dsh-forge-ratio-row">
              <button type="button" class="dsh-forge-ratio is-active">
                <span class="dsh-forge-ratio-label">1:1</span><span class="dsh-forge-ratio-size">1248×1248</span>
              </button>
              <button type="button" class="dsh-forge-ratio">
                <span class="dsh-forge-ratio-label">4:3</span><span class="dsh-forge-ratio-size">1408×1056</span>
              </button>
              <button type="button" class="dsh-forge-ratio">
                <span class="dsh-forge-ratio-label">3:4</span><span class="dsh-forge-ratio-size">1056×1408</span>
              </button>
              <button type="button" class="dsh-forge-ratio">
                <span class="dsh-forge-ratio-label">16:9</span><span class="dsh-forge-ratio-size">1664×928</span>
              </button>
              <button type="button" class="dsh-forge-ratio">
                <span class="dsh-forge-ratio-label">9:16</span><span class="dsh-forge-ratio-size">928×1664</span>
              </button>
            </div>
          </div>

          <div class="dsh-forge-field-row">
            <div class="dsh-forge-field">
              <label class="dsh-forge-label">步数</label>
              <input class="dsh-forge-input" type="number" value="25">
            </div>
            <div class="dsh-forge-field">
              <label class="dsh-forge-label">张数</label>
              <input class="dsh-forge-input" type="number" value="1">
            </div>
          </div>

          <div class="dsh-forge-field">
            <label class="dsh-forge-label">参考图（留空 = 文生图）</label>
            <div class="dsh-forge-ref-row">
              <div class="dsh-forge-ref">
                <span class="dsh-forge-ref-index">1</span>
                <span>room.png</span>
                <button type="button" class="dsh-forge-ref-remove" aria-label="移除">×</button>
              </div>
              <label class="dsh-forge-ref-add">+ 添加</label>
            </div>
          </div>

          <div class="dsh-forge-studio-actions">
            <button type="button" class="dsh-forge-btn is-primary">生成</button>
            <button type="button" class="dsh-forge-btn is-ghost" disabled>取消</button>
          </div>
        </div>

        <div class="dsh-forge-studio-results">
          <div class="dsh-forge-results-head">
            <div class="dsh-forge-view-toggle" role="group" aria-label="结果视图">
              <button type="button" class="dsh-forge-view-item is-active" aria-pressed="true">画布</button>
              <button type="button" class="dsh-forge-view-item" aria-pressed="false">列表</button>
            </div>
            <div class="dsh-forge-zoom">
              <button type="button" class="dsh-forge-btn is-ghost" aria-label="缩小">−</button>
              <span class="dsh-forge-zoom-label">92%</span>
              <button type="button" class="dsh-forge-btn is-ghost" aria-label="放大">+</button>
              <button type="button" class="dsh-forge-btn is-ghost">适应</button>
            </div>
          </div>

          <div class="dsh-forge-canvas">
            <div class="dsh-forge-canvas-layer" style="transform:translate(-14px,-22px) scale(0.92)">
              <svg class="dsh-forge-canvas-edges" width="1" height="1" aria-hidden="true">
                <path class="dsh-forge-edge" d="M 208 120 C 302 120, 306 120, 400 120"></path>
                <path class="dsh-forge-edge" d="M 608 120 C 702 120, 706 250, 400 250"></path>
              </svg>

              <div class="dsh-forge-node" style="left:0;top:0">
                <img alt="结果" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='208' height='200'%3E%3Crect width='208' height='200' fill='%23c9d6e3'/%3E%3Ccircle cx='104' cy='96' r='34' fill='%23f2b880'/%3E%3C/svg%3E">
                <div class="dsh-forge-node-meta">1248×1248 · 1523 KB</div>
              </div>

              <div class="dsh-forge-node is-selected" style="left:400px;top:0">
                <img alt="结果" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='208' height='200'%3E%3Crect width='208' height='200' fill='%2334405a'/%3E%3Ccircle cx='104' cy='88' r='30' fill='%237fd1c0'/%3E%3C/svg%3E">
                <div class="dsh-forge-node-meta">1248×1248 · 1608 KB</div>
                <div class="dsh-forge-node-actions">
                  <button type="button" class="dsh-forge-node-btn">用作参考</button>
                  <a class="dsh-forge-node-btn" href="#">原图</a>
                  <button type="button" class="dsh-forge-node-btn is-danger">移除</button>
                </div>
              </div>

              <div class="dsh-forge-node" style="left:400px;top:260px">
                <img alt="结果" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='208' height='200'%3E%3Crect width='208' height='200' fill='%234c5a3f'/%3E%3Crect x='60' y='50' width='88' height='110' rx='8' fill='%23e8d5a3'/%3E%3C/svg%3E">
                <div class="dsh-forge-node-meta">1024×1536 · 1180 KB</div>
              </div>
            </div>
            <div class="dsh-forge-canvas-foot">已选 1 张参考图，下一轮将是改图。</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>
`

const out = fileURLToPath(new URL('./client-preview.html', import.meta.url))
writeFileSync(out, html)
console.log('wrote', out, 'bytes', html.length)
