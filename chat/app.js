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
  isLoadingMessages: false, // 防重复加载锁
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
    AppState.isLoadingMessages = false;
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

const showPage = (pageId) => {
  try {
    const needLogin = ["chatPage", "settingPage", "adminPage"].includes(pageId);
    if (needLogin && !AppState.isSessionInitialized) {
      console.warn("[页面拦截] 未登录，禁止访问", pageId);
      clearAllResources();
      showPage("loginPage");
      closeLoader();
      return;
    }

    if (pageId === "adminPage" && !AppState.currentUser?.isAdmin) {
      showNotify("error", "你没有管理员权限");
      return;
    }

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
    showNotify("error", "页面切换失败：" + e.message);
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
    showNotify("error", "主题切换失败：" + e.message);
  }
};

// ====================== 单设备登录核心逻辑 ======================
const handleSessionInvalid = async (reason = "账号在其他设备登录，已为你安全下线") => {
  try {
    showNotify("error", reason);
    AppState.isSessionInitialized = false;
    if (AppState.sb) {
      try {
        await AppState.sb.auth.signOut();
      } catch (e) {
        console.warn("[退出登录] 异常", e);
      }
    }
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
        async (payload) => {
          console.log("[会话监听] 收到用户记录更新事件", payload);
          const newToken = payload.new?.current_session_token;
          if (newToken && newToken !== AppState.sessionToken) {
            console.warn("[会话监听] 检测到其他设备登录，触发下线");
            await handleSessionInvalid();
          }
        }
      )
      .subscribe((status) => {
        console.log(`[会话监听] 通道状态：${status}`);
        if (status === "CHANNEL_ERROR") {
          console.error("[会话监听] 通道连接失败，10秒后重试");
          showNotify("warning", "会话监听连接失败，正在重试...");
          setTimeout(initSessionCheckListener, 10000);
        }
      });

    AppState.timers.sessionCheck = setInterval(async () => {
      if (AppState.currentUser && AppState.isSessionInitialized) {
        try {
          const { data } = await withTimeout(
            AppState.sb.from("users").select("current_session_token").eq("id", AppState.currentUser.id).single(),
            APP_CONFIG.TIMEOUT.API,
            "会话校验超时"
          );
          const isValid = data?.current_session_token === AppState.sessionToken;
          if (!isValid) await handleSessionInvalid();
        } catch (e) {
          console.warn("[定时会话校验] 失败", e);
        }
      }
    }, APP_CONFIG.INTERVAL.SESSION_CHECK);

  } catch (e) {
    console.warn("[会话监听] 初始化失败", e);
    showNotify("error", "会话监听初始化失败：" + e.message);
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

// ====================== 登录状态变更处理 ======================
const handleAuthChange = async (event, session) => {
  if (AppState.locks.isAuthHandling) {
    console.log("[登录状态] 正在处理中，跳过重复触发");
    return;
  }

  try {
    AppState.locks.isAuthHandling = true;
    console.log("[登录状态] 事件：", event);

    const validEvents = ["SIGNED_IN", "INITIAL_SESSION"];
    if (!validEvents.includes(event)) {
      console.log("[登录状态] 非有效登录事件，跳过处理");
      if (event === "SIGNED_OUT") {
        clearAllResources();
        showPage("loginPage");
        closeLoader();
      }
      return;
    }

    if (!session?.user) {
      console.warn("[登录状态] 无有效会话");
      clearAllResources();
      showPage("loginPage");
      closeLoader();
      return;
    }

    console.log("[登录状态] 开始获取用户信息");
    const { data: userInfo, error: userError } = await withTimeout(
      AppState.sb.from("users").select("*").eq("id", session.user.id).single(),
      APP_CONFIG.TIMEOUT.API,
      "用户信息查询超时"
    );

    if (userError || !userInfo) {
      throw new Error("获取用户信息失败：" + (userError?.message || "未知错误"));
    }

    if (userInfo.status === "ban") {
      throw new Error("账号已被封禁，无法登录");
    }

    AppState.currentUser = session.user;
    AppState.currentUser.isAdmin = userInfo.is_admin || false;
    AppState.userNick = SafeStorage.get("nick") || userInfo.nick || "用户";
    SafeStorage.set("nick", AppState.userNick);

    SafeStorage.remove("chat_current_session_token");
    const newSessionToken = generateSessionToken();
    AppState.sessionToken = newSessionToken;
    SafeStorage.set("chat_current_session_token", newSessionToken);

    console.log("[登录状态] 更新会话Token到数据库");
    await withTimeout(
      AppState.sb.from("users").update({
        current_session_token: newSessionToken,
        last_login_time: new Date().toISOString()
      }).eq("id", AppState.currentUser.id),
      APP_CONFIG.TIMEOUT.API,
      "更新会话Token超时"
    );

    AppState.isSessionInitialized = true;

    showPage("chatPage");
    showNotify("success", "登录成功，欢迎使用");
    closeLoader();
    $("#userTag").innerText = `用户：${AppState.userNick}`;
    if (AppState.currentUser.isAdmin) $("#adminBtn").classList.remove("hidden");

    setTimeout(async () => {
      try {
        console.log("[登录后] 开始初始化功能");
        
        try {
          const ipRes = await withTimeout(
            fetch("https://api.ipify.org?format=json"),
            5000,
            "IP查询超时"
          );
          const ipData = await ipRes.json();
          await withTimeout(
            AppState.sb.from("users").update({
              last_login_ip: ipData.ip || "未知IP",
              last_login_device: navigator.userAgent.substring(0, 100)
            }).eq("id", AppState.currentUser.id),
            APP_CONFIG.TIMEOUT.API,
            "更新用户信息超时"
          );
        } catch (e) {
          console.warn("[登录后] 更新IP/设备信息失败", e);
        }

        initSessionCheckListener();
        await loadInitialMessages();
        initMessageRealtime();
        await markOnline();
        await refreshOnlineCount();
        initOnlineRealtime();
        initConfigRealtime();
        initHeartbeat();
        await recordLoginLog();

        console.log("[登录后] 所有功能初始化完成");

      } catch (e) {
        console.warn("[登录后] 部分功能初始化失败", e);
        showNotify("warning", "部分功能加载失败：" + e.message);
      }
    }, 0);

  } catch (e) {
    console.error("[登录状态处理] 异常", e);
    showNotify("error", `登录异常：${e.message}`);
    clearAllResources();
    try {
      await AppState.sb.auth.signOut();
    } catch (e) {
      console.warn("[退出登录] 异常", e);
    }
    showPage("loginPage");
    closeLoader();
  } finally {
    AppState.locks.isAuthHandling = false;
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
      try {
        await AppState.sb.from("users")
          .update({ current_session_token: null })
          .eq("id", AppState.currentUser.id);
      } catch (e) {
        console.warn("[退出登录] 清空会话Token失败", e);
      }
      
      try {
        await AppState.sb.from("online_users")
          .delete()
          .eq("user_id", AppState.currentUser.id);
      } catch (e) {
        console.warn("[退出登录] 清理在线状态失败", e);
      }
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

// ====================== 聊天核心功能（修复重复加载 + 406错误） ======================
const loadInitialMessages = async () => {
  try {
    // 防重复加载锁
    if (AppState.isLoadingMessages) {
      console.warn("[消息] 正在加载中，跳过重复请求");
      return;
    }
    AppState.isLoadingMessages = true;

    console.log("[消息] 开始加载历史消息");
    const { data: msgList, error } = await withTimeout(
      AppState.sb.from("messages").select("*").order("id", { ascending: true }).limit(200),
      APP_CONFIG.TIMEOUT.API,
      "加载消息超时"
    );

    if (error) throw new Error("加载历史消息失败：" + error.message);
    renderMessages(msgList || []);
    console.log(`[消息] 历史消息加载完成，共${msgList?.length || 0}条`);
  } catch (e) {
    console.warn("[消息加载] 失败", e);
    showNotify("error", e.message);
  } finally {
    // 释放锁
    AppState.isLoadingMessages = false;
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
    showNotify("error", "消息渲染失败：" + e.message);
  }
};

const initMessageRealtime = () => {
  try {
    if (AppState.channels.msg) AppState.sb.removeChannel(AppState.channels.msg);
    AppState.channels.msg = AppState.sb.channel("message_channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, async () => {
        // 防抖：避免短时间内多次触发
        if (AppState.timers.msgDebounce) clearTimeout(AppState.timers.msgDebounce);
        AppState.timers.msgDebounce = setTimeout(() => {
          loadInitialMessages();
        }, 300);
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          console.error("[消息监听] 通道连接失败");
          showNotify("warning", "消息监听连接失败");
        }
      });
  } catch (e) {
    console.warn("[消息实时监听] 失败", e);
    showNotify("error", "消息监听初始化失败：" + e.message);
  }
};

const sendMessage = async () => {
  try {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      showNotify("error", "请先登录");
      return;
    }
    
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
      // 修复406错误：捕获system_config查询失败，降级处理
      const { data: config } = await AppState.sb.from("system_config")
        .select("sensitive_words")
        .single()
        .catch(() => ({ data: { sensitive_words: "" } })); // 失败时返回空敏感词
      const badWords = (config?.sensitive_words || "").split(",").filter(w => w.trim());
      badWords.forEach(word => {
        content = content.replaceAll(word, "***");
      });
    } catch (e) {
      console.warn("[敏感词过滤] 失败，跳过过滤", e);
    }

    const { error } = await AppState.sb.from("messages").insert([{
      user_id: AppState.currentUser.id,
      nick: AppState.userNick,
      text: content,
      time: new Date().toLocaleString()
    }]);

    if (error) throw new Error("发送消息失败：" + error.message);

    msgInput.value = "";
    showNotify("success", "消息发送成功");
    await loadInitialMessages();

  } catch (e) {
    console.error("[消息发送] 失败", e);
    showNotify("error", e.message);
  } finally {
    $("#sendBtn").disabled = false;
    $("#sendBtn").innerText = "发送";
  }
};

// ====================== 在线人数功能 ======================
const markOnline = async () => {
  try {
    if (!AppState.currentUser) return;
    await AppState.sb.from("online_users").upsert({
      user_id: AppState.currentUser.id,
      nick: AppState.userNick,
      last_active: new Date().toISOString()
    }, { onConflict: "user_id" });
  } catch (e) {
    console.warn("[在线状态] 标记失败", e);
  }
};

const refreshOnlineCount = async () => {
  try {
    const { data } = await AppState.sb.from("online_users").select("*");
    $("#onlineNum").innerText = data?.length || 0;
  } catch (e) {
    console.warn("[在线人数] 刷新失败", e);
  }
};

const initOnlineRealtime = () => {
  try {
    if (AppState.channels.online) AppState.sb.removeChannel(AppState.channels.online);
    AppState.channels.online = AppState.sb.channel("online_channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, async () => {
        await refreshOnlineCount();
      })
      .subscribe();
  } catch (e) {
    console.warn("[在线人数监听] 失败", e);
  }
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
  } catch (e) {
    console.warn("[配置监听] 失败", e);
  }
};

const loadAnnouncement = async () => {
  try {
    const { data } = await AppState.sb.from("system_config")
      .select("announcement")
      .single()
      .catch(() => ({ data: { announcement: "" } })); // 失败时返回空公告
    const announceBar = $("#announceBar");
    if (data?.announcement) {
      announceBar.innerText = data.announcement;
      announceBar.classList.remove("hidden");
    } else {
      announceBar.classList.add("hidden");
    }
  } catch (e) {
    console.warn("[公告加载] 失败", e);
  }
};

// ====================== 登录日志功能 ======================
const recordLoginLog = async () => {
  try {
    if (!AppState.currentUser) return;
    let ipData = { ip: "未知IP" };
    try {
      const res = await withTimeout(
        fetch("https://api.ipify.org?format=json"),
        3000,
        "IP查询超时"
      );
      ipData = await res.json();
    } catch (e) {
      console.warn("[IP查询] 失败", e);
    }
    
    await AppState.sb.from("login_logs").insert([{
      user_id: AppState.currentUser.id,
      ip: ipData.ip,
      device: navigator.userAgent.substring(0, 80),
      time: new Date().toLocaleString()
    }]);
  } catch (e) {
    console.warn("[登录日志] 记录失败", e);
  }
};

const showMyLoginLogs = async () => {
  try {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      showNotify("error", "请先登录");
      return;
    }
    showNotify("info", "正在加载登录日志...");
    const { data, error } = await AppState.sb.from("login_logs").select("*")
      .eq("user_id", AppState.currentUser.id)
      .order("time", { ascending: false })
      .limit(10);
    
    if (error) throw new Error("加载登录日志失败：" + error.message);
    
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
    console.error("[登录日志] 加载失败", e);
    showNotify("error", e.message);
  }
};

// ====================== 设置功能 ======================
const saveNickname = async () => {
  try {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      showNotify("error", "请先登录");
      return;
    }
    const newNick = $("#nickInput").value.trim();
    if (!newNick) {
      showNotify("error", "请输入有效的昵称");
      return;
    }
    const { error } = await AppState.sb.from("users").update({ nick: newNick }).eq("id", AppState.currentUser.id);
    if (error) throw new Error("保存昵称失败：" + error.message);
    AppState.userNick = newNick;
    SafeStorage.set("nick", newNick);
    $("#userTag").innerText = `用户：${newNick}`;
    $("#nickInput").value = "";
    showNotify("success", "昵称保存成功");
    await markOnline();
  } catch (e) {
    console.error("[设置] 保存昵称失败", e);
    showNotify("error", e.message);
  }
};

const updatePassword = async () => {
  try {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      showNotify("error", "请先登录");
      return;
    }
    const newPwd = $("#newPwdInput").value.trim();
    if (newPwd.length < 8) {
      showNotify("error", "密码长度不能少于8位");
      return;
    }
    const { error } = await AppState.sb.auth.updateUser({ password: newPwd });
    if (error) throw new Error("修改密码失败：" + error.message);
    showNotify("success", "密码修改成功，请重新登录");
    $("#newPwdInput").value = "";
    setTimeout(userLogout, 1500);
  } catch (e) {
    console.error("[设置] 修改密码失败", e);
    showNotify("error", e.message);
  }
};

// ====================== 管理员功能 ======================
const loadAdminData = async () => {
  if (!AppState.currentUser?.isAdmin) {
    showNotify("error", "你没有管理员权限");
    return;
  }
  try {
    showNotify("info", "正在加载管理数据...");
    
    const { data: config, error: configError } = await AppState.sb.from("system_config").select("*").single();
    if (configError) throw new Error("加载系统配置失败：" + configError.message);
    $("#requireVerifyToggle").checked = config?.require_verify || false;
    $("#sensitiveWordsInput").value = config?.sensitive_words || "";
    $("#announceInput").value = config?.announcement || "";

    const { data: verifyUsers } = await AppState.sb.from("users").select("*").eq("status", "pending");
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

    const { data: allUsers } = await AppState.sb.from("users").select("*").order("created_at", { ascending: false });
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
      .limit(20);
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
    console.error("[管理员] 加载数据失败", e);
    showNotify("error", e.message);
  }
};

const forceUserOffline = async (userId) => {
  if (!confirm("确定要强制该用户下线吗？")) return;
  try {
    const { error } = await AppState.sb.from("users").update({ current_session_token: null }).eq("id", userId);
    if (error) throw new Error("强制下线失败：" + error.message);
    showNotify("success", "用户已被强制下线");
    loadAdminData();
  } catch (e) {
    console.error("[管理员] 强制下线失败", e);
    showNotify("error", e.message);
  }
};

const verifyUser = async (userId, status) => {
  try {
    const { error } = await AppState.sb.from("users").update({ status }).eq("id", userId);
    if (error) throw new Error("操作失败：" + error.message);
    showNotify("success", status === "active" ? "用户审核通过" : "用户审核拒绝");
    loadAdminData();
  } catch (e) {
    console.error("[管理员] 审核用户失败", e);
    showNotify("error", e.message);
  }
};

const setUserMute = async (userId, isMute) => {
  try {
    const { error } = await AppState.sb.from("users").update({ is_mute: isMute }).eq("id", userId);
    if (error) throw new Error("操作失败：" + error.message);
    showNotify("success", isMute ? "已禁言该用户" : "已解禁该用户");
    loadAdminData();
  } catch (e) {
    console.error("[管理员] 设置禁言失败", e);
    showNotify("error", e.message);
  }
};

const setUserStatus = async (userId, status) => {
  try {
    const { error } = await AppState.sb.from("users").update({ status }).eq("id", userId);
    if (error) throw new Error("操作失败：" + error.message);
    showNotify("success", status === "active" ? "已解封该用户" : "已封禁该用户");
    loadAdminData();
  } catch (e) {
    console.error("[管理员] 设置用户状态失败", e);
    showNotify("error", e.message);
  }
};

const resetUserPwd = async (email) => {
  try {
    const { error } = await AppState.sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/chat`
    });
    if (error) throw new Error("重置失败：" + error.message);
    showNotify("success", "密码重置邮件已发送");
  } catch (e) {
    console.error("[管理员] 重置密码失败", e);
    showNotify("error", e.message);
  }
};

const saveSystemConfig = async () => {
  try {
    const requireVerify = $("#requireVerifyToggle").checked;
    const { data } = await AppState.sb.from("system_config").select("id").single();
    if (data) {
      await AppState.sb.from("system_config").update({ require_verify: requireVerify }).eq("id", data.id);
    } else {
      await AppState.sb.from("system_config").insert([{ require_verify: requireVerify }]);
    }
    showNotify("success", "系统配置保存成功");
  } catch (e) {
    console.error("[管理员] 保存系统配置失败", e);
    showNotify("error", e.message);
  }
};

const saveSensitiveWords = async () => {
  try {
    const words = $("#sensitiveWordsInput").value.trim();
    const { data } = await AppState.sb.from("system_config").select("id").single();
    if (data) {
      await AppState.sb.from("system_config").update({ sensitive_words: words }).eq("id", data.id);
    } else {
      await AppState.sb.from("system_config").insert([{ sensitive_words: words }]);
    }
    showNotify("success", "敏感词保存成功");
  } catch (e) {
    console.error("[管理员] 保存敏感词失败", e);
    showNotify("error", e.message);
  }
};

const saveAnnouncement = async () => {
  try {
    const content = $("#announceInput").value.trim();
    const { data } = await AppState.sb.from("system_config").select("id").single();
    if (data) {
      await AppState.sb.from("system_config").update({ announcement: content }).eq("id", data.id);
    } else {
      await AppState.sb.from("system_config").insert([{ announcement: content }]);
    }
    showNotify("success", "公告已推送");
  } catch (e) {
    console.error("[管理员] 保存公告失败", e);
    showNotify("error", e.message);
  }
};

const deleteMsg = async (msgId) => {
  try {
    const { error } = await AppState.sb.from("messages").delete().eq("id", msgId);
    if (error) throw new Error("删除失败：" + error.message);
    showNotify("success", "消息已删除");
    await loadInitialMessages();
  } catch (e) {
    console.error("[管理员] 删除消息失败", e);
    showNotify("error", e.message);
  }
};

const clearAllMessages = async () => {
  if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
  try {
    const { error } = await AppState.sb.from("messages").delete().neq("id", 0);
    if (error) throw new Error("清空失败：" + error.message);
    showNotify("success", "所有消息已清空");
    await loadInitialMessages();
  } catch (e) {
    console.error("[管理员] 清空消息失败", e);
    showNotify("error", e.message);
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
    showNotify("error", "事件绑定失败：" + e.message);
  }
};

const initApp = async () => {
  try {
    if (AppState.locks.isInit) return;
    AppState.locks.isInit = true;
    console.log("[应用初始化] 开始");

    AppState.timers.forceCloseLoader = setTimeout(() => {
      console.warn("[初始化] 超时，强制关闭加载页");
      closeLoader();
      clearAllResources();
      showPage("loginPage");
    }, 5000);

    initTheme();

    if (!window.supabase) {
      throw new Error("Supabase SDK加载失败，请刷新页面重试");
    }

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
        }
      }
    );

    bindAllEvents();

    const { data: { session } } = await AppState.sb.auth.getSession();
    if (session?.user) {
      console.log("[初始化] 检测到已有会话，尝试恢复");
      try {
        await AppState.sb.auth.signOut();
      } catch (e) {
        console.warn("[初始化] 退出旧会话失败", e);
      }
    }

    clearAllResources();
    showPage("loginPage");
    closeLoader();

    AppState.sb.auth.onAuthStateChange(handleAuthChange);

    console.log("[应用初始化] 完成");
    
  } catch (e) {
    console.error("[应用初始化] 致命错误", e);
    showNotify("error", `初始化失败：${e.message}`);
    closeLoader();
    clearAllResources();
    showPage("loginPage");
  }
};

// ====================== 页面生命周期监听 ======================
document.addEventListener("DOMContentLoaded", initApp);

window.addEventListener("beforeunload", async () => {
  try {
    if (AppState.currentUser && AppState.sb) {
      try {
        await AppState.sb.from("online_users").delete().eq("user_id", AppState.currentUser.id);
      } catch (e) {
        console.warn("[页面关闭] 清理在线状态失败", e);
      }
    }
  } catch (e) {}
});

document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && AppState.currentUser && AppState.isSessionInitialized) {
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
