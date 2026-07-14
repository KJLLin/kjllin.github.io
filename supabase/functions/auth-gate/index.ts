import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const PROJECT_URL = "https://vzqspcuxnwpakofwumat.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6cXNwY3V4bndwYWtvZnd1bWF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODI4MTUsImV4cCI6MjA5OTQ1ODgxNX0.AlV_3gWTWTrFBO-_nYD_8RaKoC-m5p-7VpZwbnPp-Pg";
const HCAPTCHA_SECRET = (() => { try { return Deno.env.get("HCAPTCHA_SECRET") ?? ""; } catch { return ""; } })();

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization"
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const { email, password, captcha_token, action, nick } = await req.json();

    // === 1. 参数校验 ===
    if (!email || !password) {
      return new Response(JSON.stringify({ success: false, error: "邮箱和密码不能为空" }), { headers: CORS });
    }
    if (!captcha_token) {
      return new Response(JSON.stringify({ success: false, error: "缺少人机验证" }), { headers: CORS });
    }
    if (action !== "login" && action !== "register") {
      return new Response(JSON.stringify({ success: false, error: "无效的操作" }), { headers: CORS });
    }
    if (password.length < 8) {
      return new Response(JSON.stringify({ success: false, error: "密码至少8位" }), { headers: CORS });
    }

    // === 2. 服务端强制验证 hCaptcha ===
    if (!HCAPTCHA_SECRET) {
      return new Response(JSON.stringify({ success: false, error: "验证服务未配置" }), { headers: CORS });
    }

    const captchaRes = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: HCAPTCHA_SECRET, response: captcha_token })
    });
    const captchaData = await captchaRes.json();

    if (!captchaData.success) {
      return new Response(JSON.stringify({
        success: false,
        error: "人机验证失败",
        codes: captchaData["error-codes"] || []
      }), { headers: CORS });
    }

    // === 3. 执行认证操作 ===
    if (action === "login") {
      const tokenRes = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": ANON_KEY
        },
        body: JSON.stringify({ email, password })
      });
      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || tokenData.error) {
        const msg = tokenData.error_description || tokenData.error || "登录失败";
        return new Response(JSON.stringify({
          success: false,
          error: formatAuthError(msg),
        }), { headers: CORS });
      }

      return new Response(JSON.stringify({
        success: true,
        session: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          user: tokenData.user
        }
      }), { headers: CORS });
    }

    // action === "register"
    const signUpRes = await fetch(`${PROJECT_URL}/auth/v1/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY
      },
      body: JSON.stringify({
        email,
        password,
        data: { nick: (nick || email.split("@")[0]).substring(0, 20) }
      })
    });
    const signUpData = await signUpRes.json();

    if (!signUpRes.ok || signUpData.error) {
      const msg = signUpData.msg || signUpData.error || "注册失败";
      return new Response(JSON.stringify({
        success: false,
        error: formatAuthError(msg),
      }), { headers: CORS });
    }

    return new Response(JSON.stringify({
      success: true,
      message: signUpData.identities?.length
        ? "注册成功，请查收验证邮件"
        : "注册成功",
      user: signUpData
    }), { headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({
      success: false,
      error: e.message || "服务内部错误"
    }), { headers: CORS });
  }
});

function formatAuthError(msg: string): string {
  if (msg.includes("Invalid login credentials")) return "邮箱或密码错误";
  if (msg.includes("Email not confirmed")) return "邮箱未验证，请查收邮件";
  if (msg.includes("already registered") || msg.includes("already exists") || msg.includes("already been registered")) return "该邮箱已被注册";
  if (msg.includes("429")) return "请求过于频繁，请稍后重试";
  if (msg.includes("password")) return "密码不符合要求";
  return msg;
}
