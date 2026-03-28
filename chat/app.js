// ====================== 核心配置（不可修改） ======================
const APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://ayavdkodhdmcxfufnnxo.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc",
  TIMEOUT: { LOGIN: 20000, API: 10000, REALTIME: 15000 },
  INTERVAL: { HEARTBEAT: 30000, SESSION_CHECK: 60000, REALTIME_RECONNECT_BASE: 1000 },
  MAX_RECONNECT: 10,
});

// ====================== 工具函数 ======================
const Utils = {
  SafeStorage: {
    _isSupported: function() {
      try {
        const testKey = "__storage_test__";
        window.localStorage.setItem(testKey, testKey);
        window.localStorage.removeItem(testKey);
        return true;
      } catch {
        return false;
      }
    }(),
    get: function(key) {
      if (!this._isSupported) return "";
      try {
        return window.localStorage.getItem(key) || "";
      } catch {
        return "";
      }
    },
    set: function(key, value) {
      if (!this._isSupported) return false;
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    remove: function(key) {
      if (!this._isSupported) return false;
      try {
        window.localStorage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
    clear: function() {
      if (!this._isSupported) return false;
      try {
        window.localStorage.clear();
        return true;
      } catch {
        return false;
      }
    }
  },

  DOM: {
    $: function(selector) {
      try {
        const el = document.querySelector(selector);
        return el || {
          addEventListener: () => {},
          removeEventListener: () => {},
          innerText: '',
          innerHTML: '',
          value: '',
          disabled: false,
          checked: false,
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          style: { display: 'none', opacity: '' }
        };
      } catch {
        return {
          addEventListener: () => {},
          removeEventListener: () => {},
          innerText: '',
          innerHTML: '',
          value: '',
          disabled: false,
          checked: false,
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          style: { display: 'none', opacity: '' }
        };
      }
    },
    $$: function(selector) {
      try {
        return document.querySelectorAll(selector) || [];
      } catch {
        return [];
      }
    }
  },

  escapeHtml: function(text) {
    if (text == null || text === '') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  debounce: function(func, wait) {
    let timeout = null;
    const debounced = function(...args) {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timeout = null;
        func.apply(this, args);
      }, wait);
    };
    debounced.cancel = () => { if (timeout) clearTimeout(timeout); };
    return debounced;
  },

  generateId: function() {
    try {
      return window.crypto.randomUUID();
    } catch {
      return Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
    }
  },

  withTimeout: function(promise, timeoutMs, errorMsg = "请求超时") {
    let timeout = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(errorMsg)), timeoutMs);
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  },

  retry: async function(fn, maxRetries = 2, baseDelay = 300) {
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const delay = baseDelay * Math.pow(2, i);
        console.warn(`[重试] 第${i + 1}次失败`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  },

  isValidEmail: function(email) {
    if (!email) return false;
    const reg = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return reg.test(email.trim());
  }
};

// ====================== 通知模块 ======================
const Notify = {
  _timeout: null,
  show: function(type, text) {
    try {
      if (this._timeout) clearTimeout(this._timeout);
      const notifyEl = Utils.DOM.$("#winNotify");
      notifyEl.className = `win-notify ${type}`;
      notifyEl.innerText = text;
      notifyEl.classList.remove("hidden");
      this._timeout = setTimeout(() => {
        notifyEl.classList.add("hidden");
        this._timeout = null;
      }, 6000);
    } catch {
      alert(text);
    }
  },
  success: (text) => Notify.show('success', text),
  error: (text) => Notify.show('error', text),
  warning: (text) => Notify.show('warning', text),
  info: (text) => Notify.show('info', text)
};

// ====================== 全局状态管理 ======================
const AppState = {
  sb: null,
  currentUser: null,
  userNick: Utils.SafeStorage.get("nick"),
  sessionToken: Utils.SafeStorage.get("chat_current_session_token"),
  isSessionInitialized: false,
  isLoadingMessages: false,
  _locks: {
    isLoggingIn: false,
    isLoggingOut: false,
    isAuthHandling: false,
    isInit: false
  },
  channels: Object.create(null),
  timers: Object.create(null),
  _reconnectCount: Object.create(null),

  lock: function(key) {
    if (this._locks.hasOwnProperty(key)) {
      this._locks[key] = true;
    }
  },

  unlock: function(key) {
    if (this._locks.hasOwnProperty(key)) {
      this._locks[key] = false;
    }
  },

  isLocked: function(key) {
    return this._locks[key] || false;
  },

  resetReconnect: function(channelName) {
    this._reconnectCount[channelName] = 0;
  },

  getReconnectDelay: function(channelName) {
    const count = this._reconnectCount[channelName] || 0;
    this._reconnectCount[channelName] = count + 1;
    if (count >= APP_CONFIG.MAX_RECONNECT) return null;
    return APP_CONFIG.INTERVAL.REALTIME_RECONNECT_BASE * Math.pow(2, count);
  },

  reset: function() {
    try {
      console.log("[状态] 开始全量重置");
      Object.values(this.timers).forEach(timer => {
        if (timer) clearTimeout(timer) || clearInterval(timer);
      });
      if (this.sb) {
        Object.values(this.channels).forEach(channel => {
          if (channel) {
            try {
              this.sb.removeChannel(channel);
            } catch {}
          }
        });
      }
      
      const adminBtn = Utils.DOM.$("#adminBtn");
      adminBtn.style.display = "none";
      adminBtn.classList.add("hidden");
      
      this.currentUser = null;
      this.userNick = "";
      this.sessionToken = "";
      this.isSessionInitialized = false;
      this.isLoadingMessages = false;
      this.channels = Object.create(null);
      this.timers = Object.create(null);
      this._reconnectCount = Object.create(null);
      
      Utils.SafeStorage.remove("chat_current_session_token");
      Utils.SafeStorage.remove("nick");
      
      ["loginBtn", "regBtn", "sendBtn", "logoutBtn"].forEach(id => {
        const btn = Utils.DOM.$(`#${id}`);
        btn.disabled = false;
        btn.innerText = id === "loginBtn" ? "登录" : id === "regBtn" ? "注册" : id === "sendBtn" ? "发送" : "退出登录";
      });
      
      Object.keys(this._locks).forEach(key => this.unlock(key));
      
      ["msgInput", "loginEmail", "loginPwd", "regNick", "regEmail", "regPwd", "nickInput", "newPwdInput"].forEach(id => {
        Utils.DOM.$(`#${id}`).value = "";
      });
      
      console.log("[状态] 全量重置完成");
    } catch (e) {
      console.warn("[状态] 重置异常", e);
    }
  }
};

// ====================== UI模块 ======================
const UI = {
  closeLoader: function() {
    try {
      if (AppState.timers.forceCloseLoader) {
        clearTimeout(AppState.timers.forceCloseLoader);
        AppState.timers.forceCloseLoader = null;
      }
      const loader = Utils.DOM.$("#loadingPage");
      loader.style.opacity = 0;
      setTimeout(() => {
        loader.classList.add("hidden");
        loader.style.display = "none";
      }, 300);
    } catch {
      Utils.DOM.$("#loadingPage")?.remove();
    }
  },

  showPage: function(pageId) {
    try {
      const needLogin = ["chatPage", "settingPage", "adminPage"].includes(pageId);
      if (needLogin && !AppState.isSessionInitialized) {
        console.warn("[页面] 未登录，禁止访问", pageId);
        AppState.reset();
        this.showPage("loginPage");
        this.closeLoader();
        return;
      }
      if (pageId === "adminPage" && !AppState.currentUser?.isAdmin) {
        Notify.error("你没有管理员权限");
        return;
      }

      Utils.DOM.$$(".page").forEach(page => {
        page.classList.remove("active");
        page.classList.add("hidden");
      });
      const target = Utils.DOM.$(`#${pageId}`);
      target.classList.remove("hidden");
      target.classList.add("active");
      target.scrollTop = 0;
      console.log("[页面] 切换成功", pageId);

      if (pageId === "chatPage") {
        setTimeout(() => this.showAdminBtn(), 50);
      }
    } catch (e) {
      Notify.error("页面切换失败：" + e.message);
    }
  },

  showAdminBtn: function() {
    try {
      const btn = Utils.DOM.$("#adminBtn");
      if (!AppState.currentUser?.isAdmin) {
        btn.style.display = "none";
        btn.classList.add("hidden");
        return false;
      }
      btn.classList.remove("hidden");
      btn.style.display = "inline-block";
      btn.style.visibility = "visible";
      btn.style.opacity = "1";
      return true;
    } catch {
      return false;
    }
  },

  initTheme: function() {
    try {
      const isDark = Utils.SafeStorage.get("theme") === "dark" || window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = isDark ? "dark" : "";
      Utils.DOM.$("#toggleThemeBtn").innerText = isDark ? "切换浅色模式" : "切换深色模式";
    } catch {}
  },

  toggleTheme: function() {
    try {
      const root = document.documentElement;
      const isDark = root.dataset.theme === "dark";
      root.dataset.theme = isDark ? "" : "dark";
      isDark ? Utils.SafeStorage.remove("theme") : Utils.SafeStorage.set("theme", "dark");
      Utils.DOM.$("#toggleThemeBtn").innerText = isDark ? "切换深色模式" : "切换浅色模式";
    } catch {
      Notify.error("主题切换失败");
    }
  }
};

// ====================== 会话模块 ======================
const Session = {
  handleInvalid: async function(reason = "账号在其他设备登录，已为你安全下线") {
    try {
      Notify.error(reason);
      AppState.isSessionInitialized = false;
      if (AppState.sb) {
        await AppState.sb.auth.signOut().catch(() => {});
      }
      AppState.reset();
      Utils.SafeStorage.clear();
      UI.showPage("loginPage");
      setTimeout(() => window.location.reload(), 800);
    } catch {
      AppState.reset();
      Utils.SafeStorage.clear();
      window.location.href = `${window.location.origin}/chat`;
    }
  },

  initCheck: function() {
    const channelName = "session_check";
    try {
      if (!AppState.currentUser) return;
      if (AppState.channels[channelName]) {
        AppState.sb.removeChannel(AppState.channels[channelName]).catch(() => {});
      }
      AppState.resetReconnect(channelName);

      AppState.channels[channelName] = AppState.sb.channel(channelName)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "users", filter: `id=eq.${AppState.currentUser.id}` },
          async (payload) => {
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
            const delay = AppState.getReconnectDelay(channelName);
            if (delay) {
              console.error(`[会话] 通道连接失败，${delay}ms后重试`);
              setTimeout(() => Session.initCheck(), delay);
            }
          } else if (status === "SUBSCRIBED") {
            AppState.resetReconnect(channelName);
          }
        });

      if (AppState.timers.sessionCheck) clearInterval(AppState.timers.sessionCheck);
      AppState.timers.sessionCheck = setInterval(async () => {
        if (!AppState.currentUser || !AppState.isSessionInitialized) return;
        try {
          const { data, error } = await Utils.withTimeout(
            AppState.sb.from("users").select("current_session_token").eq("id", AppState.currentUser.id).single(),
            APP_CONFIG.TIMEOUT.API
          );
          if (!error && data?.current_session_token !== AppState.sessionToken) {
            await Session.handleInvalid();
          }
        } catch {}
      }, APP_CONFIG.INTERVAL.SESSION_CHECK);

    } catch {
      console.warn("[会话] 监听初始化失败");
    }
  }
};

// ====================== 认证核心模块 ======================
const Auth = {
  login: async function() {
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
      
      if (!email || !pwd) throw new Error("请填写邮箱和密码");
      if (!Utils.isValidEmail(email)) throw new Error("请输入正确的邮箱格式");

      const { error } = await Utils.withTimeout(
        AppState.sb.auth.signInWithPassword({ email, password: pwd }),
        APP_CONFIG.TIMEOUT.LOGIN,
        "登录请求超时，请检查网络后重试"
      );

      if (error) {
        let errMsg = error.message;
        if (errMsg.includes("Email not confirmed")) errMsg = "邮箱未验证，请验证后登录";
        if (errMsg.includes("Invalid login credentials")) errMsg = "邮箱或密码错误";
        if (errMsg.includes("banned")) errMsg = "账号已被封禁";
        if (errMsg.includes("infinite recursion")) errMsg = "数据库策略异常，请联系管理员";
        throw new Error(errMsg);
      }
    } catch (e) {
      Notify.error(`登录失败：${e.message}`);
    } finally {
      setTimeout(() => {
        AppState.unlock("isLoggingIn");
        loginBtn.disabled = false;
        loginBtn.innerText = "登录";
      }, 300);
    }
  },

  register: async function() {
    const regBtn = Utils.DOM.$("#regBtn");
    regBtn.disabled = true;
    regBtn.innerText = "注册中...";

    try {
      const nick = Utils.DOM.$("#regNick").value.trim();
      const email = Utils.DOM.$("#regEmail").value.trim();
      const pwd = Utils.DOM.$("#regPwd").value.trim();
      
      if (!nick || !email || !pwd) throw new Error("请填写完整注册信息");
      if (!Utils.isValidEmail(email)) throw new Error("请输入正确的邮箱格式");
      if (pwd.length < 8) throw new Error("密码长度不能少于8位");

      const { error } = await Utils.withTimeout(
        AppState.sb.auth.signUp({ 
          email, 
          password: pwd, 
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
      ["regNick", "regEmail", "regPwd"].forEach(id => Utils.DOM.$(`#${id}`).value = "");
      UI.showPage("loginPage");
    } catch (e) {
      Notify.error(`注册失败：${e.message}`);
    } finally {
      regBtn.disabled = false;
      regBtn.innerText = "注册";
    }
  },

  handleAuthChange: async function(event, session) {
    if (AppState.isLocked("isAuthHandling")) {
      console.log("[认证] 正在处理中，跳过重复触发");
      return;
    }

    AppState.lock("isAuthHandling");
    try {
      console.log("[认证] 事件：", event);

      if (event === "SIGNED_OUT") {
        console.log("[认证] 检测到退出登录");
        AppState.reset();
        UI.showPage("loginPage");
        UI.closeLoader();
        return;
      }

      const validEvents = ["SIGNED_IN", "INITIAL_SESSION"];
      if (!validEvents.includes(event) || !session?.user) {
        console.log("[认证] 非有效登录事件，重置状态");
        AppState.reset();
        UI.showPage("loginPage");
        UI.closeLoader();
        return;
      }

      Notify.info("账号验证成功，正在进入聊天...");
      let userInfo = null;

      await Utils.retry(async () => {
        const { data, error } = await Utils.withTimeout(
          AppState.sb.from("users").select("*").eq("id", session.user.id).single(),
          APP_CONFIG.TIMEOUT.API
        );
        if (error && error.code !== "PGRST116") throw error;
        userInfo = data;
      });

      if (!userInfo) {
        console.warn("[认证] 业务表无用户记录，自动创建");
        const { data: newUser, error: createError } = await Utils.withTimeout(
          AppState.sb.from("users").insert([{
            id: session.user.id,
            nick: session.user.user_metadata?.nick || session.user.email.split('@')[0],
            email: session.user.email,
            is_admin: false,
            status: 'active',
            created_at: session.user.created_at || new Date().toISOString()
          }]).select().single(),
          APP_CONFIG.TIMEOUT.API
        );
        if (createError) throw new Error("用户信息初始化失败，请刷新重试");
        userInfo = newUser;
        console.log("[认证] 用户信息自动创建成功");
      }

      if (userInfo.status === "ban") throw new Error("账号已被封禁，无法登录");

      AppState.currentUser = session.user;
      AppState.currentUser.isAdmin = [true, 'true', 1].includes(userInfo.is_admin);
      AppState.userNick = Utils.SafeStorage.get("nick") || userInfo.nick || "用户";
      Utils.SafeStorage.set("nick", AppState.userNick);

      Utils.SafeStorage.remove("chat_current_session_token");
      const newToken = Utils.generateId();
      AppState.sessionToken = newToken;
      Utils.SafeStorage.set("chat_current_session_token", newToken);

      await Utils.withTimeout(
        AppState.sb.from("users").update({
          current_session_token: newToken,
          last_login_time: new Date().toISOString()
        }).eq("id", AppState.currentUser.id),
        APP_CONFIG.TIMEOUT.API
      );

      AppState.isSessionInitialized = true;
      Notify.success("登录成功，欢迎使用");
      if (AppState.currentUser.isAdmin) Notify.success("管理员账号登录成功！");

      UI.showPage("chatPage");
      UI.closeLoader();
      Utils.DOM.$("#userTag").innerText = `用户：${AppState.userNick}`;

      setTimeout(async () => {
        try {
          console.log("[认证] 开始初始化附属功能");
          Session.initCheck();
          await Chat.loadMessages();
          Chat.initRealtime();
          await Online.mark();
          await Online.refreshCount();
          Online.initRealtime();
          Config.initRealtime();
          Heartbeat.init();
          await LoginLog.record();
          console.log("[认证] 所有功能初始化完成");
        } catch {
          Notify.warning("部分功能加载失败，不影响聊天使用");
        }
      }, 0);

    } catch (e) {
      let errMsg = e.message;
      if (errMsg.includes("infinite recursion")) errMsg = "数据库策略异常，请联系管理员";
      Notify.error(`登录异常：${errMsg}`);
      AppState.reset();
      await AppState.sb.auth.signOut().catch(() => {});
      UI.showPage("loginPage");
      UI.closeLoader();
    } finally {
      AppState.unlock("isAuthHandling");
    }
  },

  logout: async function() {
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

      if (AppState.currentUser && AppState.sb) {
        await AppState.sb.from("users")
          .update({ current_session_token: null })
          .eq("id", AppState.currentUser.id)
          .catch(() => {});
        await AppState.sb.from("online_users")
          .delete()
          .eq("user_id", AppState.currentUser.id)
          .catch(() => {});
      }

      if (AppState.sb) await AppState.sb.auth.signOut();
      AppState.reset();
      Utils.SafeStorage.clear();
      UI.showPage("loginPage");
      Notify.success("已安全退出登录");
      console.log("[认证] 退出登录完成");
    } catch (e) {
      Notify.error(`退出失败：${e.message}`);
      AppState.reset();
      Utils.SafeStorage.clear();
      UI.showPage("loginPage");
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
  _debounceLoad: null,
  init: function() {
    this._debounceLoad = Utils.debounce(() => this.loadMessages(), 300);
  },

  loadMessages: async function() {
    if (AppState.isLoadingMessages) return;
    AppState.isLoadingMessages = true;

    try {
      console.log("[聊天] 开始加载历史消息");
      const { data, error } = await Utils.withTimeout(
        AppState.sb.from("messages").select("*").order("id", { ascending: true }).limit(200),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("加载历史消息失败");
      this.render(data || []);
      console.log(`[聊天] 历史消息加载完成，共${data?.length || 0}条`);
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.isLoadingMessages = false;
    }
  },

  render: function(msgList) {
    try {
      const msgBox = Utils.DOM.$("#msgBox");
      let html = "";
      msgList.forEach(msg => {
        if (!msg || !msg.id) return;
        const isMe = msg.user_id === AppState.currentUser.id;
        const safeNick = Utils.escapeHtml(msg.nick || "匿名用户");
        const safeText = Utils.escapeHtml(msg.text || "");
        const safeTime = Utils.escapeHtml(msg.time || "");
        const msgId = Utils.escapeHtml(msg.id.toString());
        
        html += `
          <div class="msg-item ${isMe ? 'msg-me' : 'msg-other'}">
            <div class="avatar">${safeNick.charAt(0)}</div>
            <div>
              <div class="msg-name">${safeNick}</div>
              <div class="bubble">${safeText}</div>
              <div class="msg-time">${safeTime}</div>
            </div>
            ${AppState.currentUser.isAdmin ? `<button class="win-btn small danger" onclick="Admin.deleteMsg(${msgId})">删除</button>` : ''}
          </div>
        `;
      });
      msgBox.innerHTML = html;
      msgBox.scrollTop = msgBox.scrollHeight;
    } catch {
      Notify.error("消息渲染失败");
    }
  },

  initRealtime: function() {
    const channelName = "message_channel";
    try {
      if (AppState.channels[channelName]) {
        AppState.sb.removeChannel(AppState.channels[channelName]).catch(() => {});
      }
      AppState.resetReconnect(channelName);

      AppState.channels[channelName] = AppState.sb.channel(channelName)
        .on("postgres_changes", { event: "*", schema: "public", table: "messages" },
          () => this._debounceLoad()
        )
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR") {
            const delay = AppState.getReconnectDelay(channelName);
            if (delay) setTimeout(() => this.initRealtime(), delay);
          } else if (status === "SUBSCRIBED") {
            AppState.resetReconnect(channelName);
          }
        });
    } catch {
      console.warn("[聊天] 实时监听初始化失败");
    }
  },

  send: async function() {
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

    try {
      let config = { sensitive_words: "" };
      try {
        const { data, error } = await AppState.sb.from("system_config").select("sensitive_words").single();
        if (!error && data) config = data;
      } catch {}

      let content = text;
      (config?.sensitive_words || "").split(",").filter(w => w.trim()).forEach(word => {
        content = content.replaceAll(word, "***");
      });

      const { error } = await AppState.sb.from("messages").insert([{
        user_id: AppState.currentUser.id,
        nick: AppState.userNick,
        text: content,
        time: new Date().toLocaleString()
      }]);
      if (error) throw new Error("发送消息失败");

      msgInput.value = "";
      Notify.success("消息发送成功");
      await this.loadMessages();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.innerText = "发送";
    }
  }
};
Chat.init();

// ====================== 在线&心跳模块 ======================
const Online = {
  mark: async function() {
    if (!AppState.currentUser || !AppState.isSessionInitialized) return;
    try {
      await AppState.sb.from("online_users").upsert({
        user_id: AppState.currentUser.id,
        nick: AppState.userNick,
        last_active: new Date().toISOString()
      }, { onConflict: "user_id" });
    } catch {}
  },

  refreshCount: async function() {
    try {
      const { data } = await AppState.sb.from("online_users").select("*");
      Utils.DOM.$("#onlineNum").innerText = data?.length || 0;
    } catch {}
  },

  initRealtime: function() {
    const channelName = "online_channel";
    try {
      if (AppState.channels[channelName]) {
        AppState.sb.removeChannel(AppState.channels[channelName]).catch(() => {});
      }
      AppState.channels[channelName] = AppState.sb.channel(channelName)
        .on("postgres_changes", { event: "*", schema: "public", table: "online_users" },
          () => this.refreshCount()
        )
        .subscribe();
    } catch {}
  }
};

const Heartbeat = {
  init: function() {
    if (AppState.timers.heartbeat) clearInterval(AppState.timers.heartbeat);
    AppState.timers.heartbeat = setInterval(async () => {
      if (AppState.currentUser && AppState.isSessionInitialized) {
        await Online.mark();
      }
    }, APP_CONFIG.INTERVAL.HEARTBEAT);
  }
};

// ====================== 系统配置模块 ======================
const Config = {
  initRealtime: function() {
    const channelName = "config_channel";
    try {
      if (AppState.channels[channelName]) {
        AppState.sb.removeChannel(AppState.channels[channelName]).catch(() => {});
      }
      AppState.channels[channelName] = AppState.sb.channel(channelName)
        .on("postgres_changes", { event: "*", schema: "public", table: "system_config" },
          () => this.loadAnnounce()
        )
        .subscribe();
    } catch {}
  },

  loadAnnounce: async function() {
    try {
      let data = { announcement: "" };
      try {
        const res = await AppState.sb.from("system_config").select("announcement").single();
        if (!res.error && res.data) {
          data = res.data;
        }
      } catch {}
      
      const bar = Utils.DOM.$("#announceBar");
      if (data?.announcement) {
        bar.innerText = data.announcement;
        bar.classList.remove("hidden");
      } else {
        bar.classList.add("hidden");
      }
    } catch {}
  }
};

// ====================== 登录日志模块 ======================
const LoginLog = {
  record: async function() {
    if (!AppState.currentUser) return;
    try {
      const userAgent = navigator.userAgent || "未知设备";
      await AppState.sb.from("login_logs").insert([{
        user_id: AppState.currentUser.id,
        ip: "未知IP",
        device: userAgent.substring(0, 80),
        time: new Date().toLocaleString()
      }]);
    } catch {}
  },

  showMy: async function() {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      Notify.error("请先登录");
      return;
    }
    try {
      Notify.info("正在加载登录日志...");
      const { data, error } = await Utils.withTimeout(
        AppState.sb.from("login_logs").select("*").eq("user_id", AppState.currentUser.id).order("time", { ascending: false }).limit(10),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("加载登录日志失败");

      if (!data || data.length === 0) {
        alert("=== 我的登录日志 ===\n\n暂无登录日志");
        return;
      }

      let logText = "=== 我的登录日志 ===\n\n";
      data.forEach((log, index) => {
        logText += `${index + 1}. IP：${Utils.escapeHtml(log.ip || "未知")}\n   时间：${Utils.escapeHtml(log.time || "未知")}\n   设备：${Utils.escapeHtml(log.device || "未知")}\n\n`;
      });
      alert(logText);
    } catch (e) {
      Notify.error(e.message);
    }
  }
};

// ====================== 设置模块 ======================
const Settings = {
  saveNick: async function() {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      Notify.error("请先登录");
      return;
    }
    try {
      const newNick = Utils.DOM.$("#nickInput").value.trim();
      if (!newNick) throw new Error("请输入有效的昵称");
      
      const { error } = await AppState.sb.from("users").update({ nick: newNick }).eq("id", AppState.currentUser.id);
      if (error) throw new Error("保存昵称失败");
      
      AppState.userNick = newNick;
      Utils.SafeStorage.set("nick", newNick);
      Utils.DOM.$("#userTag").innerText = `用户：${newNick}`;
      Utils.DOM.$("#nickInput").value = "";
      Notify.success("昵称保存成功");
      await Online.mark();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  updatePwd: async function() {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      Notify.error("请先登录");
      return;
    }
    try {
      const newPwd = Utils.DOM.$("#newPwdInput").value.trim();
      if (newPwd.length < 8) throw new Error("密码长度不能少于8位");
      
      const { error } = await AppState.sb.auth.updateUser({ password: newPwd });
      if (error) throw new Error("修改密码失败");
      
      Notify.success("密码修改成功，请重新登录");
      Utils.DOM.$("#newPwdInput").value = "";
      setTimeout(() => Auth.logout(), 1500);
    } catch (e) {
      Notify.error(e.message);
    }
  }
};

// ====================== 管理员模块（100%修复catch报错） ======================
const Admin = {
  loadData: async function() {
    if (!AppState.currentUser?.isAdmin) {
      Notify.error("你没有管理员权限");
      return;
    }
    try {
      Notify.info("正在加载管理数据...");
      
      // 加载系统配置（修复catch报错）
      let config = {};
      try {
        const { data, error } = await AppState.sb.from("system_config").select("*").single();
        if (!error && data) {
          config = data;
        }
      } catch {}
      Utils.DOM.$("#requireVerifyToggle").checked = config?.require_verify || false;
      Utils.DOM.$("#sensitiveWordsInput").value = config?.sensitive_words || "";
      Utils.DOM.$("#announceInput").value = config?.announcement || "";

      // 加载待审核用户（修复catch报错）
      let verifyUsers = [];
      try {
        const { data, error } = await AppState.sb.from("users").select("*").eq("status", "pending");
        if (!error && data) {
          verifyUsers = data;
        }
      } catch {}
      let verifyHtml = "";
      verifyUsers.forEach(user => {
        const safeId = Utils.escapeHtml(user.id);
        const safeEmail = Utils.escapeHtml(user.email);
        const safeNick = Utils.escapeHtml(user.nick);
        verifyHtml += `
          <div class="list-item">
            <span>${safeEmail}（${safeNick}）</span>
            <div class="btn-group">
              <button class="win-btn small primary" onclick="Admin.verifyUser('${safeId}', 'active')">通过</button>
              <button class="win-btn small danger" onclick="Admin.verifyUser('${safeId}', 'ban')">拒绝</button>
            </div>
          </div>
        `;
      });
      Utils.DOM.$("#verifyUserList").innerHTML = verifyHtml || "暂无待审核用户";

      // 加载所有用户（修复catch报错）
      let allUsers = [];
      try {
        const { data, error } = await AppState.sb.from("users").select("*").order("created_at", { ascending: false });
        if (!error && data) {
          allUsers = data;
        }
      } catch {}
      let userHtml = "";
      allUsers.forEach(user => {
        const safeId = Utils.escapeHtml(user.id);
        const safeEmail = Utils.escapeHtml(user.email);
        const safeNick = Utils.escapeHtml(user.nick);
        const statusText = user.status === "active" ? "正常" : user.status === "ban" ? "封禁" : "待审核";
        const muteText = user.is_mute ? "解禁" : "禁言";
        const isOnline = user.current_session_token ? "在线" : "离线";
        userHtml += `
          <div class="list-item">
            <span>${safeEmail}（${safeNick} | ${statusText} | ${isOnline}）</span>
            <div class="btn-group">
              <button class="win-btn small secondary" onclick="Admin.resetUserPwd('${safeEmail}')">重置密码</button>
              <button class="win-btn small warning" onclick="Admin.setUserMute('${safeId}', ${!user.is_mute})">${muteText}</button>
              <button class="win-btn small ${user.status === 'ban' ? 'primary' : 'danger'}" onclick="Admin.setUserStatus('${safeId}', '${user.status === 'ban' ? 'active' : 'ban'}')">
                ${user.status === 'ban' ? '解封' : '封禁'}
              </button>
              <button class="win-btn small danger" onclick="Admin.forceUserOffline('${safeId}')">强制下线</button>
            </div>
          </div>
        `;
      });
      Utils.DOM.$("#allUserList").innerHTML = userHtml;

      // 加载登录日志（修复catch报错）
      let logs = [];
      try {
        const { data, error } = await AppState.sb.from("login_logs").select("*, users!inner(email, nick)").order("time", { ascending: false }).limit(20);
        if (!error && data) {
          logs = data;
        }
      } catch {}
      let logHtml = "";
      logs.forEach(log => {
        const safeEmail = Utils.escapeHtml(log.users?.email || '未知用户');
        const safeNick = Utils.escapeHtml(log.users?.nick || '未知');
        const safeIp = Utils.escapeHtml(log.ip || '未知');
        const safeTime = Utils.escapeHtml(log.time || '未知');
        logHtml += `
          <div class="list-item">
            <span>${safeEmail}（${safeNick}）| IP：${safeIp} | ${safeTime}</span>
          </div>
        `;
      });
      Utils.DOM.$("#allLoginLogList").innerHTML = logHtml || "暂无登录日志";

      Notify.success("管理数据加载完成");
    } catch (e) {
      Notify.error("管理数据加载失败：" + e.message);
    }
  },

  forceUserOffline: async function(userId) {
    if (!confirm("确定要强制该用户下线吗？")) return;
    try {
      const { error } = await AppState.sb.from("users").update({ current_session_token: null }).eq("id", userId);
      if (error) throw new Error("强制下线失败");
      Notify.success("用户已被强制下线");
      this.loadData();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  verifyUser: async function(userId, status) {
    try {
      const { error } = await AppState.sb.from("users").update({ status }).eq("id", userId);
      if (error) throw new Error("操作失败");
      Notify.success(status === "active" ? "用户审核通过" : "用户审核拒绝");
      this.loadData();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  setUserMute: async function(userId, isMute) {
    try {
      const { error } = await AppState.sb.from("users").update({ is_mute: isMute }).eq("id", userId);
      if (error) throw new Error("操作失败");
      Notify.success(isMute ? "已禁言该用户" : "已解禁该用户");
      this.loadData();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  setUserStatus: async function(userId, status) {
    try {
      const { error } = await AppState.sb.from("users").update({ status }).eq("id", userId);
      if (error) throw new Error("操作失败");
      Notify.success(status === "active" ? "已解封该用户" : "已封禁该用户");
      this.loadData();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  resetUserPwd: async function(email) {
    try {
      const { error } = await AppState.sb.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/chat` });
      if (error) throw new Error("重置失败");
      Notify.success("密码重置邮件已发送");
    } catch (e) {
      Notify.error(e.message);
    }
  },

  saveSystemConfig: async function() {
    try {
      const requireVerify = Utils.DOM.$("#requireVerifyToggle").checked;
      let configId = null;
      try {
        const { data } = await AppState.sb.from("system_config").select("id").single();
        if (data) configId = data.id;
      } catch {}

      if (configId) {
        await AppState.sb.from("system_config").update({ require_verify }).eq("id", configId);
      } else {
        await AppState.sb.from("system_config").insert([{ require_verify }]);
      }
      Notify.success("系统配置保存成功");
    } catch (e) {
      Notify.error(e.message);
    }
  },

  saveSensitiveWords: async function() {
    try {
      const words = Utils.DOM.$("#sensitiveWordsInput").value.trim();
      let configId = null;
      try {
        const { data } = await AppState.sb.from("system_config").select("id").single();
        if (data) configId = data.id;
      } catch {}

      if (configId) {
        await AppState.sb.from("system_config").update({ sensitive_words: words }).eq("id", configId);
      } else {
        await AppState.sb.from("system_config").insert([{ sensitive_words: words }]);
      }
      Notify.success("敏感词保存成功");
    } catch (e) {
      Notify.error(e.message);
    }
  },

  saveAnnouncement: async function() {
    try {
      const content = Utils.DOM.$("#announceInput").value.trim();
      let configId = null;
      try {
        const { data } = await AppState.sb.from("system_config").select("id").single();
        if (data) configId = data.id;
      } catch {}

      if (configId) {
        await AppState.sb.from("system_config").update({ announcement: content }).eq("id", configId);
      } else {
        await AppState.sb.from("system_config").insert([{ announcement: content }]);
      }
      Notify.success("公告已推送");
    } catch (e) {
      Notify.error(e.message);
    }
  },

  deleteMsg: async function(msgId) {
    try {
      const { error } = await AppState.sb.from("messages").delete().eq("id", msgId);
      if (error) throw new Error("删除失败");
      Notify.success("消息已删除");
      await Chat.loadMessages();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  clearAllMessages: async function() {
    if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
    try {
      const { error } = await AppState.sb.from("messages").delete().not.is("id", null);
      if (error) throw new Error("清空失败");
      Notify.success("所有消息已清空");
      await Chat.loadMessages();
    } catch (e) {
      Notify.error(e.message);
    }
  }
};

// ====================== 事件绑定 ======================
const EventBinder = {
  _bound: false,
  init: function() {
    if (this._bound) return;
    try {
      Utils.DOM.$("#toRegisterBtn").addEventListener("click", () => UI.showPage("registerPage"));
      Utils.DOM.$("#toLoginBtn").addEventListener("click", () => UI.showPage("loginPage"));
      Utils.DOM.$("#loginBtn").addEventListener("click", () => Auth.login());
      Utils.DOM.$("#regBtn").addEventListener("click", () => Auth.register());
      Utils.DOM.$("#loginPwd").addEventListener("keydown", (e) => e.key === "Enter" && Auth.login());
      Utils.DOM.$("#regPwd").addEventListener("keydown", (e) => e.key === "Enter" && Auth.register());
      Utils.DOM.$("#logoutBtn").addEventListener("click", () => Auth.logout());

      Utils.DOM.$("#sendBtn").addEventListener("click", () => Chat.send());
      Utils.DOM.$("#msgInput").addEventListener("keydown", (e) => e.key === "Enter" && !e.shiftKey && Chat.send());

      Utils.DOM.$("#settingBtn").addEventListener("click", () => UI.showPage("settingPage"));
      Utils.DOM.$("#adminBtn").addEventListener("click", () => { Admin.loadData(); UI.showPage("adminPage"); });
      Utils.DOM.$("#backToChatBtn").addEventListener("click", () => UI.showPage("chatPage"));
      Utils.DOM.$("#backToChatFromAdminBtn").addEventListener("click", () => UI.showPage("chatPage"));

      Utils.DOM.$("#saveNickBtn").addEventListener("click", () => Settings.saveNick());
      Utils.DOM.$("#toggleThemeBtn").addEventListener("click", () => UI.toggleTheme());
      Utils.DOM.$("#updatePwdBtn").addEventListener("click", () => Settings.updatePwd());
      Utils.DOM.$("#showLoginLogBtn").addEventListener("click", () => LoginLog.showMy());

      Utils.DOM.$("#saveConfigBtn").addEventListener("click", () => Admin.saveSystemConfig());
      Utils.DOM.$("#saveSwBtn").addEventListener("click", () => Admin.saveSensitiveWords());
      Utils.DOM.$("#saveAnnounceBtn").addEventListener("click", () => Admin.saveAnnouncement());
      Utils.DOM.$("#clearAllMsgBtn").addEventListener("click", () => Admin.clearAllMessages());

      this._bound = true;
      console.log("[事件] 所有事件绑定完成");
    } catch (e) {
      console.error("[事件] 绑定失败", e);
      Notify.error("页面初始化失败，请刷新重试");
    }
  }
};

// ====================== 应用初始化 ======================
const App = {
  init: async function() {
    if (AppState.isLocked("isInit")) return;
    AppState.lock("isInit");

    try {
      console.log("[应用] 开始初始化");
      AppState.timers.forceCloseLoader = setTimeout(() => {
        UI.closeLoader();
        AppState.reset();
        UI.showPage("loginPage");
      }, 5000);

      UI.initTheme();
      if (!window.supabase) throw new Error("Supabase SDK加载失败，请刷新页面重试");

      AppState.sb = window.supabase.createClient(
        APP_CONFIG.SUPABASE_URL,
        APP_CONFIG.SUPABASE_KEY,
        {
          auth: { 
            autoRefreshToken: true, 
            persistSession: true, 
            detectSessionInUrl: true,
            storage: Utils.SafeStorage._isSupported ? window.localStorage : null
          },
          realtime: { 
            timeout: APP_CONFIG.TIMEOUT.REALTIME,
            heartbeatIntervalMs: APP_CONFIG.INTERVAL.HEARTBEAT,
            params: { events_per_second: 10 }
          }
        }
      );

      EventBinder.init();

      const { data: { session } } = await AppState.sb.auth.getSession();
      if (session?.user) {
        console.log("[应用] 检测到旧会话，清理");
        await AppState.sb.auth.signOut().catch(() => {});
      }

      AppState.reset();
      UI.showPage("loginPage");
      UI.closeLoader();

      AppState.sb.auth.onAuthStateChange((event, session) => Auth.handleAuthChange(event, session));

      console.log("[应用] 初始化完成");
    } catch (e) {
      console.error("[应用] 初始化致命错误", e);
      Notify.error(`初始化失败：${e.message}`);
      UI.closeLoader();
      AppState.reset();
      UI.showPage("loginPage");
    } finally {
      AppState.unlock("isInit");
    }
  }
};

// ====================== 生命周期监听 ======================
document.addEventListener("DOMContentLoaded", () => App.init());

window.addEventListener("beforeunload", async () => {
  try {
    if (AppState.currentUser && AppState.sb) {
      await AppState.sb.from("online_users").delete().eq("user_id", AppState.currentUser.id).catch(() => {});
    }
  } catch {}
});

document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && AppState.currentUser && AppState.isSessionInitialized) {
    await Online.mark();
    await Online.refreshCount();
    UI.showAdminBtn();
  }
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => UI.initTheme());

window.Admin = Admin;
