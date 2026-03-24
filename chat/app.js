// ====================== 核心配置 ======================
const APP_CONFIG = {
  SUPABASE_URL: "https://ayavdkodhdmcxfufnnxo.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc",
  TIMEOUT: {
    LOGIN: 20000,
    API: 10000,
    REALTIME: 15000
  },
  INTERVAL: {
    HEARTBEAT: 30000,
    SESSION_CHECK: 60000
  }
};

// ====================== 安全工具函数 ======================
const SafeStorage = {
  get: (key) => {
    try {
      return localStorage.getItem(key) || "";
    } catch (e) {
      console.warn("[本地存储] 读取失败", e);
      return "";
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      console.warn("[本地存储] 写入失败", e);
      return false;
    }
  },
  remove: (key) => {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.warn("[本地存储] 删除失败", e);
      return false;
    }
  },
  clear: () => {
    try {
      localStorage.clear();
      return true;
    } catch (e) {
      console.warn("[本地存储] 清空失败", e);
      return false;
    }
  }
};

const $ = (selector) => {
  try {
    const el = document.querySelector(selector);
    return el || {
      addEventListener: () => {},
      innerText: '',
      innerHTML: '',
      value: '',
      disabled: false,
      checked: false,
      classList: { add: () => {}, remove: () => {} },
      style: {}
    };
  } catch (e) {
    console.warn("[DOM选择器] 失败", e);
    return {
      addEventListener: () => {},
      innerText: '',
      innerHTML: '',
      value: '',
      disabled: false,
      checked: false,
      classList: { add: () => {}, remove: () => {} },
      style: {}
    };
  }
};
const $$ = (selector) => {
  try {
    return document.querySelectorAll(selector) || [];
  } catch (e) {
    console.warn("[DOM选择器] 批量查询失败", e);
    return [];
  }
};

const showNotify = (type, text) => {
  try {
    const notifyEl = $("#winNotify");
    notifyEl.className = `win-notify ${type}`;
    notifyEl.innerText = text;
    notifyEl.classList.remove("hidden");
    setTimeout(() => notifyEl.classList.add("hidden"), 6000);
  } catch (e) {
    console.warn("[通知] 失败", e);
    alert(text);
  }
};

const withTimeout = (promise, timeoutMs, errorMsg = "请求超时") => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))
  ]);
};

const generateSessionToken = () => {
  try {
    return crypto.randomUUID();
  } catch (e) {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
};

// ====================== 全局状态管理 ======================
const AppState = {
  sb: null,
  currentUser: null,
  userNick: SafeStorage.get("nick"),
  sessionToken: SafeStorage.get("chat_current_session_token"),
  isSessionInitialized: false,
  locks: {
    isLoggingIn: false,
    isLoggingOut: false,
    isAuthHandling: false,
    isInit: false
  },
  channels: {},
  timers: {}
};

const resetAllButtons = () => {
  try {
    $("#loginBtn").disabled = false;
    $("#loginBtn").innerText = "登录";
    $("#regBtn").disabled = false;
    $("#regBtn").innerText = "注册";
    $("#sendBtn").disabled = false;
    $("#sendBtn").innerText = "发送";
    $("#logoutBtn").disabled = false;
    $("#logoutBtn").innerText = "退出登录";
    Object.keys(AppState.locks).forEach(key => AppState.locks[key] = false);
  } catch (e) {
    console.warn("[按钮重置] 失败", e);
  }
};

const clearAllResources = () => {
  try {
    console.log("[资源清理] 开始清理");
    Object.values(AppState.timers).forEach(timer => {
      if (timer) clearTimeout(timer) || clearInterval(timer);
    });
    if (AppState.sb) {
      Object.values(AppState.channels).forEach(channel => {
        if (channel) AppState.sb.removeChannel(channel);
      });
    }
    AppState.currentUser = null;
    AppState.userNick = "";
    AppState.sessionToken = "";
    AppState.isSessionInitialized = false;
    AppState.channels = {};
    AppState.timers = {};
    SafeStorage.remove("chat_current_session_token");
    SafeStorage.remove("nick");
    resetAllButtons();
    $("#msgInput").value = "";
    $("#loginEmail").value = "";
    $("#loginPwd").value = "";
    console.log("[资源清理] 完成");
  } catch (e) {
    console.warn("[资源清理] 异常", e);
    resetAllButtons();
  }
};

// ====================== 核心修复：严格的登录态校验 ======================
/**
 * 校验当前会话是否有效（核心拦截逻辑）
 * @returns {boolean} 会话是否有效
 */
const validateSession = async () => {
  try {
    console.log("[会话校验] 开始校验会话有效性");
    // 1. 校验Supabase客户端是否初始化
    if (!AppState.sb) {
      console.warn("[会话校验] Supabase客户端未初始化");
      return false;
    }

    // 2. 主动获取最新会话，不依赖本地缓存
    const { data: { session }, error } = await AppState.sb.auth.getSession();
    if (error || !session) {
      console.warn("[会话校验] 无有效会话", error);
      return false;
    }

    // 3. 校验会话是否过期
    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at && session.expires_at < now) {
      console.warn("[会话校验] 会话已过期");
      return false;
    }

    // 4. 校验用户是否存在
    if (!session.user || !session.user.id) {
      console.warn("[会话校验] 无有效用户信息");
      return false;
    }

    // 5. 校验用户状态是否正常
    const { data: userInfo } = await withTimeout(
      AppState.sb.from("users").select("status, is_admin, nick").eq("id", session.user.id).single(),
      APP_CONFIG.TIMEOUT.API,
      "用户信息查询超时"
    ).catch(() => ({ data: null }));

    if (!userInfo) {
      console.warn("[会话校验] 用户信息不存在");
      return false;
    }

    if (userInfo.status === "ban") {
      console.warn("[会话校验] 账号已被封禁");
      showNotify("error", "账号已被封禁，无法登录");
      return false;
    }

    // 6. 所有校验通过，更新全局状态
    AppState.currentUser = session.user;
    AppState.currentUser.isAdmin = userInfo.is_admin || false;
    AppState.userNick = SafeStorage.get("nick") || userInfo.nick || "用户";
    console.log("[会话校验] 会话有效，校验通过");
    return true;

  } catch (e) {
    console.error("[会话校验] 异常", e);
    return false;
  }
};

/**
 * 强制跳转到登录页（未登录拦截）
 */
const forceToLoginPage = () => {
  clearAllResources();
  showPage("loginPage");
  closeLoader();
};

// ====================== 页面基础功能 ======================
const closeLoader = () => {
  try {
    if (AppState.timers.forceCloseLoader) clearTimeout(AppState.timers.forceCloseLoader);
    const loader = $("#loadingPage");
    loader.style.opacity = 0;
    setTimeout(() => {
      loader.classList.add("hidden");
      loader.style.display = "none";
    }, 300);
  } catch (e) {
    console.warn("[加载页关闭] 失败", e);
    $("#loadingPage")?.remove();
  }
};

/**
 * 核心修复：页面切换+登录态拦截
 */
const showPage = (pageId) => {
  try {
    // 登录态拦截：非登录页必须校验登录态
    const needLogin = ["chatPage", "settingPage", "adminPage"].includes(pageId);
    if (needLogin && !AppState.isSessionInitialized) {
      console.warn("[页面拦截] 未登录，禁止访问", pageId);
      forceToLoginPage();
      return;
    }

    // 管理员页拦截
    if (pageId === "adminPage" && !AppState.currentUser?.isAdmin) {
      showNotify("error", "你没有管理员权限");
      return;
    }

    // 执行页面切换
    $$(".page").forEach(page => {
      page.classList.remove("active");
      page.classList.add("hidden");
    });
    const targetPage = $(`#${pageId}`);
    targetPage.classList.remove("hidden");
    targetPage.classList.add("active");
    targetPage.scrollTop = 0;
    console.log("[页面切换] 成功跳转到", pageId);

  } catch (e) {
    console.error("[页面切换] 失败", e);
    showNotify("error", "页面切换失败");
  }
};

const initTheme = () => {
  try {
    const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const localDark = SafeStorage.get("theme") === "dark";
    const root = document.documentElement;
    
    if (localDark || sysDark) {
      root.dataset.theme = "dark";
      $("#toggleThemeBtn").innerText = "切换浅色模式";
    } else {
      $("#toggleThemeBtn").innerText = "切换深色模式";
    }
  } catch (e) {
    console.warn("[主题初始化] 失败", e);
  }
};

const toggleTheme = () => {
  try {
    const root = document.documentElement;
    const isDark = root.dataset.theme === "dark";
    
    if (isDark) {
      root.dataset.theme = "";
      SafeStorage.remove("theme");
      $("#toggleThemeBtn").innerText = "切换深色模式";
    } else {
      root.dataset.theme = "dark";
      SafeStorage.set("theme", "dark");
      $("#toggleThemeBtn").innerText = "切换浅色模式";
    }
  } catch (e) {
    showNotify("error", "主题切换失败");
  }
};

// ====================== 单设备登录核心逻辑 ======================
const checkSessionValid = async () => {
  try {
    if (!AppState.currentUser || !AppState.sessionToken || !AppState.isSessionInitialized) {
      return false;
    }

    const { data } = await withTimeout(
      AppState.sb.from("users").select("current_session_token").eq("id", AppState.currentUser.id).single(),
      APP_CONFIG.TIMEOUT.API,
      "会话校验超时"
    );

    return data?.current_session_token === AppState.sessionToken;
  } catch (e) {
    console.warn("[会话校验] 失败", e);
    return false;
  }
};

const handleSessionInvalid = async (reason = "账号在其他设备登录，已为你安全下线") => {
  try {
    showNotify("error", reason);
    AppState.isSessionInitialized = false;
    if (AppState.sb) await AppState.sb.auth.signOut().catch(() => {});
    clearAllResources();
    SafeStorage.clear();
    showPage("loginPage");
    setTimeout(() => window.location.reload(), 800);
  } catch (e) {
    console.warn("[会话失效处理] 异常", e);
    clearAllResources();
    SafeStorage.clear();
    window.location.href = `${window.location.origin}/chat`;
  }
};

const initSessionCheckListener = () => {
  try {
    if (!AppState.currentUser) return;
    if (AppState.channels.sessionCheck) {
      AppState.sb.removeChannel(AppState.channels.sessionCheck);
    }

    AppState.channels.sessionCheck = AppState.sb.channel("session_check")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "users", filter: `id=eq.${AppState.currentUser.id}` },
        async () => {
          setTimeout(async () => {
            const isValid = await checkSessionValid();
            if (!isValid) await handleSessionInvalid();
          }, 500);
        }
      )
      .subscribe();

    AppState.timers.sessionCheck = setInterval(async () => {
      if (AppState.currentUser && AppState.isSessionInitialized) {
        const isValid = await checkSessionValid();
        if (!isValid) await handleSessionInvalid();
      }
    }, APP_CONFIG.INTERVAL.SESSION_CHECK);

  } catch (e) {
    console.warn("[会话监听] 初始化失败", e);
  }
};

// ====================== 登录&注册逻辑 ======================
const doLogin = async () => {
  if (AppState.locks.isLoggingIn) {
    showNotify("warning", "正在登录中，请稍候...");
    return;
  }

  AppState.locks.isLoggingIn = true;
  $("#loginBtn").disabled = true;
  $("#loginBtn").innerText = "登录中...";

  try {
    const email = $("#loginEmail").value.trim();
    const pwd = $("#loginPwd").value.trim();
    if (!email || !pwd) {
      showNotify("error", "请填写邮箱和密码");
      return;
    }

    console.log("[登录] 开始验证账号");
    const { data: authData, error: authError } = await withTimeout(
      AppState.sb.auth.signInWithPassword({ email, password: pwd }),
      APP_CONFIG.TIMEOUT.LOGIN,
      "登录请求超时（20秒），请检查网络后重试"
    );

    if (authError) {
      let errMsg = authError.message;
      if (errMsg.includes("Email not confirmed")) errMsg = "邮箱未验证，请验证后登录";
      if (errMsg.includes("Invalid login credentials")) errMsg = "邮箱或密码错误";
      if (errMsg.includes("banned")) errMsg = "账号已被封禁";
      throw new Error(errMsg);
    }

    if (!authData.user) throw new Error("登录失败，未获取到用户信息");
    showNotify("info", "登录成功，正在进入聊天...");
    console.log("[登录] 账号验证成功");

  } catch (e) {
    console.error("[登录失败]", e.message);
    showNotify("error", `登录失败：${e.message}`);
  } finally {
    setTimeout(() => {
      AppState.locks.isLoggingIn = false;
      $("#loginBtn").disabled = false;
      $("#loginBtn").innerText = "登录";
    }, 300);
  }
};

const doRegister = async () => {
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

    const { error } = await withTimeout(
      AppState.sb.auth.signUp({
        email, password: pwd,
        options: { data: { nick } }
      }),
      APP_CONFIG.TIMEOUT.LOGIN,
      "注册请求超时，请检查网络后重试"
    );

    if (error) {
      let errMsg = error.message;
      if (errMsg.includes("already registered")) errMsg = "该邮箱已被注册，请直接登录";
      throw new Error(errMsg);
    }

    showNotify("success", "注册成功，请前往邮箱验证后登录");
    $("#regNick").value = "";
    $("#regEmail").value = "";
    $("#regPwd").value = "";
    showPage("loginPage");

  } catch (e) {
    console.error("[注册失败]", e.message);
    showNotify("error", `注册失败：${e.message}`);
  } finally {
    $("#regBtn").disabled = false;
    $("#regBtn").innerText = "注册";
  }
};

// ====================== 核心修复：登录状态变更处理 ======================
const handleAuthChange = async (event, session) => {
  if (AppState.locks.isAuthHandling) {
    console.log("[登录状态] 正在处理中，跳过重复触发");
    return;
  }

  try {
    AppState.locks.isAuthHandling = true;
    console.log("[登录状态] 事件：", event);

    // 只处理有效登录事件
    const validEvents = ["SIGNED_IN", "INITIAL_SESSION"];
    if (!validEvents.includes(event)) {
      console.log("[登录状态] 非有效登录事件，跳过处理");
      // 退出登录事件，强制跳登录页
      if (event === "SIGNED_OUT") {
        forceToLoginPage();
      }
      return;
    }

    // 核心：严格校验会话有效性
    const isSessionValid = await validateSession();
    if (!isSessionValid) {
      console.warn("[登录状态] 会话无效，强制跳登录页");
      forceToLoginPage();
      return;
    }

    // 会话有效，继续处理登录流程
    console.log("[登录状态] 会话有效，开始初始化");
    SafeStorage.remove("chat_current_session_token");
    const newSessionToken = generateSessionToken();
    AppState.sessionToken = newSessionToken;
    SafeStorage.set("chat_current_session_token", newSessionToken);

    // 先标记会话已初始化，允许访问聊天页
    AppState.isSessionInitialized = true;

    // 立即跳转到聊天页
    showPage("chatPage");
    showNotify("success", "登录成功，欢迎使用");
    closeLoader();
    $("#userTag").innerText = `用户：${AppState.userNick}`;
    if (AppState.currentUser.isAdmin) $("#adminBtn").classList.remove("hidden");

    // 异步执行所有非核心操作（不阻塞用户使用）
    setTimeout(async () => {
      try {
        // 更新会话Token到数据库
        await AppState.sb.from("users").update({
          current_session_token: newSessionToken,
          last_login_time: new Date().toISOString()
        }).eq("id", AppState.currentUser.id).catch(() => {});

        // 异步更新IP/设备信息
        withTimeout(
          fetch("https://api.ipify.org?format=json").then(res => res.json()),
          5000,
          "IP查询超时"
        ).then(ipData => {
          AppState.sb.from("users").update({
            last_login_ip: ipData.ip || "未知IP",
            last_login_device: navigator.userAgent.substring(0, 100)
          }).eq("id", AppState.currentUser.id).catch(() => {});
        }).catch(() => {});

        // 初始化所有功能
        initSessionCheckListener();
        await loadInitialMessages();
        initMessageRealtime();
        await markOnline();
        await refreshOnlineCount();
        initOnlineRealtime();
        initConfigRealtime();
        initHeartbeat();
        await recordLoginLog();

        console.log("[登录后初始化] 所有功能初始化完成");

      } catch (e) {
        console.warn("[登录后初始化] 部分功能失败", e);
        // 核心修复：非关键功能失败，不提示用户，只打日志
      }
    }, 0);

  } catch (e) {
    console.error("[登录状态处理] 异常", e);
    showNotify("error", `登录异常：${e.message}`);
    forceToLoginPage();
  } finally {
    AppState.locks.isAuthHandling = false;
    closeLoader();
    resetAllButtons();
  }
};

// ====================== 退出登录逻辑 ======================
const userLogout = async () => {
  if (AppState.locks.isLoggingOut) {
    showNotify("warning", "正在退出中，请稍候...");
    return;
  }

  AppState.locks.isLoggingOut = true;
  $("#logoutBtn").disabled = true;
  $("#logoutBtn").innerText = "退出中...";

  try {
    showNotify("info", "正在安全退出...");
    console.log("[退出登录] 开始处理");

    if (AppState.currentUser) {
      await AppState.sb.from("users")
        .update({ current_session_token: null })
        .eq("id", AppState.currentUser.id)
        .catch(() => {});
      
      await AppState.sb.from("online_users")
        .delete()
        .eq("user_id", AppState.currentUser.id)
        .catch(() => {});
    }

    await AppState.sb.auth.signOut();
    clearAllResources();
    SafeStorage.clear();
    showPage("loginPage");
    showNotify("success", "已安全退出登录");
    console.log("[退出登录] 完成");

  } catch (e) {
    console.error("[退出登录] 异常", e);
    showNotify("error", `退出失败：${e.message}`);
    clearAllResources();
    SafeStorage.clear();
    showPage("loginPage");
  } finally {
    setTimeout(() => {
      AppState.locks.isLoggingOut = false;
      $("#logoutBtn").disabled = false;
      $("#logoutBtn").innerText = "退出登录";
    }, 300);
  }
};

// ====================== 聊天核心功能 ======================
const loadInitialMessages = async () => {
  try {
    const { data: msgList } = await withTimeout(
      AppState.sb.from("messages").select("*").order("id", { ascending: true }).limit(200),
      APP_CONFIG.TIMEOUT.API,
      "加载消息超时"
    );
    renderMessages(msgList || []);
  } catch (e) {
    console.warn("[消息加载] 失败", e);
  }
};

const renderMessages = (msgList) => {
  try {
    const msgBox = $("#msgBox");
    let html = "";
    msgList.forEach(msg => {
      const isMe = msg.user_id === AppState.currentUser.id;
      html += `
        <div class="msg-item ${isMe ? 'msg-me' : 'msg-other'}">
          <div class="avatar">${msg.nick.charAt(0)}</div>
          <div>
            <div class="msg-name">${msg.nick}</div>
            <div class="bubble">${msg.text}</div>
            <div class="msg-time">${msg.time}</div>
          </div>
          ${AppState.currentUser.isAdmin ? `<button class="win-btn small danger" onclick="deleteMsg(${msg.id})">删除</button>` : ''}
        </div>
      `;
    });
    msgBox.innerHTML = html;
    msgBox.scrollTop = msgBox.scrollHeight;
  } catch (e) {
    console.warn("[消息渲染] 失败", e);
  }
};

const initMessageRealtime = () => {
  try {
    if (AppState.channels.msg) AppState.sb.removeChannel(AppState.channels.msg);
    AppState.channels.msg = AppState.sb.channel("message_channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, async () => {
        await loadInitialMessages();
      })
      .subscribe();
  } catch (e) {
    console.warn("[消息实时监听] 失败", e);
  }
};

const sendMessage = async () => {
  try {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    if (!AppState.currentUser) return;
    
    const msgInput = $("#msgInput");
    const text = msgInput.value.trim();
    if (!text) {
      showNotify("error", "不能发送空消息");
      return;
    }

    $("#sendBtn").disabled = true;
    $("#sendBtn").innerText = "发送中...";

    let content = text;
    try {
      const { data: config } = await AppState.sb.from("system_config").select("sensitive_words").single().catch(() => ({ data: {} }));
      const badWords = (config?.sensitive_words || "").split(",").filter(w => w.trim());
      badWords.forEach(word => {
        content = content.replaceAll(word, "***");
      });
    } catch (e) {}

    await AppState.sb.from("messages").insert([{
      user_id: AppState.currentUser.id,
      nick: AppState.userNick,
      text: content,
      time: new Date().toLocaleString()
    }]);

    msgInput.value = "";
    showNotify("success", "消息发送成功");
    await loadInitialMessages();

  } catch (e) {
    console.error("[消息发送] 失败", e);
    showNotify("error", `发送失败：${e.message}`);
  } finally {
    $("#sendBtn").disabled = false;
    $("#sendBtn").innerText = "发送";
  }
};

// ====================== 在线人数功能 ======================
const markOnline = async () => {
  try {
    await AppState.sb.from("online_users").upsert({
      user_id: AppState.currentUser.id,
      nick: AppState.userNick,
      last_active: new Date().toISOString()
    }, { onConflict: "user_id" }).catch(() => {});
  } catch (e) {}
};

const refreshOnlineCount = async () => {
  try {
    const { data } = await AppState.sb.from("online_users").select("*").catch(() => ({ data: [] }));
    $("#onlineNum").innerText = data?.length || 0;
  } catch (e) {}
};

const initOnlineRealtime = () => {
  try {
    if (AppState.channels.online) AppState.sb.removeChannel(AppState.channels.online);
    AppState.channels.online = AppState.sb.channel("online_channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, async () => {
        await refreshOnlineCount();
      })
      .subscribe();
  } catch (e) {}
};

const initHeartbeat = () => {
  AppState.timers.heartbeat = setInterval(async () => {
    if (AppState.currentUser && AppState.isSessionInitialized) {
      await markOnline();
    }
  }, APP_CONFIG.INTERVAL.HEARTBEAT);
};

// ====================== 公告&配置功能 ======================
const initConfigRealtime = () => {
  try {
    if (AppState.channels.config) AppState.sb.removeChannel(AppState.channels.config);
    AppState.channels.config = AppState.sb.channel("config_channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "system_config" }, async () => {
        await loadAnnouncement();
      })
      .subscribe();
  } catch (e) {}
};

const loadAnnouncement = async () => {
  try {
    const { data } = await AppState.sb.from("system_config").select("announcement").single().catch(() => ({ data: {} }));
    const announceBar = $("#announceBar");
    if (data?.announcement) {
      announceBar.innerText = data.announcement;
      announceBar.classList.remove("hidden");
    } else {
      announceBar.classList.add("hidden");
    }
  } catch (e) {}
};

// ====================== 登录日志功能 ======================
const recordLoginLog = async () => {
  try {
    const ipData = await withTimeout(
      fetch("https://api.ipify.org?format=json").then(res => res.json()),
      3000,
      "IP查询超时"
    ).catch(() => ({ ip: "未知IP" }));
    
    await AppState.sb.from("login_logs").insert([{
      user_id: AppState.currentUser.id,
      ip: ipData.ip,
      device: navigator.userAgent.substring(0, 80),
      time: new Date().toLocaleString()
    }]).catch(() => {});
  } catch (e) {}
};

const showMyLoginLogs = async () => {
  try {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    showNotify("info", "正在加载登录日志...");
    const { data } = await AppState.sb.from("login_logs").select("*")
      .eq("user_id", AppState.currentUser.id)
      .order("time", { ascending: false })
      .limit(10)
      .catch(() => ({ data: [] }));
    
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
};

// ====================== 设置功能 ======================
const saveNickname = async () => {
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
    await AppState.sb.from("users").update({ nick: newNick }).eq("id", AppState.currentUser.id);
    AppState.userNick = newNick;
    SafeStorage.set("nick", newNick);
    $("#userTag").innerText = `用户：${newNick}`;
    $("#nickInput").value = "";
    showNotify("success", "昵称保存成功");
    await markOnline();
  } catch (e) {
    showNotify("error", "昵称保存失败");
  }
};

const updatePassword = async () => {
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
    const { error } = await AppState.sb.auth.updateUser({ password: newPwd });
    if (error) throw new Error(error.message);
    showNotify("success", "密码修改成功，请重新登录");
    $("#newPwdInput").value = "";
    setTimeout(userLogout, 1500);
  } catch (e) {
    showNotify("error", `密码修改失败：${e.message}`);
  }
};

// ====================== 管理员功能 ======================
const loadAdminData = async () => {
  if (!AppState.currentUser.isAdmin) {
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
    
    const { data: config } = await AppState.sb.from("system_config").select("*").single().catch(() => ({ data: {} }));
    $("#requireVerifyToggle").checked = config?.require_verify || false;
    $("#sensitiveWordsInput").value = config?.sensitive_words || "";
    $("#announceInput").value = config?.announcement || "";

    const { data: verifyUsers } = await AppState.sb.from("users").select("*").eq("status", "pending").catch(() => ({ data: [] }));
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

    const { data: allUsers } = await AppState.sb.from("users").select("*").order("created_at", { ascending: false }).catch(() => ({ data: [] }));
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

    const { data: allLogs } = await AppState.sb.from("login_logs").select("*, users!inner(email, nick)")
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
    showNotify("error", "管理数据加载失败");
  }
};

const forceUserOffline = async (userId) => {
  if (!confirm("确定要强制该用户下线吗？")) return;
  try {
    await AppState.sb.from("users").update({ current_session_token: null }).eq("id", userId);
    showNotify("success", "用户已被强制下线");
    loadAdminData();
  } catch (e) {
    showNotify("error", "强制下线失败");
  }
};

const verifyUser = async (userId, status) => {
  try {
    await AppState.sb.from("users").update({ status }).eq("id", userId);
    showNotify("success", status === "active" ? "用户审核通过" : "用户审核拒绝");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
};

const setUserMute = async (userId, isMute) => {
  try {
    await AppState.sb.from("users").update({ is_mute: isMute }).eq("id", userId);
    showNotify("success", isMute ? "已禁言该用户" : "已解禁该用户");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
};

const setUserStatus = async (userId, status) => {
  try {
    await AppState.sb.from("users").update({ status }).eq("id", userId);
    showNotify("success", status === "active" ? "已解封该用户" : "已封禁该用户");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
};

const resetUserPwd = async (email) => {
  try {
    const { error } = await AppState.sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/chat`
    });
    if (error) throw new Error(error.message);
    showNotify("success", "密码重置邮件已发送");
  } catch (e) {
    showNotify("error", `重置失败：${e.message}`);
  }
};

const saveSystemConfig = async () => {
  try {
    const requireVerify = $("#requireVerifyToggle").checked;
    const { data } = await AppState.sb.from("system_config").select("id").single().catch(() => ({ data: null }));
    if (data) {
      await AppState.sb.from("system_config").update({ require_verify: requireVerify }).eq("id", data.id);
    } else {
      await AppState.sb.from("system_config").insert([{ require_verify: requireVerify }]);
    }
    showNotify("success", "系统配置保存成功");
  } catch (e) {
    showNotify("error", "配置保存失败");
  }
};

const saveSensitiveWords = async () => {
  try {
    const words = $("#sensitiveWordsInput").value.trim();
    const { data } = await AppState.sb.from("system_config").select("id").single().catch(() => ({ data: null }));
    if (data) {
      await AppState.sb.from("system_config").update({ sensitive_words: words }).eq("id", data.id);
    } else {
      await AppState.sb.from("system_config").insert([{ sensitive_words: words }]);
    }
    showNotify("success", "敏感词保存成功");
  } catch (e) {
    showNotify("error", "保存失败");
  }
};

const saveAnnouncement = async () => {
  try {
    const content = $("#announceInput").value.trim();
    const { data } = await AppState.sb.from("system_config").select("id").single().catch(() => ({ data: null }));
    if (data) {
      await AppState.sb.from("system_config").update({ announcement: content }).eq("id", data.id);
    } else {
      await AppState.sb.from("system_config").insert([{ announcement: content }]);
    }
    showNotify("success", "公告已推送");
  } catch (e) {
    showNotify("error", "推送失败");
  }
};

const deleteMsg = async (msgId) => {
  try {
    await AppState.sb.from("messages").delete().eq("id", msgId);
    showNotify("success", "消息已删除");
    await loadInitialMessages();
  } catch (e) {
    showNotify("error", "删除失败");
  }
};

const clearAllMessages = async () => {
  if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
  try {
    await AppState.sb.from("messages").delete().neq("id", 0);
    showNotify("success", "所有消息已清空");
    await loadInitialMessages();
  } catch (e) {
    showNotify("error", "清空失败");
  }
};

// ====================== 事件绑定&应用初始化 ======================
const bindAllEvents = () => {
  try {
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
  } catch (e) {
    console.error("[事件绑定] 失败", e);
  }
};

const initApp = async () => {
  try {
    if (AppState.locks.isInit) return;
    AppState.locks.isInit = true;
    console.log("[应用初始化] 开始");

    // 强制关闭加载页兜底（5秒超时）
    AppState.timers.forceCloseLoader = setTimeout(() => {
      console.warn("[初始化] 超时，强制关闭加载页");
      closeLoader();
      forceToLoginPage();
    }, 5000);

    initTheme();

    // 校验Supabase SDK是否加载完成
    if (!window.supabase) {
      throw new Error("Supabase SDK加载失败，请刷新页面重试");
    }

    // 初始化Supabase客户端
    AppState.sb = window.supabase.createClient(
      APP_CONFIG.SUPABASE_URL,
      APP_CONFIG.SUPABASE_KEY,
      {
        auth: { 
          autoRefreshToken: true, 
          persistSession: true, 
          detectSessionInUrl: true
        },
        realtime: { 
          timeout: APP_CONFIG.TIMEOUT.REALTIME,
          heartbeatIntervalMs: APP_CONFIG.INTERVAL.HEARTBEAT
        },
        global: {
          fetch: (...args) => withTimeout(fetch(...args), APP_CONFIG.TIMEOUT.API, "请求超时")
        }
      }
    );

    bindAllEvents();

    // 核心：页面初始化时，先校验会话有效性
    const isSessionValid = await validateSession();
    if (isSessionValid) {
      console.log("[初始化] 已有有效会话，直接进入聊天页");
      AppState.isSessionInitialized = true;
      showPage("chatPage");
      closeLoader();
      // 异步初始化功能
      setTimeout(async () => {
        initSessionCheckListener();
        await loadInitialMessages();
        initMessageRealtime();
        await markOnline();
        await refreshOnlineCount();
        initOnlineRealtime();
        initConfigRealtime();
        initHeartbeat();
      }, 0);
    } else {
      console.log("[初始化] 无有效会话，跳登录页");
      forceToLoginPage();
    }

    // 监听登录状态变化
    AppState.sb.auth.onAuthStateChange(handleAuthChange);

    console.log("[应用初始化] 完成");
    
  } catch (e) {
    console.error("[应用初始化] 致命错误", e);
    showNotify("error", `初始化失败：${e.message}`);
    forceToLoginPage();
  }
};

// ====================== 页面生命周期监听 ======================
document.addEventListener("DOMContentLoaded", initApp);

window.addEventListener("beforeunload", async () => {
  try {
    if (AppState.currentUser && AppState.sb) {
      await AppState.sb.from("online_users").delete().eq("user_id", AppState.currentUser.id).catch(() => {});
    }
  } catch (e) {}
});

document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && AppState.currentUser && AppState.isSessionInitialized) {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    await markOnline();
    await refreshOnlineCount();
  }
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", initTheme);

// 暴露全局函数
window.deleteMsg = deleteMsg;
window.verifyUser = verifyUser;
window.setUserMute = setUserMute;
window.setUserStatus = setUserStatus;
window.resetUserPwd = resetUserPwd;
window.forceUserOffline = forceUserOffline;
