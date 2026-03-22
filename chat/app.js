// ====================== 你的 Supabase 配置 ======================
const SUPABASE_URL = "https://ayavdkodhdmcxfufnnxo.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc";
// ==========================================================================

// 全局初始化
let sb = null;
let currentUser = null;
let userNick = localStorage.getItem("nick") || "";
// 单设备登录核心配置
const CURRENT_SESSION_KEY = "chat_current_session_token";
let sessionToken = localStorage.getItem(CURRENT_SESSION_KEY) || "";
// 全局通道和定时器
let msgChannel = null;
let onlineChannel = null;
let configChannel = null;
let sessionCheckChannel = null; // 单设备登录监听通道
let forceCloseLoaderTimer = null;
let heartbeatTimer = null;
let sessionCheckTimer = null; // 会话校验定时器

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

// ====================== 核心工具函数 ======================
// 全局通知
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

// 关闭启动页
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

// 页面切换
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

// 统一清理所有资源（退出/页面关闭时调用）
function clearAllResources() {
  try {
    // 清理所有定时器
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sessionCheckTimer) clearInterval(sessionCheckTimer);
    heartbeatTimer = null;
    sessionCheckTimer = null;

    // 清理所有实时通道
    if (msgChannel) sb.removeChannel(msgChannel);
    if (onlineChannel) sb.removeChannel(onlineChannel);
    if (configChannel) sb.removeChannel(configChannel);
    if (sessionCheckChannel) sb.removeChannel(sessionCheckChannel);
    msgChannel = null;
    onlineChannel = null;
    configChannel = null;
    sessionCheckChannel = null;

    // 重置全局状态
    currentUser = null;
    userNick = "";
    sessionToken = "";

    // 清理本地存储
    localStorage.removeItem(CURRENT_SESSION_KEY);
    localStorage.removeItem("nick");

    // 清理输入框内容
    $("#msgInput").value = "";
    $("#loginEmail").value = "";
    $("#loginPwd").value = "";
    $("#regNick").value = "";
    $("#regEmail").value = "";
    $("#regPwd").value = "";
  } catch (e) {
    console.error("清理资源异常", e);
  }
}

// ====================== 单设备登录核心函数 ======================
// 生成唯一会话Token
function generateSessionToken() {
  return crypto.randomUUID();
}

// 核心：校验当前会话是否有效
async function checkSessionValid() {
  try {
    if (!currentUser || !sessionToken) {
      return false;
    }

    // 查询当前用户的有效会话Token
    const { data, error } = await sb
      .from("users")
      .select("current_session_token")
      .eq("id", currentUser.id)
      .single();

    if (error || !data) {
      console.error("会话校验失败", error);
      return false;
    }

    // 对比本地Token和数据库中的有效Token
    const isValid = data.current_session_token === sessionToken;
    if (!isValid) {
      console.warn("会话已失效，账号在其他设备登录");
    }
    return isValid;
  } catch (e) {
    console.error("会话校验异常", e);
    return false;
  }
}

// 核心：被挤下线时的处理逻辑
async function handleSessionInvalid(reason = "账号在其他设备登录，你已被挤下线") {
  try {
    showNotify("error", reason);
    // 先清理所有资源
    clearAllResources();
    // 执行退出登录
    await sb.auth.signOut().catch(() => {});
    // 强制跳回登录页
    showPage("loginPage");
    // 强制刷新页面，清理残留状态
    setTimeout(() => window.location.reload(), 1500);
  } catch (e) {
    console.error("会话失效处理异常", e);
    window.location.href = window.location.origin + "/chat";
  }
}

// 初始化会话监听（实时检测是否被挤下线）
function initSessionCheckListener() {
  try {
    console.log("正在开启单设备登录会话监听...");
    sessionCheckChannel = sb.channel("session_check_channel")
    .on(
      "postgres_changes",
      { 
        event: "UPDATE", 
        schema: "public", 
        table: "users",
        filter: `id=eq.${currentUser.id}` // 只监听当前用户的记录变化
      },
      async (payload) => {
        console.log("收到用户会话更新事件", payload);
        // 校验会话是否有效
        const isValid = await checkSessionValid();
        if (!isValid) {
          await handleSessionInvalid();
        }
      }
    )
    .subscribe((status) => {
      console.log("会话监听通道状态：", status);
      if (status === "SUBSCRIBED") {
        console.log("✅ 单设备登录会话监听已开启");
      } else if (status === "CHANNEL_ERROR") {
        console.error("❌ 会话监听失败，10秒后重试");
        setTimeout(initSessionCheckListener, 10000);
      }
    });

    // 开启定时心跳校验（每分钟校验一次）
    sessionCheckTimer = setInterval(async () => {
      if (currentUser) {
        const isValid = await checkSessionValid();
        if (!isValid) {
          await handleSessionInvalid();
        }
      }
    }, 60000);

  } catch (e) {
    console.error("会话监听初始化异常", e);
    setTimeout(initSessionCheckListener, 10000);
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

    // 1. 执行账号登录
    const { data: authData, error: authError } = await sb.auth.signInWithPassword({
      email, password: pwd
    });
    if (authError) throw new Error(authError.message);
    if (!authData.user) throw new Error("登录失败，未获取到用户信息");

    // 2. 单设备登录核心：生成新的会话Token
    const newSessionToken = generateSessionToken();
    sessionToken = newSessionToken;
    localStorage.setItem(CURRENT_SESSION_KEY, newSessionToken);

    // 3. 获取登录IP和设备信息
    const ipRes = await fetch("https://api.ipify.org?format=json").catch(() => ({ json: () => ({ ip: "未知IP" }) }));
    const ipData = await ipRes.json();
    const loginIp = ipData.ip || "未知IP";
    const loginDevice = navigator.userAgent.substring(0, 100);

    // 4. 更新数据库中的有效会话和登录信息
    const { error: updateError } = await sb
      .from("users")
      .update({
        current_session_token: newSessionToken,
        last_login_ip: loginIp,
        last_login_device: loginDevice,
        last_login_time: new Date().toISOString()
      })
      .eq("id", authData.user.id);

    if (updateError) throw new Error("会话初始化失败：" + updateError.message);
    console.log("✅ 新会话已生成，单设备登录已生效");

  } catch (e) {
    // 登录失败，清理本地会话
    localStorage.removeItem(CURRENT_SESSION_KEY);
    sessionToken = "";
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

// 登录状态变化处理
async function handleAuthChange(event, session) {
  try {
    // 先清理旧资源
    clearAllResources();

    currentUser = session?.user || null;

    if (currentUser) {
      // 登录成功，先校验会话是否有效
      const isValid = await checkSessionValid();
      if (!isValid) {
        await handleSessionInvalid("会话已失效，请重新登录");
        return;
      }

      // 会话有效，初始化聊天功能
      initAfterLogin().catch(e => {
        console.error("初始化聊天失败", e);
        showNotify("error", "部分功能加载失败，请刷新重试");
      });
      showPage("chatPage");
      showNotify("success", "登录成功，欢迎使用在线聊天系统");
    } else {
      // 未登录/退出成功，跳回登录页
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
      await userLogout();
      return;
    }
    if (userInfo.status === "ban") {
      showNotify("error", "账号已被封禁，无法登录");
      await userLogout();
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

    // 4. 核心：初始化单设备登录会话监听
    initSessionCheckListener();

    // 5. 按顺序初始化其他功能
    await loadInitialMessages();
    initMessageRealtime();
    await markOnline();
    await refreshOnlineCount();
    initOnlineRealtime();
    initConfigRealtime();
    initHeartbeat();
    await recordLoginLog();

  } catch (e) {
    console.error("初始化聊天异常", e);
    showNotify("error", "部分功能加载失败，请刷新重试");
  }
}

// ====================== 消息核心功能 ======================
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
  } catch (e) {
    console.error("消息渲染异常", e);
  }
}

function initMessageRealtime() {
  try {
    console.log("正在开启消息实时监听...");
    msgChannel = sb.channel("message_channel", {
      config: { broadcast: { self: true } }
    })
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages" },
      async () => {
        console.log("收到消息实时事件");
        await loadInitialMessages();
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

async function sendMessage() {
  try {
    // 发送消息前先校验会话是否有效
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
    await loadInitialMessages();

  } catch (e) {
    console.error("发送消息失败", e);
    showNotify("error", `发送失败：${e.message}`);
  } finally {
    $("#sendBtn").disabled = false;
    $("#sendBtn").innerText = "发送";
  }
}

// ====================== 在线人数核心功能 ======================
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

function initOnlineRealtime() {
  try {
    console.log("正在开启在线人数实时监听...");
    onlineChannel = sb.channel("online_channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "online_users" },
      async () => {
        console.log("收到在线状态实时事件");
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

function initHeartbeat() {
  heartbeatTimer = setInterval(async () => {
    if (currentUser) {
      await markOnline();
    }
  }, 30000);
}

// ====================== 配置&公告功能 ======================
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

// ====================== 登录日志功能 ======================
async function recordLoginLog() {
  try {
    console.log("正在记录登录日志...");
    const ipRes = await fetch("https://api.ipify.org?format=json").catch(() => ({ json: () => ({ ip: "未知IP" }) }));
    const ipData = await ipRes.json();
    const ip = ipData.ip || "未知IP";
    const device = navigator.userAgent.substring(0, 80);
    const time = new Date().toLocaleString();

    const { error } = await sb.from("login_logs").insert([{
      user_id: currentUser.id,
      ip: ip,
      device: device,
      time: time
    }]);

    if (error) throw new Error(error.message);
    console.log("✅ 登录日志记录成功");
  } catch (e) {
    console.warn("登录日志记录失败", e);
  }
}

async function showMyLoginLogs() {
  try {
    // 查看日志前先校验会话
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }

    showNotify("info", "正在加载登录日志...");
    const { data, error } = await sb
      .from("login_logs")
      .select("*")
      .eq("user_id", currentUser.id)
      .order("time", { ascending: false })
      .limit(10);

    if (error) throw new Error(error.message);
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
    console.error("登录日志加载失败", e);
    showNotify("error", `登录日志加载失败：${e.message}`);
  }
}

// ====================== 退出登录功能 ======================
async function userLogout() {
  try {
    showNotify("info", "正在退出登录...");
    console.log("开始退出登录流程");

    // 1. 清空数据库中的当前会话Token
    if (currentUser) {
      await sb
        .from("users")
        .update({ current_session_token: null })
        .eq("id", currentUser.id)
        .catch(() => {});
    }

    // 2. 清理所有资源
    clearAllResources();

    // 3. 异步删除在线状态
    sb.from("online_users").delete().eq("user_id", currentUser?.id).catch(() => {});

    // 4. 执行退出登录
    const { error } = await sb.auth.signOut();
    if (error) throw new Error(error.message);

    // 5. 强制跳回登录页
    showPage("loginPage");
    showNotify("success", "已安全退出登录");
    console.log("退出登录完成");

  } catch (e) {
    console.error("退出登录失败", e);
    showNotify("error", `退出失败：${e.message}`);
    // 兜底：强制清理和跳转
    clearAllResources();
    showPage("loginPage");
  }
}

// ====================== 设置功能 ======================
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

// ====================== 管理员功能 ======================
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
    // 加载系统配置
    const { data: config } = await sb.from("system_config").select("*").single().catch(() => ({ data: { require_verify: false, sensitive_words: "", announcement: "" } }));
    $("#requireVerifyToggle").checked = config?.require_verify || false;
    $("#sensitiveWordsInput").value = config?.sensitive_words || "";
    $("#announceInput").value = config?.announcement || "";

    // 加载待审核用户
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

    // 加载全部用户
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

    // 加载登录日志
    const { data: allLogs } = await sb
      .from("login_logs")
      .select("*, users!inner(email, nick)")
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

    showNotify("success", "管理数据加载完成");
  } catch (e) {
    console.error("管理数据加载失败", e);
    showNotify("error", `管理数据加载失败：${e.message}`);
  }
}

// 管理员强制用户下线功能
async function forceUserOffline(userId) {
  if (!confirm("确定要强制该用户下线吗？")) return;
  try {
    const { error } = await sb
      .from("users")
      .update({ current_session_token: null })
      .eq("id", userId);

    if (error) throw new Error(error.message);
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

// 页面关闭/刷新时清理
window.addEventListener("beforeunload", async () => {
  try {
    if (currentUser) {
      // 同步删除在线状态
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
    clearAllResources();
  } catch (e) {
    console.error("页面关闭清理异常", e);
  }
});

// 页面切回前台时，立即校验会话
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && currentUser) {
    console.log("页面切回前台，校验会话有效性");
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    // 刷新状态
    await markOnline();
    await refreshOnlineCount();
    await loadInitialMessages();
  }
});

// 系统主题变化跟随
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", initTheme);
