// ====================== 请在这里填写你的 Supabase 信息 ======================
const supabaseUrl = https://ayavdkodhdmcxfufnnxo.supabase.co;
const supabaseKey = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc;
// ==========================================================================

const supabase = supabase.createClient(supabaseUrl, supabaseKey);
const $ = s => document.querySelector(s);

let currentUser = null;
let userNick = localStorage.getItem("nick") || "";
let loginAttempts = 0;
let lastLoginTime = 0;
let lastSendTime = 0;

// 消息发送状态提示
function showSendStatus(text, type = "normal") {
  const el = $("#sendStatus");
  el.innerText = text;
  el.className = "send-status";
  if (type === "loading") el.classList.add("loading");
  if (type === "success") el.classList.add("success");
  if (type === "error") el.classList.add("error");
  setTimeout(() => {
    el.innerText = "";
    el.className = "send-status";
  }, 2500);
}

// 通用提示
function showTips(text) {
  $("#tips").innerText = text;
  setTimeout(() => $("#tips").innerText = "", 3000);
}

// 错误提示（同时显示在顶部和发送栏）
function showError(text) {
  showTips(text);
  showSendStatus(text, "error");
}

// 监听登录状态
supabase.auth.onAuthStateChange(async (event, session) => {
  if (session) {
    currentUser = session.user;

    // 必须验证邮箱才能继续
    if (!currentUser.email_confirmed_at) {
      showError("请先前往邮箱完成验证！");
      await supabase.auth.signOut();
      return;
    }

    // 检查用户是否存在，不存在则创建（待审核）
    const { data: userData } = await supabase
      .from("users")
      .select("*")
      .eq("id", currentUser.id)
      .single();

    if (!userData) {
      await supabase.from("users").insert([
        {
          id: currentUser.id,
          email: currentUser.email,
          nick: currentUser.user_metadata?.nick || "用户",
          status: "pending"
        }
      ]);
    }

    // 检查账号状态：待审核 / 封禁 / 正常
    await checkUserStatus();

    // 记录本次登录IP
    await recordLoginIP();

    // 加载各种功能
    loadMessages();
    monitorOnlineUsers();
    monitorAllUsers();
    updatePageUI();
    loadAnnouncement();
  } else {
    showAuthPage();
  }
});

// 检查用户状态
async function checkUserStatus() {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (data.status === "pending") {
    showError("账号已注册，请等待管理员审核通过");
    await supabase.auth.signOut();
    return;
  }

  if (data.status === "ban") {
    showError("该账号已被管理员封禁");
    await supabase.auth.signOut();
    return;
  }

  // 状态正常，显示聊天界面
  showChatPage();
}

// 记录登录IP与设备
async function recordLoginIP() {
  try {
    const ipResp = await fetch("https://api.ipify.org?format=json");
    const ipData = await ipResp.json();
    const ip = ipData.ip || "未知IP";

    const device = navigator.userAgent.substring(0, 60);
    const time = new Date().toLocaleString();

    await supabase.from("login_logs").insert([
      {
        user_id: currentUser.id,
        ip: ip,
        device: device,
        time: time
      }
    ]);
  } catch (e) {
    console.log("IP记录异常", e);
  }
}

// ========== 注册账号（用户名 + 邮箱 + 密码） ==========
async function register() {
  const nick = $("#nick").value.trim();
  const email = $("#email").value.trim();
  const pwd = $("#pwd").value.trim();

  if (!nick) {
    showError("请输入用户名");
    return;
  }

  if (pwd.length < 8) {
    showError("密码长度不能小于8位");
    return;
  }

  const { error } = await supabase.auth.signUp({
    email: email,
    password: pwd,
    options: {
      data: {
        nick: nick
      }
    }
  });

  if (error) {
    showError(error.message);
  } else {
    showTips("注册成功！请前往邮箱验证，验证后等待管理员审核");
  }
}

// ========== 登录（防暴力破解） ==========
async function login() {
  const now = Date.now();
  const email = $("#email").value.trim();
  const pwd = $("#pwd").value.trim();

  // 1 分钟内最多 5 次错误
  if (loginAttempts >= 5 && now - lastLoginTime < 60000) {
    showError("登录尝试过于频繁，请 1 分钟后再试");
    return;
  }

  const { error } = await supabase.auth.signInWithPassword({
    email: email,
    password: pwd
  });

  if (error) {
    loginAttempts++;
    lastLoginTime = now;
    showError("账号或密码错误");
  } else {
    loginAttempts = 0;
    showTips("登录成功");
  }
}

// 退出登录
async function userLogout() {
  if (currentUser) {
    await supabase.from("online_users").delete().eq("user_id", currentUser.id);
  }
  await supabase.auth.signOut();
  showTips("已安全退出登录");
}

// ========== 发送消息（防刷屏 + 敏感词过滤 + 状态显示） ==========
async function sendMsg() {
  const now = Date.now();
  const text = $("#msgInput").value.trim();

  if (now - lastSendTime < 1000) {
    showError("发送过快，请稍后再发送");
    return;
  }

  if (!text || !currentUser) {
    showError("不能发送空消息");
    return;
  }

  // 发送中状态
  showSendStatus("消息发送中...", "loading");

  try {
    // 检查是否被禁言/账号异常
    const { data: userInfo } = await supabase
      .from("users")
      .select("is_mute, status")
      .eq("id", currentUser.id)
      .single();

    if (userInfo.status !== "active" || userInfo.is_mute) {
      showError(userInfo.is_mute ? "你已被管理员禁言" : "账号状态异常，无法发言");
      return;
    }

    // 敏感词过滤
    const { data: swData } = await supabase
      .from("sensitive_words")
      .select("words")
      .single();

    let content = text;
    const badWords = (swData?.words || "").split(",").filter(w => w.trim());
    badWords.forEach(word => {
      content = content.replaceAll(word, "***");
    });

    // 插入消息
    await supabase.from("messages").insert([
      {
        user_id: currentUser.id,
        nick: userNick || currentUser.user_metadata?.nick || "用户",
        text: content,
        time: new Date().toLocaleString()
      }
    ]);

    $("#msgInput").value = "";
    lastSendTime = now;
    showSendStatus("发送成功", "success");

  } catch (err) {
    showError("发送失败：" + err.message);
  }
}

// 加载聊天消息
function loadMessages() {
  supabase
    .channel("message_channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages" },
      async () => {
        const { data: msgList } = await supabase
          .from("messages")
          .select("*")
          .order("id", { ascending: true });

        let html = "";
        msgList.forEach(msg => {
          const isMe = msg.user_id === currentUser.id;
          const delBtn = currentUser?.isAdmin
            ? `<button class="del-btn" onclick="deleteMessage(${msg.id})">×</button>`
            : "";

          html += `
          <div class="msg-item ${isMe ? "msg-me" : "msg-other"}">
            <div class="avatar">${msg.nick.charAt(0)}</div>
            <div class="bubble">
              ${delBtn}
              <div class="name">${msg.nick}</div>
              <div>${msg.text}</div>
              <div class="time">${msg.time}</div>
            </div>
          </div>
          `;
        });

        $("#msgBox").innerHTML = html;
        $("#msgBox").scrollTop = $("#msgBox").scrollHeight;
      }
    )
    .subscribe();
}

// 管理员删除消息
async function deleteMessage(msgId) {
  await supabase.from("messages").delete().eq("id", msgId);
}

// ========== 设置相关功能 ==========
// 保存昵称
function saveNick() {
  const newNick = $("#nickInput").value.trim();
  if (!newNick) return;

  userNick = newNick;
  localStorage.setItem("nick", newNick);

  supabase
    .from("users")
    .update({ nick: newNick })
    .eq("id", currentUser.id);

  showTips("昵称保存成功");
}

// 修改密码
async function updatePwd() {
  const newPwd = $("#newPwd").value.trim();
  if (newPwd.length < 8) {
    showError("新密码不能小于8位");
    return;
  }

  const { error } = await supabase.auth.updateUser({
    password: newPwd
  });

  if (error) {
    showError(error.message);
  } else {
    showTips("密码修改成功");
  }
}

// 查看自己的登录日志
async function showMyLoginLog() {
  const { data } = await supabase
    .from("login_logs")
    .select("*")
    .eq("user_id", currentUser.id)
    .limit(10);

  let logText = "=== 我的登录日志 ===\n";
  data.forEach(log => {
    logText += `IP：${log.ip}\n时间：${log.time}\n设备：${log.device}\n\n`;
  });
  alert(logText);
}

// 清空本地聊天记录
function clearLocalMsg() {
  $("#msgBox").innerHTML = "";
  showTips("本地聊天记录已清空");
}

// 切换暗黑/浅色模式
function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = current ? "" : "dark";
  localStorage.setItem("dark", document.documentElement.dataset.theme);
}

// ========== 面板控制 ==========
function openAdmin() {
  $("#adminPanel").classList.remove("hidden");
  $("#mask").classList.remove("hidden");
  loadAdminPanelData();
}

function openSetting() {
  $("#settingPanel").classList.remove("hidden");
  $("#mask").classList.remove("hidden");
}

function closeAllPanel() {
  document.querySelectorAll(".slide-panel").forEach(panel => {
    panel.classList.add("hidden");
  });
  $("#mask").classList.add("hidden");
}

// ========== 管理员功能 ==========
async function loadAdminPanelData() {
  monitorAllUsers();
  loadAllUserLoginLogs();

  const { data } = await supabase
    .from("sensitive_words")
    .select("words")
    .single();
  $("#swInput").value = data?.words || "";
}

// 监听所有用户（审核、禁言、封禁）
async function monitorAllUsers() {
  const { data: userList } = await supabase.from("users").select("*");

  let verifyHtml = "";
  let allUserHtml = "";

  userList.forEach(user => {
    const statusText =
      user.status === "active"
        ? "正常"
        : user.status === "ban"
        ? "封禁"
        : "待审核";

    // 待审核用户
    if (user.status === "pending") {
      verifyHtml += `
        <div class="user-item">
          ${user.email}
          <div>
            <button class="btn mini pri" onclick="verifyUser('${user.id}','active')">通过</button>
            <button class="btn mini danger" onclick="verifyUser('${user.id}','ban')">拒绝</button>
          </div>
        </div>
      `;
    }

    // 全部用户
    const muteText = user.is_mute ? "解禁" : "禁言";
    allUserHtml += `
      <div class="user-item">
        ${user.email}（${statusText}）
        <div>
          <button class="btn mini warn" onclick="resetUserPassword('${user.email}')">重置密码</button>
          <button class="btn mini sec" onclick="setUserMute('${user.id}',${!user.is_mute})">${muteText}</button>
        </div>
      </div>
    `;
  });

  $("#verifyList").innerHTML = verifyHtml || "暂无待审核用户";
  $("#allUserList").innerHTML = allUserHtml;
}

// 审核用户
async function verifyUser(userId, status) {
  await supabase.from("users").update({ status: status }).eq("id", userId);
}

// 禁言/解禁用户
async function setUserMute(userId, isMute) {
  await supabase.from("users").update({ is_mute: isMute }).eq("id", userId);
}

// 重置用户密码（发送邮件）
async function resetUserPassword(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) {
    showError(error.message);
  } else {
    showTips("密码重置邮件已发送");
  }
}

// 加载所有用户登录日志（管理员审计）
async function loadAllUserLoginLogs() {
  $("#loginLogPanel").innerHTML = "加载中...";
  const { data: userList } = await supabase.from("users").select("id, email");

  let logHtml = "";
  for (const user of userList) {
    const { data } = await supabase
      .from("login_logs")
      .select("*")
      .eq("user_id", user.id)
      .limit(3);

    logHtml += `<div class="user-item">${user.email}`;
    data.forEach(log => {
      logHtml += `<br>IP：${log.ip} ｜ ${log.time}`;
    });
    logHtml += `</div>`;
  }

  $("#loginLogPanel").innerHTML = logHtml;
}

// 设置敏感词
async function setSensitiveWords() {
  const words = $("#swInput").value.trim();
  const { data } = await supabase.from("sensitive_words").select("*");

  if (data && data.length > 0) {
    await supabase
      .from("sensitive_words")
      .update({ words: words })
      .eq("id", data[0].id);
  } else {
    await supabase.from("sensitive_words").insert([{ words: words }]);
  }
  showTips("敏感词配置已保存");
}

// 发送全局公告
async function sendAnnounce() {
  const content = $("#annInput").value.trim();
  const { data } = await supabase.from("announcement").select("*");

  if (data && data.length > 0) {
    await supabase
      .from("announcement")
      .update({ content: content })
      .eq("id", data[0].id);
  } else {
    await supabase.from("announcement").insert([{ content: content }]);
  }
  showTips("全局公告已推送");
}

// 加载公告
async function loadAnnouncement() {
  const { data } = await supabase
    .from("announcement")
    .select("content")
    .single();

  if (data?.content) {
    $("#announceBar").classList.remove("hidden");
    $("#announceBar").innerText = data.content;
  }
}

// ========== 在线人数 ==========
async function monitorOnlineUsers() {
  supabase
    .channel("online_channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "online_users" },
      async () => {
        const { data } = await supabase.from("online_users").select("*");
        $("#onlineNum").innerText = data?.length || 0;
      }
    )
    .subscribe();

  if (currentUser) {
    await supabase.from("online_users").upsert({ user_id: currentUser.id });
  }
}

// ========== 界面显示控制 ==========
async function updatePageUI() {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  $("#userTag").innerText = `用户：${userNick || data.nick}`;
  $("#userStatus").innerText = data.is_mute ? "状态：已禁言" : "状态：正常";

  if (data.is_admin) {
    currentUser.isAdmin = true;
    $("#adminBtn").classList.remove("hidden");
    $("#adminTag").classList.remove("hidden");
  }
}

function showChatPage() {
  $("#authPage").classList.add("hidden");
  $("#chatPage").classList.remove("hidden");
}

function showAuthPage() {
  $("#authPage").classList.remove("hidden");
  $("#chatPage").classList.add("hidden");
}

// ========== 页面加载 ==========
window.onload = () => {
  // 恢复暗黑模式
  if (localStorage.getItem("dark")) {
    document.documentElement.dataset.theme = "dark";
  }

  // 回车发送消息
  $("#msgInput").addEventListener("keypress", e => {
    if (e.key === "Enter") sendMsg();
  });

  // 关闭页面时清除在线状态
  window.onbeforeunload = async () => {
    if (currentUser) {
      await supabase.from("online_users").delete().eq("user_id", currentUser.id);
    }
  };
};
