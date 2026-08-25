import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ── 配置 ─────────────────────────────────────────────────────────
const PROJECT_URL = "https://vzqspcuxnwpakofwumat.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6cXNwY3V4bndwYWtvZnd1bWF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODI4MTUsImV4cCI6MjA5OTQ1ODgxNX0.AlV_3gWTWTrFBO-_nYD_8RaKoC-m5p-7VpZwbnPp-Pg";

const CPOAUTH_BASE = "https://www.cpoauth.com";
const CPOAUTH_CLIENT_ID = "2bbbe6cf-b13c-4181-8958-61184a2c799e";

// 敏感信息从环境变量读取（永不硬编码）
const CPOAUTH_CLIENT_SECRET = (() => {
  try { return Deno.env.get("CPOAUTH_CLIENT_SECRET") ?? ""; } catch { return ""; }
})();
const SUPABASE_SERVICE_ROLE_KEY = (() => {
  try { return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""; } catch { return ""; }
})();

// 可信域名白名单（SEC-004：替代 Access-Control-Allow-Origin: *）
const ALLOWED_ORIGINS = ["https://kjllin.github.io"];

const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get("origin") || "";
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
    Vary: "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
};

// ── CPOAuth API 调用 ─────────────────────────────────────────────

async function cpoauthExchangeToken(
  code: string, codeVerifier: string, redirectUri: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const res = await fetch(`${CPOAUTH_BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code", code,
      redirect_uri: redirectUri,
      client_id: CPOAUTH_CLIENT_ID,
      client_secret: CPOAUTH_CLIENT_SECRET,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { const d = await res.json(); detail = d.error || d.error_description || JSON.stringify(d); }
    catch { detail = res.statusText; }
    throw new Error(`CPOAuth token exchange failed: ${detail}`);
  }
  return res.json();
}

async function cpoauthGetUserInfo(accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${CPOAUTH_BASE}/api/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`CPOAuth userinfo failed (HTTP ${res.status})`);
  return res.json();
}

// ── Supabase 操作 ────────────────────────────────────────────────

/** service_role 通用的 fetch helper */
function supabaseHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

/** 查询 users 表 */
async function findUserByCpoauthSub(sub: string): Promise<{ id: string; email: string } | null> {
  const res = await fetch(
    `${PROJECT_URL}/rest/v1/users?cpoauth_sub=eq.${encodeURIComponent(sub)}&select=id,email&limit=1`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.length ? { id: data[0].id, email: data[0].email } : null;
}

/** 更新 users 表 */
async function updateUser(userId: string, fields: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${PROJECT_URL}/rest/v1/users?id=eq.${userId}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(fields),
  });
  return res.ok;
}

/** 验证 Supabase access_token 是否有效 */
async function verifySupabaseUser(token: string): Promise<{ id: string; email: string } | null> {
  try {
    const res = await fetch(`${PROJECT_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return { id: user.id, email: user.email };
  } catch { return null; }
}

/**
 * 通过 Supabase Admin API 创建登录会话
 * 使用 generate_link (magiclink)，返回一次性 action_link URL
 * 前端跳转到该 URL 后，Supabase 自动创建 session 并重定向回首页
 */
async function createSupabaseSession(email: string): Promise<string> {
  const res = await fetch(`${PROJECT_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({
      type: "magiclink",
      email: email,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to generate session link: ${text}`);
  }

  const data = await res.json();
  return data.action_link;
}

// ── 主处理器 ─────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "仅支持 POST" }), { headers: corsHeaders(req) });
  }

  try {
    const body = await req.json();
    const { code, code_verifier, redirect_uri, action, supabase_token } = body;

    // 前置校验
    if (!code || !code_verifier) {
      return new Response(JSON.stringify({ success: false, error: "缺少授权码或 PKCE 参数" }), { headers: corsHeaders(req) });
    }
    if (!redirect_uri) {
      return new Response(JSON.stringify({ success: false, error: "缺少 redirect_uri" }), { headers: corsHeaders(req) });
    }
    if (action !== "login" && action !== "link") {
      return new Response(JSON.stringify({ success: false, error: "无效 action" }), { headers: corsHeaders(req) });
    }
    if (!CPOAUTH_CLIENT_SECRET) {
      return new Response(JSON.stringify({ success: false, error: "服务未配置 CPOAuth Secret" }), { headers: corsHeaders(req) });
    }
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ success: false, error: "服务未配置 Service Role Key" }), { headers: corsHeaders(req) });
    }

    // ── 1. 服务端换取 CPOAuth token（client_secret 不离开服务器） ──
    const tokens = await cpoauthExchangeToken(code, code_verifier, redirect_uri);

    // ── 2. 获取 CPOAuth 用户信息 ──
    const userInfo = await cpoauthGetUserInfo(tokens.access_token);
    const cpoauthSub = (userInfo.sub || userInfo.id || "") as string;
    const cpoauthUsername = (userInfo.username || userInfo.display_name || "") as string;
    const cpoauthEmail = (userInfo.email || "") as string;

    if (!cpoauthSub) {
      return new Response(JSON.stringify({ success: false, error: "无法获取 CPOAuth 用户标识" }), { headers: corsHeaders(req) });
    }

    // ── 3a. action=link: 绑定 CPOAuth 到 Supabase 账号 ──
    if (action === "link") {
      if (!supabase_token) {
        return new Response(JSON.stringify({ success: false, error: "请先登录本站账号" }), { headers: corsHeaders(req) });
      }
      const supabaseUser = await verifySupabaseUser(supabase_token);
      if (!supabaseUser) {
        return new Response(JSON.stringify({ success: false, error: "本站会话已过期，请重新登录" }), { headers: corsHeaders(req) });
      }

      // 防账号抢占：检查 cpoauth_sub 是否已被其他人绑定
      const existing = await findUserByCpoauthSub(cpoauthSub);
      if (existing && existing.id !== supabaseUser.id) {
        return new Response(JSON.stringify({ success: false, error: "该 CPOAuth 账号已被其他用户绑定" }), { headers: corsHeaders(req) });
      }

      const ok = await updateUser(supabaseUser.id, {
        cpoauth_sub: cpoauthSub,
        cpoauth_linked_at: new Date().toISOString(),
        cpoauth_username: cpoauthUsername,
      });
      if (!ok) {
        return new Response(JSON.stringify({ success: false, error: "绑定写入失败，请稍后重试" }), { headers: corsHeaders(req) });
      }

      return new Response(JSON.stringify({
        success: true,
        message: "CPOAuth 绑定成功",
        cpoauth_user: { sub: cpoauthSub, username: cpoauthUsername, email: cpoauthEmail },
      }), { headers: corsHeaders(req) });
    }

    // ── 3b. action=login: 查找绑定 → 创建 Supabase 会话 ──
    const boundUser = await findUserByCpoauthSub(cpoauthSub);

    if (!boundUser) {
      return new Response(JSON.stringify({
        success: false,
        error: "cpoauth_not_bound",
        message: "该 CPOAuth 账号尚未绑定本站账号。请先用邮箱密码登录后，在账号安全中心绑定 CPOAuth。",
        cpoauth_user: { sub: cpoauthSub, username: cpoauthUsername, email: cpoauthEmail },
      }), { headers: corsHeaders(req) });
    }

    // 使用 Supabase Admin API 创建登录会话（magiclink 方式）
    const actionLink = await createSupabaseSession(boundUser.email);

    return new Response(JSON.stringify({
      success: true,
      action_link: actionLink,
      message: "登录成功，正在跳转...",
      cpoauth_user: { sub: cpoauthSub, username: cpoauthUsername, email: cpoauthEmail },
    }), { headers: corsHeaders(req) });

  } catch (e) {
    console.error("cpoauth-gate error:", e);
    const message = e instanceof Error ? e.message : "服务内部错误";
    return new Response(JSON.stringify({ success: false, error: message }), { headers: corsHeaders(req) });
  }
});
