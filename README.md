# KJLLin 个人网站 — 开发文档

纯静态多页面站点（GitHub Pages）+ Supabase 后端（Auth / Database / Storage / Realtime / Edge Functions）。
设计语言：Apple Design（弹簧物理、材质深度、排版光学），设计令牌统一在 `theme.css`。

## 目录结构

```
/                       首页
/u/                     个人主页（每用户独立网址 /u/?id=<uuid>）
/notifications/         通知中心（站内信/点赞/关注动态）
/chat/                  站内信（私信）
/discuss/               文章广场（列表/写文章/编辑/详情）
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
- `initNav(sb, opts)`：统一导航栏——登录态、**昵称直接显示在"个人主页"菜单项**（超 12 字截断，点击跳 `/u/?id=<uid>`；未登录恢复"个人主页"文案且 `#userTag` 显示登录按钮）、登出、未读横幅、**通知铃铛**（自动注入 `#userTag` 前，Realtime 订阅未读数）。页面切勿自行填充 `#userTag`（chat/cloud/game 曾各自覆盖导致与主页不一致）
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
- `upload-ticket`（verify_jwt=true）：大文件上传票据签发；**修复：曾缺失 `serve` import 导致函数启动即崩溃**（OPTIONS 500、所有票据请求失败，前端报"验证失败"），并同样透传 `expired` 标记
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
3. 修复写文章页人机验证误报（hCaptcha token 过期透传）
4. 修复舒尔特云端同步（`var supabase` 覆盖 SDK 全局）
5. 通知系统（表/触发器/铃铛/通知中心）
6. 个人主页 `/u/`；全站导航"设置"入口改为个人主页
7. 文章广场：点赞移至详情页、详情阅读模式（浅色纯白/深色近纯黑）
8. 越权加固：users 敏感列锁死、posts 所有权校验、users_select 收紧、匿名公开资料视图
9. 统一 settings/admin 页导航栏与主站一致；修复个人主页/通知页顶部遮挡
10. 导航栏"个人主页"菜单项直接显示用户昵称（去掉 userTag 昵称位）；移除 chat/cloud/game 页各自覆盖 userTag 的旧代码；chat/style.css 删除重复导航样式块，统一由 theme.css 提供
11. 修复云盘 >5MB 上传"人机验证已通过却提示验证失败"：upload-ticket Edge Function 缺失 `serve` import 启动即崩溃（线上 OPTIONS 即 500）；补 import + expired 透传，前端安全解析非 JSON 响应
12. **CSP 按 hCaptcha 官方要求放行 `https://*.hcaptcha.com`**（script-src/connect-src/frame-src）——此前仅放行 `hcaptcha.com` 与 `newassets.hcaptcha.com`，动态子域（如 `<hash>.w.hcaptcha.com`）被拦截导致 token 无法通过 siteverify（现象：勾选完成但仍报"人机验证未通过"）；涉及 cloud/discuss/new/discuss/edit/login 四页；upload-ticket 失败响应透传 `codes`（hCaptcha error-codes）便于诊断
13. **根治"人机验证未通过"：Edge Function 的 `HCAPTCHA_SECRET` 与 Supabase Auth 的 `security_captcha_secret` 不一致**（secret 轮换后只更新了 Auth 配置）。sitekey 已确认注册于 kjllin.github.io（`checksiteconfig` 验证），Auth secret 为有效 hCaptcha secret（siteverify 校验通过），已将函数的 `HCAPTCHA_SECRET` 同步为 Auth secret（SHA-256 哈希比对确认写入成功）并重新部署 upload-ticket/verify-captcha。**注意：Management API 的 secrets 接口返回的是值的哈希而非明文**（曾因此误判 secret 有效性）；hCaptcha secret 轮换时需同时更新：Auth 配置（Dashboard → Authentication → Captcha）+ 项目 secrets 的 `HCAPTCHA_SECRET`

## 部署

GitHub Pages（main 分支自动部署）。数据库变更需在 Supabase SQL Editor 手动执行 migration（幂等可重跑）；Edge Functions 用上述 Management API 部署。
