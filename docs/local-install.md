# 本地安装到 DSH Desktop

面向 `dsh-image-forge` 的本地构建与安装。已在本机 DSH Desktop `0.2.1-rc.2`（profile `desktop`）实测通过。

---

## 一、打包

在仓库根目录执行：

```bash
# 1. 装依赖（lockfile 与 package.json 不同步时必须加 --no-frozen-lockfile）
pnpm install --no-frozen-lockfile

# 2. 构建（两条命令都要跑：主进程 + 客户端）
pnpm build

# 3. 打包 tarball
npx npm pack --ignore-scripts
```

产物：`dsh-image-forge-<version>.tgz`（约 1.6 MB，41 个文件）。

`--ignore-scripts` 是必要的：`prepack` 会再跑一次 build，浪费一次构建。

### 版本号

`dsh plugin add` 按 semver 判断升级。若 tarball 版本与已装版本相同，pnpm 会认为「已是最新」而不重装。**改了代码再装，必须先升版本号**：

```bash
npm version patch --no-git-tag-version   # 0.2.0-dev.1 → 0.2.0-dev.2
```

---

## 二、安装

```bash
dsh plugin --profile desktop add "D:/file/qwen生图插件/dsh-image-forge/dsh-image-forge-0.2.0-dev.1.tgz"
```

路径要用**绝对路径**、加引号（路径里有些字符会让 shell 误解）。

`dsh plugin` 的本质是把参数转发给 profile 目录里的 pnpm，所以 tarball 路径、目录路径、npm 包名、GitHub 地址都接受：

```bash
# tarball
dsh plugin --profile desktop add "<绝对路径>/dsh-image-forge-0.2.0-dev.1.tgz"

# 直接指向源码目录（适合改了代码反复测，但不会复制文件，改 src 需自行 build）
dsh plugin --profile desktop add "D:/file/qwen生图插件/dsh-image-forge"

# GitHub
dsh plugin --profile desktop add github:Demerier/dsh-image-forge
```

安装成功的输出形如：

```
dependencies:
- dsh-image-forge 0.1.0
+ dsh-image-forge 0.2.0-dev.1
Done in 7.2s using pnpm v11.28.5
```

### 装完要重启

**完全退出 DSH Desktop 再打开**，不是刷新窗口。插件的 `cordis.yml` 在启动时加载。

---

## 三、验证

### 1. 命令层面

```bash
# 版本号对不对
node -e "console.log(require('C:/Users/Demeri/.dsh/profiles/desktop/node_modules/dsh-image-forge/package.json').version)"

# bundle 是否已注册
node -e "console.log(require('C:/Users/Demeri/.dsh/profiles/desktop/package.json').dsh.profile.bundles.includes('dsh-image-forge'))"
```

### 2. 界面上

重启后确认三处：

| 位置 | 应该看到 |
|---|---|
| 对话工具列表 | `qwen_image_generate` / `qwen_image_edit` / `qwen_image_status` |
| 设置页左侧一级条目 | 「Qwen 出图」 |
| 该条目第一个页签 | 工作台（ComfyUI 没开也能打开，顶部会写探测结果） |

### 3. 功能层面

在对话里说 **「用 qwen_image_status 检查一下环境」**，它会回报：云 API 通不通、ComfyUI 在不在跑（探了哪些端口）、三个权重能否识别、显卡与显存、输出目录能否写。

`next_steps` 字段非空就照那句话做。

---

## 四、回滚与卸载

```bash
# 装回旧版本（指定版本号）
dsh plugin --profile desktop add dsh-image-forge@0.1.0

# 卸载
dsh plugin --profile desktop remove dsh-image-forge
```

`remove` 之后 bundle 注册也会被清掉。重装时会自动加回。

---

## 五、踩过的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| **工作台显示「工作台不可用（HTTP 404）」，但 ComfyUI 和其它页签正常** | 宿主在插件激活**之后**才挂载 `webServer`，插件体里一次性 `ctx.get('webServer')` 拿到 `undefined` 就 return 了，路由永远没注册。已于 0.2.0-dev.2 修复（路由改由内嵌子插件注册，声明 `inject: ['webServer']`，服务就绪时自动激活） | 升到 0.2.0-dev.2 及以上 |
| `ERR_PNPM_OUTDATED_LOCKFILE`，提示新增 `@deepseek-ai/dsh-llm@*` | lockfile 未跟上 package.json 的新可选 peer | 加 `--no-frozen-lockfile` |
| `Cannot find package '@rolldown/pluginutils'` | `node_modules` 损坏 | 重装依赖 |
| `ERR_PNPM_LINKING_FAILED` + `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | 单次安装累计删除超 50 个文件被拦 | 手动删掉 `node_modules` 后重装，或分几次装 |
| 装了新版但界面没变 | 版本号没升，pnpm 跳过安装 | 先 `npm version patch` 再打包 |
| 界面没变（版本已升） | 没完全退出 Desktop | 彻底退出进程再启动 |
| **`pnpm test` 报 `ENOENT ... lib/client.js`** | 主配置 `clean: true` 会清空整个 `lib/`，只跑第一条 build 命令就会丢掉客户端产物 | 两条 build 都跑；`pnpm test` 前确认 `lib/client.js` 存在 |
| `dsh: command not found` | CLI 不在 PATH | 用全路径 `D:/software/dsh/resources/runtime/cli/bin/dsh.cmd` |

---

## 六、本机已验证的信息

| 项 | 值 |
|---|---|
| DSH Desktop 版本 | `0.2.1-rc.2` |
| CLI 路径 | `D:/software/dsh/resources/runtime/cli/bin/dsh.cmd` |
| profile 目录 | `C:\Users\Demeri\.dsh\profiles\desktop` |
| 已装版本 | `0.2.0-dev.2`（由 tarball 安装） |
| tarball | `dsh-image-forge-0.2.0-dev.2.tgz`，41 文件，1.6 MB |
| 测试结果 | 11 个文件 / 162 用例全通过（构建后运行） |
