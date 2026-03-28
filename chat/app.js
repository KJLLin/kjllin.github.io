// ====================== 核心配置 ======================
const APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://ayavdkodhdmcxfufnnxo.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc",
  TIMEOUT: { LOGIN: 20000, API: 10000, REALTIME: 15000 },
  INTERVAL: { HEARTBEAT: 30000, SESSION_CHECK: 60000, REALTIME_RECONNECT_BASE: 1000 },
  MAX_RECONNECT: 10
});

// ====================== 工具函数 ======================
const Utils = {
  SafeStorage: {
    _isSupported: (() => {
      try {
        const k = "__test__";
        localStorage.setItem(k, k);
        localStorage.removeItem(k);
        return true;
      } catch { return false; }
    })(),
    get: (k) => Utils.SafeStorage._isSupported ? (localStorage.getItem(k) || "") : "",
    set: (k, v) => Utils.SafeStorage._isSupported ? (localStorage.setItem(k, v), true) : false,
    remove: (k) => Utils.SafeStorage._isSupported ? (localStorage.removeItem(k), true) : false,
    clear: () => Utils.SafeStorage._isSupported ? (localStorage.clear(), true) : false
  },

  DOM: {
    $: (selector) => {
      try {
        return document.querySelector(selector) || {
          addEventListener: () => {}, removeEventListener: () => {},
          innerText: '', innerHTML: '', value: '', disabled: false, checked: false,
          classList: { add: () => {}, remove: () => {} }, style: { display: 'none' }
        };
      } catch {
        return {
          addEventListener: () => {}, removeEventListener: () => {},
          innerText: '', innerHTML: '', value: '', disabled: false, checked: false,
          classList: { add: () => {}, remove: () => {} }, style: { display: 'none' }
        };
      }
    },
    $$: (selector) => {
      try { return document.querySelectorAll(selector) || []; } catch { return []; }
    }
  },

  escapeHtml: (text) => {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  debounce: (func, wait) => {
    let timeout = null;
    const debounced = (...args) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => { timeout = null; func(...args); }, wait);
    };
    debounced.cancel = () => timeout && clearTimeout(timeout);
    return debounced;
  },

  generateId: () => {
    try { return crypto.randomUUID(); }
    catch { return Date.now().toString(36) + Math.random().toString(36).substring(2, 10); }
  },

  withTimeout: (promise, timeoutMs, errorMsg = "请求超时") => {
    let timeout = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => timeout = setTimeout(() => reject(new Error(errorMsg)), timeoutMs))
    ]).finally(() => timeout && clearTimeout(timeout));
  },

  retry: async (fn, maxRetries = 2, baseDelay = 300) => {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try { return await fn(); }
      catch (e) {
        lastError = e;
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, i)));
      }
    }
    throw lastError;
  },

  isValidEmail: (email) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email?.trim()),

  getSystemConfig: async () => {
    try {
      const { data, error } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("*").maybeSingle(),
        APP_CONFIG.TIMEOUT.API
      );
      return !error && data ? data : { require_verify: false, sensitive_words: "", announcement: "" };
    } catch {
      return { require_verify: false, sensitive_words: "", announcement: "" };
    }
  }
};

// ====================== 通知模块 ======================
const Notify = {
  _timeout: null,
  show: (type, text) => {
    try {
      if (Notify._timeout) clearTimeout(Notify._timeout);
      const el = Utils.DOM.$("#winNotify");
      el.className = `win-notify ${type}`;
      el.innerText = text;
      el.classList.remove("hidden");
      Notify._timeout = setTimeout(() => {
        el.classList.add("hidden");
        Notify._timeout = null;
      }, 6000);
    } catch { alert(text); }
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
  _locks: { isLoggingIn: false, isLoggingOut: false, isAuthHandling: false, isInit: false, isRegistering: false },
  channels: Object.create(null),
  timers: Object.create(null),
  _reconnectCount: Object.create(null),

  lock: (key) => AppState._locks.hasOwnProperty(key) && (AppState._locks[key] = true),
  unlock: (key) => AppState._locks.hasOwnProperty(key) && (AppState._locks[key] = false),
  isLocked: (key) => AppState._locks[key] || false,
  resetReconnect: (name) => AppState._reconnectCount[name] = 0,
  getReconnectDelay: (name) => {
    const count = AppState._reconnectCount[name] || 0;
    AppState._reconnectCount[name] = count + 1;
    return count >= APP_CONFIG.MAX_RECONNECT ? null : APP_CONFIG.INTERVAL.REALTIME_RECONNECT_BASE * Math.pow(2, count);
  },

  // 新增：关闭所有实时通道（解决通道关闭报错）
  closeAllChannels: () => {
    try {
      if (!AppState.sb) return;
      Object.values(AppState.channels).forEach(channel => {
        if (channel) AppState.sb.removeChannel(channel).catch(() => {});
      });
      AppState.channels = Object.create(null);
    } catch {}
  },

  reset: () => {
    try {
      // 先关闭所有通道
      AppState.closeAllChannels();
      // 清理所有定时器
      Object.values(AppState.timers).forEach(timer => timer && (clearTimeout(timer) || clearInterval(timer)));
      
      const adminBtn = Utils.DOM.$("#adminBtn");
      adminBtn.style.display = "none";
      adminBtn.classList.add("hidden");
      
      AppState.currentUser = null;
      AppState.userNick = "";
      AppState.sessionToken = "";
      AppState.isSessionInitialized = false;
      AppState.isLoadingMessages = false;
      AppState.timers = Object.create(null);
      AppState._reconnectCount = Object.create(null);
      
      Utils.SafeStorage.remove("chat_current_session_token");
      Utils.SafeStorage.remove("nick");
      
      ["loginBtn", "regBtn", "sendBtn", "logoutBtn"].forEach(id => {
        const btn = Utils.DOM.$(`#${id}`);
        btn.disabled = false;
        btn.innerText = id === "loginBtn" ? "登录" : id === "regBtn" ? "注册" : id === "sendBtn" ? "发送" : "退出登录";
      });
      
      Object.keys(AppState._locks).forEach(key => AppState.unlock(key));
      ["msgInput", "loginEmail", "loginPwd", "regNick", "regEmail", "regPwd", "nickInput", "newPwdInput"].forEach(id => Utils.DOM.$(`#${id}`).value = "");
    } catch {}
  }
};

// ====================== UI模块 ======================
const UI = {
  closeLoader: () => {
    try {
      if (AppState.timers.forceCloseLoader) clearTimeout(AppState.timers.forceCloseLoader);
      const loader = Utils.DOM.$("#loadingPage");
      loader.style.opacity = 0;
      setTimeout(() => { loader.classList.add("hidden"); loader.style.display = "none"; }, 300);
    } catch { Utils.DOM.$("#loadingPage")?.remove(); }
  },

  showPage: (pageId) => {
    try {
      const needLogin = ["chatPage", "settingPage", "adminPage"].includes(pageId);
      if (needLogin && !AppState.isSessionInitialized) {
        AppState.reset();
        UI.showPage("loginPage");
        UI.closeLoader();
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

      if (pageId === "chatPage") setTimeout(() => UI.showAdminBtn(), 50);
    } catch (e) { Notify.error("页面切换失败：" + e.message); }
  },

  showAdminBtn: () => {
    try {
      const btn = Utils.DOM.$("#adminBtn");
      if (!AppState.currentUser?.isAdmin) {
        btn.style.display = "none";
        btn.classList.add("hidden");
        return false;
      }
      btn.classList.remove("hidden");
      btn.style.display = "inline-block";
      return true;
    } catch { return false; }
  },

  initTheme: () => {
    try {
      const isDark = Utils.SafeStorage.get("theme") === "dark" || window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = isDark ? "dark" : "";
      Utils.DOM.$("#toggleThemeBtn").innerText = isDark ? "切换浅色模式" : "切换深色模式";
    } catch {}
  },

  toggleTheme: () => {
    try {
      const root = document.documentElement;
      const isDark = root.dataset.theme === "dark";
      root.dataset.theme = isDark ? "" : "dark";
      isDark ? Utils.SafeStorage.remove("theme") : Utils.SafeStorage.set("theme", "dark");
      Utils.DOM.$("#toggleThemeBtn").innerText = isDark ? "切换深色模式" : "切换浅色模式";
    } catch { Notify.error("主题切换失败"); }
  }
};

// ====================== 会话模块 ======================
const Session = {
  handleInvalid: async (reason = "账号在其他设备登录，已为你安全下线") => {
    try {
      Notify.error(reason);
      AppState.isSessionInitialized = false;
      if (AppState.sb) await AppState.sb.auth.signOut().catch(() => {});
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

  initCheck: () => {
    const name = "session_check";
    try {
      if (!AppState.currentUser) return;
      // 先关闭旧通道
      if (AppState.channels[name]) AppState.sb.removeChannel(AppState.channels[name]).catch(() => {});
      AppState.resetReconnect(name);

      AppState.channels[name] = AppState.sb.channel(name)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "users", filter: `id=eq.${AppState.currentUser.id}` },
          async (payload) => {
            try {
              const { current_session_token, status } = payload.new || {};
              if (current_session_token && current_session_token !== AppState.sessionToken) await Session.handleInvalid();
              if (status === "pending" || status === "ban") await Session.handleInvalid(status === "ban" ? "账号已被封禁" : "账号正在等待管理员审核");
            } catch {}
          }
        )
        .subscribe((status) => {
          try {
            if (status === "CHANNEL_ERROR") {
              const delay = AppState.getReconnectDelay(name);
              if (delay) setTimeout(() => Session.initCheck(), delay);
            } else if (status === "SUBSCRIBED") {
              AppState.resetReconnect(name);
            }
          } catch {}
        });

      if (AppState.timers.sessionCheck) clearInterval(AppState.timers.sessionCheck);
      AppState.timers.sessionCheck = setInterval(async () => {
        if (!AppState.currentUser || !AppState.isSessionInitialized) return;
        try {
          const { data, error } = await Utils.withTimeout(
            AppState.sb.from("users").select("current_session_token, status").eq("id", AppState.currentUser.id).single(),
            APP_CONFIG.TIMEOUT.API
          );
          if (!error && data) {
            if (data.current_session_token !== AppState.sessionToken) await Session.handleInvalid();
            if (data.status === "pending" || data.status === "ban") await Session.handleInvalid(data.status === "ban" ? "账号已被封禁" : "账号正在等待管理员审核");
          }
        } catch {}
      }, APP_CONFIG.INTERVAL.SESSION_CHECK);
    } catch {}
  }
};

// ====================== 认证核心模块 ======================
const Auth = {
  register: async () => {
    if (AppState.isLocked("isRegistering")) {
      Notify.warning("正在注册中，请稍候...");
      return;
    }

    AppState.lock("isRegistering");
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

      const config = await Utils.getSystemConfig();
      const { data: authData, error: authError } = await Utils.withTimeout(
        AppState.sb.auth.signUp({ email, password: pwd, options: { data: { nick } } }),
        APP_CONFIG.TIMEOUT.LOGIN,
        "注册请求超时，请检查网络后重试"
      );

      if (authError) {
        let errMsg = authError.message;
        if (errMsg.includes("already registered")) errMsg = "该邮箱已被注册，请直接登录";
        throw new Error(errMsg);
      }
      if (!authData.user) throw new Error("注册失败，未获取到用户信息");

      const defaultStatus = config.require_verify ? "pending" : "active";
      const { error: createError } = await Utils.withTimeout(
        AppState.sb.from("users").upsert([{
          id: authData.user.id,
          nick: nick,
          email: email,
          is_admin: false,
          status: defaultStatus,
          created_at: authData.user.created_at || new Date().toISOString()
        }], { onConflict: "id" }),
        APP_CONFIG.TIMEOUT.API
      );
      if (createError) throw new Error("用户信息初始化失败：" + createError.message);

      if (config.require_verify) {
        await AppState.sb.auth.signOut().catch(() => {});
        Notify.success("注册成功！你的账号正在等待管理员审核，审核通过后即可登录");
        ["regNick", "regEmail", "regPwd"].forEach(id => Utils.DOM.$(`#${id}`).value = "");
        UI.showPage("loginPage");
      } else {
        Notify.success("注册成功，请前往邮箱验证后登录");
        ["regNick", "regEmail", "regPwd"].forEach(id => Utils.DOM.$(`#${id}`).value = "");
        UI.showPage("loginPage");
      }
    } catch (e) {
      Notify.error(`注册失败：${e.message}`);
    } finally {
      setTimeout(() => {
        AppState.unlock("isRegistering");
        regBtn.disabled = false;
        regBtn.innerText = "注册";
      }, 300);
    }
  },

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

  handleAuthChange: async (event, session) => {
    if (AppState.isLocked("isAuthHandling")) return;
    AppState.lock("isAuthHandling");

    try {
      if (event === "SIGNED_OUT") {
        AppState.reset();
        UI.showPage("loginPage");
        UI.closeLoader();
        return;
      }

      if (!["SIGNED_IN", "INITIAL_SESSION"].includes(event) || !session?.user) {
        AppState.reset();
        UI.showPage("loginPage");
        UI.closeLoader();
        return;
      }

      let userInfo = null;
      await Utils.retry(async () => {
        const { data, error } = await Utils.withTimeout(
          AppState.sb.from("users").select("*").eq("id", session.user.id).single(),
          APP_CONFIG.TIMEOUT.API
        );
        if (error && error.code !== "PGRST116") throw error;
        userInfo = data;
      });

      const config = await Utils.getSystemConfig();
      const defaultStatus = config.require_verify ? "pending" : "active";
      if (!userInfo) {
        const { data: newUser, error: createError } = await Utils.withTimeout(
          AppState.sb.from("users").insert([{
            id: session.user.id,
            nick: session.user.user_metadata?.nick || session.user.email.split('@')[0],
            email: session.user.email,
            is_admin: false,
            status: defaultStatus,
            created_at: session.user.created_at || new Date().toISOString()
          }]).select().single(),
          APP_CONFIG.TIMEOUT.API
        );
        if (createError) throw new Error("用户信息初始化失败，请刷新重试");
        userInfo = newUser;
      }

      if (userInfo.status === "ban") throw new Error("账号已被封禁，无法登录");
      if (userInfo.status === "pending") {
        await AppState.sb.auth.signOut().catch(() => {});
        throw new Error("你的账号正在等待管理员审核，审核通过后即可登录");
      }
      if (userInfo.status !== "active") throw new Error("账号状态异常，请联系管理员");

      Notify.info("账号验证成功，正在进入聊天...");
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
          Session.initCheck();
          await Chat.loadMessages();
          Chat.initRealtime();
          await Online.mark();
          await Online.refreshCount();
          Online.initRealtime();
          Config.initRealtime();
          Heartbeat.init();
          await LoginLog.record();
        } catch {
          Notify.warning("部分功能加载失败，不影响聊天使用");
        }
      }, 0);
    } catch (e) {
      Notify.error(`登录异常：${e.message}`);
      AppState.reset();
      await AppState.sb.auth.signOut().catch(() => {});
      UI.showPage("loginPage");
      UI.closeLoader();
    } finally {
      AppState.unlock("isAuthHandling");
    }
  },

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
      // 先关闭所有通道
      AppState.closeAllChannels();
      if (AppState.currentUser && AppState.sb) {
        await AppState.sb.from("users").update({ current_session_token: null }).eq("id", AppState.currentUser.id).catch(() => {});
        await AppState.sb.from("online_users").delete().eq("user_id", AppState.currentUser.id).catch(() => {});
      }

      if (AppState.sb) await AppState.sb.auth.signOut();
      AppState.reset();
      Utils.SafeStorage.clear();
      UI.showPage("loginPage");
      Notify.success("已安全退出登录");
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
  _debounceLoad: Utils.debounce(() => Chat.loadMessages(), 300),
  init: () => {},

  loadMessages: async () => {
    if (AppState.isLoadingMessages || !AppState.currentUser) return;
    AppState.isLoadingMessages = true;

    try {
      const { data, error } = await Utils.withTimeout(
        AppState.sb.from("messages").select("*").order("id", { ascending: true }).limit(200),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("加载历史消息失败");
      Chat.render(data || []);
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.isLoadingMessages = false;
    }
  },

  render: (msgList) => {
    try {
      const msgBox = Utils.DOM.$("#msgBox");
      let html = "";
      msgList.forEach(msg => {
        if (!msg?.id) return;
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

  initRealtime: () => {
    const name = "message_channel";
    try {
      if (!AppState.currentUser) return;
      if (AppState.channels[name]) AppState.sb.removeChannel(AppState.channels[name]).catch(() => {});
      AppState.resetReconnect(name);

      AppState.channels[name] = AppState.sb.channel(name)
        .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => Chat._debounceLoad())
        .subscribe((status) => {
          try {
            if (status === "CHANNEL_ERROR") {
              const delay = AppState.getReconnectDelay(name);
              if (delay) setTimeout(() => Chat.initRealtime(), delay);
            } else if (status === "SUBSCRIBED") {
              AppState.resetReconnect(name);
            }
          } catch {}
        });
    } catch {}
  },

  send: async () => {
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
      const config = await Utils.getSystemConfig();
      let content = text;
      (config.sensitive_words || "").split(",").filter(w => w.trim()).forEach(word => {
        content = content.replaceAll(word, "***");
      });

      const { error } = await Utils.withTimeout(
        AppState.sb.from("messages").insert([{
          user_id: AppState.currentUser.id,
          nick: AppState.userNick,
          text: content,
          time: new Date().toLocaleString()
        }]),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("发送消息失败");

      msgInput.value = "";
      Notify.success("消息发送成功");
      await Chat.loadMessages();
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
  mark: async () => {
    if (!AppState.currentUser || !AppState.isSessionInitialized) return;
    try {
      await Utils.withTimeout(
        AppState.sb.from("online_users").upsert({
          user_id: AppState.currentUser.id,
          nick: AppState.userNick,
          last_active: new Date().toISOString()
        }, { onConflict: "user_id" }),
        APP_CONFIG.TIMEOUT.API
      );
    } catch {}
  },

  refreshCount: async () => {
    try {
      const { data } = await Utils.withTimeout(
        AppState.sb.from("online_users").select("*"),
        APP_CONFIG.TIMEOUT.API
      );
      Utils.DOM.$("#onlineNum").innerText = data?.length || 0;
    } catch {}
  },

  initRealtime: () => {
    const name = "online_channel";
    try {
      if (!AppState.currentUser) return;
      if (AppState.channels[name]) AppState.sb.removeChannel(AppState.channels[name]).catch(() => {});

      AppState.channels[name] = AppState.sb.channel(name)
        .on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, () => Online.refreshCount())
        .subscribe();
    } catch {}
  }
};

const Heartbeat = {
  init: () => {
    if (AppState.timers.heartbeat) clearInterval(AppState.timers.heartbeat);
    AppState.timers.heartbeat = setInterval(async () => {
      if (AppState.currentUser && AppState.isSessionInitialized) await Online.mark();
    }, APP_CONFIG.INTERVAL.HEARTBEAT);
  }
};

// ====================== 系统配置模块 ======================
const Config = {
  initRealtime: () => {
    const name = "config_channel";
    try {
      if (AppState.channels[name]) AppState.sb.removeChannel(AppState.channels[name]).catch(() => {});

      AppState.channels[name] = AppState.sb.channel(name)
        .on("postgres_changes", { event: "*", schema: "public", table: "system_config" }, () => Config.loadAnnounce())
        .subscribe();
    } catch {}
  },

  loadAnnounce: async () => {
    try {
      const { data, error } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("announcement").maybeSingle(),
        APP_CONFIG.TIMEOUT.API
      );
      const bar = Utils.DOM.$("#announceBar");
      if (!error && data?.announcement) {
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
  record: async () => {
    if (!AppState.currentUser) return;
    try {
      await Utils.withTimeout(
        AppState.sb.from("login_logs").insert([{
          user_id: AppState.currentUser.id,
          ip: "未知IP",
          device: (navigator.userAgent || "未知设备").substring(0, 80),
          time: new Date().toLocaleString()
        }]),
        APP_CONFIG.TIMEOUT.API
      );
    } catch {}
  },

  showMy: async () => {
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

      if (!data?.length) {
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
  saveNick: async () => {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      Notify.error("请先登录");
      return;
    }
    try {
      const newNick = Utils.DOM.$("#nickInput").value.trim();
      if (!newNick) throw new Error("请输入有效的昵称");
      
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ nick: newNick }).eq("id", AppState.currentUser.id),
        APP_CONFIG.TIMEOUT.API
      );
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

  updatePwd: async () => {
    if (!AppState.currentUser || !AppState.isSessionInitialized) {
      Notify.error("请先登录");
      return;
    }
    try {
      const newPwd = Utils.DOM.$("#newPwdInput").value.trim();
      if (newPwd.length < 8) throw new Error("密码长度不能少于8位");
      
      const { error } = await Utils.withTimeout(
        AppState.sb.auth.updateUser({ password: newPwd }),
        APP_CONFIG.TIMEOUT.LOGIN
      );
      if (error) throw new Error("修改密码失败");
      
      Notify.success("密码修改成功，请重新登录");
      Utils.DOM.$("#newPwdInput").value = "";
      setTimeout(() => Auth.logout(), 1500);
    } catch (e) {
      Notify.error(e.message);
    }
  }
};

// ====================== 管理员模块（核心修复catch报错） ======================
const Admin = {
  // 核心修复：所有查询用try/catch包裹，彻底解决catch is not a function报错
  loadData: async () => {
    if (!AppState.currentUser?.isAdmin) {
      Notify.error("你没有管理员权限");
      return;
    }
    try {
      Notify.info("正在加载管理数据...");
      
      // 加载系统配置
      const config = await Utils.getSystemConfig();
      Utils.DOM.$("#requireVerifyToggle").checked = config.require_verify || false;
      Utils.DOM.$("#sensitiveWordsInput").value = config.sensitive_words || "";
      Utils.DOM.$("#announceInput").value = config.announcement || "";

      // 加载待审核用户（修复：try/catch包裹）
      let verifyUsers = [];
      try {
        const { data, error } = await Utils.withTimeout(
          AppState.sb.from("users").select("*").eq("status", "pending"),
          APP_CONFIG.TIMEOUT.API
        );
        if (!error && data) verifyUsers = data;
      } catch { verifyUsers = []; }

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

      // 加载所有用户（修复：try/catch包裹）
      let allUsers = [];
      try {
        const { data, error } = await Utils.withTimeout(
          AppState.sb.from("users").select("*").order("created_at", { ascending: false }),
          APP_CONFIG.TIMEOUT.API
        );
        if (!error && data) allUsers = data;
      } catch { allUsers = []; }

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

      // 加载登录日志（修复：try/catch包裹）
      let logs = [];
      try {
        const { data, error } = await Utils.withTimeout(
          AppState.sb.from("login_logs").select("*, users!inner(email, nick)").order("time", { ascending: false }).limit(20),
          APP_CONFIG.TIMEOUT.API
        );
        if (!error && data) logs = data;
      } catch { logs = []; }

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

  verifyUser: async (userId, status) => {
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ status }).eq("id", userId),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("操作失败");
      Notify.success(status === "active" ? "用户审核通过" : "用户审核拒绝");
      Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  forceUserOffline: async (userId) => {
    if (!confirm("确定要强制该用户下线吗？")) return;
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ current_session_token: null }).eq("id", userId),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("强制下线失败");
      Notify.success("用户已被强制下线");
      Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  setUserMute: async (userId, isMute) => {
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ is_mute: isMute }).eq("id", userId),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("操作失败");
      Notify.success(isMute ? "已禁言该用户" : "已解禁该用户");
      Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  setUserStatus: async (userId, status) => {
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ status }).eq("id", userId),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("操作失败");
      Notify.success(status === "active" ? "已解封该用户" : "已封禁该用户");
      Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  resetUserPwd: async (email) => {
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/chat` }),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("重置失败");
      Notify.success("密码重置邮件已发送");
    } catch (e) {
      Notify.error(e.message);
    }
  },

  saveSystemConfig: async () => {
    try {
      const requireVerify = Utils.DOM.$("#requireVerifyToggle").checked;
      const { data } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("id").maybeSingle(),
        APP_CONFIG.TIMEOUT.API
      );
      
      if (data?.id) {
        await Utils.withTimeout(
          AppState.sb.from("system_config").update({ require_verify: requireVerify }).eq("id", data.id),
          APP_CONFIG.TIMEOUT.API
        );
      } else {
        await Utils.withTimeout(
          AppState.sb.from("system_config").insert([{ require_verify: requireVerify }]),
          APP_CONFIG.TIMEOUT.API
        );
      }
      Notify.success(`系统配置保存成功，新用户注册${requireVerify ? "需要管理员审核" : "无需审核"}`);
    } catch (e) {
      Notify.error(e.message);
    }
  },

  saveSensitiveWords: async () => {
    try {
      const words = Utils.DOM.$("#sensitiveWordsInput").value.trim();
      const { data } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("id").maybeSingle(),
        APP_CONFIG.TIMEOUT.API
      );
      
      if (data?.id) {
        await Utils.withTimeout(
          AppState.sb.from("system_config").update({ sensitive_words: words }).eq("id", data.id),
          APP_CONFIG.TIMEOUT.API
        );
      } else {
        await Utils.withTimeout(
          AppState.sb.from("system_config").insert([{ sensitive_words: words }]),
          APP_CONFIG.TIMEOUT.API
        );
      }
      Notify.success("敏感词保存成功");
    } catch (e) {
      Notify.error(e.message);
    }
  },

  saveAnnouncement: async () => {
    try {
      const content = Utils.DOM.$("#announceInput").value.trim();
      const { data } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("id").maybeSingle(),
        APP_CONFIG.TIMEOUT.API
      );
      
      if (data?.id) {
        await Utils.withTimeout(
          AppState.sb.from("system_config").update({ announcement: content }).eq("id", data.id),
          APP_CONFIG.TIMEOUT.API
        );
      } else {
        await Utils.withTimeout(
          AppState.sb.from("system_config").insert([{ announcement: content }]),
          APP_CONFIG.TIMEOUT.API
        );
      }
      Notify.success("公告已推送");
    } catch (e) {
      Notify.error(e.message);
    }
  },

  deleteMsg: async (msgId) => {
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("messages").delete().eq("id", msgId),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("删除失败");
      Notify.success("消息已删除");
      await Chat.loadMessages();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  clearAllMessages: async () => {
    if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("messages").delete().not.is("id", null),
        APP_CONFIG.TIMEOUT.API
      );
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
  init: () => {
    if (EventBinder._bound) return;
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

      EventBinder._bound = true;
    } catch (e) {
      Notify.error("页面初始化失败，请刷新重试");
    }
  }
};

// ====================== 应用初始化 ======================
const App = {
  init: async () => {
    if (AppState.isLocked("isInit")) return;
    AppState.lock("isInit");

    try {
      AppState.timers.forceCloseLoader = setTimeout(() => {
        UI.closeLoader();
        AppState.reset();
        UI.showPage("loginPage");
      }, 5000);

      UI.initTheme();
      if (!window.supabase) throw new Error("Supabase SDK加载失败，请刷新页面重试");

      // 优化Supabase客户端配置，减少连接报错
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
            reconnect: true
          },
          global: {
            fetch: (...args) => Utils.withTimeout(fetch(...args), APP_CONFIG.TIMEOUT.API)
          }
        }
      );

      EventBinder.init();
      // 初始化时清理旧会话
      const { data: { session } } = await AppState.sb.auth.getSession();
      if (session?.user) await AppState.sb.auth.signOut().catch(() => {});

      AppState.reset();
      UI.showPage("loginPage");
      UI.closeLoader();
      // 监听认证状态
      AppState.sb.auth.onAuthStateChange((event, session) => Auth.handleAuthChange(event, session));
    } catch (e) {
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

// 修复：页面卸载前先关闭所有通道，避免消息通道报错
window.addEventListener("beforeunload", async (e) => {
  try {
    // 先关闭所有实时通道
    AppState.closeAllChannels();
    // 清理在线状态
    if (AppState.currentUser && AppState.sb) {
      await AppState.sb.from("online_users").delete().eq("user_id", AppState.currentUser.id).catch(() => {});
    }
  } catch {}
});

// 优化：页面可见性变化时的防抖处理
const visibilityChangeHandler = Utils.debounce(async () => {
  if (!document.hidden && AppState.currentUser && AppState.isSessionInitialized) {
    await Online.mark();
    await Online.refreshCount();
    UI.showAdminBtn();
  }
}, 500);
document.addEventListener("visibilitychange", visibilityChangeHandler);

// 主题变化监听
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => UI.initTheme());

// 全局挂载Admin对象
window.Admin = Admin;
