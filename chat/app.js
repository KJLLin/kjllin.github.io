// ====================== 核心配置（唯一常量源） ======================
const APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://ayavdkodhdmcxfufnnxo.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc",
  TIMEOUT: { API: 8000, LOGIN: 20000, IP_FETCH: 3000 },
  INTERVAL: { HEARTBEAT: 30000, SESSION_CHECK: 60000 },
  IP_API_LIST: ["https://api.ip.sb/ip", "https://ip.3322.net", "https://api.ipify.org?format=text"],
  IP_CACHE_TTL: 3600000,
  DEFAULT_CONFIG: Object.freeze({ id: 1, require_verify: false, sensitive_words: "", announcement: "" }),
  CONFIG_ID: 1
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

// ====================== 工具函数（无冗余，全边界处理） ======================
const Utils = {
  // 修复：箭头函数改普通函数，this指向正确
  Storage: {
    _ok: (() => {
      try { const k = "__t__"; localStorage.setItem(k, k); localStorage.removeItem(k); return true; }
      catch { return false; }
    })(),
    get(k) { return this._ok ? (localStorage.getItem(k) || "") : ""; },
    set(k, v) { return this._ok ? (localStorage.setItem(k, v), true) : false; },
    remove(k) { return this._ok ? (localStorage.removeItem(k), true) : false; },
    clear() { return this._ok ? (localStorage.clear(), true) : false; }
  },

  // 高频DOM元素缓存，避免重复查询
  $cache: Object.create(null),
  $(selector) {
    if (!this.$cache[selector]) {
      this.$cache[selector] = document.querySelector(selector) || {
        addEventListener: () => {}, removeEventListener: () => {},
        innerText: '', innerHTML: '', value: '', disabled: false, checked: false,
        classList: { add: () => {}, remove: () => {} }, style: { display: 'none' }
      };
    }
    return this.$cache[selector];
  },
  $$(selector) { return document.querySelectorAll(selector) || []; },
  // 清空缓存（页面重置时调用）
  clearCache() { this.$cache = Object.create(null); },

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  },

  debounce(fn, wait) {
    let timer = null;
    const debounced = (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(...args); }, wait);
    };
    debounced.cancel = () => timer && clearTimeout(timer);
    return debounced;
  },

  throttle(fn, limit) {
    let inThrottle = false;
    return function(...args) {
      if (!inThrottle) {
        inThrottle = true;
        Promise.resolve(fn.apply(this, args))
          .finally(() => setTimeout(() => inThrottle = false, limit));
      }
    };
  },

  // 兼容HTTP环境的UUID生成
  uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      try { return crypto.randomUUID(); } catch {}
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  },

  // 统一请求处理，全错误捕获
  async request(promise, timeoutMsg = "请求超时") {
    try {
      const res = await Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(timeoutMsg)), APP_CONFIG.TIMEOUT.API))
      ]);
      if (res?.error) throw res.error;
      return res;
    } catch (e) {
      throw new Error(Utils.formatErr(e));
    }
  },

  isEmail(str) { return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(String(str).trim()); },

  formatErr(err) {
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

  // 兼容低版本浏览器的Promise.any
  promiseAny(promises) {
    if (Promise.any) return Promise.any(promises);
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
  _timer: null,
  show(type, text) {
    try {
      if (this._timer) clearTimeout(this._timer);
      const el = Utils.$("#winNotify");
      el.className = `win-notify ${type}`;
      el.innerText = text;
      el.classList.remove("hidden");
      this._timer = setTimeout(() => { el.classList.add("hidden"); this._timer = null; }, 6000);
    } catch { alert(text); }
  },
  success: (t) => Notify.show('success', t),
  error: (t) => Notify.show('error', t),
  warning: (t) => Notify.show('warning', t),
  info: (t) => Notify.show('info', t)
};

// ====================== 全局状态（单一根源，无重复） ======================
const AppState = {
  sb: null,
  user: null,
  userNick: Utils.Storage.get("nick"),
  sessionToken: Utils.Storage.get("chat_current_session_token"),
  isInit: false,
  isLoadingMsg: false,
  config: { ...APP_CONFIG.DEFAULT_CONFIG },
  _locks: Object.freeze({
    login: false, logout: false, auth: false, init: false, register: false,
    admin_load: false, admin_verify: false, admin_offline: false, admin_mute: false,
    admin_status: false, admin_pwd: false, admin_config: false, admin_msg: false
  }),
  channels: Object.create(null),
  timers: Object.create(null),
  debounces: Object.create(null), // 存储debounce实例，统一清理

  lock(key) { return this._locks.hasOwnProperty(key) && (this._locks[key] = true); },
  unlock(key) { return this._locks.hasOwnProperty(key) && (this._locks[key] = false); },
  isLocked(key) { return this._locks[key] || false; },

  // 全量重置，无任何残留
  reset() {
    RequestController.reset();
    // 清理所有debounce
    Object.values(this.debounces).forEach(d => d.cancel?.());
    this.debounces = Object.create(null);
    // 清理实时通道
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
    Utils.clearCache(); // 清空DOM缓存
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

  updateUserAvatar(nick) {
    try { Utils.$("#userAvatar").innerText = (nick || "用户").charAt(0); }
    catch {}
  },

  updateAnnounce(content) {
    try {
      const bar = Utils.$("#announceBar");
      const textEl = Utils.$("#announceText");
      if (content?.trim()) {
        textEl.innerText = content;
        bar.classList.remove("hidden");
      } else {
        bar.classList.add("hidden");
      }
    } catch {}
  }
};

// ====================== 系统配置模块 ======================
const Config = {
  async sync() {
    try {
      const { data } = await Utils.request(
        AppState.sb.from("system_config").select("*").limit(1).order("id", { ascending: true }).abortSignal(RequestController.signal)
      );
      if (data && data.length > 0) {
        AppState.config = { ...APP_CONFIG.DEFAULT_CONFIG, ...data[0] };
        // 自动清理脏数据
        if (data.length > 1) {
          await Utils.request(
            AppState.sb.from("system_config").delete().neq("id", APP_CONFIG.CONFIG_ID).abortSignal(RequestController.signal)
          ).catch(() => {});
        }
      } else {
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

  async save(updateData) {
    if (AppState.isLocked("admin_config")) {
      Notify.warning("正在保存配置，请稍候...");
      return false;
    }
    AppState.lock("admin_config");
    try {
      const saveData = { ...APP_CONFIG.DEFAULT_CONFIG, ...AppState.config, ...updateData, id: APP_CONFIG.CONFIG_ID };
      await Utils.request(
        AppState.sb.from("system_config").upsert(saveData, { onConflict: "id" }).abortSignal(RequestController.signal)
      );
      AppState.config = saveData;
      return true;
    } catch (e) {
      Notify.error("配置保存失败：" + Utils.formatErr(e));
      return false;
    } finally {
      AppState.unlock("admin_config");
    }
  },

  initRealtime() {
    try {
      if (AppState.channels.config) AppState.sb.removeChannel(AppState.channels.config).catch(() => {});
      AppState.channels.config = AppState.sb.channel("config")
        .on("postgres_changes", { event: "*", schema: "public", table: "system_config" }, (payload) => {
          if (payload.new) {
            AppState.config = { ...APP_CONFIG.DEFAULT_CONFIG, ...payload.new };
            UI.updateAnnounce(payload.new.announcement);
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
    if (AppState.isLocked("register")) return Notify.warning("正在注册中，请稍候...");
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

      await Config.sync();
      const defaultStatus = AppState.config.require_verify ? "pending" : "active";
      const { data: authData, error: authError } = await Utils.request(
        AppState.sb.auth.signUp({
          email, password: pwd,
          options: { data: { nick }, emailRedirectTo: `${window.location.origin}/chat` }
        }), "注册请求超时"
      );
      if (authError) throw authError;
      if (!authData.user) throw new Error("注册失败，未获取到用户信息");
      authUserId = authData.user.id;

      await Utils.request(
        AppState.sb.from("users").upsert([{
          id: authUserId, nick, email, is_admin: false,
          status: defaultStatus, created_at: new Date().toISOString()
        }], { onConflict: "id" }).abortSignal(RequestController.signal)
      );

      if (AppState.config.require_verify) await AppState.sb.auth.signOut().catch(() => {});
      Notify.success(AppState.config.require_verify ? "注册成功！账号正在等待管理员审核" : "注册成功，请前往邮箱验证后登录");
      ["regNick", "regEmail", "regPwd"].forEach(id => Utils.$(`#${id}`).value = "");
      UI.showPage("loginPage");
    } catch (e) {
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
    if (AppState.isLocked("login")) return Notify.warning("正在登录中，请稍候...");
    AppState.lock("login");
    const loginBtn = Utils.$("#loginBtn");
    loginBtn.disabled = true;
    loginBtn.innerText = "登录中...";

    try {
      const email = Utils.$("#loginEmail").value.trim();
      const pwd = Utils.$("#loginPwd").value.trim();
      if (!email || !pwd) throw new Error("请填写邮箱和密码");
      if (!Utils.isEmail(email)) throw new Error("请输入正确的邮箱格式");

      await Utils.request(
        AppState.sb.auth.signInWithPassword({ email, password: pwd }), "登录请求超时"
      );
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
        const { data } = await Utils.request(
          AppState.sb.from("users").select("*").eq("id", session.user.id).limit(1).abortSignal(RequestController.signal)
        );
        if (data && data.length > 0) userInfo = data[0];
      } catch {}

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

      if (!userInfo) throw new Error("用户信息初始化失败，请刷新重试");
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
      UI.updateUserAvatar(AppState.userNick);

      Utils.Storage.remove("chat_current_session_token");
      const newToken = Utils.uuid();
      AppState.sessionToken = newToken;
      Utils.Storage.set("chat_current_session_token", newToken);

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
    if (AppState.isLocked("logout")) return Notify.warning("正在退出中，请稍候...");
    AppState.lock("logout");
    const logoutBtn = Utils.$("#logoutBtn");
    logoutBtn.disabled = true;
    logoutBtn.innerText = "退出中...";

    try {
      Notify.info("正在安全退出...");
      RequestController.reset();
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
  init() {
    AppState.debounces.loadMsg = Utils.debounce(() => Chat.load(), 300);
  },
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
        const delBtn = AppState.user.isAdmin ? `<button class="btn btn-danger btn-sm msg-del-btn" data-msg-id="${msgId}">删除</button>` : '';
        
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
            ${delBtn}
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
        .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => AppState.debounces.loadMsg())
        .subscribe();
    } catch {}
  },

  send: Utils.throttle(async () => {
    if (!AppState.user || !AppState.isInit) return Notify.error("请先登录");
    const input = Utils.$("#msgInput");
    const text = input.value.trim();
    if (!text) return Notify.error("不能发送空消息");

    const sendBtn = Utils.$("#sendBtn");
    sendBtn.disabled = true;
    sendBtn.innerText = "发送中...";

    try {
      const { sensitive_words } = AppState.config;
      let content = text;
      const wordList = (sensitive_words || "").split(",").map(w => w.trim()).filter(w => w);
      wordList.forEach(word => { content = content.replaceAll(word, "***"); });

      await Utils.request(
        AppState.sb.from("messages").insert([{
          user_id: AppState.user.id,
          nick: AppState.userNick,
          text: content,
          time: new Date().toLocaleString()
        }]).abortSignal(RequestController.signal)
      );
      input.value = "";
      input.style.height = "auto";
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
    if (!AppState.user || !AppState.isInit) return Notify.error("请先登录");
    try {
      Notify.info("正在加载登录日志...");
      const { data, error } = await Utils.request(
        AppState.sb.from("login_logs").select("*").eq("user_id", AppState.user.id).order("time", { ascending: false }).limit(10).abortSignal(RequestController.signal)
      );
      if (error) throw error;
      if (!data?.length) return alert("=== 我的登录日志 ===\n\n暂无登录日志");
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
    if (!AppState.user || !AppState.isInit) return Notify.error("请先登录");
    try {
      const newNick = Utils.$("#nickInput").value.trim();
      if (!newNick) throw new Error("请输入有效的昵称");
      await Utils.request(
        AppState.sb.from("users").update({ nick: newNick }).eq("id", AppState.user.id).abortSignal(RequestController.signal)
      );
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
    if (!AppState.user || !AppState.isInit) return Notify.error("请先登录");
    try {
      const newPwd = Utils.$("#newPwdInput").value.trim();
      if (newPwd.length < 8) throw new Error("密码长度不能少于8位");
      await Utils.request(
        AppState.sb.auth.updateUser({ password: newPwd }), "修改密码请求超时"
      );
      Notify.success("密码修改成功，请重新登录");
      Utils.$("#newPwdInput").value = "";
      setTimeout(() => Auth.logout(), 1500);
    } catch (e) {
      Notify.error(`修改失败：${Utils.formatErr(e)}`);
    }
  }, 3000)
};

// ====================== 管理员模块（事件委托，无XSS风险） ======================
const Admin = {
  _scrollTop: 0,
  // 通用管理员操作执行器，合并90%重复逻辑
  async execAction(options) {
    const { lockKey, btn, action, successMsg, reload = true } = options;
    if (AppState.isLocked(lockKey)) {
      Notify.warning("正在处理，请稍候...");
      return false;
    }
    AppState.lock(lockKey);
    const originText = btn?.innerText || "";
    if (btn) {
      btn.disabled = true;
      btn.innerText = "处理中...";
    }
    try {
      await action();
      Notify.success(successMsg);
      if (reload) {
        Admin._scrollTop = Utils.$("#adminPage").scrollTop;
        await Admin.loadData();
      }
      return true;
    } catch (e) {
      Notify.error(Utils.formatErr(e));
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerText = originText;
      }
      AppState.unlock(lockKey);
    }
  },

  async loadData() {
    return Admin.execAction({
      lockKey: "admin_load",
      successMsg: "管理数据加载完成",
      reload: false,
      action: async () => {
        Notify.info("正在加载管理数据...");
        await Config.sync();
        const { require_verify, sensitive_words, announcement } = AppState.config;
        Utils.$("#requireVerifyToggle").checked = require_verify || false;
        Utils.$("#sensitiveWordsInput").value = sensitive_words || "";
        Utils.$("#announceInput").value = announcement || "";

        const [verifyRes, userRes, logRes] = await Promise.allSettled([
          Utils.request(AppState.sb.from("users").select("*").eq("status", "pending").abortSignal(RequestController.signal)),
          Utils.request(AppState.sb.from("users").select("*").order("created_at", { ascending: false }).limit(50).abortSignal(RequestController.signal)),
          Utils.request(AppState.sb.from("login_logs").select("*").order("time", { ascending: false }).limit(20).abortSignal(RequestController.signal))
        ]);

        // 渲染待审核用户
        const verifyUsers = verifyRes.status === "fulfilled" && !verifyRes.value.error ? verifyRes.value.data || [] : [];
        let verifyHtml = "";
        verifyUsers.forEach(u => {
          verifyHtml += `
            <div class="list-item">
              <span>${Utils.escapeHtml(u.email)}（${Utils.escapeHtml(u.nick)}）</span>
              <div class="btn-group">
                <button class="btn btn-primary btn-sm admin-verify-btn" data-user-id="${Utils.escapeHtml(u.id)}" data-status="active">通过</button>
                <button class="btn btn-danger btn-sm admin-verify-btn" data-user-id="${Utils.escapeHtml(u.id)}" data-status="ban">拒绝</button>
              </div>
            </div>
          `;
        });
        Utils.$("#verifyUserList").innerHTML = verifyHtml || "暂无待审核用户";

        // 渲染所有用户
        const allUsers = userRes.status === "fulfilled" && !userRes.value.error ? userRes.value.data || [] : [];
        let userHtml = "";
        allUsers.forEach(u => {
          const status = u.status === "active" ? "正常" : u.status === "ban" ? "封禁" : "待审核";
          const muteText = u.is_mute ? "解禁" : "禁言";
          const online = u.current_session_token ? "在线" : "离线";
          const statusBtnText = u.status === "ban" ? "解封" : "封禁";
          const statusBtnClass = u.status === "ban" ? "btn-primary" : "btn-danger";
          const statusTarget = u.status === "ban" ? "active" : "ban";
          
          userHtml += `
            <div class="list-item">
              <span>${Utils.escapeHtml(u.email)}（${Utils.escapeHtml(u.nick)} | ${status} | ${online}）</span>
              <div class="btn-group">
                <button class="btn btn-secondary btn-sm admin-resetpwd-btn" data-email="${Utils.escapeHtml(u.email)}">重置密码</button>
                <button class="btn btn-warning btn-sm admin-mute-btn" data-user-id="${Utils.escapeHtml(u.id)}" data-mute="${!u.is_mute}">${muteText}</button>
                <button class="btn ${statusBtnClass} btn-sm admin-status-btn" data-user-id="${Utils.escapeHtml(u.id)}" data-status="${statusTarget}">${statusBtnText}</button>
                <button class="btn btn-danger btn-sm admin-offline-btn" data-user-id="${Utils.escapeHtml(u.id)}">强制下线</button>
              </div>
            </div>
          `;
        });
        Utils.$("#allUserList").innerHTML = userHtml || "暂无用户";

        // 渲染登录日志
        const logs = logRes.status === "fulfilled" && !logRes.value.error ? logRes.value.data || [] : [];
        let logHtml = "";
        logs.forEach(log => {
          logHtml += `
            <div class="list-item">
              <span>IP：${Utils.escapeHtml(log.ip || '未知')} | ${Utils.escapeHtml(log.time || '未知')} | ${Utils.escapeHtml(log.device?.substring(0, 30) || '未知')}...</span>
            </div>
          `;
        });
        Utils.$("#allLoginLogList").innerHTML = logHtml || "暂无登录日志";

        // 恢复滚动位置
        if (Admin._scrollTop) {
          Utils.$("#adminPage").scrollTop = Admin._scrollTop;
          Admin._scrollTop = 0;
        }
      }
    });
  },

  // 配置保存
  async saveConfig() {
    const requireVerify = Utils.$("#requireVerifyToggle").checked;
    const success = await Config.save({ require_verify: requireVerify });
    if (success) Notify.success(`系统配置保存成功，新用户注册${requireVerify ? "需要管理员审核" : "无需审核"}`);
  },
  async saveSensitive() {
    const words = Utils.$("#sensitiveWordsInput").value.trim();
    const success = await Config.save({ sensitive_words: words });
    if (success) Notify.success("敏感词保存成功");
  },
  async saveAnnounce() {
    const content = Utils.$("#announceInput").value.trim();
    const success = await Config.save({ announcement: content });
    if (success) Notify.success("公告已推送");
  },

  // 消息操作
  async delMsg(msgId, btn) {
    return Admin.execAction({
      lockKey: "admin_msg",
      btn,
      successMsg: "消息已删除",
      reload: false,
      action: async () => {
        await Utils.request(
          AppState.sb.from("messages").delete().eq("id", msgId).abortSignal(RequestController.signal)
        );
        await Chat.load();
      }
    });
  },
  async clearMsg() {
    if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
    return Admin.execAction({
      lockKey: "admin_msg",
      btn: Utils.$("#clearAllMsgBtn"),
      successMsg: "所有消息已清空",
      reload: false,
      action: async () => {
        await Utils.request(
          AppState.sb.from("messages").delete().neq("id", null).abortSignal(RequestController.signal)
        );
        await Chat.load();
      }
    });
  }
};

// ====================== 事件绑定（事件委托，无XSS风险） ======================
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

      // 聊天输入框
      const msgInput = Utils.$("#msgInput");
      msgInput.addEventListener("input", function() {
        this.style.height = "auto";
        this.style.height = Math.min(this.scrollHeight, 120) + "px";
      });
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

      // 管理员操作事件委托（彻底解决XSS）
      document.addEventListener("click", (e) => {
        const target = e.target;
        // 审核用户
        if (target.classList.contains("admin-verify-btn")) {
          const userId = target.dataset.userId;
          const status = target.dataset.status;
          Admin.execAction({
            lockKey: "admin_verify",
            btn: target,
            successMsg: status === "active" ? "用户审核通过" : "用户审核拒绝",
            action: async () => {
              await Utils.request(
                AppState.sb.from("users").update({ status }).eq("id", userId).abortSignal(RequestController.signal)
              );
            }
          });
        }
        // 强制下线
        if (target.classList.contains("admin-offline-btn")) {
          const userId = target.dataset.userId;
          if (!confirm("确定要强制该用户下线吗？")) return;
          Admin.execAction({
            lockKey: "admin_offline",
            btn: target,
            successMsg: "用户已被强制下线",
            action: async () => {
              await Utils.request(
                AppState.sb.from("users").update({ current_session_token: null }).eq("id", userId).abortSignal(RequestController.signal)
              );
            }
          });
        }
        // 禁言/解禁
        if (target.classList.contains("admin-mute-btn")) {
          const userId = target.dataset.userId;
          const isMute = target.dataset.mute === "true";
          Admin.execAction({
            lockKey: "admin_mute",
            btn: target,
            successMsg: isMute ? "已禁言该用户" : "已解禁该用户",
            action: async () => {
              await Utils.request(
                AppState.sb.from("users").update({ is_mute: isMute }).eq("id", userId).abortSignal(RequestController.signal)
              );
            }
          });
        }
        // 封禁/解封
        if (target.classList.contains("admin-status-btn")) {
          const userId = target.dataset.userId;
          const status = target.dataset.status;
          Admin.execAction({
            lockKey: "admin_status",
            btn: target,
            successMsg: status === "active" ? "已解封该用户" : "已封禁该用户",
            action: async () => {
              await Utils.request(
                AppState.sb.from("users").update({ 
                  status, 
                  current_session_token: status === "ban" ? null : undefined 
                }).eq("id", userId).abortSignal(RequestController.signal)
              );
            }
          });
        }
        // 重置密码
        if (target.classList.contains("admin-resetpwd-btn")) {
          const email = target.dataset.email;
          if (!confirm(`确定要给邮箱 ${email} 发送密码重置邮件吗？\n注意：频繁发送会触发限流，请谨慎操作`)) return;
          Admin.execAction({
            lockKey: "admin_pwd",
            btn: target,
            successMsg: "密码重置邮件已发送，请注意查收",
            reload: false,
            action: async () => {
              await Utils.request(
                AppState.sb.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/chat` }), "重置邮件发送超时"
              );
            }
          });
        }
        // 删除消息
        if (target.classList.contains("msg-del-btn")) {
          const msgId = target.dataset.msgId;
          Admin.delMsg(msgId, target);
        }
      });

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
    let forceCloseTimer = null;
    try {
      forceCloseTimer = setTimeout(() => {
        UI.closeLoader();
        AppState.reset();
        UI.showPage("loginPage");
      }, 5000);
      AppState.timers.forceCloseLoader = forceCloseTimer;

      UI.initTheme();
      if (!window.supabase) throw new Error("Supabase SDK加载失败，请刷新页面重试");

      // 初始化Supabase
      AppState.sb = window.supabase.createClient(
        APP_CONFIG.SUPABASE_URL,
        APP_CONFIG.SUPABASE_KEY,
        {
          auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true, storage: Utils.Storage._ok ? window.localStorage : null },
          realtime: { timeout: APP_CONFIG.TIMEOUT.API, heartbeatIntervalMs: APP_CONFIG.INTERVAL.HEARTBEAT, reconnect: true },
          global: { fetch: (...args) => fetch(...args, { signal: RequestController.signal }) }
        }
      );

      // 初始化模块
      Chat.init();
      EventBinder.init();
      
      // 清理残留会话
      const { data: { session } } = await AppState.sb.auth.getSession();
      if (session?.user) await AppState.sb.auth.signOut().catch(() => {});

      // 初始化页面
      AppState.reset();
      UI.showPage("loginPage");
      UI.closeLoader();
      clearTimeout(forceCloseTimer); // 成功初始化，清除强制关闭定时器
      
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
window.addEventListener("beforeunload", () => RequestController.reset());
document.addEventListener("visibilitychange", Utils.debounce(async () => {
  if (!document.hidden && AppState.user && AppState.isInit) {
    await Online.mark();
    await Online.refresh();
    UI.showAdminBtn();
  }
}, 500));
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => UI.initTheme());
