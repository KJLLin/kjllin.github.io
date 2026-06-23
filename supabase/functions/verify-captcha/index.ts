import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const secret = (() => { try { return Deno.env.get("HCAPTCHA_SECRET") ?? ""; } catch { return ""; } })();

serve(async (req) => {
  const h = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  try {
    const { token } = await req.json();
    if (!token || !secret) return new Response(JSON.stringify({ success: false }), { headers: h });
    const fd = new URLSearchParams({ secret, response: token });
    const r = await fetch("https://api.hcaptcha.com/siteverify", { method: "POST", body: fd });
    return new Response(await r.text(), { headers: h });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { headers: h });
  }
});
