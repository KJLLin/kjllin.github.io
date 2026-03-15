// ====================== 填写你的 Supabase 配置 ======================
const supabaseUrl = https://ayavdkodhdmcxfufnnxo.supabase.co;
const supabaseKey = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc;
// ===================================================================

// 初始化Supabase
const supabase = supabase.createClient(supabaseUrl, supabaseKey);
const $ = s => document.querySelector(s);

// 全局状态
let currentUser = null;
let userNick = localStorage.getItem("nick") || "";
let loginAttempts = 0, lastLoginTime = 0, lastSendTime = 0;
let isProcessing = false; // 防重复提交锁

// 页面初始化
document.addEventListener('DOMContentLoaded', () => {
  // 强制关闭所有面板，默认显示登录页
  closeAllPanel();
  switchToLogin();
  
  // 恢复暗黑模式
  if (localStorage.getItem("dark")) {
    document.documentElement.dataset.theme = "dark";
  }
  
  // 回车登录/注册
  $("#loginPwd")?.addEventListener("keypress", e => {
    if (e.key === "Enter") login();
  });
  $("#regPwd")?.addEventListener("keypress", e => {
    if (e.key === "Enter") register();
  });
  $("#msgInput")?.addEventListener("keypress", e => {
    if (e.key === "Enter") sendMsg();
  });

  // 监听登录状态变化
  supabase.auth.onAuthStateChange(async (event, session) => {
    closeAllPanel();
    if (session) {
      currentUser = session.user;
      showNotify("info", "正在验证账号状态...");
      
      // 验证邮箱是否激活
      if (!currentUser.email_confirmed_at) {
        showNotify("error", "请先前往邮箱完成验证，验证后才能登录");
        await supabase.auth.signOut();
        return;
      }

      // 初始化用户数据
      try {
        const { data: userData } = await supabase
          .from("users")
          .select("*")
          .eq("id", currentUser.id)
          .single();

        // 新用户自动创建记录
        if (!userData) {
          await supabase.from("users").insert([{
            id: currentUser.id,
            email: currentUser.email,
            nick: currentUser.user_metadata?.nick || "用户" + Date.now().toString().slice(-4),
            status: "pending",
            is_mute: false,
            is_admin: false
          }]);
          showNotify("info", "新账号已创建，等待管理员审核");
          await supabase.auth.signOut();
          return;
        }

        // 检查账号状态
        if (userData.status === "pending") {
          showNotify("error", "账号已注册，等待管理员审核通过后才能登录");
          await supabase.auth.signOut();
          return;
        }
        if (userData.status === "ban") {
          showNotify("error", "该账号已被管理员封禁，无法登录");
          await supabase.auth.signOut();
          return;
        }

        // 账号正常，进入聊天
        showNotify("success", "登录成功，正在进入聊天室...");
        await recordLoginIP();
        loadMessages();
        monitorOnline();
        updateUI();
        loadAnnouncement();
        showChatPage();

      } catch (error) {
        showNotify("error", "账号初始化失败：" + error.message);
        await supabase.auth.signOut();
      }
    } else {
      // 未登录，显示登录页
      switchToLogin();
    }
  });
});

// ====================== 核心新增：全局通知函数 ======================
function showNotify(type, message) {
  const notifyEl = $("#globalNotify");
  // 清除之前的定时器
  if (notifyEl.timer) clearTimeout(notifyEl.timer);
  
  // 设置通知类型和内容
  notifyEl.className = `notify ${type}`;
  notifyEl.innerHTML = `
    ${type === "success" ? "✅" : type === "error" ? "❌" : type === "info" ? "ℹ️" : "🔄"}
    ${message}
  `;
  
  // 显示通知
  notifyEl.classList.remove("hidden");
  
  // 5秒后隐藏
  notifyEl.timer = setTimeout(() => {
    notifyEl.classList.add("hidden");
  }, 5000);
}

// ====================== 登录/注册切换 ======================
function switchToLogin() {
  $("#loginPage").classList.remove("hidden");
  $("#registerPage").classList.add("hidden");
  $("#loginTips").innerText = "";
}

function switchToRegister() {
  $("#registerPage").classList.remove("hidden");
  $("#loginPage").classList.add("hidden");
  $("#regTips").innerText = "";
}

// ====================== 修复：登录函数（100%响应） ======================
async function login() {
  // 防重复提交
  if (isProcessing) return;
  isProcessing = true;
  $("#loginBtn").innerText = "登录中...";
  $("#loginBtn").disabled = true;
  $("#loginTips").innerText = "";

  try {
    const email = $("#loginEmail").value.trim();
    const pwd = $("#loginPwd").value.trim();
    const now = Date.now();

    // 表单校验
    if (!email) {
      showNotify("error", "请输入邮箱账号");
      throw new Error("邮箱为空");
    }
    if (!email.includes("@")) {
      showNotify("error", "请输入正确的邮箱格式");
      throw new Error("邮箱格式错误");
    }
    if (!pwd || pwd.length < 8) {
      showNotify("error", "密码长度不能小于8位");
      throw new Error("密码格式错误");
    }

    // 防暴力破解
    if (loginAttempts >= 5 && now - lastLoginTime < 60000) {
      showNotify("error", "登录尝试过于频繁，请1分钟后再试");
      throw new Error("登录频繁");
    }

    // 调用Supabase登录
    showNotify("info", "正在验证账号信息...");
    const { error } = await supabase.auth.signInWithPassword({
      email: email,
      password: pwd
    });

    if (error) {
      loginAttempts++;
      lastLoginTime = now;
      showNotify("error", "登录失败：" + error.message);
      $("#loginTips").innerText = "账号或密码错误";
      throw new Error(error.message);
    }

    // 登录成功（后续由authStateChange处理）
    showNotify("success", "登录验证成功，正在进入聊天室...");

  } catch (e) {
    console.error("登录异常：", e);
  } finally {
    isProcessing = false;
    $("#loginBtn").innerText = "立即登录";
    $("#loginBtn").disabled = false;
  }
}

// ====================== 修复：注册函数（100%响应） ======================
async function register() {
  // 防重复提交
  if (isProcessing) return;
  isProcessing = true;
  $("#regBtn").innerText = "注册中...";
  $("#regBtn").disabled = true;
  $("#regTips").innerText = "";

  try {
    const nick = $("#regNick").value.trim();
    const email = $("#regEmail").value.trim();
    const pwd = $("#regPwd").value.trim();

    // 表单强校验
    if (!nick) {
      showNotify("error", "请输入用户名（注册必填）");
      throw new Error("用户名为空");
    }
    if (nick.length > 20) {
      showNotify("error", "用户名长度不能超过20位");
      throw new Error("用户名过长");
    }
    if (!email) {
      showNotify("error", "请输入邮箱账号");
      throw new Error("邮箱为空");
    }
    if (!email.includes("@")) {
      showNotify("error", "请输入正确的邮箱格式");
      throw new Error("邮箱格式错误");
    }
    if (!pwd || pwd.length < 8) {
      showNotify("error", "密码长度不能小于8位");
      throw new Error("密码格式错误");
    }

    // 调用Supabase注册
    showNotify("info", "正在创建账号，请稍候...");
    const { error } = await supabase.auth.signUp({
      email: email,
      password: pwd,
      options: {
        data: { nick: nick },
        emailRedirectTo: `${window.location.origin}/chat` // 关键：指定回调地址
      }
    });

    if (error) {
      showNotify("error", "注册失败：" + error.message);
      $("#regTips").innerText = error.message;
      throw new Error(error.message);
    }

    // 注册成功
    showNotify("success", "注册成功！请前往邮箱验证账号，验证后等待管理员审核");
    // 清空表单
    $("#regNick").value = "";
    $("#regEmail").value = "";
    $("#regPwd").value = "";
    // 自动切回登录页
    setTimeout(() => switchToLogin(), 2000);

  } catch (e) {
    console.error("注册异常：", e);
  } finally {
    isProcessing = false;
    $("#regBtn").innerText = "注册新账号";
    $("#regBtn").disabled = false;
  }
}

// ====================== 核心功能函数 ======================
// 退出登录
async function userLogout() {
  showNotify("info", "正在安全退出...");
  try {
    if (currentUser) {
      await supabase.from("online_users").delete().eq("user_id", currentUser.id);
    }
    await supabase.auth.signOut();
    showNotify("success", "已安全退出账号");
    switchToLogin();
  } catch (e) {
    showNotify("error", "退出失败：" + e.message);
  }
}

// 发送消息
async function sendMsg() {
  const now = Date.now();
  const text = $("#msgInput").value.trim();
  
  // 防刷屏
  if (now - lastSendTime < 1000) {
    showNotify("error", "发送过快，请等待1秒后再试");
    return;
  }
  if (!text) {
    showNotify("error", "不能发送空消息");
    return;
  }
  if (!currentUser) {
    showNotify("error", "请先登录后再发送消息");
    return;
  }

  showSendStatus("发送中...", "loading");
  try {
    // 检查账号状态
    const { data: userInfo } = await supabase
      .from("users")
      .select("is_mute, status")
      .eq("id", currentUser.id)
      .single();

    if (userInfo.status !== "active") {
      showNotify("error", "账号状态异常，无法发送消息");
      return;
    }
    if (userInfo.is_mute) {
      showNotify("error", "你已被管理员禁言，无法发送消息");
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
    await supabase.from("messages").insert([{
      user_id: currentUser.id,
      nick: userNick || currentUser.user_metadata?.nick || "用户",
      text: content,
      time: new Date().toLocaleString()
    }]);

    // 清空输入框
    $("#msgInput").value = "";
    lastSendTime = now;
    showSendStatus("发送成功", "success");
    showNotify("success", "消息发送成功");

  } catch (err) {
    showSendStatus("发送失败", "error");
    showNotify("error", "消息发送失败：" + err.message);
  }
}

// 加载消息
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

// 删除消息（管理员）
async function deleteMessage(msgId) {
  try {
    await supabase.from("messages").delete().eq("id", msgId);
    showNotify("success", "消息已删除");
  } catch (e) {
    showNotify("error", "删除消息失败：" + e.message);
  }
}

// 记录登录IP
async function recordLoginIP() {
  try {
    const ipResp = await fetch("https://api.ipify.org?format=json");
    const ipData = await ipResp.json();
    const ip = ipData.ip || "未知IP";
    const device = navigator.userAgent.substring(0, 60);
    const time = new Date().toLocaleString();

    await supabase.from("login_logs").insert([{
      user_id: currentUser.id,
      ip: ip,
      device: device,
      time: time
    }]);
  } catch (e) {
    console.log("IP记录异常：", e);
  }
}

// ====================== 个人设置功能 ======================
function saveNick() {
  const newNick = $("#nickInput").value.trim();
  if (!newNick) {
    showNotify("error", "请输入有效的昵称");
    return;
  }
  if (newNick.length > 20) {
    showNotify("error", "昵称长度不能超过20位");
    return;
  }

  userNick = newNick;
  localStorage.setItem("nick", newNick);

  supabase
    .from("users")
    .update({ nick: newNick })
    .eq("id", currentUser.id)
    .then(() => {
      showNotify("success", "昵称修改成功");
      updateUI();
    })
    .catch(err => {
      showNotify("error", "昵称修改失败：" + err.message);
    });
}

async function updatePwd() {
  const newPwd = $("#newPwd").value.trim();
  if (newPwd.length < 8) {
    showNotify("error", "新密码长度不能小于8位");
    return;
  }

  try {
    showNotify("info", "正在修改密码...");
    const { error } = await supabase.auth.updateUser({
      password: newPwd
    });

    if (error) {
      showNotify("error", "密码修改失败：" + error.message);
      throw new Error(error.message);
    }

    showNotify("success", "密码修改成功，请重新登录");
    $("#newPwd").value = "";
    // 自动退出登录
    setTimeout(() => userLogout(), 2000);

  } catch (e) {
    console.error("修改密码异常：", e);
  }
}

async function showMyLoginLog() {
  try {
    const { data } = await supabase
      .from("login_logs")
      .select("*")
      .eq("user_id", currentUser.id)
      .order("time", { ascending: false })
      .limit(10);

    let logText = "=== 我的登录日志 ===\n\n";
    data.forEach((log, index) => {
      logText += `${index + 1}. IP：${log.ip}\n   时间：${log.time}\n   设备：${log.device}\n\n`;
    });
    
    alert(logText);
  } catch (e) {
    showNotify("error", "获取登录日志失败：" + e.message);
  }
}

function clearLocalMsg() {
  $("#msgBox").innerHTML = "";
  showNotify("success", "本地聊天记录已清空");
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = current ? "" : "dark";
  localStorage.setItem("dark", document.documentElement.dataset.theme);
  showNotify("success", "已切换为" + (current ? "浅色" : "暗黑") + "模式");
}

// ====================== 面板控制 ======================
function openAdmin() {
  $("#adminPanel").classList.remove("hidden");
  $("#mask").classList.remove("hidden");
  loadAdminPanelData();
  showNotify("info", "已打开管理员后台");
}

function openSetting() {
  $("#settingPanel").classList.remove("hidden");
  $("#mask").classList.remove("hidden");
  // 填充当前昵称
  $("#nickInput").value = userNick || "";
}

function closeAllPanel() {
  document.querySelectorAll(".slide-panel").forEach(panel => {
    panel.classList.add("hidden");
  });
  $("#mask").classList.add("hidden");
}

// ====================== 管理员功能 ======================
async function loadAdminPanelData() {
  monitorAllUsers();
  loadAllUserLoginLogs();

  // 加载敏感词
  const { data } = await supabase
    .from("sensitive_words")
    .select("words")
    .single()
    .catch(() => ({ data: { words: "" } }));
  
  $("#swInput").value = data?.words || "";
}

// 监听所有用户
async function monitorAllUsers() {
  const { data: userList } = await supabase
    .from("users")
    .select("*")
    .order("status", { ascending: true });

  let verifyHtml = "";
  let allUserHtml = "";

  userList.forEach(user => {
    const statusText = user.status === "active" ? "正常" : user.status === "ban" ? "封禁" : "待审核";
    const muteText = user.is_mute ? "解禁" : "禁言";

    // 待审核用户
    if (user.status === "pending") {
      verifyHtml += `
        <div class="user-item">
          ${user.email}（${user.nick}）
          <div>
            <button class="btn mini pri" onclick="verifyUser('${user.id}','active')">通过</button>
            <button class="btn mini danger" onclick="verifyUser('${user.id}','ban')">拒绝</button>
          </div>
        </div>
      `;
    }

    // 全部用户
    allUserHtml += `
      <div class="user-item">
        ${user.email}（${user.nick} - ${statusText}）
        <div>
          <button class="btn mini warn" onclick="resetUserPassword('${user.email}')">重置密码</button>
          <button class="btn mini sec" onclick="setUserMute('${user.id}',${!user.is_mute})">${muteText}</button>
        </div>
      </div>
    `;
  });

  $("#verifyList").innerHTML = verifyHtml || "暂无待审核用户";
  $("#allUserList").innerHTML = allUserHtml || "暂无用户";
}

// 审核用户
async function verifyUser(userId, status) {
  try {
    await supabase.from("users").update({ status: status }).eq("id", userId);
    showNotify("success", status === "active" ? "审核通过" : "审核拒绝（账号封禁）");
    monitorAllUsers();
  } catch (e) {
    showNotify("error", "审核操作失败：" + e.message);
  }
}

// 禁言/解禁
async function setUserMute(userId, isMute) {
  try {
    await supabase.from("users").update({ is_mute: isMute }).eq("id", userId);
    showNotify("success", isMute ? "已禁言该用户" : "已解禁该用户");
    monitorAllUsers();
  } catch (e) {
    showNotify("error", "禁言操作失败：" + e.message);
  }
}

// 重置密码
async function resetUserPassword(email) {
  try {
    showNotify("info", "正在发送密码重置邮件...");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/chat`
    });

    if (error) {
      showNotify("error", "重置邮件发送失败：" + error.message);
      throw new Error(error.message);
    }

    showNotify("success", "密码重置邮件已发送至：" + email);

  } catch (e) {
    console.error("重置密码异常：", e);
  }
}

// 加载所有登录日志
async function loadAllUserLoginLogs() {
  $("#loginLogPanel").innerHTML = "加载中...";
  try {
    const { data: userList } = await supabase.from("users").select("id, email, nick");
    let logHtml = "";

    for (const user of userList) {
      const { data } = await supabase
        .from("login_logs")
        .select("*")
        .eq("user_id", user.id)
        .order("time", { ascending: false })
        .limit(3);

      logHtml += `<div class="user-item"><strong>${user.email}</strong>（${user.nick}）`;
      if (data && data.length > 0) {
        data.forEach(log => {
          logHtml += `<br>IP：${log.ip} ｜ 时间：${log.time}`;
        });
      } else {
        logHtml += "<br>暂无登录记录";
      }
      logHtml += `</div>`;
    }

    $("#loginLogPanel").innerHTML = logHtml || "暂无登录日志";
  } catch (e) {
    $("#loginLogPanel").innerHTML = "加载失败";
    showNotify("error", "加载登录日志失败：" + e.message);
  }
}

// 设置敏感词
async function setSensitiveWords() {
  const words = $("#swInput").value.trim();
  try {
    const { data } = await supabase.from("sensitive_words").select("*").single().catch(() => ({ data: null }));

    if (data) {
      await supabase.from("sensitive_words").update({ words: words }).eq("id", data.id);
    } else {
      await supabase.from("sensitive_words").insert([{ words: words }]);
    }

    showNotify("success", "敏感词配置已保存");
  } catch (e) {
    showNotify("error", "保存敏感词失败：" + e.message);
  }
}

// 发送公告
async function sendAnnounce() {
  const content = $("#annInput").value.trim();
  if (!content) {
    showNotify("error", "请输入公告内容");
    return;
  }

  try {
    const { data } = await supabase.from("announcement").select("*").single().catch(() => ({ data: null }));

    if (data) {
      await supabase.from("announcement").update({ content: content }).eq("id", data.id);
    } else {
      await supabase.from("announcement").insert([{ content: content }]);
    }

    showNotify("success", "全局公告已推送");
    $("#annInput").value = "";
    loadAnnouncement();
  } catch (e) {
    showNotify("error", "推送公告失败：" + e.message);
  }
}

// ====================== 辅助函数 ======================
// 加载公告
async function loadAnnouncement() {
  const { data } = await supabase
    .from("announcement")
    .select("content")
    .single()
    .catch(() => ({ data: null }));

  if (data?.content) {
    $("#announceBar").classList.remove("hidden");
    $("#announceBar").innerText = data.content;
  } else {
    $("#announceBar").classList.add("hidden");
  }
}

// 监听在线人数
async function monitorOnline() {
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

  // 标记在线状态
  if (currentUser) {
    await supabase.from("online_users").upsert({ user_id: currentUser.id });
  }
}

// 更新UI
async function updateUI() {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  $("#userTag").innerText = `用户：${userNick || data.nick}`;
  $("#userStatus").innerText = data.is_mute ? "状态：已禁言" : "状态：正常";

  // 管理员标记
  if (data.is_admin) {
    currentUser.isAdmin = true;
    $("#adminBtn").classList.remove("hidden");
    $("#adminTag").classList.remove("hidden");
  } else {
    $("#adminBtn").classList.add("hidden");
    $("#adminTag").classList.add("hidden");
  }
}

// 显示消息发送状态
function showSendStatus(text, type) {
  const el = $("#sendStatus");
  el.innerText = text;
  el.className = "send-status";
  if (type) el.classList.add(type);
}

// 页面切换
function showChatPage() {
  $("#loginPage").classList.add("hidden");
  $("#registerPage").classList.add("hidden");
  $("#chatPage").classList.remove("hidden");
}

// 关闭页面时清理在线状态
window.onbeforeunload = async () => {
  if (currentUser) {
    await supabase.from("online_users").delete().eq("user_id", currentUser.id);
  }
};
