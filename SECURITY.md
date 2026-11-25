# 安全策略

## 支持范围

只对当前 npm 最新发布版本提供安全修复。插件通过 npm 发布，升级到最新版本即可获得修复；发布的 tarball 附带 `npm publish --provenance` 的来源证明，可在 npm 页面核对。

## 报告漏洞

**请勿通过公开 issue 报告安全问题。**

推荐使用 GitHub 的私密漏洞报告（Private vulnerability reporting）：

<https://github.com/Demerier/dsh-image-forge/security/advisories/new>

报告时请尽量附上：

- 受影响版本和运行环境（DSH 版本、操作系统、Node 版本）
- 复现步骤或最小复现
- 影响描述，以及是否已公开

一般会在 7 天内确认收到，确认后在修复发布时按 GitHub 惯例公开安全公告（advisory）。如果问题属于依赖库的已知漏洞，Dependabot 告警会自动跟踪，无需单独报告。

## 本仓库的安全边界

插件在本机运行，通过本机的 ComfyUI 后端出图，不向任何云端服务发送提示词或图片。因此以下情况按设计行为处理，不算漏洞：

- 本机 ComfyUI 未做鉴权，局域网内其他机器可直接访问
- 生成本身消耗的本机显存与算力
- 用户主动配置的输出目录、权重目录内容

## 代码与依赖安全措施

- GitHub CodeQL 默认配置：每次推送与 PR 扫描 JavaScript/TypeScript、Actions、Python
- Secret protection 与 Push protection：提交或推送中的凭据会被拦截
- Dependabot 告警与安全更新：依赖库已知漏洞自动开修复 PR
- CI 中的 dependency review：PR 引入高严重度依赖漏洞时直接失败
- `main` 分支要求状态检查通过才能合并
