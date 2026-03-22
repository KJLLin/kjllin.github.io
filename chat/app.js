// ====================== 你的 Supabase 配置 ======================
const SUPABASE_URL = "https://ayavdkodhdmcxfufnnxo.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc";
// ==========================================================================

// 全局初始化
let sb = null;
let currentUser = null;
let userNick = localStorage.getItem("nick") || "";
// 单设备登录核心配置（完整保留）
const CURRENT_SESSION_KEY = "chat_current_session_token";
let sessionToken = localStorage.getItem(CURRENT_SESSION_KEY) || "";
let isSessionInitialized = false;
let isLoggingIn = false;
// 全局通道和定时器
let msgChannel = null;
let onlineChannel = null;
let configChannel = null;
let sessionCheckChannel = null;
let forceCloseLoaderTimer = null;
let heartbeatTimer = null;
let sessionCheckTimer = null;

// 安全选择器
const $ = s => document.querySelector(s) || {
  addEventListener: () => {},
  innerText: '',
  innerHTML: '',
  value: '',
  disabled: false,
  checked: false,
  classList: { add: () => {}, remove: () => {} }
};
const $$ = s => document.querySelectorAll(s) || [];

// ====================== 核心工具函数 ======================
function showNotify(type, text) {
  try {
    const notifyEl = $("#winNotify");
    notifyEl.className = `win-notify ${type}`;
    notifyEl.innerText = text;
    notifyEl.classList.remove("hidden");
    setTimeout(() => notifyEl.classList.add("hidden"), 5000);
  } catch (e) {
    console.error("通知异常", e);
  }
}

function closeLoader() {
  try {
    if (forceCloseLoaderTimer) clearTimeout(forceCloseLoaderTimer);
    const loader = $("#loadingPage");
    loader.style.opacity = 0;
    setTimeout(() => {
      loader.classList.add("hidden");
      loader.style.display = "none";
    }, 300);
  } catch (e) {
    console.error("关闭启动页异常", e);
    $("#loadingPage")?.remove();
  }
}

function showPage(pageId) {
  try {
    $$(".page").forEach(page => {
      page.classList.remove("active");
      page.classList.add("hidden");
    });
    const targetPage = $(`#${pageId}`);
    targetPage.classList.remove("hidden");
    targetPage.classList.add("active");
    targetPage.scrollTop = 0;
  } catch (e) {
    console.error("页面切换异常", e);
  }
}

function resetAllButtonState() {
  $("#loginBtn").disabled = false;
  $("#loginBtn").innerText = "登录";
  $("#regBtn").disabled = false;
  $("#regBtn").innerText = "注册";
  $("#sendBtn").disabled = false;
  $("#sendBtn").innerText = "发送";
}

function clearAllResources() {
  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sessionCheckTimer) clearInterval(sessionCheckTimer);
    if (msgChannel) sb.removeChannel(msgChannel);
    if (onlineChannel) sb.removeChannel(onlineChannel);
    if (configChannel) sb.removeChannel(configChannel);
    if (sessionCheckChannel) sb.removeChannel(sessionCheckChannel);

    currentUser = null;
    userNick = "";
    sessionToken = "";
    isSessionInitialized = false;
    isLoggingIn = false;

    localStorage.removeItem(CURRENT_SESSION_KEY);
    localStorage.removeItem("nick");
    resetAllButtonState();
  } catch (e) {
    console.error("清理资源异常", e);
    isLoggingIn = false;
  }
}

// 生成会话Token
function generateSessionToken() {
  return crypto.randomUUID();
}

// ====================== 单设备登录功能（完整保留） ======================
async function checkSessionValid() {
  try {
    if (!currentUser || !sessionToken || !isSessionInitialized) return false;
    const { data } = await sb.from("users").select("current_session_token").eq("id", currentUser.id).single().catch(() => ({ data: null }));
    return data?.current_session_token === sessionToken;
  } catch (e) {
    return false;
  }
}

async function handleSessionInvalid(reason = "账号在其他设备登录，你已被挤下线") {
  try {
    showNotify("error", reason);
    clearAllResources();
    await sb.auth.signOut().catch(() => {});
    showPage("loginPage");
    setTimeout(() => window.location.reload(), 1000);
  } catch (e) {
    window.location.href = window.location.origin + "/chat";
  }
}

function initSessionCheckListener() {
  try {
    sessionCheckChannel = sb.channel("session_check_channel")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "users", filter: `id=eq.${currentUser.id}` },
      async () => {
        const isValid = await checkSessionValid();
        if (!isValid) await handleSessionInvalid();
      }
    )
    .subscribe();

    sessionCheckTimer = setInterval(async () => {
      if (currentUser && isSessionInitialized) {
        const isValid = await checkSessionValid();
        if (!isValid) await handleSessionInvalid();
      }
    }, 60000);
  } catch (e) {
    console.error("会话监听异常", e);
  }
}

// ====================== 主题系统 ======================
function initTheme() {
  try {
    const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const localDark = localStorage.getItem("theme") === "dark";
    const root = document.documentElement;
    if (localDark || sysDark) {
      root.dataset.theme = "dark";
      $("#toggleThemeBtn").innerText = "切换浅色模式";
    } else {
      $("#toggleThemeBtn").innerText = "切换深色模式";
    }
  } catch (e) {}
}

function toggleTheme() {
  try {
    const root = document.documentElement;
    const isDark = root.dataset.theme === "dark";
    if (isDark) {
      root.dataset.theme = "";
      localStorage.removeItem("theme");
      $("#toggleThemeBtn").innerText = "切换深色模式";
    } else {
      root.dataset.theme = "dark";
      localStorage.setItem("theme", "dark");
      $("#toggleThemeBtn").innerText = "切换浅色模式";
    }
  } catch (e) {
    showNotify("error", "主题切换失败");
  }
}

// ====================== 核心修复：登录逻辑（零阻塞、绝对不卡死） ======================
async function doLogin() {
  if (isLoggingIn) {
    showNotify("warning", "正在登录中，请稍候");
    return;
  }

  isLoggingIn = true;
  $("#loginBtn").disabled = true;
  $("#loginBtn").innerText = "登录中...";

  try {
    const email = $("#loginEmail").value.trim();
    const pwd = $("#loginPwd").value.trim();
    if (!email || !pwd) {
      showNotify("error", "请填写邮箱和密码");
      return;
    }

    // 1. 仅做账号密码验证，10秒超时兜底
    const loginPromise = sb.auth.signInWithPassword({ email, password: pwd });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("登录超时，请检查网络")), 10000));
    const { data: authData, error: authError } = await Promise.race([loginPromise, timeoutPromise]);

    if (authError) {
      let errMsg = authError.message;
      if (errMsg.includes("Email not confirmed")) errMsg = "邮箱未验证，请验证后登录";
      if (errMsg.includes("Invalid login credentials")) errMsg = "邮箱或密码错误";
      if (errMsg.includes("banned")) errMsg = "账号已被封禁";
      throw new Error(errMsg);
    }

    if (!authData.user) throw new Error("登录失败，未获取到用户信息");
    showNotify("info", "登录成功，正在进入聊天...");

  } catch (e) {
    console.error("登录失败", e);
    showNotify("error", `登录失败：${e.message}`);
  } finally {
    // 绝对兜底，确保按钮状态恢复
    setTimeout(() => {
      isLoggingIn = false;
      $("#loginBtn").disabled = false;
      $("#loginBtn").innerText = "登录";
    }, 300);
  }
}

async function doRegister() {
  try {
    const nick = $("#regNick").value.trim();
    const email = $("#regEmail").value.trim();
    const pwd = $("#regPwd").value.trim();
    if (!nick || !email || !pwd) {
      showNotify("error", "请填写完整注册信息");
      return;
    }
    if (pwd.length < 8) {
      showNotify("error", "密码长度不能少于8位");
      return;
    }

    $("#regBtn").disabled = true;
    $("#regBtn").innerText = "注册中...";

    const registerPromise = sb.auth.signUp({
      email, password: pwd,
      options: { data: { nick } }
    });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("注册超时")), 10000));
    const { error } = await Promise.race([registerPromise, timeoutPromise]);

    if (error) {
      let errMsg = error.message;
      if (errMsg.includes("already registered")) errMsg = "该邮箱已被注册";
      throw new Error(errMsg);
    }

    showNotify("success", "注册成功，请前往邮箱验证后登录");
    $("#regNick").value = "";
    $("#regEmail").value = "";
    $("#regPwd").value = "";
    showPage("loginPage");

  } catch (e) {
    showNotify("error", `注册失败：${e.message}`);
  } finally {
    $("#regBtn").disabled = false;
    $("#regBtn").innerText = "注册";
  }
}

// ====================== 核心修复：登录状态处理（零阻塞、非核心操作全异步） ======================
async function handleAuthChange(event, session) {
  try {
    console.log("登录状态变化：", event);
    // 退出登录处理
    if (!session?.user) {
      clearAllResources();
      showPage("loginPage");
      return;
    }

    // 登录成功处理
    currentUser = session.user;
    const newSessionToken = generateSessionToken();
    sessionToken = newSessionToken;
    localStorage.setItem(CURRENT_SESSION_KEY, newSessionToken);

    // 【核心修复】先更新会话Token到数据库，确保单设备登录生效
    await sb.from("users").update({
      current_session_token: newSessionToken,
      last_login_time: new Date().toISOString()
    }).eq("id", currentUser.id).catch(() => {});

    // 【核心修复】先查询用户基础信息，不阻塞主流程
    const { data: userInfo } = await sb.from("users").select("*").eq("id", currentUser.id).single().catch(() => ({ data: null }));
    if (!userInfo) {
      // 新用户补插入记录
      await sb.from("users").insert([{
        id: currentUser.id,
        email: currentUser.email,
        nick: currentUser.user_metadata?.nick || "用户" + currentUser.id.substring(0, 4),
        status: "active"
      }]).catch(() => {});
    }

    // 【核心修复】先跳转到聊天页，绝对不阻塞！！！
    isSessionInitialized = true;
    showPage("chatPage");
    showNotify("success", "登录成功，欢迎使用");
    closeLoader();

    // 【核心修复】所有非核心操作，全部放到跳转之后异步执行，绝对不卡登录！！！
    setTimeout(async () => {
      try {
        // 初始化用户信息
        const { data: finalUserInfo } = await sb.from("users").select("*").eq("id", currentUser.id).single().catch(() => ({ data: {} }));
        userNick = localStorage.getItem("nick") || finalUserInfo.nick || "用户";
        $("#userTag").innerText = `用户：${userNick}`;
        currentUser.isAdmin = finalUserInfo.is_admin || false;
        if (currentUser.isAdmin) $("#adminBtn").classList.remove("hidden");

        // 异步更新登录IP和设备信息（之前卡死的元凶！现在完全不阻塞）
        fetch("https://api.ipify.org?format=json")
          .then(res => res.json())
          .then(ipData => {
            sb.from("users").update({
              last_login_ip: ipData.ip || "未知IP",
              last_login_device: navigator.userAgent.substring(0, 100)
            }).eq("id", currentUser.id).catch(() => {});
          })
          .catch(() => {});

        // 异步初始化所有其他功能
        initSessionCheckListener();
        await loadInitialMessages();
        initMessageRealtime();
        await markOnline();
        await refreshOnlineCount();
        initOnlineRealtime();
        initConfigRealtime();
        initHeartbeat();
        await recordLoginLog();
      } catch (e) {
        console.warn("部分功能初始化失败，不影响聊天使用", e);
      }
    }, 0);

  } catch (e) {
    console.error("登录状态处理异常", e);
    showNotify("error", `登录异常：${e.message}`);
    clearAllResources();
    await sb.auth.signOut().catch(() => {});
    showPage("loginPage");
  } finally {
    closeLoader();
    isLoggingIn = false;
    resetAllButtonState();
  }
}

// ====================== 聊天核心功能（完整保留） ======================
async function loadInitialMessages() {
  try {
    const { data: msgList } = await sb.from("messages").select("*").order("id", { ascending: true }).limit(200).catch(() => ({ data: [] }));
    renderMessages(msgList || []);
  } catch (e) {}
}

function renderMessages(msgList) {
  try {
    const msgBox = $("#msgBox");
    let html = "";
    msgList.forEach(msg => {
      const isMe = msg.user_id === currentUser.id;
      html += `
        <div class="msg-item ${isMe ? 'msg-me' : 'msg-other'}">
          <div class="avatar">${msg.nick.charAt(0)}</div>
          <div>
            <div class="msg-name">${msg.nick}</div>
            <div class="bubble">${msg.text}</div>
            <div class="msg-time">${msg.time}</div>
          </div>
          ${currentUser.isAdmin ? `<button class="win-btn small danger" onclick="deleteMsg(${msg.id})">删除</button>` : ''}
        </div>
      `;
    });
    msgBox.innerHTML = html;
    msgBox.scrollTop = msgBox.scrollHeight;
  } catch (e) {}
}

function initMessageRealtime() {
  try {
    msgChannel = sb.channel("message_channel", { config: { broadcast: { self: true } } })
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, async () => {
      await loadInitialMessages();
    })
    .subscribe();
  } catch (e) {}
}

async function sendMessage() {
  try {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    if (!currentUser) return;
    
    const msgInput = $("#msgInput");
    const text = msgInput.value.trim();
    if (!text) {
      showNotify("error", "不能发送空消息");
      return;
    }

    $("#sendBtn").disabled = true;
    $("#sendBtn").innerText = "发送中...";

    // 敏感词过滤
    let content = text;
    const { data: config } = await sb.from("system_config").select("sensitive_words").single().catch(() => ({ data: { sensitive_words: "" } }));
    const badWords = (config?.sensitive_words || "").split(",").filter(w => w.trim());
    badWords.forEach(word => {
      content = content.replaceAll(word, "***");
    });

    // 发送消息
    const { error } = await sb.from("messages").insert([{
      user_id: currentUser.id,
      nick: userNick,
      text: content,
      time: new Date().toLocaleString()
    }]);

    if (error) throw new Error(error.message);
    msgInput.value = "";
    showNotify("success", "消息发送成功");
    await loadInitialMessages();

  } catch (e) {
    showNotify("error", `发送失败：${e.message}`);
  } finally {
    $("#sendBtn").disabled = false;
    $("#sendBtn").innerText = "发送";
  }
}

// ====================== 在线人数功能（完整保留） ======================
async function markOnline() {
  try {
    await sb.from("online_users").upsert({
      user_id: currentUser.id,
      nick: userNick,
      last_active: new Date().toISOString()
    }, { onConflict: "user_id" }).catch(() => {});
  } catch (e) {}
}

async function refreshOnlineCount() {
  try {
    const { data } = await sb.from("online_users").select("*").catch(() => ({ data: [] }));
    $("#onlineNum").innerText = data?.length || 0;
  } catch (e) {}
}

function initOnlineRealtime() {
  try {
    onlineChannel = sb.channel("online_channel")
    .on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, async () => {
      await refreshOnlineCount();
    })
    .subscribe();
  } catch (e) {}
}

function initHeartbeat() {
  heartbeatTimer = setInterval(async () => {
    if (currentUser && isSessionInitialized) {
      await markOnline();
    }
  }, 30000);
}

// ====================== 公告&配置功能（完整保留） ======================
function initConfigRealtime() {
  try {
    configChannel = sb.channel("config_channel")
    .on("postgres_changes", { event: "*", schema: "public", table: "system_config" }, async () => {
      await loadAnnouncement();
    })
    .subscribe();
  } catch (e) {}
}

async function loadAnnouncement() {
  try {
    const { data } = await sb.from("system_config").select("announcement").single().catch(() => ({ data: { announcement: "" } }));
    const announceBar = $("#announceBar");
    if (data?.announcement) {
      announceBar.innerText = data.announcement;
      announceBar.classList.remove("hidden");
    } else {
      announceBar.classList.add("hidden");
    }
  } catch (e) {}
}

// ====================== 登录日志功能（完整保留） ======================
async function recordLoginLog() {
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json").catch(() => ({ json: () => ({ ip: "未知IP" }) }));
    const ipData = await ipRes.json();
    await sb.from("login_logs").insert([{
      user_id: currentUser.id,
      ip: ipData.ip || "未知IP",
      device: navigator.userAgent.substring(0, 80),
      time: new Date().toLocaleString()
    }]).catch(() => {});
  } catch (e) {}
}

async function showMyLoginLogs() {
  try {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    showNotify("info", "正在加载登录日志...");
    const { data } = await sb.from("login_logs").select("*").eq("user_id", currentUser.id).order("time", { ascending: false }).limit(10).catch(() => ({ data: [] }));
    if (!data || data.length === 0) {
      alert("=== 我的登录日志 ===\n\n暂无登录日志");
      return;
    }
    let logText = "=== 我的登录日志 ===\n\n";
    data.forEach((log, index) => {
      logText += `${index + 1}. IP：${log.ip}\n   时间：${log.time}\n   设备：${log.device}\n\n`;
    });
    alert(logText);
  } catch (e) {
    showNotify("error", "登录日志加载失败");
  }
}

// ====================== 退出登录功能（完整保留） ======================
async function userLogout() {
  try {
    showNotify("info", "正在退出登录...");
    if (currentUser) {
      await sb.from("users").update({ current_session_token: null }).eq("id", currentUser.id).catch(() => {});
      await sb.from("online_users").delete().eq("user_id", currentUser.id).catch(() => {});
    }
    clearAllResources();
    await sb.auth.signOut();
    showPage("loginPage");
    showNotify("success", "已安全退出登录");
  } catch (e) {
    showNotify("error", "退出失败");
    clearAllResources();
    showPage("loginPage");
  }
}

// ====================== 设置功能（完整保留） ======================
async function saveNickname() {
  try {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    const newNick = $("#nickInput").value.trim();
    if (!newNick) {
      showNotify("error", "请输入有效的昵称");
      return;
    }
    await sb.from("users").update({ nick: newNick }).eq("id", currentUser.id);
    userNick = newNick;
    localStorage.setItem("nick", newNick);
    $("#userTag").innerText = `用户：${newNick}`;
    $("#nickInput").value = "";
    showNotify("success", "昵称保存成功");
    await markOnline();
  } catch (e) {
    showNotify("error", "昵称保存失败");
  }
}

async function updatePassword() {
  try {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    const newPwd = $("#newPwdInput").value.trim();
    if (newPwd.length < 8) {
      showNotify("error", "密码长度不能少于8位");
      return;
    }
    const { error } = await sb.auth.updateUser({ password: newPwd });
    if (error) throw new Error(error.message);
    showNotify("success", "密码修改成功，请重新登录");
    $("#newPwdInput").value = "";
    setTimeout(userLogout, 1500);
  } catch (e) {
    showNotify("error", `密码修改失败：${e.message}`);
  }
}

// ====================== 管理员功能（完整保留，一点没少） ======================
async function loadAdminData() {
  if (!currentUser.isAdmin) {
    showNotify("error", "你没有管理员权限");
    return;
  }
  try {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    showNotify("info", "正在加载管理数据...");
    // 系统配置
    const { data: config } = await sb.from("system_config").select("*").single().catch(() => ({ data: { require_verify: false, sensitive_words: "", announcement: "" } }));
    $("#requireVerifyToggle").checked = config?.require_verify || false;
    $("#sensitiveWordsInput").value = config?.sensitive_words || "";
    $("#announceInput").value = config?.announcement || "";
    // 待审核用户
    const { data: verifyUsers } = await sb.from("users").select("*").eq("status", "pending").catch(() => ({ data: [] }));
    let verifyHtml = "";
    verifyUsers.forEach(user => {
      verifyHtml += `
        <div class="list-item">
          <span>${user.email}（${user.nick}）</span>
          <div class="btn-group">
            <button class="win-btn small primary" onclick="verifyUser('${user.id}', 'active')">通过</button>
            <button class="win-btn small danger" onclick="verifyUser('${user.id}', 'ban')">拒绝</button>
          </div>
        </div>
      `;
    });
    $("#verifyUserList").innerHTML = verifyHtml || "暂无待审核用户";
    // 全部用户
    const { data: allUsers } = await sb.from("users").select("*").order("created_at", { ascending: false }).catch(() => ({ data: [] }));
    let userHtml = "";
    allUsers.forEach(user => {
      const statusText = user.status === "active" ? "正常" : user.status === "ban" ? "封禁" : "待审核";
      const muteText = user.is_mute ? "解禁" : "禁言";
      const isOnline = user.current_session_token ? "在线" : "离线";
      userHtml += `
        <div class="list-item">
          <span>${user.email}（${user.nick} | ${statusText} | ${isOnline}）</span>
          <div class="btn-group">
            <button class="win-btn small secondary" onclick="resetUserPwd('${user.email}')">重置密码</button>
            <button class="win-btn small warning" onclick="setUserMute('${user.id}', ${!user.is_mute})">${muteText}</button>
            <button class="win-btn small ${user.status === 'ban' ? 'primary' : 'danger'}" onclick="setUserStatus('${user.id}', '${user.status === 'ban' ? 'active' : 'ban'}')">
              ${user.status === 'ban' ? '解封' : '封禁'}
            </button>
            <button class="win-btn small danger" onclick="forceUserOffline('${user.id}')">强制下线</button>
          </div>
        </div>
      `;
    });
    $("#allUserList").innerHTML = userHtml;
    // 登录日志
    const { data: allLogs } = await sb.from("login_logs").select("*, users!inner(email, nick)").order("time", { ascending: false }).limit(20).catch(() => ({ data: [] }));
    let logHtml = "";
    allLogs.forEach(log => {
      logHtml += `
        <div class="list-item">
          <span>${log.users?.email || '未知用户'}（${log.users?.nick || '未知'}）| IP：${log.ip} | ${log.time}</span>
        </div>
      `;
    });
    $("#allLoginLogList").innerHTML = logHtml || "暂无登录日志";
    showNotify("success", "管理数据加载完成");
  } catch (e) {
    showNotify("error", "管理数据加载失败");
  }
}

async function forceUserOffline(userId) {
  if (!confirm("确定要强制该用户下线吗？")) return;
  try {
    await sb.from("users").update({ current_session_token: null }).eq("id", userId);
    showNotify("success", "用户已被强制下线");
    loadAdminData();
  } catch (e) {
    showNotify("error", "强制下线失败");
  }
}

async function verifyUser(userId, status) {
  try {
    await sb.from("users").update({ status }).eq("id", userId);
    showNotify("success", status === "active" ? "用户审核通过" : "用户审核拒绝");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
}

async function setUserMute(userId, isMute) {
  try {
    await sb.from("users").update({ is_mute: isMute }).eq("id", userId);
    showNotify("success", isMute ? "已禁言该用户" : "已解禁该用户");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
}

async function setUserStatus(userId, status) {
  try {
    await sb.from("users").update({ status }).eq("id", userId);
    showNotify("success", status === "active" ? "已解封该用户" : "已封禁该用户");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
}

async function resetUserPwd(email) {
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/chat`
    });
    if (error) throw new Error(error.message);
    showNotify("success", "密码重置邮件已发送");
  } catch (e) {
    showNotify("error", "重置失败");
  }
}

async function saveSystemConfig() {
  try {
    const requireVerify = $("#requireVerifyToggle").checked;
    const { data } = await sb.from("system_config").select("id").single().catch(() => ({ data: null }));
    if (data) {
      await sb.from("system_config").update({ require_verify: requireVerify }).eq("id", data.id);
    } else {
      await sb.from("system_config").insert([{ require_verify: requireVerify }]);
    }
    showNotify("success", "系统配置保存成功");
  } catch (e) {
    showNotify("error", "配置保存失败");
  }
}

async function saveSensitiveWords() {
  try {
    const words = $("#sensitiveWordsInput").value.trim();
    const { data } = await sb.from("system_config").select("id").single().catch(() => ({ data: null }));
    if (data) {
      await sb.from("system_config").update({ sensitive_words: words }).eq("id", data.id);
    } else {
      await sb.from("system_config").insert([{ sensitive_words: words }]);
    }
    showNotify("success", "敏感词保存成功");
  } catch (e) {
    showNotify("error", "保存失败");
  }
}

async function saveAnnouncement() {
  try {
    const content = $("#announceInput").value.trim();
    const { data } = await sb.from("system_config").select("id").single().catch(() => ({ data: null }));
    if (data) {
      await sb.from("system_config").update({ announcement: content }).eq("id", data.id);
    } else {
      await sb.from("system_config").insert([{ announcement: content }]);
    }
    showNotify("success", "公告已推送");
  } catch (e) {
    showNotify("error", "推送失败");
  }
}

async function deleteMsg(msgId) {
  try {
    await sb.from("messages").delete().eq("id", msgId);
    showNotify("success", "消息已删除");
    await loadInitialMessages();
  } catch (e) {
    showNotify("error", "删除失败");
  }
}

async function clearAllMessages() {
  if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
  try {
    await sb.from("messages").delete().neq("id", 0);
    showNotify("success", "所有消息已清空");
    await loadInitialMessages();
  } catch (e) {
    showNotify("error", "清空失败");
  }
}

// ====================== 页面生命周期 ======================
document.addEventListener("DOMContentLoaded", async () => {
  try {
    forceCloseLoaderTimer = setTimeout(() => {
      closeLoader();
      showPage("loginPage");
    }, 3500);

    initTheme();
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
      realtime: { timeout: 10000 }
    });
    bindAllEvents();
    sb.auth.onAuthStateChange(handleAuthChange);
  } catch (e) {
    console.error("初始化异常", e);
    closeLoader();
    showPage("loginPage");
  }
});

function bindAllEvents() {
  $("#toRegisterBtn").addEventListener("click", () => showPage("registerPage"));
  $("#toLoginBtn").addEventListener("click", () => showPage("loginPage"));
  $("#loginBtn").addEventListener("click", doLogin);
  $("#regBtn").addEventListener("click", doRegister);
  $("#loginPwd").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
  $("#regPwd").addEventListener("keydown", (e) => e.key === "Enter" && doRegister());
  $("#sendBtn").addEventListener("click", sendMessage);
  $("#msgInput").addEventListener("keydown", (e) => e.key === "Enter" && sendMessage());
  $("#settingBtn").addEventListener("click", () => showPage("settingPage"));
  $("#adminBtn").addEventListener("click", () => { loadAdminData(); showPage("adminPage"); });
  $("#backToChatBtn").addEventListener("click", () => showPage("chatPage"));
  $("#backToChatFromAdminBtn").addEventListener("click", () => showPage("chatPage"));
  $("#saveNickBtn").addEventListener("click", saveNickname);
  $("#toggleThemeBtn").addEventListener("click", toggleTheme);
  $("#updatePwdBtn").addEventListener("click", updatePassword);
  $("#showLoginLogBtn").addEventListener("click", showMyLoginLogs);
  $("#logoutBtn").addEventListener("click", userLogout);
  $("#saveConfigBtn").addEventListener("click", saveSystemConfig);
  $("#saveSwBtn").addEventListener("click", saveSensitiveWords);
  $("#saveAnnounceBtn").addEventListener("click", saveAnnouncement);
  $("#clearAllMsgBtn").addEventListener("click", clearAllMessages);
}

window.addEventListener("beforeunload", async () => {
  if (currentUser) {
    await sb.from("online_users").delete().eq("user_id", currentUser.id).catch(() => {});
  }
});

document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && currentUser && isSessionInitialized) {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    await markOnline();
    await refreshOnlineCount();
  }
});
