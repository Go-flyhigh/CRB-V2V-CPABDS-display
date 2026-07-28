# Vercel 部署与维护手册

本仓库是 CRB-V2V-CPABDS 可视化展示的 Vercel 部署包。运行时结构：

```text
app.py              Flask WSGI 入口
templates/          页面模板
public/static/      由 Vercel CDN 提供的 CSS、JavaScript、ECharts 与道路数据
data/               五场景 frames、reputation、comparison 和 meta 数据
requirements.txt    Python 运行时依赖
vercel.json         Flask 与 data 打包配置
```

## 首次从 GitHub 导入

1. 登录 [Vercel Dashboard](https://vercel.com/new)。
2. 选择 **Add New → Project**。
3. 在 GitHub 列表中选择
   `ERASSER316/CRB-V2V-CPABDS-display`。如果列表中没有该仓库，点击
   **Adjust GitHub App Permissions**，授权 Vercel 访问这个仓库。
4. 保持以下设置：
   - Framework Preset：`Flask`（通常会自动识别）；
   - Root Directory：`.`；
   - Build Command：留空；
   - Output Directory：留空；
   - Install Command：留空，让 Vercel 使用 `requirements.txt`；
   - Environment Variables：不需要。
5. 点击 **Deploy**。

部署成功后，Vercel 会提供 `https://<project>.vercel.app` 地址。连接 GitHub 后，
`main` 分支的后续提交会自动触发生产部署，其他分支/PR 会生成预览部署。

## CLI 部署

需要 Vercel CLI 48.2.10 或更高版本：

```bash
npx vercel@latest login
npx vercel@latest --prod
```

首次运行会询问：

```text
Set up and deploy? yes
Which scope? 选择自己的 Vercel 账号
Link to existing project? no
Project name? crb-v2v-cpabds-display
In which directory is your code located? ./
```

## 更新展示数据

页面只依赖 `data/` 中以下文件：

```text
data/scenarios.json
data/<scenario>/meta.json
data/<scenario>/frames.json
data/<scenario>/reputation.json
data/<scenario>/comparison.json
```

更新本地正式结果后，把这些文件同步到仓库的 `data/`，运行本地检查，再提交到
`main`。Vercel Git 集成会自动重新部署。

## 本地检查

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

访问 `http://localhost:5001`，至少检查：

- 首页、CSS、ECharts 和 ES Modules 能加载；
- 五个场景均能进入推理回放；
- 算法对比模式能读取三算法、200 帧 timeline；
- 浏览器控制台无 `404`、`console.error` 或跨域错误。

也可以用与生产环境更接近的方式：

```bash
npx vercel@latest dev
```

## 常见问题

### Vercel 看不到 GitHub 仓库

进入 Vercel 的 GitHub 集成设置，为 Vercel GitHub App 增加
`CRB-V2V-CPABDS-display` 仓库权限，然后回到 New Project 页面刷新。

### 页面加载但静态资源 404

确认资源位于 `public/static/`，页面路径保持 `/static/...`。不要只把资源放在 Flask
传统的 `static/` 目录；Vercel 官方建议通过 `public/` 提供静态文件。

### 场景 API 返回 404

确认 `data/scenarios.json` 和五个 `data/<scenario>/` 目录已经提交。应用在 Vercel
部署包中默认读取 `./data`，无需设置 `DEMO_DATA_DIR`。

### 部署包过大

不要提交实验 `artifacts/`、模型、PCD、虚拟环境或测试缓存。当前部署包只包含约
14 MB 展示数据和约 1.4 MB 静态资源，远低于 Vercel Python 函数限制。

### 自定义域名

打开 Vercel 项目 → **Settings → Domains → Add Domain**，输入域名并按页面提示
添加 DNS 记录。DNS 生效后 Vercel 会自动配置 HTTPS。
