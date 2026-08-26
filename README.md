# KJLLin 个人网站 — 开发文档

纯静态多页面站点（GitHub Pages）+ Supabase 后端（Auth / Database / Storage / Realtime / Edge Functions）。
设计语言：Apple Design（弹簧物理、材质深度、排版光学），设计令牌统一在 `theme.css`。

## 目录结构

```
/                       首页
/u/                     个人主页（每用户独立网址 /u/?id=<uuid>）
/notifications/         通知中心（站内信/点赞/关注动态）
/chat/                  站内信（私信）
/discuss/               讨论版（列表/发帖/编辑/详情）
/cloud/                 资源云盘（公共空间 + 私有空间）
/game/                  游戏中心（dino/snake/tfe/schulte/rps）
/login/                 登录/注册（OAuth 回调 /login/callback/）
/settings/              设置中心（account/profile/devices/password/about）
/admin/                 管理员后台（用户功能权限管理）
/common.js              全站共享工具（见下）
/theme.css              全站设计令牌 + 统一导航栏样式
/migration/*.sql        数据库迁移脚本（SQL Editor 依次执行）
/supabase/functions/    Edge Functions 源码
```

## common.js（全站共享，`window.KJ`）

- `createSupabase()`：创建/复用全站唯一客户端实例（**页面变量切勿命名为 `supabase`**——`var` 声明会覆盖 SDK 全局工厂，曾导致舒尔特页导航/登出/横幅全部失效）
- `initNav(sb, opts)`：统一导航栏——登录态、用户名（点击跳个人主页 `/u/?id=<uid>`）、登出、未读横幅、**通知铃铛**（自动注入 `#userTag` 前，Realtime 订阅未读数）
- `initMessageBanner(sb)`：未读站内信横幅，**水位机制**——叉掉时记录未读数（localStorage `kj_pm_banner_watermark`），只有新未读超过水位才再次提醒，未读清零自动重置
- `rateLimit / toast / escapeHtml / formatDate / applyTheme / safeRedirect / formatSupabaseError` 等工具

## 数据库（migration/，按序号执行）

| 迁移 | 内容 |
|---|---|
| 01–04 | 基础 schema、RLS、触发器、storage 修复 |
| 05 | 云盘按用户路径隔离 |
| 06 | 服务端限流触发器（game_scores/posts/pm/login_devices） |
| 07 | 私有 bucket + pg_cron 清理任务 |
| 08 | 社交功能（post_likes/user_follows）、banned_features、upload_tickets、`submit_game_score` RPC |
| 09 | **通知系统 + 安全加固**：notifications 表与触发器（pm/like/follow 自动生成/清理通知）、`pm_update_read_only` 策略修复、`pm_protect_content`/`users_protect_sensitive`/`notif_protect_content` 内容保护触发器、posts UPDATE 补 WITH CHECK、`users_select` 收紧为需登录、`profiles_public` 匿名可读视图（无邮箱）、pg_cron 清理 30 天前已读通知 |

### 关键表

- `users(id, nick, email, is_admin, banned_features[], ...)` — banned_features 取值：chat/discuss/cloud/games
- `private_messages(sender_id, recipient_id, text, read)` — 收件人仅可更新 `read`（触发器锁死其余列）
- `notifications(user_id, actor_id, type[pm|like|follow|system], title, link, read)` — 接收者仅可更新 `read`/删除
- `posts / post_likes / user_follows` — 点赞计数由触发器维护；点赞仅详情页可操作
- `game_scores` — 写入仅经 `submit_game_score` RPC（白名单 + 分数上限 + 封禁校验）
- `upload_tickets` — 大文件（>5MB）上传需先经 upload-ticket Edge Function 完成 hCaptcha 验证换票据

## Edge Functions

- `verify-captcha`（verify_jwt=false）：hCaptcha 服务端验证；**透传 `expired` 标记**（timeout-or-duplicate），前端据此提示"验证已过期请重新勾选"
- `upload-ticket`（verify_jwt=true）：大文件上传票据签发
- `auth-gate` / `cpoauth-gate` / `room-cleaner`

部署方式（Management API，token 走 `sbp_...`）：
`POST /v1/projects/<ref>/functions/deploy?slug=<name>`，multipart 字段 `metadata`（含 `entrypoint_path`）+ `file`。
注意：`POST /v1/functions`（body 直传源码）不支持远程 import，勿用。

## 布局约定

- 全站导航为 `position: fixed`（`.top-menu`，z-index 100）→ **页面主容器 padding-top 必须 ≥ 80px（移动端 72px）**，否则内容被遮挡
- 未读横幅（z-index 10000）出现时 `adjustPagePadding` 会把 `.top-menu` 下移 44px

## 近期变更（2026-08）

1. 修复站内信已读无法记录（RLS WITH CHECK 损坏子查询）
2. 修复设备管理页误报未登录（auth 事件与 3s 兜底竞态）
3. 修复发帖页人机验证误报（hCaptcha token 过期透传）
4. 修复舒尔特云端同步（`var supabase` 覆盖 SDK 全局）
5. 通知系统（表/触发器/铃铛/通知中心）
6. 个人主页 `/u/`；全站导航"设置"入口改为个人主页
7. 讨论版：点赞移至详情页、详情阅读模式（浅色纯白/深色近纯黑）
8. 越权加固：users 敏感列锁死、posts 所有权校验、users_select 收紧、匿名公开资料视图
9. 统一 settings/admin 页导航栏与主站一致；修复个人主页/通知页顶部遮挡

## 部署

GitHub Pages（main 分支自动部署）。数据库变更需在 Supabase SQL Editor 手动执行 migration（幂等可重跑）；Edge Functions 用上述 Management API 部署。
