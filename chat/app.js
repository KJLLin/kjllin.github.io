// ====================== 核心配置 ======================
const APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://ayavdkodhdmcxfufnnxo.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc",
  TIMEOUT: { API: 8000, LOGIN: 20000, IP_FETCH: 3000 },
  INTERVAL: { HEARTBEAT: 30000, SESSION_CHECK: 60000 },
  IP_API_LIST: ["https://api.ip.sb/ip", "https://ip.3322.net", "https://api.ipify.org?format=text"],
  IP_CACHE_TTL: 3600000,
  DEFAULT_CONFIG: Object.freeze({ id: 1, require_verify: false, sensitive_words: "", announcement: "" }),
  CONFIG_ID: 1 // 固定全局配置唯一ID，彻底解决多条记录问题
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

  $: (s) => document.querySelector(s) || {
    addEventListener: () => {}, removeEventListener: () => {},
    innerText: '', innerHTML: '', value: '', disabled: false, checked: false,
    classList: { add: () => {}, remove: () => {} }, style: { display: 'none' }
  },
  $$: (s) => document.querySelectorAll(s) || [],

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

  // 统一Supabase请求处理，严格符合SDK规范
  request: async (promise, timeoutMsg = "请求超时") => {
    try {
      const res = await Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(timeoutMsg)), APP_CONFIG.TIMEOUT.API))
      ]);
      // 严格处理Supabase返回：有error直接抛出
      if (res?.error) throw res.error;
      return res;
    } catch (e) {
      throw new Error(Utils.formatErr(e));
    }
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
    if (msg.includes("multiple rows")) return "数据异常，已自动修复，请重试";
    return msg;
  },

  promiseAny: (promises) => {
    return new Promise((res, rej) => {
      if (!promises.length) rej(new Error("所有请求失败"));
      let errCount = 0;
      promises.forEach(p => Promise.resolve(p).then(res).catch(() => {
        if (++errCount === promises.length) rej(new Error("所有请求失败"));
      }));
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
        fetch(api, { method: "GET", signal: RequestController.signal, headers: { Accept: "text/plain" } })
          .then(res => res.ok ? res.text().then(t => t.trim()) : Promise.reject())
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
      const el = Utils.$("#winNotify");
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
  config: { ...APP_CONFIG.DEFAULT_CONFIG },
  // 精细化锁机制，彻底解决互斥死锁
  _locks: {
    login: false, logout: false, auth: false, init: false, register: false,
    admin_load: false, admin_verify: false, admin_offline: false, admin_mute: false,
    admin_status: false, admin_pwd: false, admin_config: false, admin_msg: false
  },
  channels: Object.create(null),
  timers: Object.create(null),

  lock(k) { return this._locks.hasOwnProperty(k) && (this._locks[k] = true); },
  unlock(k) { return this._locks.hasOwnProperty(k) && (this._locks[k] = false); },
  isLocked(k) { return this._locks[k] || false; },

  // 重置所有状态，彻底清理缓存
  reset() {
    RequestController.reset();
    // 清理所有实时通道
    try {
      if (this.sb) Object.values(this.channels).forEach(c => {
        c.unsubscribe().catch(() => {});
        this.sb.removeChannel(c).catch(() => {});
      });
    } catch {}
    this.channels = Object.create(null);

    // 清理所有定时器
    Object.values(this.timers).forEach(t => { clearTimeout(t); clearInterval(t); });
    this.timers = Object.create(null);

    // 重置UI
    const adminBtn = Utils.$("#adminBtn");
    adminBtn.style.display = "none";
    adminBtn.classList.add("hidden");
    
    // 重置状态
    this.user = null;
    this.userNick = "";
    this.sessionToken = "";
    this.isInit = false;
    this.isLoadingMsg = false;
    this.config = { ...APP_CONFIG.DEFAULT_CONFIG };
    
    // 清理存储
    Utils.Storage.remove("chat_current_session_token");
    Utils.Storage.remove("nick");
    IPUtils.clearCache();
    
    // 重置按钮
    ["loginBtn", "regBtn", "sendBtn", "logoutBtn"].forEach(id => {
      const btn = Utils.$(`#${id}`);
      btn.disabled = false;
      btn.innerText = id === "loginBtn" ? "登录" : id === "regBtn" ? "注册" : id === "sendBtn" ? "发送" : "退出登录";
    });
    
    // 解锁所有锁
    Object.keys(this._locks).forEach(k => this.unlock(k));
    // 清空输入框
    ["msgInput", "loginEmail", "loginPwd", "regNick", "regEmail", "regPwd", "nickInput", "newPwdInput"].forEach(id => {
      Utils.$(`#${id}`).value = "";
    });
  }
};

// ====================== UI模块 ======================
const UI = {
  closeLoader() {
    try {
      if (AppState.timers.forceCloseLoader) clearTimeout(AppState.timers.forceCloseLoader);
      const loader = Utils.$("#loadingPage");
      loader.style.opacity = 0;
      setTimeout(() => { loader.classList.add("hidden"); loader.style.display = "none"; }, 300);
    } catch { Utils.$("#loadingPage")?.remove(); }
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

      Utils.$$(".page").forEach(p => {
        p.classList.remove("active");
        p.classList.add("hidden");
      });
      const target = Utils.$(`#${pageId}`);
      target.classList.remove("hidden");
      target.classList.add("active");
      target.scrollTop = 0;

      if (pageId === "chatPage") setTimeout(() => UI.showAdminBtn(), 50);
    } catch (e) { Notify.error("页面切换失败：" + Utils.formatErr(e)); }
  },

  showAdminBtn() {
    try {
      const btn = Utils.$("#adminBtn");
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
      Utils.$("#toggleThemeBtn").innerText = isDark ? "切换浅色模式" : "切换深色模式";
    } catch {}
  },

  toggleTheme() {
    try {
      const root = document.documentElement;
      const isDark = root.dataset.theme === "dark";
      root.dataset.theme = isDark ? "" : "dark";
      isDark ? Utils.Storage.remove("theme") : Utils.Storage.set("theme", "dark");
      Utils.$("#toggleThemeBtn").innerText = isDark ? "切换深色模式" : "切换浅色模式";
    } catch { Notify.error("主题切换失败"); }
  },

  // 更新用户头像
  updateUserAvatar(nick) {
    try {
      const avatar = Utils.$("#userAvatar");
      avatar.innerText = (nick || "用户").charAt(0);
    } catch {}
  }
};

// ====================== 系统配置模块 ======================
const Config = {
  // 同步全局配置，自动修复脏数据
  async sync() {
    try {
      // 用limit(1)取第一条，兼容多条脏数据，不会报错
      const { data } = await Utils.request(
        AppState.sb.from("system_config").select("*").limit(1).order("id", { ascending: true }).abortSignal(RequestController.signal)
      );
      
      // 有有效数据：合并默认值，避免null覆盖
      if (data && data.length > 0) {
        AppState.config = { ...APP_CONFIG.DEFAULT_CONFIG, ...data[0] };
        // 自动清理脏数据：如果有多条记录，删除id!=1的多余数据
        if (data.length > 1) {
          await Utils.request(
            AppState.sb.from("system_config").delete().neq("id", APP_CONFIG.CONFIG_ID).abortSignal(RequestController.signal)
          ).catch(() => {});
        }
      } else {
        // 无数据：初始化默认配置
        await Utils.request(
          AppState.sb.from("system_config").insert([APP_CONFIG.DEFAULT_CONFIG]).abortSignal(RequestController.signal)
        );
        AppState.config = { ...APP_CONFIG.DEFAULT_CONFIG };
      }
    } catch (e) {
      console.warn("配置同步失败", e);
      AppState.config = { ...APP_CONFIG.DEFAULT_CONFIG };
    }
  },

  // 统一配置保存方法，固定ID upsert，永远只有一条记录
  async save(updateData) {
    if (AppState.isLocked("admin_config")) {
      Notify.warning("正在保存配置，请稍候...");
      return false;
    }
    AppState.lock("admin_config");

    try {
      // 原子化upsert：固定id=1，有则更新，无则插入，永远不会生成多条记录
      const saveData = { ...APP_CONFIG.DEFAULT_CONFIG, ...AppState.config, ...updateData, id: APP_CONFIG.CONFIG_ID };
      const { error } = await Utils.request(
        AppState.sb.from("system_config").upsert(saveData, { onConflict: "id" }).abortSignal(RequestController.signal)
      );
      if (error) throw error;

      // 同步更新本地缓存
      AppState.config = saveData;
      return true;
    } catch (e) {
      Notify.error("配置保存失败：" + Utils.formatErr(e));
      return false;
    } finally {
      AppState.unlock("admin_config");
    }
  },

  // 实时配置监听
  initRealtime() {
    try {
      if (AppState.channels.config) AppState.sb.removeChannel(AppState.channels.config).catch(() => {});
      AppState.channels.config = AppState.sb.channel("config")
        .on("postgres_changes", { event: "*", schema: "public", table: "system_config" }, (payload) => {
          if (payload.new) {
            AppState.config = { ...APP_CONFIG.DEFAULT_CONFIG, ...payload.new };
            // 更新公告栏
            const bar = Utils.$("#announceBar");
            const textEl = Utils.$("#announceText");
            const content = payload.new.announcement?.trim();
            if (content) {
              textEl.innerText = content;
              bar.classList.remove("hidden");
            } else {
              bar.classList.add("hidden");
            }
          }
        })
        .subscribe();
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
    try {
      if (!AppState.user) return;
      if (AppState.channels.session) AppState.sb.removeChannel(AppState.channels.session).catch(() => {});

      AppState.channels.session = AppState.sb.channel("session")
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
          const { data } = await Utils.request(
            AppState.sb.from("users").select("current_session_token, status").eq("id", AppState.user.id).limit(1).abortSignal(RequestController.signal)
          );
          if (data && data.length > 0) {
            const userData = data[0];
            if (userData.current_session_token !== AppState.sessionToken) await Session.invalid();
            if (userData.status === "pending" || userData.status === "ban") await Session.invalid(userData.status === "ban" ? "账号已被封禁" : "账号正在等待管理员审核");
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
    const regBtn = Utils.$("#regBtn");
    regBtn.disabled = true;
    regBtn.innerText = "注册中...";
    let authUserId = null;

    try {
      const nick = Utils.$("#regNick").value.trim();
      const email = Utils.$("#regEmail").value.trim();
      const pwd = Utils.$("#regPwd").value.trim();
      
      if (!nick || !email || !pwd) throw new Error("请填写完整注册信息");
      if (!Utils.isEmail(email)) throw new Error("请输入正确的邮箱格式");
      if (pwd.length < 8) throw new Error("密码长度不能少于8位");

      // 确保使用最新配置
      await Config.sync();
      const { require_verify } = AppState.config;
      const defaultStatus = require_verify ? "pending" : "active";

      const { data: authData, error: authError } = await Utils.request(
        AppState.sb.auth.signUp({
          email, password: pwd,
          options: { data: { nick }, emailRedirectTo: `${window.location.origin}/chat` }
        }), "注册请求超时"
      );

      if (authError) throw authError;
      if (!authData.user) throw new Error("注册失败，未获取到用户信息");
      authUserId = authData.user.id;

      // 初始化用户表
      const { error: createError } = await Utils.request(
        AppState.sb.from("users").upsert([{
          id: authUserId, nick, email, is_admin: false,
          status: defaultStatus, created_at: new Date().toISOString()
        }], { onConflict: "id" }).abortSignal(RequestController.signal)
      );
      if (createError) throw createError;

      // 注册成功处理
      if (require_verify) await AppState.sb.auth.signOut().catch(() => {});
      Notify.success(require_verify ? "注册成功！账号正在等待管理员审核" : "注册成功，请前往邮箱验证后登录");
      ["regNick", "regEmail", "regPwd"].forEach(id => Utils.$(`#${id}`).value = "");
      UI.showPage("loginPage");
    } catch (e) {
      // 注册失败回滚，删除auth用户
      if (authUserId) await AppState.sb.auth.admin.deleteUser(authUserId).catch(() => {});
      Notify.error(`注册失败：${Utils.formatErr(e)}`);
    } finally {
      setTimeout(() => {
        AppState.unlock("register");
        regBtn.disabled = false;
        regBtn.innerText = "完成注册";
      }, 300);
    }
  }, 2000),

  login: Utils.throttle(async () => {
    if (AppState.isLocked("login")) {
      Notify.warning("正在登录中，请稍候...");
      return;
    }

    AppState.lock("login");
    const loginBtn = Utils.$("#loginBtn");
    loginBtn.disabled = true;
    loginBtn.innerText = "登录中...";

    try {
      const email = Utils.$("#loginEmail").value.trim();
      const pwd = Utils.$("#loginPwd").value.trim();
      
      if (!email || !pwd) throw new Error("请填写邮箱和密码");
      if (!Utils.isEmail(email)) throw new Error("请输入正确的邮箱格式");

      const { error } = await Utils.request(
        AppState.sb.auth.signInWithPassword({ email, password: pwd }), "登录请求超时"
      );
      if (error) throw error;
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
      // 处理登出/过期
      if (event === "TOKEN_EXPIRED" || event === "SIGNED_OUT") {
        AppState.reset();
        UI.showPage("loginPage");
        UI.closeLoader();
        return;
      }

      // 无效会话处理
      if (!["SIGNED_IN", "INITIAL_SESSION"].includes(event) || !session?.user) {
        AppState.reset();
        UI.showPage("loginPage");
        UI.closeLoader();
        return;
      }

      // 同步最新配置
      await Config.sync();
      // 获取用户信息
      let userInfo = null;
      try {
        const { data } = await Utils.request(
          AppState.sb.from("users").select("*").eq("id", session.user.id).limit(1).abortSignal(RequestController.signal)
        );
        if (data && data.length > 0) userInfo = data[0];
      } catch {}

      // 新用户初始化
      if (!userInfo) {
        const { data: newUser } = await Utils.request(
          AppState.sb.from("users").insert([{
            id: session.user.id,
            nick: session.user.user_metadata?.nick || session.user.email.split('@')[0],
            email: session.user.email, is_admin: false,
            status: AppState.config.require_verify ? "pending" : "active",
            created_at: session.user.created_at || new Date().toISOString()
          }]).select().limit(1).abortSignal(RequestController.signal)
        );
        if (newUser && newUser.length > 0) userInfo = newUser[0];
      }

      // 校验用户状态
      if (!userInfo) throw new Error("用户信息初始化失败，请刷新重试");
      if (userInfo.status === "ban") throw new Error("账号已被封禁，无法登录");
      if (userInfo.status === "pending") {
        await AppState.sb.auth.signOut().catch(() => {});
        throw new Error("你的账号正在等待管理员审核，审核通过后即可登录");
      }

      // 登录成功初始化
      Notify.info("账号验证成功，正在进入聊天...");
      AppState.user = session.user;
      AppState.user.isAdmin = [true, 'true', 1].includes(userInfo.is_admin);
      AppState.userNick = Utils.Storage.get("nick") || userInfo.nick || "用户";
      Utils.Storage.set("nick", AppState.userNick);

      // 更新用户头像
      UI.updateUserAvatar(AppState.userNick);

      // 生成会话Token，单设备登录
      Utils.Storage.remove("chat_current_session_token");
      const newToken = Utils.uuid();
      AppState.sessionToken = newToken;
      Utils.Storage.set("chat_current_session_token", newToken);

      // 更新用户登录信息
      await Utils.request(
        AppState.sb.from("users").update({
          current_session_token: newToken, last_login_time: new Date().toISOString()
        }).eq("id", AppState.user.id).abortSignal(RequestController.signal)
      );

      AppState.isInit = true;
      Notify.success("登录成功，欢迎使用");
      if (AppState.user.isAdmin) Notify.success("管理员账号登录成功！");

      UI.showPage("chatPage");
      UI.closeLoader();
      Utils.$("#userTag").innerText = `用户：${AppState.userNick}`;

      // 异步初始化模块
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
    const logoutBtn = Utils.$("#logoutBtn");
    logoutBtn.disabled = true;
    logoutBtn.innerText = "退出中...";

    try {
      Notify.info("正在安全退出...");
      RequestController.reset();
      
      // 清理用户会话
      if (AppState.user && AppState.sb) {
        await Utils.request(
          AppState.sb.from("users").update({ current_session_token: null }).eq("id", AppState.user.id).abortSignal(RequestController.signal)
        ).catch(() => {});
        await Utils.request(
          AppState.sb.from("online_users").delete().eq("user_id", AppState.user.id).abortSignal(RequestController.signal)
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
      const { data, error } = await Utils.request(
        AppState.sb.from("messages").select("*").order("id", { ascending: true }).limit(200).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      Chat.render(data || []);
    } catch (e) {
      Notify.error(e.message);
    } finally {
      AppState.isLoadingMsg = false;
    }
  },

  render(list) {
    try {
      const box = Utils.$("#msgBox");
      const emptyState = Utils.$("#msgEmptyState");
      
      // 处理空状态
      if (!list || list.length === 0) {
        box.innerHTML = "";
        emptyState.classList.remove("hidden");
        return;
      }
      
      emptyState.classList.add("hidden");
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
            <div class="msg-content">
              <div class="msg-name">${nick}</div>
              <div class="bubble-wrapper">
                <div class="bubble">${text}</div>
              </div>
              <div class="msg-time">${time}</div>
            </div>
            ${AppState.user.isAdmin ? `<button class="btn btn-danger btn-sm" onclick="Admin.delMsg(${msgId}, this)">删除</button>` : ''}
          </div>
        `;
      });
      box.innerHTML = html;
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      Notify.error("消息渲染失败");
      console.error(e);
    }
  },

  initRealtime() {
    try {
      if (AppState.channels.chat) AppState.sb.removeChannel(AppState.channels.chat).catch(() => {});
      AppState.channels.chat = AppState.sb.channel("chat")
        .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => Chat._debounceLoad())
        .subscribe();
    } catch {}
  },

  send: Utils.throttle(async () => {
    if (!AppState.user || !AppState.isInit) {
      Notify.error("请先登录");
      return;
    }

    const input = Utils.$("#msgInput");
    const text = input.value.trim();
    if (!text) {
      Notify.error("不能发送空消息");
      return;
    }

    const sendBtn = Utils.$("#sendBtn");
    sendBtn.disabled = true;
    sendBtn.innerText = "发送中...";

    try {
      // 敏感词过滤
      const { sensitive_words } = AppState.config;
      let content = text;
      (sensitive_words || "").split(",").filter(w => w.trim()).forEach(word => {
        content("messages").insert([{
          user_id: AppState.user.id,
          nick: AppState.userNick,
          text: content,
          time: new Date().toLocaleString()
        }]).abortSignal(RequestController.signal)
      );
      if (error) throw error;

      input.value = "";
      input.style.height = "auto"; // 重置输入框高度
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
      await Utils.request(
        AppState.sb.from("online_users").upsert({
          user_id: AppState.user.id,
          nick: AppState.userNick,
          last_active: new Date().toISOString()
        }, { onConflict: "user_id" }).abortSignal(RequestController.signal)
      );
    } catch {}
  },

  async refresh() {
    try {
      const { data } = await Utils.request(
        AppState.sb.from("online_users").select("*").abortSignal(RequestController.signal)
      );
      Utils.$("#onlineNum").innerText = data?.length || 0;
    } catch {}
  },

  initRealtime() {
    try {
      if (AppState.channels.online) AppState.sb.removeChannel(AppState.channels.online).catch(() => {});
      AppState.channels.online = AppState.sb.channel("online")
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
      await Utils.request(
        AppState.sb.from("login_logs").insert([{
          user_id: AppState.user.id,
          ip: ip,
          device: (navigator.userAgent || "未知设备").substring(0, 100),
          time: new Date().toLocaleString()
        }]).abortSignal(RequestController.signal)
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
      const { data, error } = await Utils.request(
        AppState.sb.from("login_logs").select("*").eq("user_id", AppState.user.id).order("time", { ascending: false }).limit(10).abortSignal(RequestController.signal)
      );
      if (error) throw error;

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
      const newNick = Utils.$("#nickInput").value.trim();
      if (!newNick) throw new Error("请输入有效的昵称");
      
      const { error } = await Utils.request(
        AppState.sb.from("users").update({ nick: newNick }).eq("id", AppState.user.id).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      
      AppState.userNick = newNick;
      Utils.Storage.set("nick", newNick);
      Utils.$("#userTag").innerText = `用户：${newNick}`;
      UI.updateUserAvatar(newNick);
      Utils.$("#nickInput").value = "";
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
      const newPwd = Utils.$("#newPwdInput").value.trim();
      if (newPwd.length < 8) throw new Error("密码长度不能少于8位");
      
      const { error } = await Utils.request(
        AppState.sb.auth.updateUser({ password: newPwd }), "修改密码请求超时"
      );
      if (error) throw error;
      
      Notify.success("密码修改成功，请重新登录");
      Utils.$("#newPwdInput").value = "";
      setTimeout(() => Auth.logout(), 1500);
    } catch (e) {
      Notify.error(`修改失败：${Utils.formatErr(e)}`);
    }
  }, 3000)
};

// ====================== 管理员模块（核心报错修复） ======================
window.Admin = {
  _scrollTop: 0, // 记录滚动位置

  // 加载管理数据
  async loadData() {
    if (!AppState.user?.isAdmin) {
      Notify.error("你没有管理员权限");
      return;
    }
    if (AppState.isLocked("admin_load")) {
      Notify.warning("正在加载管理数据，请稍候...");
      return;
    }

    AppState.lock("admin_load");
    try {
      Notify.info("正在加载管理数据...");
      // 同步最新配置，确保回显正确
      await Config.sync();
      const { require_verify, sensitive_words, announcement } = AppState.config;
      
      // 回显配置
      Utils.$("#requireVerifyToggle").checked = require_verify || false;
      Utils.$("#sensitiveWordsInput").value = sensitive_words || "";
      Utils.$("#announceInput").value = announcement || "";

      // 并行加载数据
      const [verifyRes, userRes, logRes] = await Promise.allSettled([
        Utils.request(AppState.sb.from("users").select("*").eq("status", "pending").abortSignal(RequestController.signal)),
        Utils.request(AppState.sb.from("users").select("*").order("created_at", { ascending: false }).limit(50).abortSignal(RequestController.signal)),
        Utils.request(AppState.sb.from("login_logs").select("*").order("time", { ascending: false }).limit(20).abortSignal(RequestController.signal))
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
              <button class="btn btn-primary btn-sm" onclick="Admin.verify('${id}', 'active', this)">通过</button>
              <button class="btn btn-danger btn-sm" onclick="Admin.verify('${id}', 'ban', this)">拒绝</button>
            </div>
          </div>
        `;
      });
      Utils.$("#verifyUserList").innerHTML = verifyHtml || "暂无待审核用户";

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
              <button class="btn btn-secondary btn-sm" onclick="Admin.resetPwd('${email}', this)">重置密码</button>
              <button class="btn btn-warning btn-sm" onclick="Admin.setMute('${id}', ${!u.is_mute}, this)">${muteText}</button>
              <button class="btn ${u.status === 'ban' ? 'btn-primary' : 'btn-danger'} btn-sm" onclick="Admin.setStatus('${id}', '${u.status === 'ban' ? 'active' : 'ban'}', this)">
                ${u.status === 'ban' ? '解封' : '封禁'}
              </button>
              <button class="btn btn-danger btn-sm" onclick="Admin.forceOffline('${id}', this)">强制下线</button>
            </div>
          </div>
        `;
      });
      Utils.$("#allUserList").innerHTML = userHtml || "暂无用户";

      // 渲染登录日志
      let logs = logRes.status === "fulfilled" && !logRes.value.error ? logRes.value.data || [] : [];
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
      Utils.$("#allLoginLogList").innerHTML = logHtml || "暂无登录日志";

      // 恢复滚动位置
      if (Admin._scrollTop) {
        Utils.$("#adminPage").scrollTop = Admin._scrollTop;
        Admin._scrollTop = 0;
      }

      Notify.success("管理数据加载完成");
    } catch (e) {
      Notify.error("管理数据加载失败：" + Utils.formatErr(e));
    } finally {
      AppState.unlock("admin_load");
    }
  },

  // 审核用户
  verify: Utils.throttle(async (userId, status, btn) => {
    if (AppState.isLocked("admin_verify")) {
      Notify.warning("正在处理审核，请稍候...");
      return;
    }
    AppState.lock("admin_verify");
    btn.disabled = true;
    const originText = btn.innerText;
    btn.innerText = "处理中...";

    try {
      const { error } = await Utils.request(
        AppState.sb.from("users").update({ status }).eq("id", userId).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      Notify.success(status === "active" ? "用户审核通过" : "用户审核拒绝");
      Admin._scrollTop = Utils.$("#adminPage").scrollTop;
      await Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
      btn.disabled = false;
      btn.innerText = originText;
    } finally {
      AppState.unlock("admin_verify");
    }
  }, 1500),

  // 强制下线
  forceOffline: Utils.throttle(async (userId, btn) => {
    if (AppState.isLocked("admin_offline")) {
      Notify.warning("正在处理强制下线，请稍候...");
      return;
    }
    if (!confirm("确定要强制该用户下线吗？")) return;
    AppState.lock("admin_offline");
    btn.disabled = true;
    btn.innerText = "处理中...";

    try {
      const { error } = await Utils.request(
        AppState.sb.from("users").update({ current_session_token: null }).eq("id", userId).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      Notify.success("用户已被强制下线");
      Admin._scrollTop = Utils.$("#adminPage").scrollTop;
      await Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
      btn.disabled = false;
      btn.innerText = "强制下线";
    } finally {
      AppState.unlock("admin_offline");
    }
  }, 1500),

  // 禁言/解禁
  setMute: Utils.throttle(async (userId, isMute, btn) => {
    if (AppState.isLocked("admin_mute")) {
      Notify.warning("正在处理禁言操作，请稍候...");
      return;
    }
    AppState.lock("admin_mute");
    btn.disabled = true;
    btn.innerText = "处理中...";

    try {
      const { error } = await Utils.request(
        AppState.sb.from("users").update({ is_mute: isMute }).eq("id", userId).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      Notify.success(isMute ? "已禁言该用户" : "已解禁该用户");
      Admin._scrollTop = Utils.$("#adminPage").scrollTop;
      await Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
      btn.disabled = false;
      btn.innerText = isMute ? "禁言" : "解禁";
    } finally {
      AppState.unlock("admin_mute");
    }
  }, 1500),

  // 封禁/解封
  setStatus: Utils.throttle(async (userId, status, btn) => {
    if (AppState.isLocked("admin_status")) {
      Notify.warning("正在处理状态变更，请稍候...");
      return;
    }
    AppState.lock("admin_status");
    btn.disabled = true;
    btn.innerText = "处理中...";

    try {
      const { error } = await Utils.request(
        AppState.sb.from("users").update({ 
          status, 
          current_session_token: status === "ban" ? null : undefined 
        }).eq("id", userId).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      Notify.success(status === "active" ? "已解封该用户" : "已封禁该用户");
      Admin._scrollTop = Utils.$("#adminPage").scrollTop;
      await Admin.loadData();
    } catch (e) {
      Notify.error(e.message);
      btn.disabled = false;
      btn.innerText = status === "active" ? "解封" : "封禁";
    } finally {
      AppState.unlock("admin_status");
    }
  }, 1500),

  // 重置密码
  resetPwd: Utils.throttle(async (email, btn) => {
    if (AppState.isLocked("admin_pwd")) {
      Notify.warning("正在处理重置请求，请稍候...");
      return;
    }
    if (!confirm(`确定要给邮箱 ${email} 发送密码重置邮件吗？\n注意：频繁发送会触发限流，请谨慎操作`)) return;
    AppState.lock("admin_pwd");
    btn.disabled = true;
    btn.innerText = "发送中...";

    try {
      Notify.info("正在发送重置邮件...");
      const { error } = await Utils.request(
        AppState.sb.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/chat` }), "重置邮件发送超时"
      );
      if (error) throw error;
      Notify.success("密码重置邮件已发送，请注意查收");
    } catch (e) {
      Notify.error(`重置失败：${Utils.formatErr(e)}`);
    } finally {
      btn.disabled = false;
      btn.innerText = "重置密码";
      AppState.unlock("admin_pwd");
    }
  }, 3000),

  // 保存注册审核配置
  async saveConfig() {
    const requireVerify = Utils.$("#requireVerifyToggle").checked;
    const success = await Config.save({ require_verify: requireVerify });
    if (success) Notify.success(`系统配置保存成功，新用户注册${requireVerify ? "需要管理员审核" : "无需审核"}`);
  },

  // 保存敏感词配置
  async saveSensitive() {
    const words = Utils.$("#sensitiveWordsInput").value.trim();
    const success = await Config.save({ sensitive_words: words });
    if (success) Notify.success("敏感词保存成功");
  },

  // 保存公告配置
  async saveAnnounce() {
    const content = Utils.$("#announceInput").value.trim();
    const success = await Config.save({ announcement: content });
    if (success) Notify.success("公告已推送");
  },

  // 删除单条消息
  delMsg: Utils.throttle(async (msgId, btn) => {
    if (AppState.isLocked("admin_msg")) {
      Notify.warning("正在删除消息，请稍候...");
      return;
    }
    AppState.lock("admin_msg");
    btn.disabled = true;
    btn.innerText = "删除中...";

    try {
      const { error } = await Utils.request(
        AppState.sb.from("messages").delete().eq("id", msgId).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      Notify.success("消息已删除");
      await Chat.load();
    } catch (e) {
      Notify.error(e.message);
      btn.disabled = false;
      btn.innerText = "删除";
    } finally {
      AppState.unlock("admin_msg");
    }
  }, 1500),

  // 清空所有消息（核心报错修复：修正错误的Supabase语法）
  async clearMsg() {
    if (AppState.isLocked("admin_msg")) {
      Notify.warning("正在清空消息，请稍候...");
      return;
    }
    if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
    AppState.lock("admin_msg");
    const btn = Utils.$("#clearAllMsgBtn");
    btn.disabled = true;
    btn.innerText = "清空中...";

    try {
      // 修复：错误的.not.is改为正确的.neq，彻底解决报错
      const { error } = await Utils.request(
        AppState.sb.from("messages").delete().neq("id", null).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      Notify.success("所有消息已清空");
      await Chat.load();
    } catch (e) {
      Notify.error(e.message);
    } finally {
      btn.disabled = false;
      btn.innerText = "清空所有消息";
      AppState.unlock("admin_msg");
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
      Utils.$("#toRegisterBtn").addEventListener("click", () => UI.showPage("registerPage"));
      Utils.$("#toLoginBtn").addEventListener("click", () => UI.showPage("loginPage"));
      Utils.$("#loginBtn").addEventListener("click", () => Auth.login());
      Utils.$("#regBtn").addEventListener("click", () => Auth.register());
      Utils.$("#loginPwd").addEventListener("keydown", (e) => e.key === "Enter" && Auth.login());
      Utils.$("#regPwd").addEventListener("keydown", (e) => e.key === "Enter" && Auth.register());
      Utils.$("#logoutBtn").addEventListener("click", () => Auth.logout());

      // 聊天输入框自动高度
      const msgInput = Utils.$("#msgInput");
      msgInput.addEventListener("input", function() {
        this.style.height = "auto";
        this.style.height = Math.min(this.scrollHeight, 120) + "px";
      });
      // 聊天发送
      Utils.$("#sendBtn").addEventListener("click", () => Chat.send());
      msgInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          Chat.send();
        }
      });

      // 页面导航
      Utils.$("#settingBtn").addEventListener("click", () => UI.showPage("settingPage"));
      Utils.$("#adminBtn").addEventListener("click", () => { Admin.loadData(); UI.showPage("adminPage"); });
      Utils.$("#backToChatBtn").addEventListener("click", () => UI.showPage("chatPage"));
      Utils.$("#backToChatFromAdminBtn").addEventListener("click", () => UI.showPage("chatPage"));

      // 设置
      Utils.$("#saveNickBtn").addEventListener("click", () => Settings.saveNick());
      Utils.$("#toggleThemeBtn").addEventListener("click", () => UI.toggleTheme());
      Utils.$("#updatePwdBtn").addEventListener("click", () => Settings.updatePwd());
      Utils.$("#showLoginLogBtn").addEventListener("click", () => LoginLog.showMy());

      // 管理员配置
      Utils.$("#saveConfigBtn").addEventListener("click", () => Admin.saveConfig());
      Utils.$("#saveSwBtn").addEventListener("click", () => Admin.saveSensitive());
      Utils.$("#saveAnnounceBtn").addEventListener("click", () => Admin.saveAnnounce());
      Utils.$("#clearAllMsgBtn").addEventListener("click", () => Admin.clearMsg());

      this._bound = true;
    } catch (e) {
      Notify.error("页面初始化失败，请刷新重试");
      console.error(e);
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

      // 初始化Supabase客户端
      AppState.sb = window.supabase.createClient(
        APP_CONFIG.SUPABASE_URL,
        APP_CONFIG.SUPABASE_KEY,
        {
          auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true, storage: Utils.Storage._ok ? window.localStorage : null },
          realtime: { timeout: APP_CONFIG.TIMEOUT.API, heartbeatIntervalMs: APP_CONFIG.INTERVAL.HEARTBEAT, reconnect: true },
          global: { fetch: (...args) => fetch(...args, { signal: RequestController.signal }) }
        }
      );

      // 绑定事件
      EventBinder.init();
      // 清理残留会话
      const { data: { session } } = await AppState.sb.auth.getSession();
      if (session?.user) await AppState.sb.auth.signOut().catch(() => {});

      // 初始化页面
      AppState.reset();
      UI.showPage("loginPage");
      UI.closeLoader();
      // 监听认证状态
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
