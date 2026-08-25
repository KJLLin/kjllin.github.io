// room-cleaner：清理过期的石头剪刀布联机房间（HTTP 手动触发）
// 部署：POST /v1/projects/{ref}/functions/deploy?slug=room-cleaner (multipart, metadata: verify_jwt=false)
// 环境变量：SUPABASE_SERVICE_ROLE_KEY（Dashboard → Edge Functions → Secrets）
//
// 定时清理已改用数据库 pg_cron（见 migration/07），比 Edge Function cron 更可靠
// （Deno.cron 与 Deno.serve 共存会导致 worker 启动报错，此前的线上报错即源于此）。

const PROJECT_URL = "https://vzqspcuxnwpakofwumat.supabase.co";
const SERVICE_ROLE_KEY = (() => {
  try { return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""; } catch { return ""; }
})();

async function cleanExpiredRooms(): Promise<{ closed: number }> {
  if (!SERVICE_ROLE_KEY) {
    console.warn("room-cleaner: SUPABASE_SERVICE_ROLE_KEY not configured, skip");
    return { closed: 0 };
  }

  const now = new Date().toISOString();
  // 将所有未关闭且已过期的房间置为 closed（一次 PATCH，原子操作）
  const res = await fetch(
    `${PROJECT_URL}/rest/v1/rps_rooms?status=neq.closed&expires_at=lt.${encodeURIComponent(now)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({ status: "closed" }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH rps_rooms failed: HTTP ${res.status} ${text}`);
  }

  const rows = await res.json();
  const closed = Array.isArray(rows) ? rows.length : 0;
  if (closed > 0) console.log(`room-cleaner: closed ${closed} expired room(s)`);
  return { closed };
}

// HTTP 端点：支持手动触发（便于测试与排查）
Deno.serve(async () => {
  try {
    const result = await cleanExpiredRooms();
    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("room-cleaner error:", e);
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "internal_error" }),
      { headers: { "Content-Type": "application/json" }, status: 500 }
    );
  }
});
