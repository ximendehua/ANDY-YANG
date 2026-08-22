# 部署到 Render（让任何手机 / 任何网络都能用）

本工程已配置好容器化部署文件：`Dockerfile` 与 `render.yaml`。
部署后你会得到一个 `https://xxx.onrender.com` 的公网地址，任何设备浏览器打开即可拍照成表，
后端走腾讯云 OCR（准确率 >96%），密钥通过环境变量传入，**不进代码仓库**。

## 前提
- 已注册 GitHub 账号、Render 账号（均免费）。
- 本机工程已 `git commit`（密钥 `config.json` 已被 `.gitignore` 忽略）。

## 第一步：推送到 GitHub
1. 打开 github.com → **New repository** → 名称如 `photo-to-sheet-app`
   → **不要**勾选 README / .gitignore 等初始化文件（本地已有）→ **Create repository**。
2. 复制仓库的 HTTPS 地址（形如 `https://github.com/你的名/photo-to-sheet-app.git`）。
3. 在本机终端执行（把 `<URL>` 换成你的地址）：
   ```bash
   cd C:\Users\Administrator\WorkBuddy\2026-08-22-14-48-55\photo-to-sheet-app
   git remote add origin <URL>
   git branch -M main
   git push -u origin main
   ```
   若提示认证，按 GitHub 指引用浏览器令牌（Personal Access Token）登录即可。

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
