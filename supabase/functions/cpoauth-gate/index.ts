import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ── 配置（URL/Key 常量 + 环境变量） ──────────────────────────────
const PROJECT_URL = "https://vzqspcuxnwpakofwumat.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6cXNwY3V4bndwYWtvZnd1bWF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODI4MTUsImV4cCI6MjA5OTQ1ODgxNX0.AlV_3gWTWTrFBO-_nYD_8RaKoC-m5p-7VpZwbnPp-Pg";

const CPOAUTH_BASE = "https://www.cpoauth.com";
const CPOAUTH_CLIENT_ID = "2bbbe6cf-b13c-4181-8958-61184a2c799e";
const CPOAUTH_CLIENT_SECRET = (() => {
  try { return Deno.env.get("CPOAUTH_CLIENT_SECRET") ?? ""; } catch { return ""; }
})();
const SUPABASE_JWT_SECRET = (() => {
  try { return Deno.env.get("SUPABASE_JWT_SECRET") ?? ""; } catch { return ""; }
})();
const SUPABASE_SERVICE_ROLE_KEY = (() => {
  try { return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""; } catch { return ""; }
})();

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
};

// ── 工具函数 ─────────────────────────────────────────────────────

/** Base64url 编码（安全处理 Unicode） */
function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** HMAC-SHA256 签名 → base64url */
async function hmacSign(input: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  const bytes = new Uint8Array(sig);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 签发 Supabase 兼容 JWT access_token */
async function issueSupabaseJWT(
  userId: string,
  email: string,
  userMeta: Record<string, unknown>,
  expiresInSec = 3600
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: userId,
    email: email,
    role: "authenticated",
    aud: "authenticated",
    exp: now + expiresInSec,
    iat: now,
    iss: "supabase",
    session_id: crypto.randomUUID(),
    aal: "aal1",
    amr: [{ method: "oauth", timestamp: now }],
    app_metadata: { provider: "cpoauth", providers: ["cpoauth"] },
    user_metadata: userMeta,
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signature = await hmacSign(`${headerB64}.${payloadB64}`, SUPABASE_JWT_SECRET);

  return `${headerB64}.${payloadB64}.${signature}`;
}

/** 生成安全的随机令牌 */
function generateToken(length = 48): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64urlEncode(String.fromCharCode(...bytes));
}

// ── CPOAuth API 调用 ─────────────────────────────────────────────

/** 用 code + code_verifier + client_secret 换取 CPOAuth token */
async function cpoauthExchangeToken(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const res = await fetch(`${CPOAUTH_BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CPOAUTH_CLIENT_ID,
      client_secret: CPOAUTH_CLIENT_SECRET,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const d = await res.json();
      detail = d.error || d.error_description || JSON.stringify(d);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`CPOAuth token exchange failed: ${detail}`);
  }
  return res.json();
}

/** 获取 CPOAuth 用户信息 */
async function cpoauthGetUserInfo(accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${CPOAUTH_BASE}/api/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`CPOAuth userinfo failed (HTTP ${res.status})`);
  }
  return res.json();
}

// ── Supabase 数据库操作 ──────────────────────────────────────────

/** 用 service_role 查询 users 表 */
async function supabaseQuery(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const url = `${PROJECT_URL}/rest/v1/${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
  if (options.method === "PATCH") {
    headers["Prefer"] = "return=representation";
  }

  return fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

/** 通过 Supabase access_token 验证当前用户身份 */
async function verifySupabaseUser(token: string): Promise<{ id: string; email: string } | null> {
  try {
    const res = await fetch(`${PROJECT_URL}/auth/v1/user`, {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return { id: user.id, email: user.email };
  } catch {
    return null;
  }
}

/** 用 cpoauth_sub 查找已绑定的用户 */
async function findUserByCpoauthSub(sub: string): Promise<{ id: string; email: string } | null> {
  const res = await supabaseQuery(`users?cpoauth_sub=eq.${encodeURIComponent(sub)}&select=id,email&limit=1`);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.length ? { id: data[0].id, email: data[0].email } : null;
}

// ── 处理器 ───────────────────────────────────────────────────────

serve(async (req: Request) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  // 仅接受 POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "仅支持 POST" }), { headers: CORS });
  }

  try {
    const body = await req.json();
    const { code, code_verifier, redirect_uri, action, supabase_token } = body;

    // 参数校验
    if (!code || !code_verifier) {
      return new Response(
        JSON.stringify({ success: false, error: "缺少授权码或 PKCE 参数" }),
        { headers: CORS }
      );
    }
    if (!redirect_uri) {
      return new Response(
        JSON.stringify({ success: false, error: "缺少 redirect_uri" }),
        { headers: CORS }
      );
    }
    if (action !== "login" && action !== "link") {
      return new Response(
        JSON.stringify({ success: false, error: "无效的 action，仅支持 login 或 link" }),
        { headers: CORS }
      );
    }
    if (!CPOAUTH_CLIENT_SECRET) {
      return new Response(
        JSON.stringify({ success: false, error: "服务未配置 CPOAuth Secret" }),
        { headers: CORS }
      );
    }
    if (!SUPABASE_JWT_SECRET || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({ success: false, error: "服务未配置 Supabase 密钥" }),
        { headers: CORS }
      );
    }

    // ── 1. 用 code 换 CPOAuth token（服务端，安全） ──
    const cpoauthTokens = await cpoauthExchangeToken(code, code_verifier, redirect_uri);

    // ── 2. 获取 CPOAuth 用户信息 ──
    const userInfo = await cpoauthGetUserInfo(cpoauthTokens.access_token);
    const cpoauthSub = (userInfo.sub || userInfo.id || "") as string;
    const cpoauthUsername = (userInfo.username || userInfo.display_name || "") as string;
    const cpoauthEmail = (userInfo.email || "") as string;

    if (!cpoauthSub) {
      return new Response(
        JSON.stringify({ success: false, error: "无法获取 CPOAuth 用户标识" }),
        { headers: CORS }
      );
    }

    // ── 3a. action=link: 绑定 CPOAuth 到当前 Supabase 账号 ──
    if (action === "link") {
      if (!supabase_token) {
        return new Response(
          JSON.stringify({ success: false, error: "请先登录 Supabase 账号" }),
          { headers: CORS }
        );
      }

      // 验证 Supabase 用户身份
      const supabaseUser = await verifySupabaseUser(supabase_token);
      if (!supabaseUser) {
        return new Response(
          JSON.stringify({ success: false, error: "Supabase 会话无效或已过期" }),
          { headers: CORS }
        );
      }

      // 检查该 cpoauth_sub 是否已被其他用户绑定
      const existingBind = await findUserByCpoauthSub(cpoauthSub);
      if (existingBind && existingBind.id !== supabaseUser.id) {
        return new Response(
          JSON.stringify({ success: false, error: "该 CPOAuth 账号已被其他用户绑定" }),
          { headers: CORS }
        );
      }

      // 更新绑定
      const updateRes = await supabaseQuery(`users?id=eq.${supabaseUser.id}`, {
        method: "PATCH",
        body: {
          cpoauth_sub: cpoauthSub,
          cpoauth_linked_at: new Date().toISOString(),
          cpoauth_username: cpoauthUsername,
        },
      });

      if (!updateRes.ok) {
        return new Response(
          JSON.stringify({ success: false, error: "绑定失败，请稍后重试" }),
          { headers: CORS }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: "CPOAuth 绑定成功",
          cpoauth_user: {
            sub: cpoauthSub,
            username: cpoauthUsername,
            email: cpoauthEmail,
          },
        }),
        { headers: CORS }
      );
    }

    // ── 3b. action=login: 查找绑定并签发 Supabase JWT ──
    const boundUser = await findUserByCpoauthSub(cpoauthSub);

    if (!boundUser) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "cpoauth_not_bound",
          message: "该 CPOAuth 账号尚未绑定，请先用邮箱密码登录后，在账号安全中心绑定 CPOAuth",
          cpoauth_user: {
            sub: cpoauthSub,
            username: cpoauthUsername,
            email: cpoauthEmail,
          },
        }),
        { headers: CORS }
      );
    }

    // 签发 Supabase JWT
    const accessToken = await issueSupabaseJWT(boundUser.id, boundUser.email, {
      nick: cpoauthUsername || boundUser.email?.split("@")[0],
    });
    const refreshToken = `cpoauth_${generateToken()}`; // 占位 refresh_token（CPOAuth 会话依赖 CPOAuth 刷新）

    return new Response(
      JSON.stringify({
        success: true,
        session: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
          user: {
            id: boundUser.id,
            email: boundUser.email,
            user_metadata: { nick: cpoauthUsername || boundUser.email?.split("@")[0] },
          },
        },
        cpoauth_user: {
          sub: cpoauthSub,
          username: cpoauthUsername,
          email: cpoauthEmail,
        },
      }),
      { headers: CORS }
    );
  } catch (e) {
    console.error("cpoauth-gate error:", e);
    const message = e instanceof Error ? e.message : "服务内部错误";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { headers: CORS }
    );
  }
});
