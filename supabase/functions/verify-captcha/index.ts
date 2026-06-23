import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const HCAPTCHA_SECRET = (() => {
  try { return Deno.env.get("HCAPTCHA_SECRET") || ""; } catch { return ""; }
})();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" }
    });
  }

  try {
    const { token } = await req.json();
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: "Missing token" }), { status: 400 });
    }

    if (!HCAPTCHA_SECRET) {
      return new Response(JSON.stringify({ success: false, error: "Server not configured" }), { status: 500 });
    }

    const formData = new URLSearchParams();
    formData.append("secret", HCAPTCHA_SECRET);
    formData.append("response", token);
    formData.append("sitekey", "abe0d880-7704-481a-b892-9b982f7c5890");

    const result = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST", body: formData,
    });
    const data = await result.json();

    return new Response(JSON.stringify(data), {
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }
    });
  }
});
