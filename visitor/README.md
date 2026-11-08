# 访客版与 GitHub Pages

访客版提供武器分析、自由试算和同模式历史对比。公开产物由 `visitor/` 的页面脚本、现有计算与可视化核心、你修改的 CSS、网页字体以及 `weapon_db/` 组成。维护页继续通过原有启动器使用。

## 本地查看

在项目目录运行：

```text
npm run build:visitor
npm run start:visitor
```

默认地址为 `http://127.0.0.1:4173/`。服务只监听本机，不会抢占或停止已有端口。修改页面或数据库后重新构建，再刷新页面。

`site/` 是构建产物，适合作为 GitHub Pages 发布内容。构建只复制访客所需文件，维护入口和维护脚本不进入发布产物。网页使用相对地址，可部署在 `https://用户名.github.io/仓库名/` 子路径。

## 手动整理数据库

每个模式使用一个 `latest-[模式].json` 最新库；`weapon_db/index.json` 登记模式与历史版本。现有武器和射击模式的 ID 应在各次更新中保持一致，以便识别改名和字段变更。

一次更新的文件操作如下：

1. 在本地维护页导入上一版数据库，修改后导出。
2. 将新版保存为对应模式的历史快照，例如 `weapon_db/history/wz/2026-11-08-r1.json`。
3. 将同一份 JSON 复制为 `weapon_db/latest-wz.json`。
4. 手动更新 `weapon_db/index.json` 中的版本名称、生效日期、历史文件路径和 `currentVersion`。
5. 将上述文件一起提交到 GitHub。

构建会检查数据库格式、清单路径，以及已启用模式的 latest 是否与当前快照一致；它不会替你生成或修改历史文件、latest 或清单。

暂未提供数据的模式使用 `available: false`、`currentVersion: null`、空 `versions`，并保留合法的空 latest 数据库。访客页将显示待补充状态，不会自动套用其他模式或示例数据。历史只有一版时，页面会说明尚无可比较的第二版。

## GitHub Pages 设置

项目根目录已有 `.github/workflows/pages.yml`。在创建 GitHub 仓库并上传代码后，在仓库 **Settings → Pages → Source** 中选择 **GitHub Actions**。每次向 `main` 推送会先测试、构建，再发布 `site/`。也可在 Actions 页面手动运行工作流。

本地 Git 仓库已经位于 `weapon-lab/`，无需在上一级工作目录重复初始化。首次连接 GitHub 时，先创建一个空仓库，保持自动生成 README 等选项未勾选；然后在 `weapon-lab/` 中执行以下命令，将地址替换为你自己的仓库：

```text
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

再设置 Pages 的 Source 为 GitHub Actions。若首次推送时尚未启用 Pages，可在设置完成后到 Actions 中重新运行工作流。未创建远端时，本地构建和本地浏览仍可正常使用。

工作流使用 GitHub 官方 Pages 操作，首次配置仍需仓库管理员完成。当前开发只准备本地文件，不会创建 GitHub 仓库或改变远端访问权限。

## 字体

网页字体使用工作目录提供的更纱字体完整字形，转换为 WOFF2 后位于 `assets/fonts/`，无需访客预先安装。两份 WOFF2 合计约 16.1 MiB，未删除字形；转换前后已核对字形顺序和 Unicode 映射一致。许可证采用源字体 0.36.5／0.36.2 对应的官方文件，来源和校验信息记录于 `FONT-SOURCES.json`。字体使用 `font-display: swap`，文字可先使用备用字体显示。

参考：[GitHub 自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[FontTools WOFF2 文档](https://fonttools.readthedocs.io/en/latest/ttLib/woff2.html)、[Sarasa Gothic 字体许可证](https://github.com/be5invis/Sarasa-Gothic/blob/v0.36.5/LICENSE)。
