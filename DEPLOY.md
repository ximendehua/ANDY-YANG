# 部署到 Render（让任何手机 / 任何网络都能用）

本工程已配置好容器化部署文件：`Dockerfile` 与 `render.yaml`。
部署后你会得到一个 `https://xxx.onrender.com` 的公网地址，任何设备浏览器打开即可拍照成表，
后端走腾讯云 OCR（准确率 >96%），密钥通过环境变量传入，**不进代码仓库**。

## 先把 Render 界面变成中文（强烈建议先做）

Render 后台本身没有语言切换，但**用 Chrome 浏览器整页翻译**即可让它变成中文：

1. 用 **Google Chrome** 打开 render.com（Edge 浏览器同样支持）。
2. 在页面**空白处点右键 → 选择「翻译成中文（简体）」**。
3. 整页所有英文按钮、菜单都会变成中文，照着点即可。
   - 怕翻译不全？下面每一步都附了**英文原文**，对照着找就行。

> 补充：如果右键菜单里没有"翻译"，点地址栏右侧的「翻译」图标（一个小地球或 G 图标）也能触发。

---

## 英文术语对照表（部署时会遇到的词）

| 英文（页面上看到的） | 中文意思 | 操作 |
|---|---|---|
| Sign up | 注册 | 首次进入点它 |
| Log in | 登录 | 已有账号点它 |
| New | 新建 | 右上角，点出下拉菜单 |
| Blueprint | 蓝图部署 | 仓库里有 `render.yaml` 时选它 |
| Web Service | Web 服务 | 没有 yaml 时选它 |
| Authorize / Connect GitHub | 授权 GitHub | 连仓库时弹窗，点允许 |
| Connect | 连接 | 选仓库后的确认按钮 |
| Environment | 环境变量 | 填密钥的地方 |
| KEY / VALUE | 键 / 值 | 变量名 / 变量值 |
| Create / Deploy | 创建 / 部署 | 最终提交按钮 |
| Manual Deploy | 手动部署 | 改完变量后重新部署 |
| Deploy latest commit | 部署最新提交 | 重启使变量生效 |
| Your service is live | 服务已上线 | 部署成功标志 |
| Settings | 设置 | 改服务名、删服务的地方 |
| Delete | 删除 | 不想用时销毁服务 |

---

## 前提
- 已注册 GitHub 账号、Render 账号（均免费）。
- 本机工程已 `git commit`（密钥 `config.json` 已被 `.gitignore` 忽略）。

## 第一步：推送到 GitHub

> 提示：用 **Chrome 打开 github.com**，空白处右键 → 翻译成中文（简体），整个过程就是中文的。

1. **注册 / 登录**：右上角 **Sign up**（注册）/ **Log in**（登录），免费。
2. **新建仓库**：点右上角 **+** → **New repository** →
   Repository name 填 `photo-to-sheet-app` → 可见性 **Public** →
   **三个初始化选项全部不要勾**（Add README / Add .gitignore / Choose a license，本地已有文件）→
   点 **Create repository**。
3. **复制仓库地址**：进仓库后点绿色 **Code** → 选 **HTTPS** → 复制形如
   `https://github.com/你的名/photo-to-sheet-app.git` 的地址。
4. **生成访问令牌（PAT）**——这是 push 时要用的"密码"（GitHub 已不支持登录密码推代码）：
   - 右上角头像 → **Settings** → 页面最底部 **Developer settings**
     → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**。
   - Note 随便写（如 `render-deploy`）；Expiration 选 **No expiration**（或 90 days）。
   - **勾选 `repo` 这一整组**（控制仓库读写）。
   - 拉到底点 **Generate token** → 复制以 **`ghp_`** 开头的那串（**只显示这一次，存到记事本**）。
5. **本机推送**（把 `<URL>` 换成第 3 步复制的地址）：
   ```bash
   cd C:\Users\Administrator\WorkBuddy\2026-08-22-14-48-55\photo-to-sheet-app
   git remote add origin <URL>
   git push -u origin main
   ```
6. **认证填写**：
   - 弹窗要 Username → 填你的 **GitHub 用户名**。
   - 要 Password → **粘贴第 4 步的 `ghp_...` 令牌**（不是登录密码）。
   - 推送成功后，刷新 GitHub 页面能看到一堆文件；**确认没有 `config.json`**（密钥没泄露）。


## 第二步：Render 一键部署
1. 打开 render.com → 登录 → 右上角 **New** → **Blueprints**（或 **Web Service**）
   → 授权连接 GitHub → 选择本仓库。
2. Render 会自动读取仓库根目录的 `render.yaml`（已配好 `runtime: docker`、`plan: free`、端口 3000）。
3. 在 **Environment** 变量里填写（`render.yaml` 中 `sync: false` 的项需手动填）：
   - `TENCENT_SECRET_ID` = 你的腾讯云 SecretId
   - `TENCENT_SECRET_KEY` = 你的腾讯云 SecretKey
   - `KDOCS_TOKEN`（可选）= 金山文档令牌；**不填则"保存为 WPS"降级为下载 CSV**
4. 点击 **Create / Deploy**，等待镜像构建（几分钟）。

## 第三步：拿到公网地址并使用
- 部署完成后，Render 给出地址，形如 `https://photo-to-sheet-api.onrender.com`（可在设置里改名）。
- 任何手机 / 电脑浏览器打开该 https 地址 → 拍照 / 选图 → 看到识别表格 → 可直接编辑、保存。
- 之前那个 `app.workbuddy.link` 静态链接只含前端、不含后端 OCR，请改用这个 Render 地址。

## 注意事项
- **免费版限制**：服务闲置 15 分钟后会休眠，首次访问有约 30–50 秒冷启动；若要做到"随时秒开常驻"，
  需升级为付费实例（约 $7/月）。
- **安全**：密钥只存在于 Render 的环境变量中，绝不会出现在 GitHub 仓库里。
- **开启自动存 WPS**：补填 `KDOCS_TOKEN` 后，在 Render 该服务页面点 **Manual Deploy → Deploy latest commit** 重启即可生效。
- **月度额度**：腾讯云通用印刷体 / 手写体 / 表格识别各 1000 次/月免费，请确认已关闭后付费，避免超额扣费。

## 备选方案：腾讯云云托管（全中文界面，复用现有腾讯云账号）
适合不想碰 GitHub 英文界面的用户。界面全中文，且与腾讯云 OCR 同一账号。

### 第 1 步：开通/进入云开发环境
1. 打开 https://console.cloud.tencent.com → 顶部搜索 **"云开发"** → 进入 **云开发 CloudBase**。
2. 未开通则按引导开通一个环境（需实名，选**按量计费**环境即可）。

### 第 2 步：新建云托管服务
环境左侧菜单找 **"云托管"** → **"服务列表"** → **"新建服务"** → 名称 `photo-to-sheet`，类型选 **Web 服务** → 确定。

### 第 3 步：上传代码包并部署（关键）
1. 进入服务 → **"新建版本"**。
2. **部署方式选"本地代码"** → 上传 `photo-to-sheet-app-deploy.zip`（构建时自动排除 node_modules / config.json / chi_sim，密钥改由环境变量传入）。
3. 构建配置：Dockerfile 路径 `./Dockerfile`，**端口 `3000`**。
4. **环境变量**（必填，否则无法调用 OCR）：
   - `TENCENT_SECRET_ID` = 你的密钥 ID
   - `TENCENT_SECRET_KEY` = 你的密钥 Key
   - `KDOCS_TOKEN` = 留空（可选；不填"保存"降级为下载 CSV）
   - `PORT` / `HOST` 由云托管自动注入，无需填写（镜像已绑定 0.0.0.0:3000）
5. 点 **"部署"**，等待构建并启动（几分钟）。

### 第 4 步：拿到公网地址
版本状态变 **"正常/运行中"** 后，服务详情给出**默认公网访问地址**（形如 `https://xxx.tcloudbaseapp.com` 或 `https://xxx.apigw.tencentcs.com`）。
任意手机/电脑浏览器打开该 https 地址即可拍照成表，走腾讯云 OCR。

### 注意
- 云托管按量计费（CPU/内存/流量），日常用量很低；**不用时删版本/服务**避免持续计费。
- 若第 3 步无"本地代码"入口（仅"代码库/镜像"），选"代码库"连 GitHub，或告知我换方案。
- 构建报红请把日志发我排查。
