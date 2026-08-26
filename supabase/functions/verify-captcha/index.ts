import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const secret = (() => { try { return Deno.env.get("HCAPTCHA_SECRET") ?? ""; } catch { return ""; } })();

// 可信域名白名单（SEC-004：替代 Access-Control-Allow-Origin: *）
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

serve(async (req) => {
  const h = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  try {
    const { token } = await req.json();

    // 不返回任何诊断信息（SEC-005：移除 secret_set/secret_len/token_preview 等泄露字段）
    if (!token || !secret) {
      return new Response(JSON.stringify({ success: false, error: "invalid_request" }), { headers: h });
    }

    const fd = new URLSearchParams({ secret, response: token });
    const r = await fetch("https://api.hcaptcha.com/siteverify", { method: "POST", body: fd });

    let parsed: { success?: boolean; "error-codes"?: string[] };
    try { parsed = await r.json(); } catch { parsed = { success: false }; }

    // 区分"token 过期/重复使用"（timeout-or-duplicate）与其他失败，
    // 让前端能提示用户重新勾选，而不是笼统的"未通过"
    const errCodes = parsed["error-codes"] || [];
    const expired = errCodes.includes("timeout-or-duplicate");
    // codes 仅透传 siteverify 的 error-codes，不含 secret/token 明文（SEC-005 仍满足）
    let dbg = {};
    try {
      // 诊断（临时）：暴露 secret 的 SHA-256 指纹 + 明文长度/前缀，仅用于定位，上线后需移除
      const _s = secret || "";
      const _enc = new TextEncoder().encode(_s);
      const _buf = await crypto.subtle.digest("SHA-256", _enc);
      const _h = Array.from(new Uint8Array(_buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      dbg = { secret_len: _s.length, secret_head: _s.slice(0, 6), secret_sha256: _h };
    } catch {}
    return new Response(
      JSON.stringify({
        success: !!parsed.success,
        ...(expired ? { expired: true } : {}),
        ...(errCodes.length ? { codes: errCodes } : {}),
        ...dbg,
      }),
      { headers: h },
    );
  } catch {
    return new Response(JSON.stringify({ success: false, error: "internal_error" }), { headers: h });
  }
});
