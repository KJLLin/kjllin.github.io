// upload-ticket：大文件上传票据签发（服务端强制 hCaptcha）
// 流程：前端完成 hCaptcha → 携带 captcha token + 登录 JWT 调用本函数 →
//       验证通过后向 upload_tickets 表写入一次性票据（默认 10 分钟有效）→
//       上传 >5MB 文件时存储触发器校验并消耗票据
// 部署：POST /v1/projects/{ref}/functions/deploy?slug=upload-ticket (metadata: verify_jwt=true)
// 环境变量：HCAPTCHA_SECRET、SUPABASE_SERVICE_ROLE_KEY

const PROJECT_URL = "https://vzqspcuxnwpakofwumat.supabase.co";
const HCAPTCHA_SECRET = (() => { try { return Deno.env.get("HCAPTCHA_SECRET") ?? ""; } catch { return ""; } })();
const SERVICE_ROLE_KEY = (() => { try { return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""; } catch { return ""; } })();

// 可信域名白名单
const ALLOWED_ORIGINS = ["https://kjllin.github.io"];

function corsHeaders(req: Request): Record<string, string> {
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
}

// 从 JWT payload 解出用户 sub（verify_jwt=true 已保证 token 有效）
function getUserIdFromJwt(token: string): string {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(part));
    return payload.sub || "";
  } catch {
    return "";
  }
}

serve(async (req: Request) => {
  const h = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "仅支持 POST" }), { headers: h });
  }

  try {
    const { token, files } = await req.json();

    if (!HCAPTCHA_SECRET || !SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ success: false, error: "service_not_configured" }), { headers: h });
    }
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: "missing_captcha" }), { headers: h });
    }

    const userId = getUserIdFromJwt(req.headers.get("Authorization")?.replace("Bearer ", "") || "");
    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "请先登录" }), { headers: h });
    }

    // 服务端验证 hCaptcha
    const r = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: HCAPTCHA_SECRET, response: String(token) }),
    });
    let ok = false;
    try { ok = (await r.json()).success === true; } catch { ok = false; }
    if (!ok) {
      return new Response(JSON.stringify({ success: false, error: "人机验证未通过" }), { headers: h });
    }

    // 签发票据（files_allowed：本批大文件数量，单次批量上限 10）
    const filesAllowed = Math.min(Math.max(Number(files) || 1, 1), 10);
    const validUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const ins = await fetch(`${PROJECT_URL}/rest/v1/upload_tickets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({ user_id: userId, files_allowed: filesAllowed, valid_until: validUntil }),
    });
    if (!ins.ok) {
      return new Response(JSON.stringify({ success: false, error: "ticket_issue_failed" }), { headers: h });
    }

    return new Response(JSON.stringify({ success: true, valid_until: validUntil }), { headers: h });
  } catch {
    return new Response(JSON.stringify({ success: false, error: "internal_error" }), { headers: h });
  }
});
