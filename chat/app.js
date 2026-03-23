// ====================== 全局配置（统一管理，可直接调整） ======================
const CONFIG = {
  SUPABASE_URL: "https://ayavdkodhdmcxfufnnxo.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc",
  TIMEOUT: {
    LOGIN: 15000,       // 登录/注册超时15秒
    DB_QUERY: 10000,    // 数据库查询超时
    REALTIME: 10000     // 实时通道超时
  },
  HEARTBEAT_INTERVAL: 30000,  // 在线心跳间隔
  SESSION_CHECK_INTERVAL: 60000 // 会话校验间隔
};

// ====================== 全局状态管理（集中管理，避免状态混乱） ======================
const state = {
  sb: null,
  currentUser: null,
  userNick: localStorage.getItem("nick") || "",
  sessionToken: localStorage.getItem("chat_current_session_token") || "",
  isSessionInitialized: false,
  isLoggingIn: false,
  isLoggingOut: false,
  // 通道/定时器统一管理
  channels: {
    msg: null,
    online: null,
    config: null,
    sessionCheck: null
  },
  timers: {
    forceCloseLoader: null,
    heartbeat: null,
    sessionCheck: null
  }
};

// ====================== 安全DOM选择器 ======================
const $ = (selector) => {
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
};
const $$ = (selector) => document.querySelectorAll(s) || [];

// ====================== 核心工具函数（统一封装，无冗余） ======================
/**
 * 统一通知提示
 * @param {string} type success/error/warning/info
 * @param {string} text 提示内容
 */
const showNotify = (type, text) => {
  try {
    const notifyEl = $("#winNotify");
    notifyEl.className = `win-notify ${type}`;
    notifyEl.innerText = text;
    notifyEl.classList.remove("hidden");
    setTimeout(() => notifyEl.classList.add("hidden"), 6000);
  } catch (e) {
    console.error(`[通知异常] ${e.message}`);
  }
};

/**
 * 带超时的异步操作封装
 * @param {Promise} promise 异步操作
 * @param {number} timeout 超时时间(ms)
 * @param {string} errorMsg 超时提示
 * @returns {Promise}
 */
const withTimeout = (promise, timeout, errorMsg) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeout))
  ]);
};

/**
 * 重置所有按钮状态（兜底用）
 */
const resetAllButtons = () => {
  $("#loginBtn").disabled = false;
  $("#loginBtn").innerText = "登录";
  $("#regBtn").disabled = false;
  $("#regBtn").innerText = "注册";
  $("#sendBtn").disabled = false;
  $("#sendBtn").innerText = "发送";
  $("#logoutBtn").disabled = false;
  $("#logoutBtn").innerText = "退出登录";
  state.isLoggingIn = false;
  state.isLoggingOut = false;
};

/**
 * 清理所有资源（通道/定时器/状态）
 */
const clearAllResources = () => {
  try {
    console.log("[资源清理] 开始清理所有资源");
    // 清理所有定时器
    Object.values(state.timers).forEach(timer => {
      if (timer) clearTimeout(timer) || clearInterval(timer);
    });
    // 清理所有实时通道
    Object.values(state.channels).forEach(channel => {
      if (channel && state.sb) state.sb.removeChannel(channel);
    });
    // 重置所有状态
    state.currentUser = null;
    state.userNick = "";
    state.sessionToken = "";
    state.isSessionInitialized = false;
    state.isLoggingIn = false;
    state.isLoggingOut = false;
    // 重置通道/定时器对象
    state.channels = { msg: null, online: null, config: null, sessionCheck: null };
    state.timers = { forceCloseLoader: null, heartbeat: null, sessionCheck: null };
    // 清理本地存储
    localStorage.removeItem("chat_current_session_token");
    localStorage.removeItem("nick");
    // 重置按钮
    resetAllButtons();
    // 清理输入框
    $("#msgInput").value = "";
    $("#loginEmail").value = "";
    $("#loginPwd").value = "";
    console.log("[资源清理] 所有资源清理完成");
  } catch (e) {
    console.error(`[资源清理异常] ${e.message}`);
    resetAllButtons();
  }
};

/**
 * 生成唯一会话Token
 * @returns {string} UUID
 */
const generateSessionToken = () => crypto.randomUUID();

/**
 * 关闭启动加载页
 */
const closeLoader = () => {
  try {
    if (state.timers.forceCloseLoader) clearTimeout(state.timers.forceCloseLoader);
    const loader = $("#loadingPage");
    loader.style.opacity = 0;
    setTimeout(() => {
      loader.classList.add("hidden");
      loader.style.display = "none";
    }, 300);
  } catch (e) {
    console.error(`[关闭加载页异常] ${e.message}`);
    $("#loadingPage")?.remove();
  }
};

/**
 * 切换页面
 * @param {string} pageId 页面ID
 */
const showPage = (pageId) => {
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
    console.error(`[页面切换异常] ${e.message}`);
    showNotify("error", "页面切换失败，请刷新重试");
  }
};

// ====================== 主题系统 ======================
const initTheme = () => {
  try {
    const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const localDark = localStorage.getItem("theme") === "dark";
    const root = document.documentElement;
    const metaTheme = $('meta[name="theme-color"]');
    
    if (localDark || sysDark) {
      root.dataset.theme = "dark";
      $("#toggleThemeBtn").innerText = "切换浅色模式";
      metaTheme.content = "#0f0f0f";
    } else {
      $("#toggleThemeBtn").innerText = "切换深色模式";
      metaTheme.content = "#f3f3f3";
    }
  } catch (e) {
    console.error(`[主题初始化异常] ${e.message}`);
  }
};

const toggleTheme = () => {
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
};

// ====================== 核心修复：单设备登录会话逻辑 ======================
/**
 * 校验会话有效性
 * @returns {boolean} 会话是否有效
 */
const checkSessionValid = async () => {
  try {
    // 边界情况直接返回无效
    if (!state.currentUser || !state.sessionToken || !state.isSessionInitialized) {
      console.warn("[会话校验] 未登录或会话未初始化");
      return false;
    }

    console.log("[会话校验] 开始校验会话有效性");
    const { data, error } = await withTimeout(
      state.sb.from("users").select("current_session_token").eq("id", state.currentUser.id).single(),
      CONFIG.TIMEOUT.DB_QUERY,
      "会话校验请求超时"
    );

    if (error || !data) {
      console.error("[会话校验] 查询失败", error);
      return false;
    }

    const isValid = data.current_session_token === state.sessionToken;
    console.log(`[会话校验] 结果：${isValid ? "有效" : "无效"}`);
    return isValid;
  } catch (e) {
    console.error(`[会话校验异常] ${e.message}`);
    return false;
  }
};

/**
 * 处理会话失效（被踢出），100%完整执行，不会中途中断
 * @param {string} reason 失效原因
 */
const handleSessionInvalid = async (reason = "账号在其他设备登录，你已被安全下线") => {
  try {
    console.log("[会话失效] 开始处理下线流程，原因：", reason);
    showNotify("error", reason);
    
    // 1. 先锁定状态，禁止操作
    state.isSessionInitialized = false;
    state.currentUser = null;

    // 2. 清空数据库中的会话Token
    if (state.sb?.auth?.session()) {
      await state.sb.from("users")
        .update({ current_session_token: null })
        .eq("id", state.sb.auth.session().user.id)
        .catch(() => {});
    }

    // 3. 清理在线状态
    if (state.sb?.auth?.session()) {
      await state.sb.from("online_users")
        .delete()
        .eq("user_id", state.sb.auth.session().user.id)
        .catch(() => {});
    }

    // 4. 执行退出登录
    await state.sb.auth.signOut().catch(() => {});

    // 5. 清理所有资源
    clearAllResources();

    // 6. 强制跳回登录页
    showPage("loginPage");

    // 7. 强制刷新页面，彻底清理残留状态
    setTimeout(() => window.location.reload(), 800);

  } catch (e) {
    console.error(`[会话失效处理异常] ${e.message}`);
    // 终极兜底：强制跳转刷新
    clearAllResources();
    window.location.href = `${window.location.origin}/chat`;
  }
};

/**
 * 核心修复：初始化会话监听（只监听其他设备的会话更新，避免自己触发误判）
 */
const initSessionCheckListener = () => {
  try {
    if (!state.currentUser) return;
    console.log("[会话监听] 开始初始化单设备登录会话监听");

    // 先移除旧的通道，避免重复监听
    if (state.channels.sessionCheck) {
      state.sb.removeChannel(state.channels.sessionCheck);
      state.channels.sessionCheck = null;
    }

    state.channels.sessionCheck = state.sb.channel("session_check_channel")
      .on(
        "postgres_changes",
        { 
          event: "UPDATE", 
          schema: "public", 
          table: "users",
          filter: `id=eq.${state.currentUser.id}`
        },
        async (payload) => {
          console.log("[会话监听] 收到用户记录更新事件", payload);
          
          // 核心修复：延迟500ms校验，确保本地Token已同步，避免时序问题
          setTimeout(async () => {
            const isValid = await checkSessionValid();
            if (!isValid) {
              await handleSessionInvalid();
            }
          }, 500);
        }
      )
      .subscribe((status) => {
        console.log(`[会话监听] 通道状态：${status}`);
        if (status === "CHANNEL_ERROR") {
          console.error("[会话监听] 通道连接失败，10秒后重试");
          setTimeout(initSessionCheckListener, 10000);
        }
      });
    
    // 定时校验会话（兜底用）
    state.timers.sessionCheck = setInterval(async () => {
      if (state.currentUser && state.isSessionInitialized) {
        const isValid = await checkSessionValid();
        if (!isValid) {
          await handleSessionInvalid();
        }
      }
    }, CONFIG.SESSION_CHECK_INTERVAL);
    
  } catch (e) {
    console.error(`[会话监听初始化异常] ${e.message}`);
    setTimeout(initSessionCheckListener, 10000);
  }
};

// ====================== 核心修复：登录&注册逻辑 ======================
/**
 * 执行登录操作
 */
const doLogin = async () => {
  // 防重复提交
  if (state.isLoggingIn) {
    showNotify("warning", "正在登录中，请稍候...");
    return;
  }

  // 锁定登录状态
  state.isLoggingIn = true;
  $("#loginBtn").disabled = true;
  $("#loginBtn").innerText = "登录中...";

  try {
    // 基础校验
    const email = $("#loginEmail").value.trim();
    const pwd = $("#loginPwd").value.trim();
    if (!email || !pwd) {
      showNotify("error", "请填写邮箱和密码");
      return;
    }

    console.log(`[登录] 开始验证账号：${email}`);
    
    // 核心登录操作（15秒超时）
    const { data: authData, error: authError } = await withTimeout(
      state.sb.auth.signInWithPassword({ email, password: pwd }),
      CONFIG.TIMEOUT.LOGIN,
      "登录请求超时（15秒），请检查网络后重试"
    );

    // 处理登录错误
    if (authError) {
      let errMsg = authError.message;
      if (errMsg.includes("Email not confirmed")) errMsg = "邮箱未验证，请前往邮箱验证后再登录";
      if (errMsg.includes("Invalid login credentials")) errMsg = "邮箱或密码错误，请重新输入";
      if (errMsg.includes("User banned")) errMsg = "账号已被封禁，无法登录";
      throw new Error(errMsg);
    }

    if (!authData.user) throw new Error("登录失败，未获取到用户信息");
    
    showNotify("info", "登录成功，正在进入聊天...");
    console.log(`[登录] 账号验证成功：${email}`);

  } catch (e) {
    console.error(`[登录失败] ${e.message}`);
    showNotify("error", `登录失败：${e.message}`);
  } finally {
    // 绝对兜底：300ms后重置状态
    setTimeout(() => {
      state.isLoggingIn = false;
      $("#loginBtn").disabled = false;
      $("#loginBtn").innerText = "登录";
    }, 300);
  }
};

/**
 * 执行注册操作
 */
const doRegister = async () => {
  try {
    // 基础校验
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

    // 禁用按钮
    $("#regBtn").disabled = true;
    $("#regBtn").innerText = "注册中...";

    console.log(`[注册] 开始注册账号：${email}`);
    
    // 核心注册操作（15秒超时）
    const { error } = await withTimeout(
      state.sb.auth.signUp({
        email, password: pwd,
        options: { data: { nick } }
      }),
      CONFIG.TIMEOUT.LOGIN,
      "注册请求超时（15秒），请检查网络后重试"
    );

    // 处理注册错误
    if (error) {
      let errMsg = error.message;
      if (errMsg.includes("User already registered")) errMsg = "该邮箱已被注册，请直接登录";
      throw new Error(errMsg);
    }

    // 注册成功
    showNotify("success", "注册成功，请前往邮箱验证后登录");
    $("#regNick").value = "";
    $("#regEmail").value = "";
    $("#regPwd").value = "";
    showPage("loginPage");
    console.log(`[注册] 账号注册成功：${email}`);

  } catch (e) {
    console.error(`[注册失败] ${e.message}`);
    showNotify("error", `注册失败：${e.message}`);
  } finally {
    // 重置按钮
    $("#regBtn").disabled = false;
    $("#regBtn").innerText = "注册";
  }
};

// ====================== 核心修复：登录状态变更处理（时序完全正确） ======================
/**
 * 处理登录状态变更
 * @param {string} event 事件类型
 * @param {object} session 会话信息
 */
const handleAuthChange = async (event, session) => {
  try {
    console.log(`[登录状态变更] 事件：${event}，是否有会话：${!!session?.user}`);

    // 退出登录/无会话处理
    if (!session?.user) {
      clearAllResources();
      showPage("loginPage");
      return;
    }

    // 登录成功处理
    state.currentUser = session.user;

    // 核心修复：先清理旧的会话缓存，避免冲突
    localStorage.removeItem("chat_current_session_token");
    state.sessionToken = "";

    // 核心修复：时序完全正确！！！
    // 1. 先生成新的会话Token
    const newSessionToken = generateSessionToken();
    // 2. 先保存到本地状态和存储，确保本地先有新Token
    state.sessionToken = newSessionToken;
    localStorage.setItem("chat_current_session_token", newSessionToken);
    console.log("[登录] 新会话Token已保存到本地");

    // 3. 再更新到数据库（这时候本地已经有新Token，监听触发后校验不会误判）
    try {
      await state.sb.from("users").update({
        current_session_token: newSessionToken,
        last_login_time: new Date().toISOString()
      }).eq("id", state.currentUser.id);
      console.log("[登录] 会话Token已更新到数据库");
    } catch (e) {
      console.warn(`[登录] 会话Token更新失败（不影响登录）：${e.message}`);
    }

    // 4. 查询/验证用户信息
    let userInfo = null;
    try {
      const { data } = await state.sb.from("users").select("*").eq("id", state.currentUser.id).single();
      userInfo = data;
    } catch (e) {
      console.warn(`[登录] 查询用户信息失败，尝试创建：${e.message}`);
      // 新用户补创建
      await state.sb.from("users").insert([{
        id: state.currentUser.id,
        email: state.currentUser.email,
        nick: state.currentUser.user_metadata?.nick || `用户${state.currentUser.id.substring(0, 4)}`,
        status: "active"
      }]);
    }

    // 5. 账号状态校验
    if (userInfo?.status === "pending") {
      throw new Error("账号待管理员审核，暂无法登录");
    }
    if (userInfo?.status === "ban") {
      throw new Error("账号已被封禁，无法登录");
    }

    // 6. 立即跳转聊天页（核心优化：不阻塞）
    state.isSessionInitialized = true;
    showPage("chatPage");
    showNotify("success", "登录成功，欢迎使用在线聊天系统");
    closeLoader();

    // 7. 异步初始化非核心功能（完全不阻塞登录）
    setTimeout(async () => {
      try {
        // 补全用户信息
        const { data: finalUserInfo } = await state.sb.from("users").select("*").eq("id", state.currentUser.id).single();
        state.userNick = localStorage.getItem("nick") || finalUserInfo?.nick || "用户";
        $("#userTag").innerText = `用户：${state.userNick}`;
        state.currentUser.isAdmin = finalUserInfo?.is_admin || false;
        if (state.currentUser.isAdmin) $("#adminBtn").classList.remove("hidden");

        // 异步更新登录IP/设备（非核心，不阻塞）
        fetch("https://api.ipify.org?format=json")
          .then(res => res.json())
          .then(async (ipData) => {
            try {
              await state.sb.from("users").update({
                last_login_ip: ipData.ip || "未知IP",
                last_login_device: navigator.userAgent.substring(0, 100)
              }).eq("id", state.currentUser.id);
            } catch (e) {
              console.warn(`[登录] 更新IP/设备失败：${e.message}`);
            }
          })
          .catch(() => {});

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

      } catch (e) {
        console.warn(`[登录] 部分功能初始化失败（不影响聊天）：${e.message}`);
        showNotify("warning", "部分功能加载失败，不影响聊天使用");
      }
    }, 0);

  } catch (e) {
    console.error(`[登录状态处理异常] ${e.message}`);
    showNotify("error", `登录异常：${e.message}`);
    clearAllResources();
    await state.sb.auth.signOut().catch(() => {});
    showPage("loginPage");
  } finally {
    closeLoader();
    resetAllButtons();
  }
};

// ====================== 核心修复：退出登录逻辑（顺序完全正确，无报错） ======================
/**
 * 用户手动退出登录
 */
const userLogout = async () => {
  // 防重复提交
  if (state.isLoggingOut) {
    showNotify("warning", "正在退出中，请稍候...");
    return;
  }

  // 锁定退出状态
  state.isLoggingOut = true;
  $("#logoutBtn").disabled = true;
  $("#logoutBtn").innerText = "退出中...";

  try {
    showNotify("info", "正在安全退出登录...");
    console.log("[退出登录] 开始处理退出流程");

    // 核心修复：顺序完全正确！！！
    // 1. 先清空数据库中的会话Token（让其他设备的会话失效）
    if (state.currentUser) {
      await state.sb.from("users")
        .update({ current_session_token: null })
        .eq("id", state.currentUser.id)
        .catch(() => {});
      console.log("[退出登录] 数据库会话Token已清空");

      // 2. 清理在线状态
      await state.sb.from("online_users")
        .delete()
        .eq("user_id", state.currentUser.id)
        .catch(() => {});
      console.log("[退出登录] 在线状态已清理");
    }

    // 3. 执行Supabase退出登录
    await state.sb.auth.signOut();
    console.log("[退出登录] Supabase会话已注销");

    // 4. 清理所有本地资源
    clearAllResources();

    // 5. 跳回登录页
    showPage("loginPage");
    showNotify("success", "已安全退出登录");
    console.log("[退出登录] 退出流程完成");

  } catch (e) {
    console.error(`[退出登录异常] ${e.message}`);
    showNotify("error", `退出失败：${e.message}`);
    // 兜底：强制清理和跳转
    clearAllResources();
    showPage("loginPage");
  } finally {
    // 绝对兜底：重置按钮状态
    setTimeout(() => {
      state.isLoggingOut = false;
      $("#logoutBtn").disabled = false;
      $("#logoutBtn").innerText = "退出登录";
    }, 300);
  }
};

// ====================== 聊天核心功能 ======================
const loadInitialMessages = async () => {
  try {
    console.log("[消息] 开始加载历史消息");
    const { data: msgList } = await withTimeout(
      state.sb.from("messages").select("*").order("id", { ascending: true }).limit(200),
      CONFIG.TIMEOUT.DB_QUERY,
      "加载历史消息超时"
    );
    
    renderMessages(msgList || []);
    console.log(`[消息] 历史消息加载完成，共${msgList?.length || 0}条`);
  } catch (e) {
    console.error(`[消息] 加载历史消息异常：${e.message}`);
    showNotify("error", "历史消息加载失败");
  }
};

const renderMessages = (msgList) => {
  try {
    const msgBox = $("#msgBox");
    let html = "";
    
    msgList.forEach(msg => {
      const isMe = msg.user_id === state.currentUser.id;
      html += `
        <div class="msg-item ${isMe ? 'msg-me' : 'msg-other'}">
          <div class="avatar">${msg.nick.charAt(0)}</div>
          <div>
            <div class="msg-name">${msg.nick}</div>
            <div class="bubble">${msg.text}</div>
            <div class="msg-time">${msg.time}</div>
          </div>
          ${state.currentUser.isAdmin ? `<button class="win-btn small danger" onclick="deleteMsg(${msg.id})">删除</button>` : ''}
        </div>
      `;
    });
    
    msgBox.innerHTML = html;
    msgBox.scrollTop = msgBox.scrollHeight;
  } catch (e) {
    console.error(`[消息] 渲染异常：${e.message}`);
  }
};

const initMessageRealtime = () => {
  try {
    if (state.channels.msg) {
      state.sb.removeChannel(state.channels.msg);
      state.channels.msg = null;
    }

    state.channels.msg = state.sb.channel("message_channel", {
      config: { broadcast: { self: true } }
    })
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages" },
      async () => {
        console.log("[消息] 收到实时更新事件");
        await loadInitialMessages();
      }
    )
    .subscribe((status) => {
      console.log(`[消息] 实时通道状态：${status}`);
      if (status === "CHANNEL_ERROR") {
        console.error("[消息] 实时通道连接失败，10秒后重试");
        setTimeout(initMessageRealtime, 10000);
      }
    });
  } catch (e) {
    console.error(`[消息] 初始化实时监听异常：${e.message}`);
    setTimeout(initMessageRealtime, 10000);
  }
};

const sendMessage = async () => {
  try {
    // 校验会话
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    
    if (!state.currentUser) return;
    
    // 基础校验
    const msgInput = $("#msgInput");
    const text = msgInput.value.trim();
    if (!text) {
      showNotify("error", "不能发送空消息");
      return;
    }

    // 禁用按钮
    $("#sendBtn").disabled = true;
    $("#sendBtn").innerText = "发送中...";

    // 敏感词过滤
    let content = text;
    try {
      const { data: config } = await state.sb.from("system_config").select("sensitive_words").single();
      const badWords = (config?.sensitive_words || "").split(",").filter(w => w.trim());
      badWords.forEach(word => {
        content = content.replaceAll(word, "***");
      });
    } catch (e) {
      console.warn(`[消息] 敏感词过滤失败，发送原消息：${e.message}`);
    }

    // 发送消息
    await state.sb.from("messages").insert([{
      user_id: state.currentUser.id,
      nick: state.userNick,
      text: content,
      time: new Date().toLocaleString()
    }]);

    // 发送成功处理
    msgInput.value = "";
    showNotify("success", "消息发送成功");
    await loadInitialMessages();

  } catch (e) {
    console.error(`[消息] 发送失败：${e.message}`);
    showNotify("error", `发送失败：${e.message}`);
  } finally {
    // 重置按钮
    $("#sendBtn").disabled = false;
    $("#sendBtn").innerText = "发送";
  }
};

// ====================== 在线人数功能 ======================
const markOnline = async () => {
  try {
    await state.sb.from("online_users").upsert({
      user_id: state.currentUser.id,
      nick: state.userNick,
      last_active: new Date().toISOString()
    }, { onConflict: "user_id" });
    console.log("[在线状态] 标记成功");
  } catch (e) {
    console.warn(`[在线状态] 标记失败：${e.message}`);
  }
};

const refreshOnlineCount = async () => {
  try {
    const { data } = await state.sb.from("online_users").select("*");
    const count = data?.length || 0;
    $("#onlineNum").innerText = count;
    console.log(`[在线人数] 刷新为：${count}`);
  } catch (e) {
    console.error(`[在线人数] 刷新异常：${e.message}`);
  }
};

const initOnlineRealtime = () => {
  try {
    if (state.channels.online) {
      state.sb.removeChannel(state.channels.online);
      state.channels.online = null;
    }

    state.channels.online = state.sb.channel("online_channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "online_users" },
      async () => {
        console.log("[在线人数] 收到实时更新事件");
        await refreshOnlineCount();
      }
    )
    .subscribe((status) => {
      console.log(`[在线人数] 实时通道状态：${status}`);
      if (status === "CHANNEL_ERROR") {
        console.error("[在线人数] 实时通道连接失败，10秒后重试");
        setTimeout(initOnlineRealtime, 10000);
      }
    });
  } catch (e) {
    console.error(`[在线人数] 初始化实时监听异常：${e.message}`);
    setTimeout(initOnlineRealtime, 10000);
  }
};

const initHeartbeat = () => {
  state.timers.heartbeat = setInterval(async () => {
    if (state.currentUser && state.isSessionInitialized) {
      await markOnline();
    }
  }, CONFIG.HEARTBEAT_INTERVAL);
};

// ====================== 公告&配置功能 ======================
const initConfigRealtime = () => {
  try {
    if (state.channels.config) {
      state.sb.removeChannel(state.channels.config);
      state.channels.config = null;
    }

    state.channels.config = state.sb.channel("config_channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "system_config" },
      async () => {
        console.log("[配置] 收到实时更新事件");
        await loadAnnouncement();
      }
    )
    .subscribe();
  } catch (e) {
    console.error(`[配置] 初始化实时监听异常：${e.message}`);
  }
};

const loadAnnouncement = async () => {
  try {
    const { data } = await state.sb.from("system_config").select("announcement").single();
    const announceBar = $("#announceBar");
    if (data?.announcement) {
      announceBar.innerText = data.announcement;
      announceBar.classList.remove("hidden");
    } else {
      announceBar.classList.add("hidden");
    }
  } catch (e) {
    console.error(`[公告] 加载异常：${e.message}`);
  }
};

// ====================== 登录日志功能 ======================
const recordLoginLog = async () => {
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json").catch(() => ({ json: () => ({ ip: "未知IP" }) }));
    const ipData = await ipRes.json();
    
    await state.sb.from("login_logs").insert([{
      user_id: state.currentUser.id,
      ip: ipData.ip || "未知IP",
      device: navigator.userAgent.substring(0, 80),
      time: new Date().toLocaleString()
    }]);
    
    console.log("[登录日志] 记录成功");
  } catch (e) {
    console.warn(`[登录日志] 记录失败：${e.message}`);
  }
};

const showMyLoginLogs = async () => {
  try {
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    
    showNotify("info", "正在加载登录日志...");
    const { data } = await state.sb.from("login_logs").select("*")
      .eq("user_id", state.currentUser.id)
      .order("time", { ascending: false })
      .limit(10);
    
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
    console.error(`[登录日志] 加载失败：${e.message}`);
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
    
    await state.sb.from("users").update({ nick: newNick }).eq("id", state.currentUser.id);
    
    // 更新本地状态
    state.userNick = newNick;
    localStorage.setItem("nick", newNick);
    $("#userTag").innerText = `用户：${newNick}`;
    $("#nickInput").value = "";
    
    showNotify("success", "昵称保存成功");
    await markOnline();
    
  } catch (e) {
    console.error(`[设置] 保存昵称失败：${e.message}`);
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
    
    const { error } = await state.sb.auth.updateUser({ password: newPwd });
    if (error) throw new Error(error.message);
    
    showNotify("success", "密码修改成功，请重新登录");
    $("#newPwdInput").value = "";
    setTimeout(userLogout, 1500);
    
  } catch (e) {
    console.error(`[设置] 修改密码失败：${e.message}`);
    showNotify("error", `密码修改失败：${e.message}`);
  }
};

// ====================== 管理员功能（完整保留） ======================
const loadAdminData = async () => {
  if (!state.currentUser.isAdmin) {
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
    
    // 1. 加载系统配置
    const { data: config } = await state.sb.from("system_config").select("*").single();
    $("#requireVerifyToggle").checked = config?.require_verify || false;
    $("#sensitiveWordsInput").value = config?.sensitive_words || "";
    $("#announceInput").value = config?.announcement || "";

    // 2. 加载待审核用户
    const { data: verifyUsers } = await state.sb.from("users").select("*").eq("status", "pending");
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

    // 3. 加载所有用户
    const { data: allUsers } = await state.sb.from("users").select("*").order("created_at", { ascending: false });
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

    // 4. 加载登录日志
    const { data: allLogs } = await state.sb.from("login_logs").select("*, users!inner(email, nick)")
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
    console.error(`[管理员] 加载数据失败：${e.message}`);
    showNotify("error", "管理数据加载失败");
  }
};

const forceUserOffline = async (userId) => {
  if (!confirm("确定要强制该用户下线吗？")) return;
  try {
    await state.sb.from("users").update({ current_session_token: null }).eq("id", userId);
    showNotify("success", "用户已被强制下线");
    loadAdminData();
  } catch (e) {
    console.error(`[管理员] 强制下线失败：${e.message}`);
    showNotify("error", "强制下线失败");
  }
};

const verifyUser = async (userId, status) => {
  try {
    await state.sb.from("users").update({ status }).eq("id", userId);
    showNotify("success", status === "active" ? "用户审核通过" : "用户审核拒绝");
    loadAdminData();
  } catch (e) {
    console.error(`[管理员] 审核用户失败：${e.message}`);
    showNotify("error", "操作失败");
  }
};

const setUserMute = async (userId, isMute) => {
  try {
    await state.sb.from("users").update({ is_mute: isMute }).eq("id", userId);
    showNotify("success", isMute ? "已禁言该用户" : "已解禁该用户");
    loadAdminData();
  } catch (e) {
    console.error(`[管理员] 设置禁言失败：${e.message}`);
    showNotify("error", "操作失败");
  }
};

const setUserStatus = async (userId, status) => {
  try {
    await state.sb.from("users").update({ status }).eq("id", userId);
    showNotify("success", status === "active" ? "已解封该用户" : "已封禁该用户");
    loadAdminData();
  } catch (e) {
    console.error(`[管理员] 设置用户状态失败：${e.message}`);
    showNotify("error", "操作失败");
  }
};

const resetUserPwd = async (email) => {
  try {
    const { error } = await state.sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/chat`
    });
    if (error) throw new Error(error.message);
    showNotify("success", "密码重置邮件已发送");
  } catch (e) {
    console.error(`[管理员] 重置密码失败：${e.message}`);
    showNotify("error", `重置失败：${e.message}`);
  }
};

const saveSystemConfig = async () => {
  try {
    const requireVerify = $("#requireVerifyToggle").checked;
    const { data } = await state.sb.from("system_config").select("id").single();
    
    if (data) {
      await state.sb.from("system_config").update({ require_verify: requireVerify }).eq("id", data.id);
    } else {
      await state.sb.from("system_config").insert([{ require_verify: requireVerify }]);
    }
    
    showNotify("success", "系统配置保存成功");
    
  } catch (e) {
    console.error(`[管理员] 保存系统配置失败：${e.message}`);
    showNotify("error", "配置保存失败");
  }
};

const saveSensitiveWords = async () => {
  try {
    const words = $("#sensitiveWordsInput").value.trim();
    const { data } = await state.sb.from("system_config").select("id").single();
    
    if (data) {
      await state.sb.from("system_config").update({ sensitive_words: words }).eq("id", data.id);
    } else {
      await state.sb.from("system_config").insert([{ sensitive_words: words }]);
    }
    
    showNotify("success", "敏感词保存成功");
    
  } catch (e) {
    console.error(`[管理员] 保存敏感词失败：${e.message}`);
    showNotify("error", "保存失败");
  }
};

const saveAnnouncement = async () => {
  try {
    const content = $("#announceInput").value.trim();
    const { data } = await state.sb.from("system_config").select("id").single();
    
    if (data) {
      await state.sb.from("system_config").update({ announcement: content }).eq("id", data.id);
    } else {
      await state.sb.from("system_config").insert([{ announcement: content }]);
    }
    
    showNotify("success", "公告已推送");
    
  } catch (e) {
    console.error(`[管理员] 保存公告失败：${e.message}`);
    showNotify("error", "推送失败");
  }
};

const deleteMsg = async (msgId) => {
  try {
    await state.sb.from("messages").delete().eq("id", msgId);
    showNotify("success", "消息已删除");
    await loadInitialMessages();
  } catch (e) {
    console.error(`[管理员] 删除消息失败：${e.message}`);
    showNotify("error", "删除失败");
  }
};

const clearAllMessages = async () => {
  if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
  try {
    await state.sb.from("messages").delete().neq("id", 0);
    showNotify("success", "所有消息已清空");
    await loadInitialMessages();
  } catch (e) {
    console.error(`[管理员] 清空消息失败：${e.message}`);
    showNotify("error", "清空失败");
  }
};

// ====================== 事件绑定&页面初始化 ======================
const bindAllEvents = () => {
  // 页面切换
  $("#toRegisterBtn").addEventListener("click", () => showPage("registerPage"));
  $("#toLoginBtn").addEventListener("click", () => showPage("loginPage"));
  
  // 登录/注册
  $("#loginBtn").addEventListener("click", doLogin);
  $("#regBtn").addEventListener("click", doRegister);
  $("#loginPwd").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
  $("#regPwd").addEventListener("keydown", (e) => e.key === "Enter" && doRegister());
  
  // 聊天
  $("#sendBtn").addEventListener("click", sendMessage);
  $("#msgInput").addEventListener("keydown", (e) => e.key === "Enter" && sendMessage());
  
  // 页面导航
  $("#settingBtn").addEventListener("click", () => showPage("settingPage"));
  $("#adminBtn").addEventListener("click", () => { loadAdminData(); showPage("adminPage"); });
  $("#backToChatBtn").addEventListener("click", () => showPage("chatPage"));
  $("#backToChatFromAdminBtn").addEventListener("click", () => showPage("chatPage"));
  
  // 设置
  $("#saveNickBtn").addEventListener("click", saveNickname);
  $("#toggleThemeBtn").addEventListener("click", toggleTheme);
  $("#updatePwdBtn").addEventListener("click", updatePassword);
  $("#showLoginLogBtn").addEventListener("click", showMyLoginLogs);
  $("#logoutBtn").addEventListener("click", userLogout);
  
  // 管理员
  $("#saveConfigBtn").addEventListener("click", saveSystemConfig);
  $("#saveSwBtn").addEventListener("click", saveSensitiveWords);
  $("#saveAnnounceBtn").addEventListener("click", saveAnnouncement);
  $("#clearAllMsgBtn").addEventListener("click", clearAllMessages);
};

const initApp = async () => {
  try {
    // 强制关闭加载页兜底（3.5秒）
    state.timers.forceCloseLoader = setTimeout(() => {
      closeLoader();
      showPage("loginPage");
    }, 3500);

    // 初始化主题
    initTheme();

    // 初始化Supabase客户端
    state.sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
      auth: { 
        autoRefreshToken: true, 
        persistSession: true, 
        detectSessionInUrl: true 
      },
      realtime: { 
        timeout: CONFIG.TIMEOUT.REALTIME,
        heartbeatIntervalMs: CONFIG.HEARTBEAT_INTERVAL
      }
    });

    // 绑定事件
    bindAllEvents();

    // 监听登录状态变化
    state.sb.auth.onAuthStateChange(handleAuthChange);

    console.log("[初始化] 应用初始化完成");
    
  } catch (e) {
    console.error(`[初始化] 异常：${e.message}`);
    showNotify("error", "系统初始化失败，请刷新重试");
    closeLoader();
    showPage("loginPage");
  }
};

// ====================== 页面生命周期监听 ======================
// 页面加载完成初始化
document.addEventListener("DOMContentLoaded", initApp);

// 页面关闭前清理
window.addEventListener("beforeunload", async () => {
  try {
    if (state.currentUser) {
      await state.sb.from("online_users").delete().eq("user_id", state.currentUser.id);
    }
  } catch (e) {
    console.error(`[页面关闭] 清理异常：${e.message}`);
  }
});

// 页面可见性变化
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && state.currentUser && state.isSessionInitialized) {
    console.log("[页面] 切回前台，校验会话+刷新状态");
    const isValid = await checkSessionValid();
    if (!isValid) {
      await handleSessionInvalid();
      return;
    }
    await markOnline();
    await refreshOnlineCount();
    await loadInitialMessages();
  }
});

// 系统主题变化监听
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", initTheme);

// 暴露全局函数（供HTML调用）
window.deleteMsg = deleteMsg;
window.verifyUser = verifyUser;
window.setUserMute = setUserMute;
window.setUserStatus = setUserStatus;
window.resetUserPwd = resetUserPwd;
window.forceUserOffline = forceUserOffline;
