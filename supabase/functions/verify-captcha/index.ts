import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const secret = (() => { try { return Deno.env.get("HCAPTCHA_SECRET") ?? ""; } catch { return ""; } })();

serve(async (req) => {
  const h = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  try {
    const { token } = await req.json();

    // 诊断：secret 状态
    const diag = {
      secret_set: !!secret,
      secret_len: secret.length,
      token_len: (token || "").length,
      token_preview: (token || "").substring(0, 8) + "..."
    };

    if (!token || !secret) {
      return new Response(JSON.stringify({ success: false, diag }), { headers: h });
    }

    const fd = new URLSearchParams({ secret, response: token });
    const t0 = Date.now();
    const r = await fetch("https://api.hcaptcha.com/siteverify", { method: "POST", body: fd });
    const elapsed = Date.now() - t0;
    const raw = await r.text();

    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }

    return new Response(JSON.stringify({
      ...parsed,
      diag: { ...diag, hcaptcha_ms: elapsed, hcaptcha_status: r.status }
    }), { headers: h });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { headers: h });
  }
});
