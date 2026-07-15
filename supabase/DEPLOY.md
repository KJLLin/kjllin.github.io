# CPOAuth 部署指南

## 前置条件

1. Supabase 项目: `vzqspcuxnwpakofwumat`
2. Supabase CLI 已安装并登录 (`supabase login`)
3. CPOAuth 应用已在 https://www.cpoauth.com 注册，回调地址为 `https://kjllin.github.io/login/callback/`

## 部署步骤

### 1. 执行数据库迁移

在 Supabase Dashboard → SQL Editor 执行:
```
supabase/migrations/cpoauth_setup.sql
```

或通过 CLI:
```bash
supabase db push
```

### 2. 配置环境变量

在 Supabase Dashboard → Settings → Edge Functions → Secrets 添加:

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `CPOAUTH_CLIENT_SECRET` | `-trugBgLLH0JWzjp0l7iUINJV62Unp1hNPnfYI8JzYE` | CPOAuth 密钥 |
| `SUPABASE_SERVICE_ROLE_KEY` | (从 Settings > API > service_role key 获取) | 用于 Admin API 创建会话 + 查询 users 表 |

### 3. 部署 Edge Function

```bash
cd supabase
supabase functions deploy cpoauth-gate --no-verify-jwt
```

> `--no-verify-jwt` 是因为该函数由前端直接调用（无需 Supabase 认证 header），内部自行验证。

### 4. 部署前端（自动）

GitHub Pages 在 push 后自动部署，无需额外操作。

## 验证

1. 登录 https://kjllin.github.io → 邮箱密码登录
2. 进入账号安全中心 → 点击 CPOAuth "绑定"
3. 完成 CPOAuth 授权 → 应显示"绑定成功"
4. 退出登录 → 点击登录页三点按钮 → CPOAuth 登录
5. 应自动登录成功

## 安全架构

```
浏览器                          Edge Function                  CPOAuth
  │                                │                              │
  │─ POST /cpoauth-gate ──────────>│                              │
  │  {code, code_verifier, ...}    │─ POST /api/oauth/token ────>│
  │                                │  (含 client_secret)          │
  │                                │<── {access_token} ──────────│
  │                                │─ GET /api/oauth/userinfo ──>│
  │                                │<── {sub, username, ...} ────│
  │                                │                              │
  │                                │─ 查 users 表 (service_role)  │
  │                                │  WHERE cpoauth_sub = ?       │
  │                                │                              │
  │                                │─ Admin generate_link         │
  │<── {action_link} ─────────────│  (magiclink, 创建会话)       │
  │                                │                              │
  │─ redirect → action_link       │                              │
  │  Supabase 自动创建 session    │                              │
  │  重定向回首页，已登录 ✓       │                              │
```

- client_secret 永不离开 Edge Function
- 前端仅持有 PKCE code_verifier（用完即弃）
- Supabase session 由 Admin API 原生创建
- 未绑定用户无法通过 CPOAuth 登录
