// ====================== 核心配置（冻结不可修改，避免意外篡改） ======================
const APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://ayavdkodhdmcxfufnnxo.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc",
  TIMEOUT: {
    LOGIN: 20000,
    API: 10000,
    REALTIME: 15000
  },
  INTERVAL: {
    HEARTBEAT: 30000,
    SESSION_CHECK: 60000,
    REALTIME_RECONNECT: 5000
  }
});

// ====================== 工具函数模块（纯函数，无副作用） ======================
const Utils = {
  // 安全本地存储
  SafeStorage: {
    get: (key) => {
      try {
        return localStorage.getItem(key) || "";
      } catch (e) {
        console.warn("[存储] 读取失败", key, e);
        return "";
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e) {
        console.warn("[存储] 写入失败", key, e);
        return false;
      }
    },
    remove: (key) => {
      try {
        localStorage.removeItem(key);
        return true;
      } catch (e) {
        console.warn("[存储] 删除失败", key, e);
        return false;
      }
    },
    clear: () => {
      try {
        localStorage.clear();
        return true;
      } catch (e) {
        console.warn("[存储] 清空失败", e);
        return false;
      }
    }
  },

  // DOM安全操作
  DOM: {
    $: (selector) => {
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
          style: { display: 'none' }
        };
      } catch (e) {
        console.warn("[DOM] 选择器失败", selector, e);
        return {
          addEventListener: () => {},
          innerText: '',
          innerHTML: '',
          value: '',
          disabled: false,
          checked: false,
          classList: { add: () => {}, remove: () => {} },
          style: { display: 'none' }
        };
      }
    },
    $$: (selector) => {
      try {
        return document.querySelectorAll(selector) || [];
      } catch (e) {
        console.warn("[DOM] 批量选择失败", selector, e);
        return [];
      }
    }
  },

  // XSS防护（所有用户输入渲染前必须经过此方法）
  escapeHtml: (text) => {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // 防抖函数（避免重复触发）
  debounce: (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // 生成唯一会话ID
  generateId: () => {
    try {
      return crypto.randomUUID();
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
  },

  // 带超时的Promise（避免无限等待）
  withTimeout: (promise, timeoutMs, errorMsg = "请求超时") => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))
    ]);
  },

  // 带重试的异步函数（弱网适配）
  retry: async (fn, maxRetries = 3, delay = 500) => {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        console.warn(`[重试] 第${i + 1}次失败，${delay}ms后重试`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  },

  // 邮箱格式校验
  isValidEmail: (email) => {
    const reg = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return reg.test(email);
  }
};

// ====================== 通知模块（统一消息提示） ======================
const Notify = {
  show: (type, text) => {
    try {
      const notifyEl = Utils.DOM.$("#winNotify");
      notifyEl.className = `win-notify ${type}`;
      notifyEl.innerText = text;
      notifyEl.classList.remove("hidden");
      setTimeout(() => notifyEl.classList.add("hidden"), 6000);
    } catch (e) {
      console.warn("[通知] 显示失败", e);
      alert(text);
    }
  },
  success: (text) => Notify.show('success', text),
  error: (text) => Notify.show('error', text),
  warning: (text) => Notify.show('warning', text),
  info: (text) => Notify.show('info', text)
};

// ====================== 全局状态管理（单例，统一状态控制） ======================
const AppState = {
  sb: null,
  currentUser: null,
  userNick: Utils.SafeStorage.get("nick"),
  sessionToken: Utils.SafeStorage.get("chat_current_session_token"),
  isSessionInitialized: false,
  isLoadingMessages: false,
  // 状态锁（防止并发执行）
  _locks: {
    isLoggingIn: false,
    isLoggingOut: false,
    isAuthHandling: false,
    isInit: false
  },
  channels: {},
  timers: {},

  // 加锁方法
  lock: (key) => {
    if (this._locks[key] !== undefined) {
      this._locks[key] = true;
    }
  },

  // 解锁方法
  unlock: (key) => {
    if (this._locks[key] !== undefined) {
      this._locks[key] = false;
    }
  },

  // 检查锁状态
  isLocked: (key) => {
    return this._locks[key] || false;
  },

  // 安全重置所有状态（无副作用，清理所有资源）
  reset: () => {
    try {
      console.log("[状态] 开始重置");
      // 清理所有定时器
      Object.values(this.timers).forEach(timer => {
        if (timer) clearTimeout(timer) || clearInterval(timer);
      });
      // 清理所有实时通道
      if (this.sb) {
        Object.values(this.channels).forEach(channel => {
          if (channel) {
            try {
              this.sb.removeChannel(channel);
            } catch (e) {}
          }
        });
      }
      
      // 隐藏管理员按钮
      const adminBtn = Utils.DOM.$("#adminBtn");
      adminBtn.style.display = "none";
      adminBtn.classList.add("hidden");
      
      // 重置核心状态
      this.currentUser = null;
      this.userNick = "";
      this.sessionToken = "";
      this.isSessionInitialized = false;
      this.isLoadingMessages = false;
      this.channels = {};
      this.timers = {};
      
      // 清理本地存储
      Utils.SafeStorage.remove("chat_current_session_token");
      Utils.SafeStorage.remove("nick");
      
      // 重置所有按钮
      Utils.DOM.$("#loginBtn").disabled = false;
      Utils.DOM.$("#loginBtn").innerText = "登录";
      Utils.DOM.$("#regBtn").disabled = false;
      Utils.DOM.$("#regBtn").innerText = "注册";
      Utils.DOM.$("#sendBtn").disabled = false;
      Utils.DOM.$("#sendBtn").innerText = "发送";
      Utils.DOM.$("#logoutBtn").disabled = false;
      Utils.DOM.$("#logoutBtn").innerText = "退出登录";
      
      // 解锁所有状态锁
      Object.keys(this._locks).forEach(key => this.unlock(key));
      
      // 清空输入框
      Utils.DOM.$("#msgInput").value = "";
      Utils.DOM.$("#loginEmail").value = "";
      Utils.DOM.$("#loginPwd").value = "";
      
      console.log("[状态] 重置完成");
    } catch (e) {
      console.warn("[状态] 重置异常", e);
    }
  }
};

// ====================== 管理员按钮模块 ======================
const AdminBtn = {
  // 强制显示管理员按钮（三重保险，兼容所有浏览器）
  forceShow: () => {
    try {
      const adminBtn = Utils.DOM.$("#adminBtn");
      if (!AppState.currentUser?.isAdmin) {
        adminBtn.style.display = "none";
        adminBtn.classList.add("hidden");
        return false;
      }
      adminBtn.classList.remove("hidden");
      adminBtn.style.display = "inline-block";
      adminBtn.style.visibility = "visible";
      adminBtn.style.opacity = "1";
      return true;
    } catch (e) {
      console.warn("[管理员按钮] 显示异常", e);
      return false;
    }
  },

  // 重试显示（确保DOM渲染完成后一定显示）
  retryShow: () => {
    let retryCount = 0;
    const retryTimer = setInterval(() => {
      retryCount++;
      const isShowed = AdminBtn.forceShow();
      if (isShowed || retryCount >= 10) {
        clearInterval(retryTimer);
      }
    }, 100);
  }
};

// ====================== 页面模块 ======================
const Page = {
  // 关闭加载页
  closeLoader: () => {
    try {
      if (AppState.timers.forceCloseLoader) clearTimeout(AppState.timers.forceCloseLoader);
      const loader = Utils.DOM.$("#loadingPage");
      loader.style.opacity = 0;
      setTimeout(() => {
        loader.classList.add("hidden");
        loader.style.display = "none";
      }, 300);
    } catch (e) {
      console.warn("[加载页] 关闭失败", e);
      Utils.DOM.$("#loadingPage")?.remove();
    }
  },

  // 页面切换
  show: (pageId) => {
    try {
      const needLogin = ["chatPage", "settingPage", "adminPage"].includes(pageId);
      if (needLogin && !AppState.isSessionInitialized) {
        console.warn("[页面] 未登录，禁止访问", pageId);
        AppState.reset();
        Page.show("loginPage");
        Page.closeLoader();
        return;
      }

      if (pageId === "adminPage" && !AppState.currentUser?.isAdmin) {
        Notify.error("你没有管理员权限");
        return;
      }

      // 隐藏所有页面
      Utils.DOM.$$(".page").forEach(page => {
        page.classList.remove("active");
        page.classList.add("hidden");
      });
      // 显示目标页面
      const targetPage = Utils.DOM.$(`#${pageId}`);
      targetPage.classList.remove("hidden");
      targetPage.classList.add("active");
      targetPage.scrollTop = 0;
      console.log("[页面] 切换成功", pageId);

      // 聊天页强制显示管理员按钮
      if (pageId === "chatPage") {
        AdminBtn.retryShow();
      }

    } catch (e) {
      console.error("[页面] 切换失败", e);
      Notify.error("页面切换失败：" + e.message);
    }
  }
};

// ====================== 主题模块 ======================
const Theme = {
  init: () => {
    try {
      const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const localDark = Utils.SafeStorage.get("theme") === "dark";
      const root = document.documentElement;
      
      if (localDark || sysDark) {
        root.dataset.theme = "dark";
        Utils.DOM.$("#toggleThemeBtn").innerText = "切换浅色模式";
      } else {
        Utils.DOM.$("#toggleThemeBtn").innerText = "切换深色模式";
      }
    } catch (e) {
      console.warn("[主题] 初始化失败", e);
    }
  },

  toggle: () => {
    try {
      const root = document.documentElement;
      const isDark = root.dataset.theme === "dark";
      
      if (isDark) {
        root.dataset.theme = "";
        Utils.SafeStorage.remove("theme");
        Utils.DOM.$("#toggleThemeBtn").innerText = "切换深色模式";
      } else {
        root.dataset.theme = "dark";
        Utils.SafeStorage.set("theme", "dark");
        Utils.DOM.$("#toggleThemeBtn").innerText = "切换浅色模式";
      }
    } catch (e) {
      Notify.error("主题切换失败");
    }
  }
};

// ====================== 会话模块（单设备登录控制） ======================
const Session = {
  // 会话失效处理
  handleInvalid: async (reason = "账号在其他设备登录，已为你安全下线") => {
    try {
      Notify.error(reason);
      AppState.isSessionInitialized = false;
      if (AppState.sb) {
        try {
          await AppState.sb.auth.signOut();
        } catch (e) {
          console.warn("[会话] 退出登录异常", e);
        }
      }
      AppState.reset();
      Utils.SafeStorage.clear();
      Page.show("loginPage");
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      console.warn("[会话] 失效处理异常", e);
      AppState.reset();
      Utils.SafeStorage.clear();
      window.location.href = `${window.location.origin}/chat`;
    }
  },

  // 初始化会话监听
  initCheckListener: () => {
    try {
      if (!AppState.currentUser) return;
      if (AppState.channels.sessionCheck) {
        try {
          AppState.sb.removeChannel(AppState.channels.sessionCheck);
        } catch (e) {}
      }

      AppState.channels.sessionCheck = AppState.sb.channel("session_check")
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "users", filter: `id=eq.${AppState.currentUser.id}` },
          async (payload) => {
            console.log("[会话] 收到用户记录更新事件");
            const newToken = payload.new?.current_session_token;
            if (newToken && newToken !== AppState.sessionToken) {
              console.warn("[会话] 检测到其他设备登录，触发下线");
              await Session.handleInvalid();
            }
          }
        )
        .subscribe((status) => {
          console.log(`[会话] 通道状态：${status}`);
          if (status === "CHANNEL_ERROR") {
            console.error("[会话] 通道连接失败，10秒后重试");
            setTimeout(Session.initCheckListener, APP_CONFIG.INTERVAL.REALTIME_RECONNECT);
          }
        });

      // 定时会话校验
      AppState.timers.sessionCheck = setInterval(async () => {
        if (AppState.currentUser && AppState.isSessionInitialized) {
          try {
            const { data } = await Utils.withTimeout(
              AppState.sb.from("users").select("current_session_token").eq("id", AppState.currentUser.id).single(),
              APP_CONFIG.TIMEOUT.API,
              "会话校验超时"
            );
            const isValid = data?.current_session_token === AppState.sessionToken;
            if (!isValid) await Session.handleInvalid();
          } catch (e) {
            console.warn("[会话] 定时校验失败", e);
          }
        }
      }, APP_CONFIG.INTERVAL.SESSION_CHECK);

    } catch (e) {
      console.warn("[会话] 监听初始化失败", e);
    }
  }
};

// ====================== 认证模块（彻底重构，核心修复登录逻辑） ======================
const Auth = {
  // 登录函数：只负责发起登录请求，不处理后续逻辑，无重复提示
  login: async () => {
    if (AppState.isLocked("isLoggingIn")) {
      Notify.warning("正在登录中，请稍候...");
      return;
    }

    AppState.lock("isLoggingIn");
    const loginBtn = Utils.DOM.$("#loginBtn");
    loginBtn.disabled = true;
    loginBtn.innerText = "登录中...";

    try {
      const email = Utils.DOM.$("#loginEmail").value.trim();
      const pwd = Utils.DOM.$("#loginPwd").value.trim();
      
      // 输入校验
      if (!email || !pwd) {
        Notify.error("请填写邮箱和密码");
        return;
      }
      if (!Utils.isValidEmail(email)) {
        Notify.error("请输入正确的邮箱格式");
        return;
      }

      console.log("[认证] 开始验证账号");
      // 只发起登录请求，后续逻辑全在onAuthStateChange里处理
      const { error: authError } = await Utils.withTimeout(
        AppState.sb.auth.signInWithPassword({ email, password: pwd }),
        APP_CONFIG.TIMEOUT.LOGIN,
        "登录请求超时（20秒），请检查网络后重试"
      );

      // 登录失败直接抛出错误，成功的话会自动触发onAuthStateChange
      if (authError) {
        let errMsg = authError.message;
        if (errMsg.includes("Email not confirmed")) errMsg = "邮箱未验证，请验证后登录";
        if (errMsg.includes("Invalid login credentials")) errMsg = "邮箱或密码错误";
        if (errMsg.includes("banned")) errMsg = "账号已被封禁";
        throw new Error(errMsg);
      }

    } catch (e) {
      console.error("[认证] 登录失败", e.message);
      Notify.error(`登录失败：${e.message}`);
    } finally {
      setTimeout(() => {
        AppState.unlock("isLoggingIn");
        loginBtn.disabled = false;
        loginBtn.innerText = "登录";
      }, 300);
    }
  },

  // 注册函数
  register: async () => {
    try {
      const nick = Utils.DOM.$("#regNick").value.trim();
      const email = Utils.DOM.$("#regEmail").value.trim();
      const pwd = Utils.DOM.$("#regPwd").value.trim();
      
      // 输入校验
      if (!nick || !email || !pwd) {
        Notify.error("请填写完整注册信息");
        return;
      }
      if (!Utils.isValidEmail(email)) {
        Notify.error("请输入正确的邮箱格式");
        return;
      }
      if (pwd.length < 8) {
        Notify.error("密码长度不能少于8位");
        return;
      }

      const regBtn = Utils.DOM.$("#regBtn");
      regBtn.disabled = true;
      regBtn.innerText = "注册中...";

      const { error } = await Utils.withTimeout(
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

      Notify.success("注册成功，请前往邮箱验证后登录");
      Utils.DOM.$("#regNick").value = "";
      Utils.DOM.$("#regEmail").value = "";
      Utils.DOM.$("#regPwd").value = "";
      Page.show("loginPage");

    } catch (e) {
      console.error("[认证] 注册失败", e.message);
      Notify.error(`注册失败：${e.message}`);
    } finally {
      const regBtn = Utils.DOM.$("#regBtn");
      regBtn.disabled = false;
      regBtn.innerText = "注册";
    }
  },

  // 核心：登录状态处理（唯一处理登录后逻辑的地方，无冲突，无竞态）
  handleChange: async (event, session) => {
    if (AppState.isLocked("isAuthHandling")) {
      console.log("[认证] 正在处理中，跳过重复触发");
      return;
    }

    try {
      AppState.lock("isAuthHandling");
      console.log("[认证] 事件：", event);

      // 退出登录事件处理
      if (event === "SIGNED_OUT") {
        console.log("[认证] 检测到退出登录");
        AppState.reset();
        Page.show("loginPage");
        Page.closeLoader();
        return;
      }

      // 只处理有效登录事件
      const validEvents = ["SIGNED_IN", "INITIAL_SESSION"];
      if (!validEvents.includes(event)) {
        console.log("[认证] 非有效登录事件，跳过处理");
        return;
      }

      // 校验会话有效性
      if (!session?.user) {
        console.warn("[认证] 无有效会话");
        AppState.reset();
        Page.show("loginPage");
        Page.closeLoader();
        return;
      }

      console.log("[认证] 开始初始化用户会话");
      Notify.info("账号验证成功，正在进入聊天...");

      // ====================== 核心修复：用户信息兜底自动创建 ======================
      let userInfo = null;
      // 1. 先尝试查询用户信息（2次重试）
      await Utils.retry(async () => {
        const { data, error } = await Utils.withTimeout(
          AppState.sb.from("users").select("*").eq("id", session.user.id).single(),
          APP_CONFIG.TIMEOUT.API,
          "用户信息查询超时"
        );
        if (error && error.code !== "PGRST116") throw error; // PGRST116是查询无结果，不是错误
        userInfo = data;
      }, 2, 300);

      // 2. 如果用户信息不存在，自动创建（兜底，彻底解决账号不存在问题）
      if (!userInfo) {
        console.warn("[认证] 业务表无用户记录，自动创建");
        const { data: newUser, error: createError } = await Utils.withTimeout(
          AppState.sb.from("users").insert([{
            id: session.user.id,
            nick: session.user.user_metadata?.nick || session.user.email.split('@')[0],
            email: session.user.email,
            is_admin: false,
            status: 'active',
            created_at: new Date().toISOString()
          }]).select().single(),
          APP_CONFIG.TIMEOUT.API,
          "用户信息创建失败"
        );

        if (createError) throw new Error("用户信息初始化失败，请刷新重试");
        userInfo = newUser;
        console.log("[认证] 用户信息自动创建成功");
      }

      // 3. 校验账号状态
      if (userInfo.status === "ban") {
        throw new Error("账号已被封禁，无法登录");
      }

      // ====================== 初始化用户状态 ======================
      AppState.currentUser = session.user;
      AppState.currentUser.isAdmin = 
        userInfo.is_admin === true || 
        userInfo.is_admin === 'true' || 
        userInfo.is_admin === 1;
      AppState.userNick = Utils.SafeStorage.get("nick") || userInfo.nick || "用户";
      Utils.SafeStorage.set("nick", AppState.userNick);

      console.log("[认证] 用户信息初始化完成", {
        email: session.user.email,
        isAdmin: AppState.currentUser.isAdmin
      });

      // ====================== 初始化会话Token ======================
      Utils.SafeStorage.remove("chat_current_session_token");
      const newSessionToken = Utils.generateId();
      AppState.sessionToken = newSessionToken;
      Utils.SafeStorage.set("chat_current_session_token", newSessionToken);

      console.log("[认证] 更新会话Token到数据库");
      await Utils.withTimeout(
        AppState.sb.from("users").update({
          current_session_token: newSessionToken,
          last_login_time: new Date().toISOString()
        }).eq("id", AppState.currentUser.id),
        APP_CONFIG.TIMEOUT.API,
        "更新会话Token超时"
      );

      // ====================== 会话初始化完成 ======================
      AppState.isSessionInitialized = true;

      // 唯一的登录成功提示，时机完全正确
      Notify.success("登录成功，欢迎使用");
      if (AppState.currentUser.isAdmin) {
        Notify.success("管理员账号登录成功！");
      }

      // 跳转页面
      Page.show("chatPage");
      Page.closeLoader();
      Utils.DOM.$("#userTag").innerText = `用户：${AppState.userNick}`;

      // 显示管理员按钮
      AdminBtn.retryShow();

      // 异步初始化其他功能（不阻塞主流程）
      setTimeout(async () => {
        try {
          console.log("[认证] 开始初始化附属功能");
          
          Session.initCheckListener();
          await Chat.loadInitialMessages();
          Chat.initRealtime();
          await Online.mark();
          await Online.refreshCount();
          Online.initRealtime();
          Config.initRealtime();
          Heartbeat.init();
          await LoginLog.record();

          console.log("[认证] 所有功能初始化完成");
        } catch (e) {
          console.warn("[认证] 部分功能初始化失败", e);
          Notify.warning("部分功能加载失败，不影响聊天使用");
        }
      }, 0);

    } catch (e) {
      // 登录流程失败，统一处理
      console.error("[认证] 会话初始化异常", e);
      Notify.error(`登录异常：${e.message}`);
      AppState.reset();
      // 强制退出登录，避免状态混乱
      try {
        await AppState.sb.auth.signOut();
      } catch (e) {
        console.warn("[认证] 退出登录异常", e);
      }
      Page.show("loginPage");
      Page.closeLoader();
    } finally {
      AppState.unlock("isAuthHandling");
    }
  },

  // 退出登录函数
  logout: async () => {
    if (AppState.isLocked("isLoggingOut")) {
      Notify.warning("正在退出中，请稍候...");
      return;
    }

    AppState.lock("isLoggingOut");
    const logoutBtn = Utils.DOM.$("#logoutBtn");
    logoutBtn.disabled = true;
    logoutBtn.innerText = "退出中...";

    try {
      Notify.info("正在安全退出...");
      console.log("[认证] 开始退出登录");

      if (AppState.currentUser) {
        // 清空会话Token
        try {
          await AppState.sb.from("users")
            .update({ current_session_token: null })
            .eq("id", AppState.currentUser.id);
        } catch (e) {
          console.warn("[认证] 清空会话Token失败", e);
        }
        // 清理在线状态
        try {
          await AppState.sb.from("online_users")
            .delete()
            .eq("user_id", AppState.currentUser.id);
        } catch (e) {
          console.warn("[认证] 清理在线状态失败", e);
        }
      }

      // 执行退出登录
      await AppState.sb.auth.signOut();
      AppState.reset();
      Utils.SafeStorage.clear();
      Page.show("loginPage");
      Notify.success("已安全退出登录");
      console.log("[认证] 退出登录完成");

    } catch (e) {
      console.error("[认证] 退出登录异常", e);
      Notify.error(`退出失败：${e.message}`);
      AppState.reset();
      Utils.SafeStorage.clear();
      Page.show("loginPage");
    } finally {
      setTimeout(() => {
        AppState.unlock("isLoggingOut");
        logoutBtn.disabled = false;
        logoutBtn.innerText = "退出登录";
      }, 300);
    }
  }
};

// ====================== 聊天模块 ======================
const Chat = {
  // 加载历史消息
  loadInitialMessages: async () => {
    try {
      if (AppState.isLoadingMessages) {
        console.warn("[聊天] 正在加载中，跳过重复请求");
        return;
      }
      AppState.isLoadingMessages = true;

      console.log("[聊天] 开始加载历史消息");
      const { data: msgList, error } = await Utils.withTimeout(
        AppState.sb.from("messages").select("*").order("id", { ascending: true }).limit(200),
        APP_CONFIG.TIMEOUT.API,
        "加载消息超时"
      );

      if (error) throw new Error("加载历史消息失败：" + error.message);
      Chat.renderMessages(msgList || []);
      console.log(`[聊天] 历史消息加载完成，共${msgList?.length || 0}条`);
    } catch (e) {
      console.warn("[聊天] 加载失败", e);
      Notify.error(e.message);
    } finally {
      AppState.isLoadingMessages = false;
    }
  },

  // 渲染消息
  renderMessages: (msgList) => {
    try {
      const msgBox = Utils.DOM.$("#msgBox");
      let html = "";
      msgList.forEach(msg => {
        const isMe = msg.user_id === AppState.currentUser.id;
        // XSS防护
        const safeNick = Utils.escapeHtml(msg.nick);
        const safeText = Utils.escapeHtml(msg.text);
        const safeTime = Utils.escapeHtml(msg.time);
        
        html += `
          <div class="msg-item ${isMe ? 'msg-me' : 'msg-other'}">
            <div class="avatar">${safeNick.charAt(0)}</div>
            <div>
              <div class="msg-name">${safeNick}</div>
              <div class="bubble">${safeText}</div>
              <div class="msg-time">${safeTime}</div>
            </div>
            ${AppState.currentUser.isAdmin ? `<button class="win-btn small danger" onclick="Admin.deleteMsg(${msg.id})">删除</button>` : ''}
          </div>
        `;
      });
      msgBox.innerHTML = html;
      msgBox.scrollTop = msgBox.scrollHeight;
    } catch (e) {
      console.warn("[聊天] 渲染失败", e);
      Notify.error("消息渲染失败");
    }
  },

  // 初始化消息实时监听
  initRealtime: () => {
    try {
      if (AppState.channels.msg) {
        try {
          AppState.sb.removeChannel(AppState.channels.msg);
        } catch (e) {}
      }
      
      AppState.channels.msg = AppState.sb.channel("message_channel")
        .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, Utils.debounce(async () => {
          await Chat.loadInitialMessages();
        }, 300))
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR") {
            console.error("[聊天] 通道连接失败，5秒后重试");
            setTimeout(Chat.initRealtime, APP_CONFIG.INTERVAL.REALTIME_RECONNECT);
          }
        });
    } catch (e) {
      console.warn("[聊天] 实时监听初始化失败", e);
    }
  },

  // 发送消息
  send: async () => {
    try {
      if (!AppState.currentUser || !AppState.isSessionInitialized) {
        Notify.error("请先登录");
        return;
      }
      
      const msgInput = Utils.DOM.$("#msgInput");
      const text = msgInput.value.trim();
      if (!text) {
        Notify.error("不能发送空消息");
        return;
      }

      const sendBtn = Utils.DOM.$("#sendBtn");
      sendBtn.disabled = true;
      sendBtn.innerText = "发送中...";

      // 敏感词过滤
      let content = text;
      try {
        const { data: config } = await AppState.sb.from("system_config")
          .select("sensitive_words")
          .single()
          .catch(() => ({ data: { sensitive_words: "" } }));
        const badWords = (config?.sensitive_words || "").split(",").filter(w => w.trim());
        badWords.forEach(word => {
          content = content.replaceAll(word, "***");
        });
      } catch (e) {
        console.warn("[聊天] 敏感词过滤失败", e);
      }

      // 发送消息
      const { error } = await AppState.sb.from("messages").insert([{
        user_id: AppState.currentUser.id,
        nick: AppState.userNick,
        text: content,
        time: new Date().toLocaleString()
      }]);

      if (error) throw new Error("发送消息失败：" + error.message);

      msgInput.value = "";
      Notify.success("消息发送成功");
      await Chat.loadInitialMessages();

    } catch (e) {
      console.error("[聊天] 发送失败", e);
      Notify.error(e.message);
    } finally {
      const sendBtn = Utils.DOM.$("#sendBtn");
      sendBtn.disabled = false;
      sendBtn.innerText = "发送";
    }
  }
};

// ====================== 在线用户模块 ======================
const Online = {
  // 标记在线状态
  mark: async () => {
    try {
      if (!AppState.currentUser) return;
      await AppState.sb.from("online_users").upsert({
        user_id: AppState.currentUser.id,
        nick: AppState.userNick,
        last_active: new Date().toISOString()
      }, { onConflict: "user_id" });
    } catch (e) {
      console.warn("[在线] 标记失败", e);
    }
  },

  // 刷新在线人数
  refreshCount: async () => {
    try {
      const { data } = await AppState.sb.from("online_users").select("*");
      Utils.DOM.$("#onlineNum").innerText = data?.length || 0;
    } catch (e) {
      console.warn("[在线] 刷新失败", e);
    }
  },

  // 初始化在线状态实时监听
  initRealtime: () => {
    try {
      if (AppState.channels.online) {
        try {
          AppState.sb.removeChannel(AppState.channels.online);
        } catch (e) {}
      }
      
      AppState.channels.online = AppState.sb.channel("online_channel")
        .on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, async () => {
          await Online.refreshCount();
        })
        .subscribe();
    } catch (e) {
      console.warn("[在线] 监听初始化失败", e);
    }
  }
};

// ====================== 心跳模块 ======================
const Heartbeat = {
  init: () => {
    AppState.timers.heartbeat = setInterval(async () => {
      if (AppState.currentUser && AppState.isSessionInitialized) {
        await Online.mark();
      }
    }, APP_CONFIG.INTERVAL.HEARTBEAT);
  }
};

// ====================== 系统配置模块 ======================
const Config = {
  // 初始化配置实时监听
  initRealtime: () => {
    try {
      if (AppState.channels.config) {
        try {
          AppState.sb.removeChannel(AppState.channels.config);
        } catch (e) {}
      }
      
      AppState.channels.config = AppState.sb.channel("config_channel")
        .on("postgres_changes", { event: "*", schema: "public", table: "system_config" }, async () => {
          await Config.loadAnnouncement();
        })
        .subscribe();
    } catch (e) {
      console.warn("[配置] 监听初始化失败", e);
    }
  },

  // 加载公告
  loadAnnouncement: async () => {
    try {
      const { data } = await AppState.sb.from("system_config")
        .select("announcement")
        .single()
        .catch(() => ({ data: { announcement: "" } }));
      const announceBar = Utils.DOM.$("#announceBar");
      if (data?.announcement) {
        announceBar.innerText = data.announcement;
        announceBar.classList.remove("hidden");
      } else {
        announceBar.classList.add("hidden");
      }
    } catch (e) {
      console.warn("[配置] 公告加载失败", e);
    }
  }
};

// ====================== 登录日志模块 ======================
const LoginLog = {
  // 记录登录日志
  record: async () => {
    try {
      if (!AppState.currentUser) return;
      // 不请求外网IP，避免国内网络连接报错
      const ipData = { ip: "未知IP" };
      
      await AppState.sb.from("login_logs").insert([{
        user_id: AppState.currentUser.id,
        ip: ipData.ip,
        device: navigator.userAgent.substring(0, 80),
        time: new Date().toLocaleString()
      }]);
    } catch (e) {
      console.warn("[登录日志] 记录失败", e);
    }
  },

  // 显示我的登录日志
  showMy: async () => {
    try {
      if (!AppState.currentUser || !AppState.isSessionInitialized) {
        Notify.error("请先登录");
        return;
      }
      Notify.info("正在加载登录日志...");
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
        logText += `${index + 1}. IP：${Utils.escapeHtml(log.ip)}\n   时间：${Utils.escapeHtml(log.time)}\n   设备：${Utils.escapeHtml(log.device)}\n\n`;
      });
      alert(logText);
    } catch (e) {
      console.error("[登录日志] 加载失败", e);
      Notify.error(e.message);
    }
  }
};

// ====================== 设置模块 ======================
const Settings = {
  // 保存昵称
  saveNickname: async () => {
    try {
      if (!AppState.currentUser || !AppState.isSessionInitialized) {
        Notify.error("请先登录");
        return;
      }
      const newNick = Utils.DOM.$("#nickInput").value.trim();
      if (!newNick) {
        Notify.error("请输入有效的昵称");
        return;
      }
      const { error } = await AppState.sb.from("users").update({ nick: newNick }).eq("id", AppState.currentUser.id);
      if (error) throw new Error("保存昵称失败：" + error.message);
      AppState.userNick = newNick;
      Utils.SafeStorage.set("nick", newNick);
      Utils.DOM.$("#userTag").innerText = `用户：${newNick}`;
      Utils.DOM.$("#nickInput").value = "";
      Notify.success("昵称保存成功");
      await Online.mark();
    } catch (e) {
      console.error("[设置] 保存昵称失败", e);
      Notify.error(e.message);
    }
  },

  // 修改密码
  updatePassword: async () => {
    try {
      if (!AppState.currentUser || !AppState.isSessionInitialized) {
        Notify.error("请先登录");
        return;
      }
      const newPwd = Utils.DOM.$("#newPwdInput").value.trim();
      if (newPwd.length < 8) {
        Notify.error("密码长度不能少于8位");
        return;
      }
      const { error } = await AppState.sb.auth.updateUser({ password: newPwd });
      if (error) throw new Error("修改密码失败：" + error.message);
      Notify.success("密码修改成功，请重新登录");
      Utils.DOM.$("#newPwdInput").value = "";
      setTimeout(Auth.logout, 1500);
    } catch (e) {
      console.error("[设置] 修改密码失败", e);
      Notify.error(e.message);
    }
  }
};

// ====================== 管理员模块 ======================
const Admin = {
  // 加载管理数据
  loadData: async () => {
    if (!AppState.currentUser?.isAdmin) {
      Notify.error("你没有管理员权限");
      return;
    }
    try {
      Notify.info("正在加载管理数据...");
      
      // 加载系统配置
      let config = { require_verify: false, sensitive_words: "", announcement: "" };
      try {
        const { data: configData } = await Utils.withTimeout(
          AppState.sb.from("system_config").select("*").single(),
          APP_CONFIG.TIMEOUT.API,
          "系统配置查询超时"
        );
        if (configData) config = configData;
      } catch (e) {
        console.warn("[管理员] 加载系统配置失败", e);
      }

      Utils.DOM.$("#requireVerifyToggle").checked = config.require_verify || false;
      Utils.DOM.$("#sensitiveWordsInput").value = config.sensitive_words || "";
      Utils.DOM.$("#announceInput").value = config.announcement || "";

      // 加载待审核用户
      let verifyUsers = [];
      try {
        const { data: verifyData } = await Utils.withTimeout(
          AppState.sb.from("users").select("*").eq("status", "pending"),
          APP_CONFIG.TIMEOUT.API,
          "待审核用户查询超时"
        );
        verifyUsers = verifyData || [];
      } catch (e) {
        console.warn("[管理员] 加载待审核用户失败", e);
      }

      let verifyHtml = "";
      verifyUsers.forEach(user => {
        verifyHtml += `
          <div class="list-item">
            <span>${Utils.escapeHtml(user.email)}（${Utils.escapeHtml(user.nick)}）</span>
            <div class="btn-group">
              <button class="win-btn small primary" onclick="Admin.verifyUser('${user.id}', 'active')">通过</button>
              <button class="win-btn small danger" onclick="Admin.verifyUser('${user.id}', 'ban')">拒绝</button>
            </div>
          </div>
        `;
      });
      Utils.DOM.$("#verifyUserList").innerHTML = verifyHtml || "暂无待审核用户";

      // 加载所有用户
      let allUsers = [];
      try {
        const { data: userData } = await Utils.withTimeout(
          AppState.sb.from("users").select("*").order("created_at", { ascending: false }),
          APP_CONFIG.TIMEOUT.API,
          "用户列表查询超时"
        );
        allUsers = userData || [];
      } catch (e) {
        console.warn("[管理员] 加载用户列表失败", e);
      }

      let userHtml = "";
      allUsers.forEach(user => {
        const statusText = user.status === "active" ? "正常" : user.status === "ban" ? "封禁" : "待审核";
        const muteText = user.is_mute ? "解禁" : "禁言";
        const isOnline = user.current_session_token ? "在线" : "离线";
        userHtml += `
          <div class="list-item">
            <span>${Utils.escapeHtml(user.email)}（${Utils.escapeHtml(user.nick)} | ${statusText} | ${isOnline}）</span>
            <div class="btn-group">
              <button class="win-btn small secondary" onclick="Admin.resetUserPwd('${Utils.escapeHtml(user.email)}')">重置密码</button>
              <button class="win-btn small warning" onclick="Admin.setUserMute('${user.id}', ${!user.is_mute})">${muteText}</button>
              <button class="win-btn small ${user.status === 'ban' ? 'primary' : 'danger'}" onclick="Admin.setUserStatus('${user.id}', '${user.status === 'ban' ? 'active' : 'ban'}')">
                ${user.status === 'ban' ? '解封' : '封禁'}
              </button>
              <button class="win-btn small danger" onclick="Admin.forceUserOffline('${user.id}')">强制下线</button>
            </div>
          </div>
        `;
      });
      Utils.DOM.$("#allUserList").innerHTML = userHtml;

      // 加载登录日志
      let allLogs = [];
      try {
        const { data: logData } = await Utils.withTimeout(
          AppState.sb.from("login_logs").select("*, users!inner(email, nick)")
            .order("time", { ascending: false })
            .limit(20),
          APP_CONFIG.TIMEOUT.API,
          "登录日志查询超时"
        );
        allLogs = logData || [];
      } catch (e) {
        console.warn("[管理员] 加载登录日志失败", e);
      }

      let logHtml = "";
      allLogs.forEach(log => {
        logHtml += `
          <div class="list-item">
            <span>${Utils.escapeHtml(log.users?.email || '未知用户')}（${Utils.escapeHtml(log.users?.nick || '未知')}）| IP：${Utils.escapeHtml(log.ip)} | ${Utils.escapeHtml(log.time)}</span>
          </div>
        `;
      });
      Utils.DOM.$("#allLoginLogList").innerHTML = logHtml || "暂无登录日志";

      Notify.success("管理数据加载完成");

    } catch (e) {
      console.error("[管理员] 加载数据失败", e);
      Notify.error("管理数据加载失败：" + e.message);
    }
  },

  // 强制用户下线
  forceUserOffline: async (userId) => {
    if (!confirm("确定要强制该用户下线吗？")) return;
    try {
      const { error } = await AppState.sb.from("users").update({ current_session_token: null }).eq("id", userId);
      if (error) throw new Error("强制下线失败：" + error.message);
      Notify.success("用户已被强制下线");
      Admin.loadData();
    } catch (e) {
      console.error("[管理员] 强制下线失败", e);
      Notify.error(e.message);
    }
  },

  // 审核用户
  verifyUser: async (userId, status) => {
    try {
      const { error } = await AppState.sb.from("users").update({ status }).eq("id", userId);
      if (error) throw new Error("操作失败：" + error.message);
      Notify.success(status === "active" ? "用户审核通过" : "用户审核拒绝");
      Admin.loadData();
    } catch (e) {
      console.error("[管理员] 审核用户失败", e);
      Notify.error(e.message);
    }
  },

  // 设置用户禁言
  setUserMute: async (userId, isMute) => {
    try {
      const { error } = await AppState.sb.from("users").update({ is_mute: isMute }).eq("id", userId);
      if (error) throw new Error("操作失败：" + error.message);
      Notify.success(isMute ? "已禁言该用户" : "已解禁该用户");
      Admin.loadData();
    } catch (e) {
      console.error("[管理员] 设置禁言失败", e);
      Notify.error(e.message);
    }
  },

  // 设置用户状态
  setUserStatus: async (userId, status) => {
    try {
      const { error } = await AppState.sb.from("users").update({ status }).eq("id", userId);
      if (error) throw new Error("操作失败：" + error.message);
      Notify.success(status === "active" ? "已解封该用户" : "已封禁该用户");
      Admin.loadData();
    } catch (e) {
      console.error("[管理员] 设置用户状态失败", e);
      Notify.error(e.message);
    }
  },

  // 重置用户密码
  resetUserPwd: async (email) => {
    try {
      const { error } = await AppState.sb.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/chat`
      });
      if (error) throw new Error("重置失败：" + error.message);
      Notify.success("密码重置邮件已发送");
    } catch (e) {
      console.error("[管理员] 重置密码失败", e);
      Notify.error(e.message);
    }
  },

  // 保存系统配置
  saveSystemConfig: async () => {
    try {
      const requireVerify = Utils.DOM.$("#requireVerifyToggle").checked;
      const { data } = await AppState.sb.from("system_config").select("id").single().catch(() => ({ data: null }));
      if (data) {
        await AppState.sb.from("system_config").update({ require_verify: requireVerify }).eq("id", data.id);
      } else {
        await AppState.sb.from("system_config").insert([{ require_verify: requireVerify }]);
      }
      Notify.success("系统配置保存成功");
    } catch (e) {
      console.error("[管理员] 保存系统配置失败", e);
      Notify.error(e.message);
    }
  },

  // 保存敏感词
  saveSensitiveWords: async () => {
    try {
      const words = Utils.DOM.$("#sensitiveWordsInput").value.trim();
      const { data } = await AppState.sb.from("system_config").select("id").single().catch(() => ({ data: null }));
      if (data) {
        await AppState.sb.from("system_config").update({ sensitive_words: words }).eq("id", data.id);
      } else {
        await AppState.sb.from("system_config").insert([{ sensitive_words: words }]);
      }
      Notify.success("敏感词保存成功");
    } catch (e) {
      console.error("[管理员] 保存敏感词失败", e);
      Notify.error(e.message);
    }
  },

  // 保存公告
  saveAnnouncement: async () => {
    try {
      const content = Utils.DOM.$("#announceInput").value.trim();
      const { data } = await AppState.sb.from("system_config").select("id").single().catch(() => ({ data: null }));
      if (data) {
        await AppState.sb.from("system_config").update({ announcement: content }).eq("id", data.id);
      } else {
        await AppState.sb.from("system_config").insert([{ announcement: content }]);
      }
      Notify.success("公告已推送");
    } catch (e) {
      console.error("[管理员] 保存公告失败", e);
      Notify.error(e.message);
    }
  },

  // 删除消息
  deleteMsg: async (msgId) => {
    try {
      const { error } = await AppState.sb.from("messages").delete().eq("id", msgId);
      if (error) throw new Error("删除失败：" + error.message);
      Notify.success("消息已删除");
      await Chat.loadInitialMessages();
    } catch (e) {
      console.error("[管理员] 删除消息失败", e);
      Notify.error(e.message);
    }
  },

  // 清空所有消息
  clearAllMessages: async () => {
    if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
    try {
      const { error } = await AppState.sb.from("messages").delete().neq("id", 0);
      if (error) throw new Error("清空失败：" + error.message);
      Notify.success("所有消息已清空");
      await Chat.loadInitialMessages();
    } catch (e) {
      console.error("[管理员] 清空消息失败", e);
      Notify.error(e.message);
    }
  }
};

// ====================== 事件绑定模块 ======================
const EventBinder = {
  init: () => {
    try {
      // 认证事件
      Utils.DOM.$("#toRegisterBtn").addEventListener("click", () => Page.show("registerPage"));
      Utils.DOM.$("#toLoginBtn").addEventListener("click", () => Page.show("loginPage"));
      Utils.DOM.$("#loginBtn").addEventListener("click", Auth.login);
      Utils.DOM.$("#regBtn").addEventListener("click", Auth.register);
      Utils.DOM.$("#loginPwd").addEventListener("keydown", (e) => e.key === "Enter" && Auth.login());
      Utils.DOM.$("#regPwd").addEventListener("keydown", (e) => e.key === "Enter" && Auth.register());
      Utils.DOM.$("#logoutBtn").addEventListener("click", Auth.logout);

      // 聊天事件
      Utils.DOM.$("#sendBtn").addEventListener("click", Chat.send);
      Utils.DOM.$("#msgInput").addEventListener("keydown", (e) => e.key === "Enter" && Chat.send());

      // 导航事件
      Utils.DOM.$("#settingBtn").addEventListener("click", () => Page.show("settingPage"));
      Utils.DOM.$("#adminBtn").addEventListener("click", () => { Admin.loadData(); Page.show("adminPage"); });
      Utils.DOM.$("#backToChatBtn").addEventListener("click", () => Page.show("chatPage"));
      Utils.DOM.$("#backToChatFromAdminBtn").addEventListener("click", () => Page.show("chatPage"));

      // 设置事件
      Utils.DOM.$("#saveNickBtn").addEventListener("click", Settings.saveNickname);
      Utils.DOM.$("#toggleThemeBtn").addEventListener("click", Theme.toggle);
      Utils.DOM.$("#updatePwdBtn").addEventListener("click", Settings.updatePassword);
      Utils.DOM.$("#showLoginLogBtn").addEventListener("click", LoginLog.showMy);

      // 管理员事件
      Utils.DOM.$("#saveConfigBtn").addEventListener("click", Admin.saveSystemConfig);
      Utils.DOM.$("#saveSwBtn").addEventListener("click", Admin.saveSensitiveWords);
      Utils.DOM.$("#saveAnnounceBtn").addEventListener("click", Admin.saveAnnouncement);
      Utils.DOM.$("#clearAllMsgBtn").addEventListener("click", Admin.clearAllMessages);

      console.log("[事件] 所有事件绑定完成");
    } catch (e) {
      console.error("[事件] 绑定失败", e);
      Notify.error("页面初始化失败，请刷新重试");
    }
  }
};

// ====================== 应用初始化模块 ======================
const App = {
  init: async () => {
    try {
      if (AppState.isLocked("isInit")) return;
      AppState.lock("isInit");
      console.log("[应用] 开始初始化");

      // 超时强制关闭加载页
      AppState.timers.forceCloseLoader = setTimeout(() => {
        console.warn("[应用] 初始化超时，强制关闭加载页");
        Page.closeLoader();
        AppState.reset();
        Page.show("loginPage");
      }, 5000);

      // 初始化主题
      Theme.init();

      // 检查Supabase SDK
      if (!window.supabase) {
        throw new Error("Supabase SDK加载失败，请刷新页面重试");
      }

      // 创建Supabase客户端
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

      // 绑定所有事件
      EventBinder.init();

      // 清理旧会话（避免刷新页面后残留会话导致状态混乱）
      const { data: { session } } = await AppState.sb.auth.getSession();
      if (session?.user) {
        console.log("[应用] 检测到已有会话，清理旧状态");
        try {
          await AppState.sb.auth.signOut();
        } catch (e) {
          console.warn("[应用] 退出旧会话失败", e);
        }
      }

      // 重置状态，显示登录页
      AppState.reset();
      Page.show("loginPage");
      Page.closeLoader();

      // 监听认证状态变化（唯一入口）
      AppState.sb.auth.onAuthStateChange(Auth.handleChange);

      console.log("[应用] 初始化完成");
      
    } catch (e) {
      console.error("[应用] 初始化致命错误", e);
      Notify.error(`初始化失败：${e.message}`);
      Page.closeLoader();
      AppState.reset();
      Page.show("loginPage");
    } finally {
      AppState.unlock("isInit");
    }
  }
};

// ====================== 页面生命周期监听 ======================
// DOM加载完成后初始化应用
document.addEventListener("DOMContentLoaded", App.init);

// 页面关闭前清理资源
window.addEventListener("beforeunload", async () => {
  try {
    if (AppState.currentUser && AppState.sb) {
      try {
        await AppState.sb.from("online_users").delete().eq("user_id", AppState.currentUser.id);
      } catch (e) {
        console.warn("[页面] 关闭前清理在线状态失败", e);
      }
    }
  } catch (e) {}
});

// 页面可见性变化时更新状态
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && AppState.currentUser && AppState.isSessionInitialized) {
    await Online.mark();
    await Online.refreshCount();
    AdminBtn.retryShow();
  }
});

// 系统主题变化时更新主题
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", Theme.init);

// 暴露全局函数（供HTML内联onclick调用）
window.Admin = Admin;
