// client-ip：返回调用方的真实 IP（SEC-006）
//
// 背景：前端记录登录设备时需要显示 IP，原先由浏览器直接请求
//       api.ipify.org / api.ip.sb / httpbin.org 三个第三方接口获取，
//       导致用户 IP 被暴露给无关的第三方，且 CSP 需为其开放白名单。
//
// 方案：改为请求本站自己的 Edge Function，IP 从 Supabase 网关注入的
//       请求头读取，不再经过任何第三方。
//
// 隐私：本函数为无状态实现，不记录、不落库、不打印任何 IP。
//       返回给调用方的只有其自身的 IP。

const ALLOWED_ORIGINS = [
  "https://kjllin.dpdns.org",
  "https://kjllin.github.io",
];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

// 取最右侧一项：X-Forwarded-For 由网关在链尾追加，
// 最右侧是离服务器最近、最不可被客户端伪造的那一跳。
// 若网关是覆盖写入，则整条只有一个值，同样取到真实 IP。
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length) return parts[parts.length - 1];
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    ""
  );
}

// 规范化：去掉 IPv6 映射前缀，避免同一地址出现两种写法
function normalize(ip: string): string {
  const v = (ip || "").trim();
  return v.startsWith("::ffff:") ? v.slice(7) : v;
}

Deno.serve((req) => {
  const h = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: h });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "method_not_allowed" }),
      { status: 405, headers: h },
    );
  }

  const ip = normalize(clientIp(req));
  if (!ip) {
    return new Response(
      JSON.stringify({ success: false, error: "ip_unavailable" }),
      { status: 200, headers: h },
    );
  }

  return new Response(JSON.stringify({ success: true, ip }), { headers: h });
});
