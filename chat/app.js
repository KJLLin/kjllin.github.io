// ====================== 填写你的 Supabase 配置 ======================
const supabaseUrl = https://ayavdkodhdmcxfufnnxo.supabase.co;
const supabaseKey = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc;
// ===================================================================

const supabase = supabase.createClient(supabaseUrl, supabaseKey);
const $ = s => document.querySelector(s);

let currentUser = null;
let userNick = localStorage.getItem("nick") || "";
let loginAttempts = 0, lastLoginTime = 0, lastSendTime = 0;
let isRegistering = false; // 防重复注册

// 页面初始化：强制关闭所有面板，只显示登录
document.addEventListener('DOMContentLoaded', () => {
  closeAllPanel();
  showAuthPage();
  if (localStorage.getItem("dark")) document.documentElement.dataset.theme = "dark";
  
  // 回车注册/登录
  $("#pwd").addEventListener("keypress", e => {
    if (e.key === "Enter") register();
  });
  $("#msgInput").addEventListener("keypress", e => {
    if (e.key === "Enter") sendMsg();
  });
});

// 全局提示
function showTips(text) {
  $("#tips").innerText = text;
  setTimeout(() => $("#tips").innerText = "", 3500);
}
function showError(text) {
  showTips("❌ " + text);
}
function showSendStatus(text, type) {
  const el = $("#sendStatus");
  el.innerText = text;
  el.className = "send-status";
  if (type) el.classList.add(type);
  setTimeout(() => { el.innerText = ""; el.className = "send-status"; }, 2500);
}

// 登录状态监听
supabase.auth.onAuthStateChange(async (event, session) => {
  closeAllPanel();
  if (session) {
    currentUser = session.user;
    if (!currentUser.email_confirmed_at) {
      showError("请先验证邮箱！");
      await supabase.auth.signOut();
      return;
    }
    // 初始化用户数据
    const { data: userData } = await supabase.from("users").select("*").eq("id", currentUser.id).single();
    if (!userData) {
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
    updateUI();
    loadAnnouncement();
  } else {
    showAuthPage();
  }
});

// 检查账号状态
async function checkUserStatus() {
  const { data } = await supabase.from("users").select("*").eq("id", currentUser.id).single();
  if (data.status === "pending") {
    showError("账号待管理员审核");
    await supabase.auth.signOut();
    return;
  }
  if (data.status === "ban") {
    showError("账号已被封禁");
    await supabase.auth.signOut();
    return;
  }
  showChatPage();
}

// 记录登录IP
async function recordLoginIP() {
  try {
    const ip = await fetch("https://api.ipify.org?format=json").then(r=>r.json()).then(d=>d.ip).catch(()=>"未知");
    const device = navigator.userAgent.substring(0, 60);
    const time = new Date().toLocaleString();
    await supabase.from("login_logs").insert([{ user_id: currentUser.id, ip, device, time }]);
  } catch (e) {}
}

// ====================== 修复：注册函数（完整捕获+防重复） ======================
async function register() {
  // 防重复点击
  if (isRegistering) return;
  isRegistering = true;
  $("#regBtn").innerText = "注册中...";
  $("#regBtn").disabled = true;

  try {
    const nick = $("#nick").value.trim();
    const email = $("#email").value.trim();
    const pwd = $("#pwd").value.trim();

    // 表单校验
    if (!nick) { showError("请输入用户名"); throw new Error(); }
    if (!email || !email.includes("@")) { showError("请输入正确邮箱"); throw new Error(); }
    if (pwd.length < 8) { showError("密码长度≥8位"); throw new Error(); }

    // 调用Supabase注册
    const { error } = await supabase.auth.signUp({
      email,
      password: pwd,
      options: { data: { nick } }
    });

    if (error) {
      showError(error.message);
      throw new Error();
    }

    showTips("✅ 注册成功！请去邮箱验证，验证后等待审核");
    $("#nick").value = "";
    $("#email").value = "";
    $("#pwd").value = "";

  } catch (e) {
    console.error("注册异常", e);
  } finally {
    isRegistering = false;
    $("#regBtn").innerText = "注册新账号";
    $("#regBtn").disabled = false;
  }
}

// 登录
async function login() {
  const now = Date.now();
  const email = $("#email").value.trim();
  const pwd = $("#pwd").value.trim();

  if (loginAttempts >=5 && now - lastLoginTime < 60000) {
    showError("登录频繁，1分钟后再试");
    return;
  }
  if (!email || !pwd) {
    showError("邮箱和密码不能为空");
    return;
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password: pwd });
  if (error) {
    loginAttempts++;
    lastLoginTime = now;
    showError("账号或密码错误");
  } else {
    loginAttempts = 0;
    showTips("✅ 登录成功");
  }
}

// 退出登录
async function userLogout() {
  if (currentUser) await supabase.from("online_users").delete().eq("user_id", currentUser.id);
  await supabase.auth.signOut();
  showTips("✅ 已安全退出");
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
    if (u.status !== "active" || u.is_mute) {
      showError(u.is_mute ? "已被禁言" : "账号异常");
      return;
    }
    // 敏感词过滤
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
    showError("发送失败");
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

// 基础功能
async function delMsg(id) { await supabase.from("messages").delete().eq("id", id); }
function saveNick() {
  const n = $("#nickInput").value.trim();
  if (!n) return;
  userNick = n; localStorage.setItem("nick", n);
  supabase.from("users").update({ nick: n }).eq("id", currentUser.id);
  showTips("✅ 昵称保存成功");
}
async function updatePwd() {
  const p = $("#newPwd").value.trim();
  if (p.length <8) { showError("密码≥8位"); return; }
  const { error } = await supabase.auth.updateUser({ password: p });
  error ? showError(error.message) : showTips("✅ 密码修改成功");
}
async function showMyLoginLog() {
  const { data } = await supabase.from("login_logs").select("*").eq("user_id", currentUser.id).limit(10);
  let str = "=== 我的登录日志 ===\n";
  data.forEach(d => str += `IP:${d.ip}\n时间:${d.time}\n`);
  alert(str);
}
function clearLocalMsg() { $("#msgBox").innerHTML = ""; showTips("✅ 已清空本地记录"); }
function toggleTheme() {
  const d = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = d ? "" : "dark";
  localStorage.setItem("dark", document.documentElement.dataset.theme);
}

// 面板控制
function openAdmin() { $("#adminPanel").classList.remove("hidden"); $("#mask").classList.remove("hidden"); loadAdminData(); }
function openSetting() { $("#settingPanel").classList.remove("hidden"); $("#mask").classList.remove("hidden"); }
function closeAllPanel() {
  $("#settingPanel").classList.add("hidden");
  $("#adminPanel").classList.add("hidden");
  $("#mask").classList.add("hidden");
}

// 管理员功能
async function loadAdminData() { monitorUsers(); loadAllLoginLogs(); }
async function monitorUsers() {
  const { data } = await supabase.from("users").select("*");
  let v = "", a = "";
  data.forEach(u => {
    const st = u.status === "active" ? "正常" : u.status === "ban" ? "封禁" : "待审";
    if (u.status === "pending") v += `<div class="user-item">${u.email}<div><button class="btn mini pri" onclick="verify('${u.id}','active')">通过</button><button class="btn mini danger" onclick="verify('${u.id}','ban')">拒绝</button></div></div>`;
    a += `<div class="user-item">${u.email}(${st})<div><button class="btn mini warn" onclick="resetPwd('${u.email}')">重置</button><button class="btn mini sec" onclick="mute('${u.id}',${!u.is_mute})">${u.is_mute?"解禁":"禁言"}</button></div></div>`;
  });
  $("#verifyList").innerHTML = v || "暂无审核";
  $("#allUserList").innerHTML = a;
}
async function verify(id, s) { await supabase.from("users").update({ status: s }).eq("id", id); }
async function mute(id, val) { await supabase.from("users").update({ is_mute: val }).eq("id", id); }
async function resetPwd(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  error ? showError(error.message) : showTips("✅ 重置邮件已发送");
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
  showTips("✅ 敏感词保存成功");
}
async function sendAnnounce() {
  const c = $("#annInput").value.trim();
  const { data } = await supabase.from("announcement").select("*");
  data.length ? await supabase.from("announcement").update({ content: c }).eq("id", data[0].id)
  : await supabase.from("announcement").insert([{ content: c }]);
  showTips("✅ 公告推送成功");
}
async function loadAnnouncement() {
  const { data } = await supabase.from("announcement").select("content").single();
  if (data?.content) { $("#announceBar").classList.remove("hidden"); $("#announceBar").innerText = data.content; }
}

// 在线人数
async function monitorOnline() {
  supabase.channel("online").on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, async () => {
    const { data } = await supabase.from("online_users").select("*");
    $("#onlineNum").innerText = data?.length || 0;
  }).subscribe();
  if (currentUser) await supabase.from("online_users").upsert({ user_id: currentUser.id });
}

// UI更新
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

// 关闭页面清理在线状态
window.onbeforeunload = async () => {
  if (currentUser) await supabase.from("online_users").delete().eq("user_id", currentUser.id);
};
