// ====================== 核心配置 ======================
const APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://ayavdkodhdmcxfufnnxo.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc",
  TIMEOUT: { API: 8000, LOGIN: 20000, IP_FETCH: 3000 },
  INTERVAL: { HEARTBEAT: 30000, SESSION_CHECK: 60000 },
  IP_API_LIST: ["https://api.ip.sb/ip", "https://ip.3322.net", "https://api.ipify.org?format=text"],
  IP_CACHE_TTL: 3600000
});

// ====================== 全局请求控制器 ======================
const RequestController = {
  controller: new AbortController(),
  get signal() { return this.controller.signal; },
  reset() {
    try {
      this.controller.abort();
      this.controller = new AbortController();
    } catch {}
  }
};

// ====================== 工具函数 ======================
const Utils = {
  Storage: {
    _ok: (() => {
      try { const k = "__t__"; localStorage.setItem(k, k); localStorage.removeItem(k); return true; }
      catch { return false; }
    })(),
    get: (k) => this._ok ? (localStorage.getItem(k) || "") : "",
    set: (k, v) => this._ok ? (localStorage.setItem(k, v), true) : false,
    remove: (k) => this._ok ? (localStorage.removeItem(k), true) : false,
    clear: () => this._ok ? (localStorage.clear(), true) : false
  },

  DOM: {
    $: (s) => document.querySelector(s) || {
      addEventListener: () => {}, removeEventListener: () => {},
      innerText: '', innerHTML: '', value: '', disabled: false, checked: false,
      classList: { add: () => {}, remove: () => {} }, style: { display: 'none' }
    },
    $$: (s) => document.querySelectorAll(s) || []
  },

  escapeHtml: (t) => {
    if (!t) return '';
    return String(t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  },

  debounce: (fn, wait) => {
    let t = null;
    const d = (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn(...args); }, wait);
    };
    d.cancel = () => t && clearTimeout(t);
    return d;
  },

  throttle: (fn, limit) => {
    let inThrottle = false;
    return function(...args) {
      if (!inThrottle) {
        inThrottle = true;
        Promise.resolve(fn.apply(this, args))
          .finally(() => setTimeout(() => inThrottle = false, limit));
      }
    };
  },

  uuid: () => {
    try { return crypto.randomUUID(); }
    catch { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  },

  withTimeout: (promise, timeoutMs, msg = "请求超时") => {
    let t = null;
    return Promise.race([
      promise,
      new Promise((_, rej) => t = setTimeout(() => rej(new Error(msg)), timeoutMs))
    ]).finally(() => t && clearTimeout(t));
  },

  isEmail: (e) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(String(e).trim()),

  formatErr: (err) => {
    const msg = typeof err === "string" ? err : (err?.message || err?.toString() || "未知错误");
    if (msg.includes("429") || msg.includes("rate limit")) return "请求过于频繁，请1分钟后再试";
    if (msg.includes("JWT") || msg.includes("token") || msg.includes("expired")) return "登录已过期，请重新登录";
    if (msg.includes("Email not confirmed")) return "邮箱未验证，请验证后登录";
    if (msg.includes("Invalid login credentials")) return "邮箱或密码错误";
    if (msg.includes("already registered")) return "该邮箱已被注册，请直接登录";
    if (msg.includes("banned")) return "账号已被封禁";
    return msg;
  },

  promiseAny: (promises) => {
    return new Promise((res, rej) => {
      if (!promises.length) rej(new Error("所有请求失败"));
      let errCount = 0;
      promises.forEach((p) => {
        Promise.resolve(p).then(res).catch(() => {
          errCount++;
          if (errCount === promises.length) rej(new Error("所有请求失败"));
        });
      });
    });
  }
};

// ====================== IP获取模块 ======================
const IPUtils = {
  async getIP() {
    const cache = sessionStorage.getItem("user_ip");
    const cacheTime = sessionStorage.getItem("user_ip_time");
    if (cache && cacheTime && Date.now() - Number(cacheTime) < APP_CONFIG.IP_CACHE_TTL) return cache;

    try {
      const promises = APP_CONFIG.IP_API_LIST.map(api =>
        Utils.withTimeout(
          fetch(api, { method: "GET", signal: RequestController.signal, headers: { Accept: "text/plain" } })
            .then(res => res.ok ? res.text() : Promise.reject()),
          APP_CONFIG.TIMEOUT.IP_FETCH
        ).then(ip => ip.trim())
      );
      const ip = await Utils.promiseAny(promises);
      if (!/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip)) throw new Error();
      
      sessionStorage.setItem("user_ip", ip);
      sessionStorage.setItem("user_ip_time", Date.now().toString());
      return ip;
    } catch {
      return "未知IP";
    }
  },
  clearCache() {
    sessionStorage.removeItem("user_ip");
    sessionStorage.removeItem("user_ip_time");
  }
};

// ====================== 通知模块 ======================
const Notify = {
  _t: null,
  show(type, text) {
    try {
      if (this._t) clearTimeout(this._t);
      const el = Utils.DOM.$("#winNotify");
      el.className = `win-notify ${type}`;
      el.innerText = text;
      el.classList.remove("hidden");
      this._t = setTimeout(() => { el.classList.add("hidden"); this._t = null; }, 6000);
    } catch { alert(text); }
  },
  success: (t) => Notify.show('success', t),
  error: (t) => Notify.show('error', t),
  warning: (t) => Notify.show('warning', t),
  info: (t) => Notify.show('info', t)
};

// ====================== 全局状态 ======================
const AppState = {
  sb: null,
  user: null,
  userNick: Utils.Storage.get("nick"),
  sessionToken: Utils.Storage.get("chat_current_session_token"),
  isInit: false,
  isLoadingMsg: false,
  config: { require_verify: false, sensitive_words: "", announcement: "" },
  _locks: {
    login: false, logout: false, auth: false, init: false,
    register: false, admin: false, adminLoad: false, configSync: false
  },
  channels: Object.create(null),
  timers: Object.create(null),

  lock(k) { return this._locks.hasOwnProperty(k) && (this._locks[k] = true); },
  unlock(k) { return this._locks.hasOwnProperty(k) && (this._locks[k] = false); },
  isLocked(k) { return this._locks[k] || false; },

  closeChannels() {
    try {
      if (!this.sb) return;
      Object.values(this.channels).forEach(c => {
        c.unsubscribe().catch(() => {});
        this.sb.removeChannel(c).catch(() => {});
      });
      this.channels = Object.create(null);
    } catch {}
  },

  clearTimers() {
    Object.values(this.timers).forEach(t => {
      clearTimeout(t);
      clearInterval(t);
    });
    this.timers = Object.create(null);
  },

  reset() {
    RequestController.reset();
    this.closeChannels();
    this.clearTimers();
    
    const adminBtn = Utils.DOM.$("#adminBtn");
    adminBtn.style.display = "none";
    adminBtn.classList.add("hidden");
    
    this.user = null;
    this.userNick = "";
    this.sessionToken = "";
    this.isInit = false;
    this.isLoadingMsg = false;
    this.config = { require_verify: false, sensitive_words: "", announcement: "" };
    
    Utils.Storage.remove("chat_current_session_token");
    Utils.Storage.remove("nick");
    IPUtils.clearCache();
    
    ["loginBtn", "regBtn", "sendBtn", "logoutBtn"].forEach(id => {
      const btn = Utils.DOM.$(`#${id}`);
      btn.disabled = false;
      btn.innerText = id === "loginBtn" ? "登录" : id === "regBtn" ? "注册" : id === "sendBtn" ? "发送" : "退出登录";
    });
    
    Object.keys(this._locks).forEach(k => this.unlock(k));
    ["msgInput", "loginEmail", "loginPwd", "regNick", "regEmail", "regPwd", "nickInput", "newPwdInput"].forEach(id => {
      Utils.DOM.$(`#${id}`).value = "";
    });
  }
};

// ====================== UI模块 ======================
const UI = {
  closeLoader() {
    try {
      if (AppState.timers.forceCloseLoader) clearTimeout(AppState.timers.forceCloseLoader);
      const loader = Utils.DOM.$("#loadingPage");
      loader.style.opacity = 0;
      setTimeout(() => { loader.classList.add("hidden"); loader.style.display = "none"; }, 300);
    } catch { Utils.DOM.$("#loadingPage")?.remove(); }
  },

  showPage(pageId) {
    try {
      const needLogin = ["chatPage", "settingPage", "adminPage"].includes(pageId);
      if (needLogin && !AppState.isInit) {
        AppState.reset();
        UI.showPage("loginPage");
        UI.closeLoader();
        return;
      }
      if (pageId === "adminPage" && !AppState.user?.isAdmin) {
        Notify.error("你没有管理员权限");
        return;
      }

      Utils.DOM.$$(".page").forEach(p => {
        p.classList.remove("active");
        p.classList.add("hidden");
      });
      const target = Utils.DOM.$(`#${pageId}`);
      target.classList.remove("hidden");
      target.classList.add("active");
      target.scrollTop = 0;

      if (pageId === "chatPage") setTimeout(() => UI.showAdminBtn(), 50);
    } catch (e) { Notify.error("页面切换失败：" + Utils.formatErr(e)); }
  },

  showAdminBtn() {
    try {
      const btn = Utils.DOM.$("#adminBtn");
      if (!AppState.user?.isAdmin) {
        btn.style.display = "none";
        btn.classList.add("hidden");
        return false;
      }
      btn.classList.remove("hidden");
      btn.style.display = "inline-block";
      return true;
    } catch { return false; }
  },

  initTheme() {
    try {
      const isDark = Utils.Storage.get("theme") === "dark" || window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = isDark ? "dark" : "";
      Utils.DOM.$("#toggleThemeBtn").innerText = isDark ? "切换浅色模式" : "切换深色模式";
    } catch {}
  },

  toggleTheme() {
    try {
      const root = document.documentElement;
      const isDark = root.dataset.theme === "dark";
      root.dataset.theme = isDark ? "" : "dark";
      isDark ? Utils.Storage.remove("theme") : Utils.Storage.set("theme", "dark");
      Utils.DOM.$("#toggleThemeBtn").innerText = isDark ? "切换深色模式" : "切换浅色模式";
    } catch { Notify.error("主题切换失败"); }
  }
};

// ====================== 配置模块 ======================
const Config = {
  async sync() {
    if (AppState.isLocked("configSync")) return;
    AppState.lock("configSync");
    try {
      const { data, error } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("*").maybeSingle().abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (!error && data) AppState.config = { ...AppState.config, ...data };
    } catch {} finally {
      AppState.unlock("configSync");
    }
  },

  initRealtime() {
    const name = "config";
    try {
      if (AppState.channels[name]) AppState.sb.removeChannel(AppState.channels[name]).catch(() => {});
      AppState.channels[name] = AppState.sb.channel(name)
        .on("postgres_changes", { event: "*", schema: "public", table: "system_config" }, (payload) => {
          if (payload.new) {
            AppState.config = { ...AppState.config, ...payload.new };
            Config.loadAnnounce();
          }
        })
        .subscribe();
    } catch {}
  },

  loadAnnounce() {
    try {
      const bar = Utils.DOM.$("#announceBar");
      const { announcement } = AppState.config;
      announcement?.trim() ? (bar.innerText = announcement, bar.classList.remove("hidden")) : bar.classList.add("hidden");
    } catch {}
  }
};

// ====================== 会话校验模块 ======================
const Session = {
  async invalid(reason = "账号在其他设备登录，已为你安全下线") {
    try {
      Notify.error(reason);
      AppState.isInit = false;
      if (AppState.sb) await AppState.sb.auth.signOut().catch(() => {});
      AppState.reset();
      Utils.Storage.clear();
      UI.showPage("loginPage");
      setTimeout(() => window.location.reload(), 800);
    } catch {
      AppState.reset();
      window.location.href = `${window.location.origin}/chat`;
    }
  },

  initCheck() {
    const name = "session";
    try {
      if (!AppState.user) return;
      if (AppState.channels[name]) AppState.sb.removeChannel(AppState.channels[name]).catch(() => {});

      AppState.channels[name] = AppState.sb.channel(name)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "users", filter: `id=eq.${AppState.user.id}` },
          async (payload) => {
            try {
              const { current_session_token, status } = payload.new || {};
              if (current_session_token && current_session_token !== AppState.sessionToken) await Session.invalid();
              if (status === "pending" || status === "ban") await Session.invalid(status === "ban" ? "账号已被封禁" : "账号正在等待管理员审核");
            } catch {}
          }
        )
        .subscribe();

      if (AppState.timers.sessionCheck) clearInterval(AppState.timers.sessionCheck);
      AppState.timers.sessionCheck = setInterval(async () => {
        if (!AppState.user || !AppState.isInit) return;
        try {
          const { data, error } = await Utils.withTimeout(
            AppState.sb.from("users").select("current_session_token, status").eq("id", AppState.user.id).single().abortSignal(RequestController.signal),
            APP_CONFIG.TIMEOUT.API
          );
          if (!error && data) {
            if (data.current_session_token !== AppState.sessionToken) await Session.invalid();
            if (data.status === "pending" || data.status === "ban") await Session.invalid(data.status === "ban" ? "账号已被封禁" : "账号正在等待管理员审核");
          }
        } catch {}
      }, APP_CONFIG.INTERVAL.SESSION_CHECK);
    } catch {}
  }
};

// ====================== 认证模块 ======================
const Auth = {
  register: Utils.throttle(async () => {
    if (AppState.isLocked("register")) {
      Notify.warning("正在注册中，请稍候...");
      return;
    }

    AppState.lock("register");
    const regBtn = Utils.DOM.$("#regBtn");
    regBtn.disabled = true;
    regBtn.innerText = "注册中...";
    let authUserId = null;

    try {
      const nick = Utils.DOM.$("#regNick").value.trim();
      const email = Utils.DOM.$("#regEmail").value.trim();
      const pwd = Utils.DOM.$("#regPwd").value.trim();
      
      if (!nick || !email || !pwd) throw new Error("请填写完整注册信息");
      if (!Utils.isEmail(email)) throw new Error("请输入正确的邮箱格式");
      if (pwd.length < 8) throw new Error("密码长度不能少于8位");

      const { require_verify } = AppState.config;
      const { data: authData, error: authError } = await Utils.withTimeout(
        AppState.sb.auth.signUp({
          email, password: pwd,
          options: { data: { nick }, emailRedirectTo: `${window.location.origin}/chat` }
        }),
        APP_CONFIG.TIMEOUT.LOGIN
      );

      if (authError) throw new Error(Utils.formatErr(authError));
      if (!authData.user) throw new Error("注册失败，未获取到用户信息");
      authUserId = authData.user.id;

      const { error: createError } = await Utils.withTimeout(
        AppState.sb.from("users").upsert([{
          id: authUserId, nick, email, is_admin: false,
          status: require_verify ? "pending" : "active",
          created_at: new Date().toISOString()
        }], { onConflict: "id" }).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (createError) throw new Error("用户信息初始化失败：" + createError.message);

      if (require_verify) await AppState.sb.auth.signOut().catch(() => {});
      Notify.success(require_verify ? "注册成功！账号正在等待管理员审核" : "注册成功，请前往邮箱验证后登录");
      ["regNick", "regEmail", "regPwd"].forEach(id => Utils.DOM.$(`#${id}`).value = "");
      UI.showPage("loginPage");
    } catch (e) {
      if (authUserId) await AppState.sb.auth.admin.deleteUser(authUserId).catch(() => {});
      Notify.error(`注册失败：${Utils.formatErr(e)}`);
    } finally {
      setTimeout(() => {
        AppState.unlock("register");
        regBtn.disabled = false;
        regBtn.innerText = "注册";
      }, 300);
    }
  }, 2000),

  login: Utils.throttle(async () => {
    if (AppState.isLocked("login")) {
      Notify.warning("正在登录中，请稍候...");
      return;
    }

    AppState.lock("login");
    const loginBtn = Utils.DOM.$("#loginBtn");
    loginBtn.disabled = true;
    loginBtn.innerText = "登录中...";

    try {
      const email = Utils.DOM.$("#loginEmail").value.trim();
      const pwd = Utils.DOM.$("#loginPwd").value.trim();
      
      if (!email || !pwd) throw new Error("请填写邮箱和密码");
      if (!Utils.isEmail(email)) throw new Error("请输入正确的邮箱格式");

      const { error } = await Utils.withTimeout(
        AppState.sb.auth.signInWithPassword({ email, password: pwd }),
        APP_CONFIG.TIMEOUT.LOGIN
      );
      if (error) throw new Error(Utils.formatErr(error));
    } catch (e) {
      Notify.error(`登录失败：${Utils.formatErr(e)}`);
    } finally {
      setTimeout(() => {
        AppState.unlock("login");
        loginBtn.disabled = false;
        loginBtn.innerText = "登录";
      }, 300);
    }
  }, 2000),

  async handleAuthChange(event, session) {
    if (AppState.isLocked("auth")) return;
    AppState.lock("auth");

    try {
      if (event === "TOKEN_EXPIRED" || event === "SIGNED_OUT") {
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

      await Config.sync();
      let userInfo = null;
      try {
        const { data, error } = await Utils.withTimeout(
          AppState.sb.from("users").select("*").eq("id", session.user.id).single().abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        );
        if (!error && data) userInfo = data;
      } catch {}

      const { require_verify } = AppState.config;
      if (!userInfo) {
        const { data: newUser, error: createError } = await Utils.withTimeout(
          AppState.sb.from("users").insert([{
            id: session.user.id,
            nick: session.user.user_metadata?.nick || session.user.email.split('@')[0],
            email: session.user.email, is_admin: false,
            status: require_verify ? "pending" : "active",
            created_at: session.user.created_at || new Date().toISOString()
          }]).select().single().abortSignal(RequestController.signal),
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

      Notify.info("账号验证成功，正在进入聊天...");
      AppState.user = session.user;
      AppState.user.isAdmin = [true, 'true', 1].includes(userInfo.is_admin);
      AppState.userNick = Utils.Storage.get("nick") || userInfo.nick || "用户";
      Utils.Storage.set("nick", AppState.userNick);

      Utils.Storage.remove("chat_current_session_token");
      const newToken = Utils.uuid();
      AppState.sessionToken = newToken;
      Utils.Storage.set("chat_current_session_token", newToken);

      await Utils.withTimeout(
        AppState.sb.from("users").update({
          current_session_token: newToken, last_login_time: new Date().toISOString()
        }).eq("id", AppState.user.id).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );

      AppState.isInit = true;
      Notify.success("登录成功，欢迎使用");
      if (AppState.user.isAdmin) Notify.success("管理员账号登录成功！");

      UI.showPage("chatPage");
      UI.closeLoader();
      Utils.DOM.$("#userTag").innerText = `用户：${AppState.userNick}`;

      setTimeout(async () => {
        try {
          Session.initCheck();
          await Chat.load();
          Chat.initRealtime();
          await Online.mark();
          await Online.refresh();
          Online.initRealtime();
          Config.initRealtime();
          Heartbeat.init();
          await LoginLog.record();
        } catch {
          Notify.warning("部分功能加载失败，不影响聊天使用");
        }
      }, 0);
    } catch (e) {
      Notify.error(`登录异常：${Utils.formatErr(e)}`);
      AppState.reset();
      await AppState.sb.auth.signOut().catch(() => {});
      UI.showPage("loginPage");
      UI.closeLoader();
    } finally {
      AppState.unlock("auth");
    }
  },

  async logout() {
    if (AppState.isLocked("logout")) {
      Notify.warning("正在退出中，请稍候...");
      return;
    }

    AppState.lock("logout");
    const logoutBtn = Utils.DOM.$("#logoutBtn");
    logoutBtn.disabled = true;
    logoutBtn.innerText = "退出中...";

    try {
      Notify.info("正在安全退出...");
      RequestController.reset();
      AppState.closeChannels();
      
      if (AppState.user && AppState.sb) {
        await Utils.withTimeout(
          AppState.sb.from("users").update({ current_session_token: null }).eq("id", AppState.user.id).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        ).catch(() => {});
        await Utils.withTimeout(
          AppState.sb.from("online_users").delete().eq("user_id", AppState.user.id).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        ).catch(() => {});
      }
      if (AppState.sb) await AppState.sb.auth.signOut();
      
      AppState.reset();
      Utils.Storage.clear();
      UI.showPage("loginPage");
      Notify.success("已安全退出登录");
    } catch (e) {
      Notify.error(`退出失败：${Utils.formatErr(e)}`);
      AppState.reset();
      Utils.Storage.clear();
      UI.showPage("loginPage");
    } finally {
      setTimeout(() => {
        AppState.unlock("logout");
        logoutBtn.disabled = false;
        logoutBtn.innerText = "退出登录";
      }, 300);
    }
  }
};

// ====================== 聊天模块 ======================
const Chat = {
  _debounceLoad: Utils.debounce(() => Chat.load(), 300),
  async load() {
    if (AppState.isLoadingMsg || !AppState.user) return;
    AppState.isLoadingMsg = true;

    try {
      const { data, error } = await Utils.withTimeout(
        AppState.sb.from("messages").select("*").order("id", { ascending: true }).limit(200).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("加载历史消息失败");
      Chat.render(data || []);
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.isLoadingMsg = false;
    }
  },

  render(list) {
    try {
      const box = Utils.DOM.$("#msgBox");
      let html = "";
      list.forEach(msg => {
        if (!msg?.id) return;
        const isMe = msg.user_id === AppState.user.id;
        const nick = Utils.escapeHtml(msg.nick || "匿名用户");
        const text = Utils.escapeHtml(msg.text || "");
        const time = Utils.escapeHtml(msg.time || "");
        const msgId = Utils.escapeHtml(msg.id.toString());
        
        html += `
          <div class="msg-item ${isMe ? 'msg-me' : 'msg-other'}">
            <div class="avatar">${nick.charAt(0)}</div>
            <div>
              <div class="msg-name">${nick}</div>
              <div class="bubble">${text}</div>
              <div class="msg-time">${time}</div>
            </div>
            ${AppState.user.isAdmin ? `<button class="win-btn small danger" onclick="Admin.delMsg(${msgId})">删除</button>` : ''}
          </div>
        `;
      });
      box.innerHTML = html;
      box.scrollTop = box.scrollHeight;
    } catch {
      Notify.error("消息渲染失败");
    }
  },

  initRealtime() {
    const name = "chat";
    try {
      if (!AppState.user) return;
      if (AppState.channels[name]) AppState.sb.removeChannel(AppState.channels[name]).catch(() => {});
      AppState.channels[name] = AppState.sb.channel(name)
        .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => Chat._debounceLoad())
        .subscribe();
    } catch {}
  },

  send: Utils.throttle(async () => {
    if (!AppState.user || !AppState.isInit) {
      Notify.error("请先登录");
      return;
    }

    const input = Utils.DOM.$("#msgInput");
    const text = input.value.trim();
    if (!text) {
      Notify.error("不能发送空消息");
      return;
    }

    const sendBtn = Utils.DOM.$("#sendBtn");
    sendBtn.disabled = true;
    sendBtn.innerText = "发送中...";

    try {
      const { sensitive_words } = AppState.config;
      let content = text;
      (sensitive_words || "").split(",").filter(w => w.trim()).forEach(word => {
        content = content.replaceAll(word, "***");
      });

      const { error } = await Utils.withTimeout(
        AppState.sb.from("messages").insert([{
          user_id: AppState.user.id,
          nick: AppState.userNick,
          text: content,
          time: new Date().toLocaleString()
        }]).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("发送消息失败");

      input.value = "";
      Notify.success("消息发送成功");
      await Chat.load();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.innerText = "发送";
    }
  }, 1000)
};

// ====================== 在线&心跳模块 ======================
const Online = {
  async mark() {
    if (!AppState.user || !AppState.isInit) return;
    try {
      await Utils.withTimeout(
        AppState.sb.from("online_users").upsert({
          user_id: AppState.user.id,
          nick: AppState.userNick,
          last_active: new Date().toISOString()
        }, { onConflict: "user_id" }).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
    } catch {}
  },

  async refresh() {
    try {
      const { data } = await Utils.withTimeout(
        AppState.sb.from("online_users").select("*").abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      Utils.DOM.$("#onlineNum").innerText = data?.length || 0;
    } catch {}
  },

  initRealtime() {
    const name = "online";
    try {
      if (!AppState.user) return;
      if (AppState.channels[name]) AppState.sb.removeChannel(AppState.channels[name]).catch(() => {});
      AppState.channels[name] = AppState.sb.channel(name)
        .on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, () => Online.refresh())
        .subscribe();
    } catch {}
  }
};

const Heartbeat = {
  init() {
    if (AppState.timers.heartbeat) clearInterval(AppState.timers.heartbeat);
    AppState.timers.heartbeat = setInterval(async () => {
      if (AppState.user && AppState.isInit) await Online.mark();
    }, APP_CONFIG.INTERVAL.HEARTBEAT);
  }
};

// ====================== 登录日志模块 ======================
const LoginLog = {
  async record() {
    if (!AppState.user) return;
    try {
      const ip = await IPUtils.getIP();
      await Utils.withTimeout(
        AppState.sb.from("login_logs").insert([{
          user_id: AppState.user.id,
          ip: ip,
          device: (navigator.userAgent || "未知设备").substring(0, 100),
          time: new Date().toLocaleString()
        }]).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
    } catch {}
  },

  async showMy() {
    if (!AppState.user || !AppState.isInit) {
      Notify.error("请先登录");
      return;
    }
    try {
      Notify.info("正在加载登录日志...");
      const { data, error } = await Utils.withTimeout(
        AppState.sb.from("login_logs").select("*").eq("user_id", AppState.user.id).order("time", { ascending: false }).limit(10).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("加载登录日志失败");

      if (!data?.length) {
        alert("=== 我的登录日志 ===\n\n暂无登录日志");
        return;
      }

      let text = "=== 我的登录日志 ===\n\n";
      data.forEach((log, i) => {
        text += `${i+1}. IP：${Utils.escapeHtml(log.ip || "未知")}\n   时间：${Utils.escapeHtml(log.time || "未知")}\n   设备：${Utils.escapeHtml(log.device || "未知")}\n\n`;
      });
      alert(text);
    } catch (e) {
      Notify.error(e.message);
    }
  }
};

// ====================== 设置模块 ======================
const Settings = {
  async saveNick() {
    if (!AppState.user || !AppState.isInit) {
      Notify.error("请先登录");
      return;
    }
    try {
      const newNick = Utils.DOM.$("#nickInput").value.trim();
      if (!newNick) throw new Error("请输入有效的昵称");
      
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ nick: newNick }).eq("id", AppState.user.id).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("保存昵称失败");
      
      AppState.userNick = newNick;
      Utils.Storage.set("nick", newNick);
      Utils.DOM.$("#userTag").innerText = `用户：${newNick}`;
      Utils.DOM.$("#nickInput").value = "";
      Notify.success("昵称保存成功");
      await Online.mark();
    } catch (e) {
      Notify.error(e.message);
    }
  },

  updatePwd: Utils.throttle(async () => {
    if (!AppState.user || !AppState.isInit) {
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
      if (error) throw new Error(Utils.formatErr(error));
      
      Notify.success("密码修改成功，请重新登录");
      Utils.DOM.$("#newPwdInput").value = "";
      setTimeout(() => Auth.logout(), 1500);
    } catch (e) {
      Notify.error(`修改失败：${Utils.formatErr(e)}`);
    }
  }, 3000)
};

// ====================== 管理员模块 ======================
const Admin = {
  async loadData() {
    if (!AppState.user?.isAdmin) {
      Notify.error("你没有管理员权限");
      return;
    }
    if (AppState.isLocked("adminLoad")) {
      Notify.warning("正在加载管理数据，请稍候...");
      return;
    }

    AppState.lock("adminLoad");
    try {
      Notify.info("正在加载管理数据...");
      await Config.sync();
      const { require_verify, sensitive_words, announcement } = AppState.config;
      
      Utils.DOM.$("#requireVerifyToggle").checked = require_verify || false;
      Utils.DOM.$("#sensitiveWordsInput").value = sensitive_words || "";
      Utils.DOM.$("#announceInput").value = announcement || "";

      const [verifyRes, userRes] = await Promise.allSettled([
        Utils.withTimeout(AppState.sb.from("users").select("*").eq("status", "pending").abortSignal(RequestController.signal), APP_CONFIG.TIMEOUT.API),
        Utils.withTimeout(AppState.sb.from("users").select("*").order("created_at", { ascending: false }).limit(50).abortSignal(RequestController.signal), APP_CONFIG.TIMEOUT.API)
      ]);

      // 渲染待审核用户
      let verifyUsers = verifyRes.status === "fulfilled" && !verifyRes.value.error ? verifyRes.value.data || [] : [];
      let verifyHtml = "";
      verifyUsers.forEach(u => {
        const id = Utils.escapeHtml(u.id);
        const email = Utils.escapeHtml(u.email);
        const nick = Utils.escapeHtml(u.nick);
        verifyHtml += `
          <div class="list-item">
            <span>${email}（${nick}）</span>
            <div class="btn-group">
              <button class="win-btn small primary" onclick="Admin.verify('${id}', 'active')">通过</button>
              <button class="win-btn small danger" onclick="Admin.verify('${id}', 'ban')">拒绝</button>
            </div>
          </div>
        `;
      });
      Utils.DOM.$("#verifyUserList").innerHTML = verifyHtml || "暂无待审核用户";

      // 渲染所有用户
      let allUsers = userRes.status === "fulfilled" && !userRes.value.error ? userRes.value.data || [] : [];
      let userHtml = "";
      allUsers.forEach(u => {
        const id = Utils.escapeHtml(u.id);
        const email = Utils.escapeHtml(u.email);
        const nick = Utils.escapeHtml(u.nick);
        const status = u.status === "active" ? "正常" : u.status === "ban" ? "封禁" : "待审核";
        const muteText = u.is_mute ? "解禁" : "禁言";
        const online = u.current_session_token ? "在线" : "离线";
        userHtml += `
          <div class="list-item">
            <span>${email}（${nick} | ${status} | ${online}）</span>
            <div class="btn-group">
              <button class="win-btn small secondary" onclick="Admin.resetPwd('${email}')">重置密码</button>
              <button class="win-btn small warning" onclick="Admin.setMute('${id}', ${!u.is_mute})">${muteText}</button>
              <button class="win-btn small ${u.status === 'ban' ? 'primary' : 'danger'}" onclick="Admin.setStatus('${id}', '${u.status === 'ban' ? 'active' : 'ban'}')">
                ${u.status === 'ban' ? '解封' : '封禁'}
              </button>
              <button class="win-btn small danger" onclick="Admin.forceOffline('${id}')">强制下线</button>
            </div>
          </div>
        `;
      });
      Utils.DOM.$("#allUserList").innerHTML = userHtml || "暂无用户";

      // 渲染登录日志
      let logs = [];
      try {
        const { data, error } = await Utils.withTimeout(
          AppState.sb.from("login_logs").select("*").order("time", { ascending: false }).limit(20).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        );
        if (!error && data) logs = data;
      } catch {}

      let logHtml = "";
      logs.forEach(log => {
        const ip = Utils.escapeHtml(log.ip || '未知');
        const time = Utils.escapeHtml(log.time || '未知');
        const device = Utils.escapeHtml(log.device || '未知');
        logHtml += `
          <div class="list-item">
            <span>IP：${ip} | ${time} | ${device.substring(0, 30)}...</span>
          </div>
        `;
      });
      Utils.DOM.$("#allLoginLogList").innerHTML = logHtml || "暂无登录日志";

      Notify.success("管理数据加载完成");
    } catch (e) {
      Notify.error("管理数据加载失败：" + Utils.formatErr(e));
    } finally {
      AppState.unlock("adminLoad");
    }
  },

  verify: Utils.throttle(async (userId, status) => {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在处理操作，请稍候...");
      return;
    }
    AppState.lock("admin");
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ status }).eq("id", userId).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("操作失败");
      Notify.success(status === "active" ? "用户审核通过" : "用户审核拒绝");
      Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  }, 1500),

  forceOffline: Utils.throttle(async (userId) => {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在处理操作，请稍候...");
      return;
    }
    if (!confirm("确定要强制该用户下线吗？")) return;
    AppState.lock("admin");
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ current_session_token: null }).eq("id", userId).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("强制下线失败");
      Notify.success("用户已被强制下线");
      Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  }, 1500),

  setMute: Utils.throttle(async (userId, isMute) => {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在处理操作，请稍候...");
      return;
    }
    AppState.lock("admin");
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ is_mute: isMute }).eq("id", userId).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("操作失败");
      Notify.success(isMute ? "已禁言该用户" : "已解禁该用户");
      Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  }, 1500),

  setStatus: Utils.throttle(async (userId, status) => {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在处理操作，请稍候...");
      return;
    }
    AppState.lock("admin");
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("users").update({ status }).eq("id", userId).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("操作失败");
      Notify.success(status === "active" ? "已解封该用户" : "已封禁该用户");
      Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  }, 1500),

  resetPwd: Utils.throttle(async (email) => {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在处理重置请求，请稍候...");
      return;
    }
    if (!confirm(`确定要给邮箱 ${email} 发送密码重置邮件吗？\n注意：频繁发送会触发限流，请谨慎操作`)) return;
    AppState.lock("admin");
    try {
      Notify.info("正在发送重置邮件...");
      const { error } = await Utils.withTimeout(
        AppState.sb.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/chat` }),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error(Utils.formatErr(error));
      Notify.success("密码重置邮件已发送，请注意查收");
    } catch (e) {
      Notify.error(`重置失败：${Utils.formatErr(e)}`);
    } finally {
      AppState.unlock("admin");
    }
  }, 3000),

  async saveConfig() {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在保存配置，请稍候...");
      return;
    }
    AppState.lock("admin");
    try {
      const requireVerify = Utils.DOM.$("#requireVerifyToggle").checked;
      const { data } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("id").maybeSingle().abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      
      if (data?.id) {
        await Utils.withTimeout(
          AppState.sb.from("system_config").update({ require_verify: requireVerify }).eq("id", data.id).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        );
      } else {
        await Utils.withTimeout(
          AppState.sb.from("system_config").insert([{ require_verify: requireVerify }]).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        );
      }
      AppState.config.require_verify = requireVerify;
      Notify.success(`系统配置保存成功，新用户注册${requireVerify ? "需要管理员审核" : "无需审核"}`);
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  },

  async saveSensitive() {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在保存敏感词，请稍候...");
      return;
    }
    AppState.lock("admin");
    try {
      const words = Utils.DOM.$("#sensitiveWordsInput").value.trim();
      const { data } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("id").maybeSingle().abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      
      if (data?.id) {
        await Utils.withTimeout(
          AppState.sb.from("system_config").update({ sensitive_words: words }).eq("id", data.id).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        );
      } else {
        await Utils.withTimeout(
          AppState.sb.from("system_config").insert([{ sensitive_words: words }]).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        );
      }
      AppState.config.sensitive_words = words;
      Notify.success("敏感词保存成功");
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  },

  async saveAnnounce() {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在保存公告，请稍候...");
      return;
    }
    AppState.lock("admin");
    try {
      const content = Utils.DOM.$("#announceInput").value.trim();
      const { data } = await Utils.withTimeout(
        AppState.sb.from("system_config").select("id").maybeSingle().abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      
      if (data?.id) {
        await Utils.withTimeout(
          AppState.sb.from("system_config").update({ announcement: content }).eq("id", data.id).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        );
      } else {
        await Utils.withTimeout(
          AppState.sb.from("system_config").insert([{ announcement: content }]).abortSignal(RequestController.signal),
          APP_CONFIG.TIMEOUT.API
        );
      }
      AppState.config.announcement = content;
      Notify.success("公告已推送");
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  },

  delMsg: Utils.throttle(async (msgId) => {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在删除消息，请稍候...");
      return;
    }
    AppState.lock("admin");
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("messages").delete().eq("id", msgId).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("删除失败");
      Notify.success("消息已删除");
      await Chat.load();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  }, 1500),

  async clearMsg() {
    if (AppState.isLocked("admin")) {
      Notify.warning("正在清空消息，请稍候...");
      return;
    }
    if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
    AppState.lock("admin");
    try {
      const { error } = await Utils.withTimeout(
        AppState.sb.from("messages").delete().not.is("id", null).abortSignal(RequestController.signal),
        APP_CONFIG.TIMEOUT.API
      );
      if (error) throw new Error("清空失败");
      Notify.success("所有消息已清空");
      await Chat.load();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.unlock("admin");
    }
  }
};

// ====================== 事件绑定 ======================
const EventBinder = {
  _bound: false,
  init() {
    if (this._bound) return;
    try {
      // 登录注册
      Utils.DOM.$("#toRegisterBtn").addEventListener("click", () => UI.showPage("registerPage"));
      Utils.DOM.$("#toLoginBtn").addEventListener("click", () => UI.showPage("loginPage"));
      Utils.DOM.$("#loginBtn").addEventListener("click", () => Auth.login());
      Utils.DOM.$("#regBtn").addEventListener("click", () => Auth.register());
      Utils.DOM.$("#loginPwd").addEventListener("keydown", (e) => e.key === "Enter" && Auth.login());
      Utils.DOM.$("#regPwd").addEventListener("keydown", (e) => e.key === "Enter" && Auth.register());
      Utils.DOM.$("#logoutBtn").addEventListener("click", () => Auth.logout());

      // 聊天
      Utils.DOM.$("#sendBtn").addEventListener("click", () => Chat.send());
      Utils.DOM.$("#msgInput").addEventListener("keydown", (e) => e.key === "Enter" && !e.shiftKey && Chat.send());

      // 页面导航
      Utils.DOM.$("#settingBtn").addEventListener("click", () => UI.showPage("settingPage"));
      Utils.DOM.$("#adminBtn").addEventListener("click", () => { Admin.loadData(); UI.showPage("adminPage"); });
      Utils.DOM.$("#backToChatBtn").addEventListener("click", () => UI.showPage("chatPage"));
      Utils.DOM.$("#backToChatFromAdminBtn").addEventListener("click", () => UI.showPage("chatPage"));

      // 设置
      Utils.DOM.$("#saveNickBtn").addEventListener("click", () => Settings.saveNick());
      Utils.DOM.$("#toggleThemeBtn").addEventListener("click", () => UI.toggleTheme());
      Utils.DOM.$("#updatePwdBtn").addEventListener("click", () => Settings.updatePwd());
      Utils.DOM.$("#showLoginLogBtn").addEventListener("click", () => LoginLog.showMy());

      // 管理员
      Utils.DOM.$("#saveConfigBtn").addEventListener("click", () => Admin.saveConfig());
      Utils.DOM.$("#saveSwBtn").addEventListener("click", () => Admin.saveSensitive());
      Utils.DOM.$("#saveAnnounceBtn").addEventListener("click", () => Admin.saveAnnounce());
      Utils.DOM.$("#clearAllMsgBtn").addEventListener("click", () => Admin.clearMsg());

      this._bound = true;
    } catch (e) {
      Notify.error("页面初始化失败，请刷新重试");
    }
  }
};

// ====================== 应用初始化 ======================
const App = {
  async init() {
    if (AppState.isLocked("init")) return;
    AppState.lock("init");
    try {
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
          auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true, storage: Utils.Storage._ok ? window.localStorage : null },
          realtime: { timeout: APP_CONFIG.TIMEOUT.API, heartbeatIntervalMs: APP_CONFIG.INTERVAL.HEARTBEAT, reconnect: true },
          global: { fetch: (...args) => fetch(...args, { signal: RequestController.signal }) }
        }
      );

      EventBinder.init();
      const { data: { session } } = await AppState.sb.auth.getSession();
      if (session?.user) await AppState.sb.auth.signOut().catch(() => {});

      AppState.reset();
      UI.showPage("loginPage");
      UI.closeLoader();
      AppState.sb.auth.onAuthStateChange((event, session) => Auth.handleAuthChange(event, session));
    } catch (e) {
      Notify.error(`初始化失败：${Utils.formatErr(e)}`);
      UI.closeLoader();
      AppState.reset();
      UI.showPage("loginPage");
    } finally {
      AppState.unlock("init");
    }
  }
};

// ====================== 生命周期 ======================
document.addEventListener("DOMContentLoaded", () => App.init());
window.addEventListener("beforeunload", () => {
  try {
    RequestController.reset();
    AppState.closeChannels();
    if (AppState.user && AppState.sb) {
      navigator.sendBeacon(`${APP_CONFIG.SUPABASE_URL}/rest/v1/online_users?user_id=eq.${AppState.user.id}`, JSON.stringify({}));
    }
  } catch {}
});
document.addEventListener("visibilitychange", Utils.debounce(async () => {
  if (!document.hidden && AppState.user && AppState.isInit) {
    await Online.mark();
    await Online.refresh();
    UI.showAdminBtn();
  }
}, 500));
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => UI.initTheme());
window.Admin = Admin;
