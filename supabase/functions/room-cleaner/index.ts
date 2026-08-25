// room-cleaner：每分钟清理过期的石头剪刀布联机房间
// 部署：supabase functions deploy room-cleaner
// 环境变量：SUPABASE_SERVICE_ROLE_KEY（Dashboard → Edge Functions → Secrets）
//
// 已知线上报错排查要点：
// 1. Deno.cron 需要 Edge Function 以 scheduled 触发器方式部署（旧版 CLI 不支持，需升级 supabase CLI）
// 2. 若 SUPABASE_SERVICE_ROLE_KEY 未配置，会在启动时打印警告且不注册 cron

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
Deno.serve(async (req: Request) => {
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

// 定时任务：每分钟执行一次
Deno.cron("clean-expired-rps-rooms", "* * * * *", async () => {
  try {
    await cleanExpiredRooms();
  } catch (e) {
    console.error("room-cleaner cron error:", e);
  }
});
