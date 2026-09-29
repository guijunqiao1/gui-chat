# GitHub Actions → TCR → Docker 部署说明

本目录用于将 Sky Chat 发布到 Linux 服务器。发布链路为：

`push main/master → GitHub Actions 构建镜像 → 推送 TCR → SSH 到服务器 → Compose 拉取新镜像并重建 app → Nginx 代理到 app:3000`。

## 首次服务器初始化

以部署目录 `/opt/sky-chat` 为例，先在服务器执行：

```bash
sudo mkdir -p /opt/sky-chat/deploy /opt/sky-chat/generated
sudo chown -R 1001:1001 /opt/sky-chat/generated
```

在 `/opt/sky-chat/.env` 创建仅保留在服务器上的生产配置：

```env
# 用 URL 安全的随机字符串；不要包含 #、空格或未转义的 $。
POSTGRES_USER=skychat
POSTGRES_PASSWORD=replace-with-a-long-random-password
POSTGRES_DB=skychat

AUTH_SECRET=replace-with-a-long-random-secret
NEXTAUTH_SECRET=replace-with-a-long-random-secret
JWT_SECRET=replace-with-a-long-random-secret
NEXTAUTH_URL=https://chat.example.com

SILICONFLOW_API_KEY=...
TAVILY_API_KEY=...
ENABLE_RAG=true
RAG_EMBEDDING_MODEL=BAAI/bge-m3

# 默认占用宿主机 80。若已有宝塔/其他 Nginx 占用 80，改为 127.0.0.1:3001，
# 再由已有 Nginx 反向代理至 http://127.0.0.1:3001。
APP_HTTP_PORT=80
```

服务器必须预先安装 Docker Engine 和 Docker Compose plugin，并能访问 TCR。数据库数据保存在 Docker 卷中；应用升级不会删除它。应额外制定 `pg_dump` 备份计划。

## GitHub Actions Secrets

在仓库 `Settings → Secrets and variables → Actions` 配置：

| Secret | 用途 |
| --- | --- |
| `ECS_HOST` | 服务器 IP 或 SSH 主机名 |
| `ECS_USER` | 有权运行 Docker 的 Linux 用户 |
| `ECS_SSH_PRIVATE_KEY` | 部署用户完整 SSH 私钥 |
| `TCR_REGISTRY` | TCR 域名，例如 `ccr.ccs.tencentyun.com` |
| `TCR_NAMESPACE` | TCR 命名空间 |
| `TCR_REPOSITORY` | 仓库名，例如 `sky-chat` |
| `TCR_USERNAME` | TCR 用户名 |
| `TCR_PASSWORD` | TCR 密码或临时令牌 |

可选 Repository Variable：`DEPLOY_PATH`，默认 `/opt/sky-chat`。

## 端口与现有站点

本编排的 Nginx 默认绑定宿主机 80 端口，**不能与旧项目或宝塔 Nginx 同时占用 80**。不要使用“杀掉所有占用 80 的进程”的发布脚本。

- 要替换旧站点：先人工确认旧容器/服务已下线，再使用 `APP_HTTP_PORT=80`。
- 要与现有宝塔站点共存：设置 `APP_HTTP_PORT=127.0.0.1:3001`，在宝塔站点增加反向代理到 `http://127.0.0.1:3001`，并由宝塔管理域名与 HTTPS。

## 发布后的检查

```bash
cd /opt/sky-chat
docker compose -f deploy/docker-compose.production.yml ps
docker compose -f deploy/docker-compose.production.yml logs -f app
curl -fsS http://127.0.0.1:${APP_HTTP_PORT:-80}/api/health
```

应用启动脚本会执行 `prisma migrate deploy`。首次发布前必须确认镜像中的 `prisma/migrations` 完整，否则数据库迁移会失败。
