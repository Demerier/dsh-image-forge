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
const match = styles.match(/export const CLIENT_CSS = `([\s\S]*?)`/)
if (!match) {
  console.error('CLIENT_CSS extract failed')
  process.exit(1)
}
const css = match[1]

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-image-forge · settings + tool cards preview</title>
<style>${css}</style>
</head>
<body style="margin:16px;font-family:system-ui,sans-serif;background:#f6f7f9;color:#1c1e21">

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
</body>
</html>
`

const out = fileURLToPath(new URL('./client-preview.html', import.meta.url))
writeFileSync(out, html)
console.log('wrote', out, 'bytes', html.length)
