// admin-phone：仅管理员可执行的手机号辅助注册 / 绑定
//
// 安全模型（SEC-003：验证管理员后再操作）：
//   - verify_jwt=true，确保调用者是已登录用户
//   - 函数内再用 service role 读 users 表核验 is_admin === true，非管理员直接拒绝
//   - 所有 GoTrue 管理接口走 service role key（匿名/普通用户无权访问）
//   - 响应不泄露 secret / token / 手机号之外的敏感字段
//
// 动作：
//   action=register : 通过手机号创建全新账号（nick + password），并写入 users 表
//   action=bind     : 为既有账号(user_id)绑定一个手机号，此后可用手机号+密码登录
//
// 部署：POST /v1/projects/{ref}/functions/deploy?slug=admin-phone (metadata: verify_jwt=true)
// 环境变量：SUPABASE_SERVICE_ROLE_KEY（Edge Function 内自动注入）

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const PROJECT_URL = "https://vzqspcuxnwpakofwumat.supabase.co";
const SERVICE_ROLE_KEY = (() => { try { return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""; } catch { return ""; } })();

// 仅允许网站前端调用
const ALLOWED_ORIGINS = ["https://kjllin.github.io"];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
    Vary: "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// 规范化手机号为 E.164（中国大陆手机默认补 +86）
function normalizePhone(raw: string): string {
  const p = (raw || "").trim().replace(/[\s\-()]/g, "");
  if (!p) return "";
  if (p.startsWith("+")) return p;
  if (/^1[3-9]\d{9}$/.test(p)) return "+86" + p;
  return "";
}

// 从 JWT 解出调用者 sub
function subFromJwt(token: string): string {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part)).sub || "";
  } catch { return ""; }
}

// 用 service role 调 GoTrue admin 接口
async function goTrue(path: string, init: RequestInit): Promise<{ status: number; data: any }> {
  const res = await fetch(`${PROJECT_URL}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  let data: any = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

serve(async (req: Request) => {
  const h = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "仅支持 POST" }), { headers: h });
  }
  if (!SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ success: false, error: "service_not_configured" }), { headers: h });
  }

  try {
    const callerId = subFromJwt(req.headers.get("Authorization")?.replace("Bearer ", "") || "");
    if (!callerId) {
      return new Response(JSON.stringify({ success: false, error: "请先登录" }), { headers: h });
    }

    // 核验管理员身份（service role 读取，不受 RLS 限制）
    const adminCheck = await fetch(`${PROJECT_URL}/rest/v1/users?select=is_admin&id=eq.${callerId}`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    const adminRows = adminCheck.ok ? await adminCheck.json() : [];
    if (!Array.isArray(adminRows) || adminRows.length === 0 || adminRows[0].is_admin !== true) {
      return new Response(JSON.stringify({ success: false, error: "无权访问" }), { headers: h });
    }

    const body = await req.json();
    const action = body.action;
    const phone = normalizePhone(body.phone);

    if (!phone) {
      return new Response(JSON.stringify({ success: false, error: "手机号格式不正确" }), { headers: h });
    }
    if (action === "register") {
      const nick = (body.nick || "").trim().slice(0, 20);
      const password = (body.password || "").toString();
      if (!nick) return new Response(JSON.stringify({ success: false, error: "请填写昵称" }), { headers: h });
      if (password.length < 8) {
        return new Response(JSON.stringify({ success: false, error: "密码至少8位" }), { headers: h });
      }

      const created = await goTrue("/users", {
        method: "POST",
        body: JSON.stringify({
          phone,
          password,
          email_confirm: true,
          phone_confirm: true,
          user_metadata: { nick },
          app_metadata: {},
        }),
      });
      if (!Array.isArray(created.data) && created.data && !created.data.id) {
        const msg = created.data?.msg || created.data?.error_description || "创建失败";
        const code = created.data?.code || "";
        return new Response(JSON.stringify({ success: false, error: formatErr(msg, code) }), { headers: h });
      }
      const newId = created.data.id;

      // 写入 users 表（service role 直写）
      await fetch(`${PROJECT_URL}/rest/v1/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({ id: newId, nick, phone, is_admin: false, status: "active", created_at: new Date().toISOString() }),
      });

      return new Response(JSON.stringify({ success: true, message: "账号已创建，可使用手机号+密码登录" }), { headers: h });
    }

    if (action === "bind") {
      const userId = (body.user_id || "").toString();
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: "缺少目标用户" }), { headers: h });
      }

      // 确认目标 auth 用户存在
      const existing = await goTrue(`/users/${userId}`, { method: "GET" });
      if (existing.data && !existing.data.id) {
        return new Response(JSON.stringify({ success: false, error: "目标用户不存在" }), { headers: h });
      }

      const upd = await goTrue(`/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ phone, phone_confirm: true }),
      });
      if (!upd.data || !upd.data.id) {
        const msg = upd.data?.msg || upd.data?.error_description || "绑定失败";
        const code = upd.data?.code || "";
        return new Response(JSON.stringify({ success: false, error: formatErr(msg, code) }), { headers: h });
      }

      // 同步 users 表 phone 列（按 id 定位）
      await fetch(`${PROJECT_URL}/rest/v1/users?id=eq.${userId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ phone }),
      });

      return new Response(JSON.stringify({ success: true, message: "绑定成功，该用户可用手机号+密码登录" }), { headers: h });
    }

    return new Response(JSON.stringify({ success: false, error: "无效操作" }), { headers: h });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "服务内部错误" }), { headers: h });
  }
});

function formatErr(msg: string, code: string): string {
  if (code === "user_already_exists" || msg.includes("already registered")) return "该手机号已被使用";
  if (msg.includes("password")) return "密码不符合要求";
  return msg;
}