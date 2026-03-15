// ====================== 填写你的 Supabase 配置 ======================
const supabaseUrl = https://ayavdkodhdmcxfufnnxo.supabase.co;
const supabaseKey = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc;
// ===================================================================

const supabase = supabase.createClient(supabaseUrl, supabaseKey);
const $ = s => document.querySelector(s);

let currentUser = null;
let userNick = localStorage.getItem("nick") || "";
let loginAttempts = 0, lastLoginTime = 0, lastSendTime = 0;

// 页面加载立刻执行：强制关闭所有面板，只显示登录页
window.onload = () => {
  closeAllPanel();
  showAuthPage();
  
  if (localStorage.getItem("dark")) {
    document.documentElement.dataset.theme = "dark";
  }

  $("#msgInput").addEventListener("keypress", e => {
    if (e.key === "Enter") sendMsg();
  });

  window.onbeforeunload = async () => {
    if (currentUser) {
      await supabase.from("online_users").delete().eq("user_id", currentUser.id);
    }
  };
};

// 消息状态
function showSendStatus(text, type = "normal") {
  const el = $("#sendStatus");
  el.innerText = text;
  el.className = "send-status";
  if (type === "loading") el.classList.add("loading");
  if (type === "success") el.classList.add("success");
  if (type === "error") el.classList.add("error");
  setTimeout(() => { el.innerText = ""; el.className = "send-status"; }, 2500);
}
function showTips(text) { $("#tips").innerText = text; setTimeout(() => $("#tips").innerText = "", 3000); }
function showError(text) { showTips(text); showSendStatus(text, "error"); }

// 登录监听
supabase.auth.onAuthStateChange(async (event, session) => {
  closeAllPanel(); // 每次状态变化都关闭面板
  if (session) {
    currentUser = session.user;
    if (!currentUser.email_confirmed_at) {
      showError("请先验证邮箱！");
      await supabase.auth.signOut();
      return;
    }
    const { data: u } = await supabase.from("users").select("*").eq("id", currentUser.id).single();
    if (!u) {
      await supabase.from("users").insert([{
        id: currentUser.id,
        email: currentUser.email,
        nick: currentUser.user_metadata?.nick || "用户",
        status: "pending"
      }]);
    }
    await checkUserStatus();
    await recordLoginIP();
    loadMessages();
    monitorOnline();
    monitorUsers();
    updateUI();
    loadAnnouncement();
  } else {
    showAuthPage();
  }
});

// 检查用户状态
async function checkUserStatus() {
  const { data } = await supabase.from("users").select("*").eq("id", currentUser.id).single();
  if (data.status === "pending") { showError("待管理员审核"); await supabase.auth.signOut(); return; }
  if (data.status === "ban") { showError("账号已封禁"); await supabase.auth.signOut(); return; }
  showChatPage();
}

// 记录IP
async function recordLoginIP() {
  const ip = await fetch("https://api.ipify.org?format=json").then(r=>r.json()).then(d=>d.ip).catch(()=>"未知");
  const device = navigator.userAgent.substring(0, 60);
  const time = new Date().toLocaleString();
  await supabase.from("login_logs").insert([{ user_id: currentUser.id, ip, device, time }]);
}

// 注册
async function register() {
  const nick = $("#nick").value.trim();
  const email = $("#email").value.trim();
  const pwd = $("#pwd").value.trim();
  if (!nick) { showError("请输入用户名"); return; }
  if (pwd.length < 8) { showError("密码≥8位"); return; }
  const { error } = await supabase.auth.signUp({
    email, password: pwd, options: { data: { nick } }
  });
  error ? showError(error.message) : showTips("注册成功，请验证邮箱");
}

// 登录
async function login() {
  const now = Date.now();
  if (loginAttempts >=5 && now - lastLoginTime < 60000) { showError("1分钟后再试"); return; }
  const email = $("#email").value.trim();
  const pwd = $("#pwd").value.trim();
  const { error } = await supabase.auth.signInWithPassword({ email, password: pwd });
  if (error) { loginAttempts++; lastLoginTime = now; showError("账号或密码错误"); }
  else { loginAttempts = 0; showTips("登录成功"); }
}

// 退出
async function userLogout() {
  await supabase.from("online_users").delete().eq("user_id", currentUser.id);
  await supabase.auth.signOut();
  showTips("已退出");
}

// 发送消息
async function sendMsg() {
  const now = Date.now();
  const text = $("#msgInput").value.trim();
  if (now - lastSendTime < 1000) { showError("发送过快"); return; }
  if (!text) { showError("消息不能为空"); return; }

  showSendStatus("发送中...", "loading");
  try {
    const { data: u } = await supabase.from("users").select("is_mute,status").eq("id", currentUser.id).single();
    if (u.status !== "active" || u.is_mute) { showError(u.is_mute ? "已禁言" : "状态异常"); return; }

    const { data: sw } = await supabase.from("sensitive_words").select("words").single();
    let content = text;
    (sw?.words || "").split(",").filter(w => w).forEach(w => content = content.replaceAll(w, "***"));

    await supabase.from("messages").insert([{
      user_id: currentUser.id,
      nick: userNick || currentUser.user_metadata.nick,
      text: content,
      time: new Date().toLocaleString()
    }]);

    $("#msgInput").value = "";
    lastSendTime = now;
    showSendStatus("发送成功", "success");
  } catch (e) {
    showError("发送失败：" + e.message);
  }
}

// 加载消息
function loadMessages() {
  supabase.channel("msg").on("postgres_changes", { event: "*", schema: "public", table: "messages" }, async () => {
    const { data } = await supabase.from("messages").select("*").order("id", { ascending: true });
    let html = "";
    data.forEach(m => {
      const isMe = m.user_id === currentUser.id;
      const del = currentUser?.isAdmin ? `<button class="del-btn" onclick="delMsg(${m.id})">×</button>` : "";
      html += `
        <div class="msg-item ${isMe ? 'msg-me' : 'msg-other'}">
          <div class="avatar">${m.nick.charAt(0)}</div>
          <div class="bubble">${del}
            <div class="name">${m.nick}</div>
            <div>${m.text}</div>
            <div class="time">${m.time}</div>
          </div>
        </div>`;
    });
    $("#msgBox").innerHTML = html;
    $("#msgBox").scrollTop = $("#msgBox").scrollHeight;
  }).subscribe();
}
async function delMsg(id) { await supabase.from("messages").delete().eq("id", id); }

// 设置
function saveNick() {
  const n = $("#nickInput").value.trim();
  if (!n) return;
  userNick = n; localStorage.setItem("nick", n);
  supabase.from("users").update({ nick: n }).eq("id", currentUser.id);
  showTips("昵称保存成功");
}
async function updatePwd() {
  const p = $("#newPwd").value.trim();
  if (p.length <8) { showError("密码≥8位"); return; }
  const { error } = await supabase.auth.updateUser({ password: p });
  error ? showError(error.message) : showTips("密码修改成功");
}
async function showMyLoginLog() {
  const { data } = await supabase.from("login_logs").select("*").eq("user_id", currentUser.id).limit(10);
  let str = "登录日志：\n";
  data.forEach(d => str += `IP:${d.ip} ${d.time}\n`);
  alert(str);
}
function clearLocalMsg() { $("#msgBox").innerHTML = ""; }
function toggleTheme() {
  const d = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = d ? "" : "dark";
  localStorage.setItem("dark", document.documentElement.dataset.theme);
}

// 面板控制 - 核心修复
function openAdmin() { $("#adminPanel").classList.remove("hidden"); $("#mask").classList.remove("hidden"); loadAdminData(); }
function openSetting() { $("#settingPanel").classList.remove("hidden"); $("#mask").classList.remove("hidden"); }
function closeAllPanel() {
  $("#settingPanel").classList.add("hidden");
  $("#adminPanel").classList.add("hidden");
  $("#mask").classList.add("hidden");
}

// 管理员
async function loadAdminData() { monitorUsers(); loadAllLoginLogs(); }
async function monitorUsers() {
  const { data } = await supabase.from("users").select("*");
  let v = "", a = "";
  data.forEach(u => {
    const st = u.status === "active" ? "正常" : u.status === "ban" ? "封禁" : "待审";
    if (u.status === "pending") v += `<div class="user-item">${u.email}<div><button class="btn mini pri" onclick="verify('${u.id}','active')">通过</button><button class="btn mini danger" onclick="verify('${u.id}','ban')">拒绝</button></div></div>`;
    a += `<div class="user-item">${u.email}(${st})<div><button class="btn mini warn" onclick="resetPwd('${u.email}')">重置</button><button class="btn mini sec" onclick="mute('${u.id}',${!u.is_mute})">${u.is_mute?"解禁":"禁言"}</button></div></div>`;
  });
  $("#verifyList").innerHTML = v || "无";
  $("#allUserList").innerHTML = a;
}
async function verify(id, s) { await supabase.from("users").update({ status: s }).eq("id", id); }
async function mute(id, val) { await supabase.from("users").update({ is_mute: val }).eq("id", id); }
async function resetPwd(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  error ? showError(error.message) : showTips("重置邮件已发送");
}
async function loadAllLoginLogs() {
  $("#loginLogPanel").innerHTML = "加载中...";
  const { data: users } = await supabase.from("users").select("id,email");
  let h = "";
  for (const u of users) {
    const { data } = await supabase.from("login_logs").select("*").eq("user_id", u.id).limit(3);
    h += `<div class="user-item">${u.email}`;
    data.forEach(d => h += `<br>IP:${d.ip} ${d.time}`);
    h += "</div>";
  }
  $("#loginLogPanel").innerHTML = h;
}
async function setSensitiveWords() {
  const w = $("#swInput").value.trim();
  const { data } = await supabase.from("sensitive_words").select("*");
  data.length ? await supabase.from("sensitive_words").update({ words: w }).eq("id", data[0].id)
  : await supabase.from("sensitive_words").insert([{ words: w }]);
  showTips("保存成功");
}
async function sendAnnounce() {
  const c = $("#annInput").value.trim();
  const { data } = await supabase.from("announcement").select("*");
  data.length ? await supabase.from("announcement").update({ content: c }).eq("id", data[0].id)
  : await supabase.from("announcement").insert([{ content: c }]);
  showTips("公告已推送");
}
async function loadAnnouncement() {
  const { data } = await supabase.from("announcement").select("content").single();
  if (data?.content) { $("#announceBar").classList.remove("hidden"); $("#announceBar").innerText = data.content; }
}

// 在线
async function monitorOnline() {
  supabase.channel("online").on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, async () => {
    const { data } = await supabase.from("online_users").select("*");
    $("#onlineNum").innerText = data.length;
  }).subscribe();
  if (currentUser) await supabase.from("online_users").upsert({ user_id: currentUser.id });
}

// UI
async function updateUI() {
  const { data } = await supabase.from("users").select("*").eq("id", currentUser.id).single();
  $("#userTag").innerText = `用户：${userNick || data.nick}`;
  $("#userStatus").innerText = data.is_mute ? "状态：已禁言" : "状态：正常";
  if (data.is_admin) {
    currentUser.isAdmin = true;
    $("#adminBtn").classList.remove("hidden");
    $("#adminTag").classList.remove("hidden");
  }
}

// 页面切换
function showChatPage() { $("#authPage").classList.add("hidden"); $("#chatPage").classList.remove("hidden"); }
function showAuthPage() { $("#authPage").classList.remove("hidden"); $("#chatPage").classList.add("hidden"); }
