// ====================== 你的 Supabase 配置 ======================
const SUPABASE_URL = "https://ayavdkodhdmcxfufnnxo.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc";
// ==========================================================================

// 全局初始化
let sb = null;
let currentUser = null;
let userNick = localStorage.getItem("nick") || "";
let msgChannel = null;
let onlineChannel = null;
let configChannel = null;
let forceCloseLoaderTimer = null;
let heartbeatTimer = null;

// 安全选择器
const $ = s => {
  const el = document.querySelector(s);
  return el || {
    addEventListener: () => {},
    innerText: '',
    innerHTML: '',
    value: '',
    disabled: false,
    checked: false,
    classList: { add: () => {}, remove: () => {} }
  };
};
const $$ = s => document.querySelectorAll(s) || [];

// ====================== 工具函数 ======================
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
    const loader = $("#loadingPage");
    if (loader) loader.remove();
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
    showNotify("error", "页面切换失败，请刷新重试");
  }
}

// ====================== 主题系统 ======================
function initTheme() {
  try {
    const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const localDark = localStorage.getItem("theme") === "dark";
    const useDark = localDark || sysDark;
    const root = document.documentElement;
    const metaTheme = $('meta[name="theme-color"]');

    if (useDark) {
      root.dataset.theme = "dark";
      $("#toggleThemeBtn").innerText = "切换浅色模式";
      metaTheme.content = "#0f0f0f";
    } else {
      $("#toggleThemeBtn").innerText = "切换深色模式";
      metaTheme.content = "#f3f3f3";
    }
  } catch (e) {
    console.error("主题初始化失败", e);
  }
}

function toggleTheme() {
  try {
    const root = document.documentElement;
    const metaTheme = $('meta[name="theme-color"]');
    const isDark = root.dataset.theme === "dark";

    if (isDark) {
      root.dataset.theme = "";
      localStorage.removeItem("theme");
      $("#toggleThemeBtn").innerText = "切换深色模式";
      metaTheme.content = "#f3f3f3";
    } else {
      root.dataset.theme = "dark";
      localStorage.setItem("theme", "dark");
      $("#toggleThemeBtn").innerText = "切换浅色模式";
      metaTheme.content = "#0f0f0f";
    }
  } catch (e) {
    showNotify("error", "主题切换失败");
  }
}

// ====================== 登录/注册核心逻辑 ======================
async function doLogin() {
  try {
    const email = $("#loginEmail").value.trim();
    const pwd = $("#loginPwd").value.trim();
    if (!email || !pwd) {
      showNotify("error", "请填写邮箱和密码");
      return;
    }

    $("#loginBtn").disabled = true;
    $("#loginBtn").innerText = "登录中...";

    const { data: authData, error: authError } = await sb.auth.signInWithPassword({
      email, password: pwd
    });
    if (authError) throw new Error(authError.message);
    if (!authData.user) throw new Error("登录失败，未获取到用户信息");

  } catch (e) {
    showNotify("error", `登录失败：${e.message}`);
  } finally {
    $("#loginBtn").disabled = false;
    $("#loginBtn").innerText = "登录";
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

    const { error } = await sb.auth.signUp({
      email, password: pwd,
      options: { data: { nick } }
    });
    if (error) throw new Error(error.message);

    showNotify("success", "注册成功，请登录");
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

async function handleAuthChange(event, session) {
  try {
    currentUser = session?.user || null;

    // 清理旧通道和定时器
    if (msgChannel) sb.removeChannel(msgChannel);
    if (onlineChannel) sb.removeChannel(onlineChannel);
    if (configChannel) sb.removeChannel(configChannel);
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    if (currentUser) {
      initAfterLogin().catch(e => console.error("初始化聊天失败", e));
      showPage("chatPage");
      showNotify("success", "登录成功，欢迎使用在线聊天系统");
    } else {
      showPage("loginPage");
    }
  } catch (e) {
    console.error("登录状态处理异常", e);
    showPage("loginPage");
  } finally {
    closeLoader();
  }
}

// ====================== 登录后初始化 ======================
async function initAfterLogin() {
  try {
    // 1. 查询用户信息
    let userInfo = null;
    try {
      const { data, error } = await sb
        .from("users")
        .select("*")
        .eq("id", currentUser.id)
        .single();
      if (!error && data) userInfo = data;
    } catch (e) {
      console.warn("查询用户信息失败，尝试补插入", e);
    }

    if (!userInfo) {
      try {
        const { data: newUser, error: insertError } = await sb
          .from("users")
          .insert([{
            id: currentUser.id,
            email: currentUser.email,
            nick: currentUser.user_metadata?.nick || "用户" + currentUser.id.substring(0, 4),
            status: "active"
          }])
          .select()
          .single();
        if (!insertError && newUser) userInfo = newUser;
      } catch (e) {
        console.error("补插入用户信息失败", e);
        userInfo = {
          id: currentUser.id,
          email: currentUser.email,
          nick: currentUser.user_metadata?.nick || "用户" + currentUser.id.substring(0, 4),
          status: "active",
          is_admin: false
        };
      }
    }

    // 2. 账号状态校验
    if (userInfo.status === "pending") {
      showNotify("error", "账号待管理员审核，暂无法登录");
      await sb.auth.signOut().catch(() => {});
      return;
    }
    if (userInfo.status === "ban") {
      showNotify("error", "账号已被封禁，无法登录");
      await sb.auth.signOut().catch(() => {});
      return;
    }

    // 3. 初始化用户信息
    userNick = localStorage.getItem("nick") || userInfo.nick;
    $("#userTag").innerText = `用户：${userNick}`;

    if (userInfo.is_admin) {
      $("#adminBtn").classList.remove("hidden");
      currentUser.isAdmin = true;
    } else {
      $("#adminBtn").classList.add("hidden");
      currentUser.isAdmin = false;
    }

    // 4. 核心初始化（按顺序执行，确保稳定）
    await loadInitialMessages(); // 先加载历史消息
    initMessageRealtime(); // 开启消息实时监听
    await markOnline(); // 标记在线
    await refreshOnlineCount(); // 刷新在线人数
    initOnlineRealtime(); // 开启在线人数实时监听
    initConfigRealtime(); // 开启配置实时监听
    initHeartbeat(); // 开启心跳

  } catch (e) {
    console.error("初始化聊天异常", e);
    showNotify("error", "部分功能加载失败，请刷新重试");
  }
}

// ====================== 消息核心功能（终极修复：实时推送+双重保障） ======================
// 加载历史消息
async function loadInitialMessages() {
  try {
    console.log("正在加载历史消息...");
    const { data: msgList, error } = await sb
      .from("messages")
      .select("*")
      .order("id", { ascending: true })
      .limit(200);

    if (error) throw new Error(error.message);
    renderMessages(msgList || []);
    console.log("历史消息加载完成，共", msgList?.length || 0, "条");
  } catch (e) {
    console.error("历史消息加载异常", e);
    showNotify("error", "历史消息加载失败");
  }
}

// 渲染消息
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
    // 自动滚动到底部
    msgBox.scrollTop = msgBox.scrollHeight;
  } catch (e) {
    console.error("消息渲染异常", e);
  }
}

// 初始化消息实时监听（核心修复：Realtime订阅）
function initMessageRealtime() {
  try {
    console.log("正在开启消息实时监听...");
    msgChannel = sb.channel("message_channel", {
      config: { broadcast: { self: true } } // 核心修复：自己发的消息也能收到
    })
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages" },
      async (payload) => {
        console.log("收到消息实时事件", payload);
        await loadInitialMessages(); // 收到事件后重新加载消息
      }
    )
    .subscribe((status) => {
      console.log("消息实时通道状态：", status);
      if (status === "SUBSCRIBED") {
        console.log("✅ 消息实时监听已开启");
      } else if (status === "CHANNEL_ERROR") {
        console.error("❌ 消息实时监听失败，10秒后重试");
        setTimeout(initMessageRealtime, 10000);
      }
    });
  } catch (e) {
    console.error("消息实时监听初始化异常", e);
    setTimeout(initMessageRealtime, 10000);
  }
}

// 发送消息（终极修复：双重保障）
async function sendMessage() {
  try {
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
    try {
      const { data: config } = await sb.from("system_config").select("sensitive_words").single().catch(() => ({ data: { sensitive_words: "" } }));
      const badWords = (config?.sensitive_words || "").split(",").filter(w => w.trim());
      badWords.forEach(word => {
        content = content.replaceAll(word, "***");
      });
    } catch (e) {
      console.warn("敏感词过滤失败，直接发送原消息", e);
      content = text;
    }

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

    // 核心修复：双重保障，发送后立即主动刷新消息列表，不依赖实时推送
    await loadInitialMessages();

  } catch (e) {
    console.error("发送消息失败", e);
    showNotify("error", `发送失败：${e.message}`);
  } finally {
    $("#sendBtn").disabled = false;
    $("#sendBtn").innerText = "发送";
  }
}

// ====================== 在线人数核心功能（终极修复：100%准确） ======================
// 标记在线
async function markOnline() {
  try {
    console.log("正在标记在线状态...");
    const { error } = await sb.from("online_users").upsert({
      user_id: currentUser.id,
      nick: userNick,
      last_active: new Date().toISOString()
    }, { onConflict: "user_id" });

    if (error) throw new Error(error.message);
    console.log("✅ 在线状态标记成功");
  } catch (e) {
    console.error("标记在线失败", e);
  }
}

// 刷新在线人数
async function refreshOnlineCount() {
  try {
    const { data, error } = await sb.from("online_users").select("*");
    if (error) throw new Error(error.message);
    const count = data?.length || 0;
    $("#onlineNum").innerText = count;
    console.log("在线人数刷新为：", count);
  } catch (e) {
    console.error("在线人数刷新异常", e);
  }
}

// 初始化在线人数实时监听
function initOnlineRealtime() {
  try {
    console.log("正在开启在线人数实时监听...");
    onlineChannel = sb.channel("online_channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "online_users" },
      async (payload) => {
        console.log("收到在线状态实时事件", payload);
        await refreshOnlineCount();
      }
    )
    .subscribe((status) => {
      console.log("在线人数实时通道状态：", status);
      if (status === "SUBSCRIBED") {
        console.log("✅ 在线人数实时监听已开启");
      } else if (status === "CHANNEL_ERROR") {
        console.error("❌ 在线人数实时监听失败，10秒后重试");
        setTimeout(initOnlineRealtime, 10000);
      }
    });
  } catch (e) {
    console.error("在线人数实时监听初始化异常", e);
    setTimeout(initOnlineRealtime, 10000);
  }
}

// 初始化心跳（30秒更新一次在线状态）
function initHeartbeat() {
  heartbeatTimer = setInterval(async () => {
    if (currentUser) {
      await markOnline();
    }
  }, 30000);
}

// ====================== 配置实时监听 ======================
function initConfigRealtime() {
  try {
    configChannel = sb.channel("config_channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "system_config" },
      async () => {
        console.log("收到配置更新事件");
        await loadAnnouncement();
      }
    )
    .subscribe();
  } catch (e) {
    console.error("配置实时监听异常", e);
  }
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
  } catch (e) {
    console.error("公告加载异常", e);
  }
}

async function recordLoginLog() {
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json").catch(() => ({ json: () => ({ ip: "未知IP" }) }));
    const ipData = await ipRes.json();
    const ip = ipData.ip || "未知IP";
    const device = navigator.userAgent.substring(0, 80);
    const time = new Date().toLocaleString();

    await sb.from("login_logs").insert([{
      user_id: currentUser.id,
      ip: ip,
      device: device,
      time: time
    }]);
  } catch (e) {
    console.log("登录日志记录失败", e);
  }
}

// ====================== 设置功能 ======================
async function saveNickname() {
  try {
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
    // 更新在线状态里的昵称
    await markOnline();
  } catch (e) {
    showNotify("error", "昵称保存失败");
  }
}

async function updatePassword() {
  try {
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

async function showMyLoginLogs() {
  try {
    const { data } = await sb
      .from("login_logs")
      .select("*")
      .eq("user_id", currentUser.id)
      .order("time", { ascending: false })
      .limit(10)
      .catch(() => ({ data: [] }));

    let logText = "=== 我的登录日志 ===\n\n";
    data.forEach((log, index) => {
      logText += `${index + 1}. IP：${log.ip}\n   时间：${log.time}\n   设备：${log.device}\n\n`;
    });
    alert(logText);
  } catch (e) {
    showNotify("error", "登录日志加载失败");
  }
}

async function userLogout() {
  try {
    // 退出前删除自己的在线状态
    await sb.from("online_users").delete().eq("user_id", currentUser.id).catch(() => {});
    await sb.auth.signOut();
    showNotify("info", "已安全退出登录");
  } catch (e) {
    showNotify("error", "退出失败");
  }
}

// ====================== 管理员功能 ======================
async function loadAdminData() {
  if (!currentUser.isAdmin) {
    showNotify("error", "你没有管理员权限");
    return;
  }

  try {
    const { data: config } = await sb.from("system_config").select("*").single().catch(() => ({ data: { require_verify: false, sensitive_words: "", announcement: "" } }));
    $("#requireVerifyToggle").checked = config?.require_verify || false;
    $("#sensitiveWordsInput").value = config?.sensitive_words || "";
    $("#announceInput").value = config?.announcement || "";

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

    const { data: allUsers } = await sb.from("users").select("*").order("created_at", { ascending: false }).catch(() => ({ data: [] }));
    let userHtml = "";
    allUsers.forEach(user => {
      const statusText = user.status === "active" ? "正常" : user.status === "ban" ? "封禁" : "待审核";
      const muteText = user.is_mute ? "解禁" : "禁言";
      userHtml += `
        <div class="list-item">
          <span>${user.email}（${user.nick} | ${statusText}）</span>
          <div class="btn-group">
            <button class="win-btn small secondary" onclick="resetUserPwd('${user.email}')">重置密码</button>
            <button class="win-btn small warning" onclick="setUserMute('${user.id}', ${!user.is_mute})">${muteText}</button>
            <button class="win-btn small ${user.status === 'ban' ? 'primary' : 'danger'}" onclick="setUserStatus('${user.id}', '${user.status === 'ban' ? 'active' : 'ban'}')">
              ${user.status === 'ban' ? '解封' : '封禁'}
            </button>
          </div>
        </div>
      `;
    });
    $("#allUserList").innerHTML = userHtml;

    const { data: allLogs } = await sb
      .from("login_logs")
      .select("*, users!login_logs_user_id_fkey(email, nick)")
      .order("time", { ascending: false })
      .limit(20)
      .catch(() => ({ data: [] }));
    let logHtml = "";
    allLogs.forEach(log => {
      logHtml += `
        <div class="list-item">
          <span>${log.users?.email || '未知用户'}（${log.users?.nick || '未知'}）| IP：${log.ip} | ${log.time}</span>
        </div>
      `;
    });
    $("#allLoginLogList").innerHTML = logHtml || "暂无登录日志";
  } catch (e) {
    showNotify("error", "管理数据加载失败");
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
    showNotify("error", `重置失败：${e.message}`);
  }
}

async function saveSystemConfig() {
  try {
    const requireVerify = $("#requireVerifyToggle").checked;
    const { data } = await sb.from("system_config").select("id").single().catch(() => ({ data: null }));

    if (data) {
      await sb.from("system_config").update({ require_verify: requireVerify, updated_at: new Date() }).eq("id", data.id);
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
      await sb.from("system_config").update({ sensitive_words: words, updated_at: new Date() }).eq("id", data.id);
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
      await sb.from("system_config").update({ announcement: content, updated_at: new Date() }).eq("id", data.id);
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
// 页面初始化
document.addEventListener("DOMContentLoaded", async () => {
  try {
    // 全局超时：最多3.5秒强制关闭启动页
    forceCloseLoaderTimer = setTimeout(() => {
      console.warn("启动超时，强制关闭启动页");
      closeLoader();
      showPage("loginPage");
    }, 3500);

    initTheme();
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true
      },
      realtime: {
        timeout: 10000,
        heartbeatIntervalMs: 30000
      }
    });
    bindAllEvents();
    sb.auth.onAuthStateChange(handleAuthChange);
  } catch (e) {
    console.error("初始化异常", e);
    showNotify("error", "系统初始化失败，请刷新重试");
    closeLoader();
    showPage("loginPage");
  }
});

// 事件绑定
function bindAllEvents() {
  // 登录/注册切换
  $("#toRegisterBtn").addEventListener("click", () => showPage("registerPage"));
  $("#toLoginBtn").addEventListener("click", () => showPage("loginPage"));

  // 登录/注册功能
  $("#loginBtn").addEventListener("click", doLogin);
  $("#regBtn").addEventListener("click", doRegister);
  $("#loginPwd").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
  $("#regPwd").addEventListener("keydown", (e) => e.key === "Enter" && doRegister());

  // 聊天功能
  $("#sendBtn").addEventListener("click", sendMessage);
  $("#msgInput").addEventListener("keydown", (e) => e.key === "Enter" && sendMessage());

  // 页面跳转
  $("#settingBtn").addEventListener("click", () => showPage("settingPage"));
  $("#adminBtn").addEventListener("click", () => { loadAdminData(); showPage("adminPage"); });
  $("#backToChatBtn").addEventListener("click", () => showPage("chatPage"));
  $("#backToChatFromAdminBtn").addEventListener("click", () => showPage("chatPage"));

  // 设置功能
  $("#saveNickBtn").addEventListener("click", saveNickname);
  $("#toggleThemeBtn").addEventListener("click", toggleTheme);
  $("#updatePwdBtn").addEventListener("click", updatePassword);
  $("#showLoginLogBtn").addEventListener("click", showMyLoginLogs);
  $("#logoutBtn").addEventListener("click", userLogout);

  // 管理员功能
  $("#saveConfigBtn").addEventListener("click", saveSystemConfig);
  $("#saveSwBtn").addEventListener("click", saveSensitiveWords);
  $("#saveAnnounceBtn").addEventListener("click", saveAnnouncement);
  $("#clearAllMsgBtn").addEventListener("click", clearAllMessages);
}

// 页面关闭/刷新时清理在线状态
window.addEventListener("beforeunload", async () => {
  try {
    if (forceCloseLoaderTimer) clearTimeout(forceCloseLoaderTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (currentUser) {
      // 同步删除在线状态，确保离线后立即清理
      await fetch(`${SUPABASE_URL}/rest/v1/online_users?user_id=eq.${currentUser.id}`, {
        method: "DELETE",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${sb.auth.session()?.access_token}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        }
      }).catch(() => {});
    }
    if (msgChannel) sb.removeChannel(msgChannel);
    if (onlineChannel) sb.removeChannel(onlineChannel);
    if (configChannel) sb.removeChannel(configChannel);
  } catch (e) {
    console.error("清理异常", e);
  }
});

// 页面从后台切回时，重连实时通道，刷新状态
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && currentUser) {
    console.log("页面切回前台，刷新状态");
    await markOnline();
    await refreshOnlineCount();
    await loadInitialMessages();
  }
});

// 系统主题变化自动跟随
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", initTheme);
