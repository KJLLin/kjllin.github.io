/**
 * KJLLin 共享工具模块 — common.js
 * Apple Design Language · 弹簧物理 · 材质深度 · 交互反馈
 * 依赖：Font Awesome 6.5.1、Supabase JS SDK（页面自行加载）
 */
(function(global) {
  'use strict';

  const SUPABASE_URL = 'https://vzqspcuxnwpakofwumat.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6cXNwY3V4bndwYWtvZnd1bWF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODI4MTUsImV4cCI6MjA5OTQ1ODgxNX0.AlV_3gWTWTrFBO-_nYD_8RaKoC-m5p-7VpZwbnPp-Pg';

  // ====================== 防 Safari/Edge Tracking Prevention ======================
  const safeStorage = {
    getItem: function(k) { try { return localStorage.getItem(k); } catch(e) { return null; } },
    setItem: function(k, v) { try { localStorage.setItem(k, v); } catch(e) {} },
    removeItem: function(k) { try { localStorage.removeItem(k); } catch(e) {} }
  };

  // ====================== Supabase 客户端 ======================
  // 全站共享的主客户端实例：createSupabase 创建后登记，
  // initNav 未显式传入 sb 时复用它，避免双客户端并发刷新 refresh token
  // （双实例会用同一个 refresh token 竞争轮换，导致会话被误判登出）
  var _primaryClient = null;

  /**
   * 创建 Supabase 客户端（安全存储）
   * @returns {object|null} Supabase client 或 null
   */
  function createSupabase() {
    try {
      if (!global.supabase) return null;
      if (_primaryClient) return _primaryClient;
      var client = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
          persistSession: true,
          detectSessionInUrl: true,
          storage: {
            getItem: function(k) { return safeStorage.getItem(k); },
            setItem: function(k, v) { safeStorage.setItem(k, v); },
            removeItem: function(k) { safeStorage.removeItem(k); }
          }
        }
      });
      // 自动记录登录设备（SIGNED_IN 时触发一次）
      var _recorded = false;
      client.auth.onAuthStateChange(function(event) {
        if (event === 'SIGNED_IN' && !_recorded) {
          _recorded = true;
          recordLoginDevice(client);
        }
        if (event === 'SIGNED_OUT') _recorded = false;
      });
      _primaryClient = client;
      return client;
    } catch(e) {
      console.warn('Supabase init failed:', e);
      return null;
    }
  }

  // ====================== HTML 安全转义 ======================
  /**
   * 防止 XSS
   * @param {*} s
   * @returns {string}
   */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, function(c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ====================== Toast 通知 ======================
  /**
   * 显示 Toast（自动移除旧 Toast）
   * @param {string} msg
   * @param {number} [duration=2500]
   */
  function toast(msg, duration) {
    var existing = document.querySelector('.kj-toast');
    if (existing) existing.remove();
    var t = document.createElement('div');
    t.className = 'kj-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.remove(); }, duration || 2500);
  }

  /**
   * 注入 Toast 默认样式（页面 CSS 可覆盖 .kj-toast）
   */
  function injectToastStyle() {
    if (document.getElementById('kj-common-style')) return;
    var style = document.createElement('style');
    style.id = 'kj-common-style';
    // Apple spring entry animation — 使用 spring-bounce 曲线
    style.textContent = '.kj-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:20px;font-size:14px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.15);animation:kjToastIn .35s cubic-bezier(.25,1.1,.35,1.15);background:var(--color-bg-glass-solid,var(--text-primary,#1d1d1f));color:var(--color-text-primary,var(--bg-body,#f5f5f7));border:1px solid var(--color-border,rgba(0,0,0,0.06))}@keyframes kjToastIn{from{opacity:0;transform:translateX(-50%) translateY(12px) scale(0.96)}}';
    document.head.appendChild(style);
  }

  // ====================== Apple Smooth Scroll ======================
  /**
   * 使用 Apple 风格减速平滑滚动到目标元素
   * 模拟 UIScrollView deceleration: behavior: 'smooth' + 弹簧补充
   * @param {string|Element} target - 目标选择器或元素
   * @param {object} [opts]
   * @param {number} [opts.offset=0] - 偏移量（如固定 header 高度）
   * @param {string} [opts.behavior='smooth'] - 滚动行为
   */
  function smoothScrollTo(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.pageYOffset - (opts.offset || 56);
    try {
      window.scrollTo({ top: top, behavior: opts.behavior || 'smooth' });
    } catch(e) {
      window.scrollTo(0, top);
    }
  }

  // ====================== 全局交互反馈（Apple: pointerdown 即时响应） ======================
  /**
   * 为所有交互元素注入 :active 即时反馈
   * CSS 已处理 scale(0.97)，此处添加 pointer 捕获确保拖拽时不丢失反馈
   */
  function initGlobalFeedback() {
    // 防止移动端长按弹出菜单干扰交互
    document.addEventListener('contextmenu', function(e) {
      if (e.target.closest('.btn, .card, .menu-item, [role="button"], .conv-item, .game-card')) {
        // 仅在移动端预防长按菜单
        if ('ontouchstart' in window) e.preventDefault();
      }
    }, { passive: false });

    // 全局 pointerdown 添加即时高亮（配合 :active）
    document.addEventListener('pointerdown', function(e) {
      var el = e.target.closest('.btn, .menu-item, .card, .game-card, .conv-item, [role="button"]');
      if (el) {
        el.style.transition = 'transform 80ms cubic-bezier(0.23,0.01,0,1)';
      }
    }, { passive: true });
  }

  // ====================== 滚动边缘渐变遮罩 ======================
  /**
   * 为滚动容器自动添加顶部/底部渐变遮罩（Apple 风格：替代硬分割线）
   * @param {string|Element} container - 滚动容器选择器或元素
   */
  function applyScrollEdgeMask(container) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container) return;

    function update() {
      var hasTop = container.scrollTop > 4;
      var hasBottom = container.scrollTop + container.clientHeight < container.scrollHeight - 4;
      container.style.maskImage = [
        hasTop ? 'linear-gradient(to bottom, transparent 0%, black 20px)' : 'none',
        hasBottom ? 'linear-gradient(to top, transparent 0%, black 20px)' : 'none'
      ].filter(Boolean).join(', ') || 'none';
      container.style.webkitMaskImage = container.style.maskImage;
    }

    container.addEventListener('scroll', update, { passive: true });
    update();
  }

  // ====================== 主题系统（三模式：自动/浅色/深色） ======================
  /**
   * 获取系统是否为深色模式
   */
  function getSystemDark() {
    return global.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /**
   * 当前实际是否深色
   */
  function isActuallyDark() {
    var mode = safeStorage.getItem('theme');
    return mode === 'dark' || (!mode && getSystemDark());
  }

  /**
   * 更新主题 UI（DOM 无关，返回状态供页面使用）
   * @returns {{dark: boolean, mode: string}} mode: 'auto'|'light'|'dark'
   */
  function getThemeState() {
    var mode = safeStorage.getItem('theme') || 'auto';
    var dark = mode === 'dark' || (mode === 'auto' && getSystemDark());
    return { dark: dark, mode: mode };
  }

  /**
   * 应用主题到 document 和 meta theme-color
   * @param {string} [themeColorLight='#f5f5f7']
   * @param {string} [themeColorDark='#000']
   */
  function applyTheme(themeColorLight, themeColorDark) {
    var state = getThemeState();
    var root = document.documentElement;
    var metaTheme = document.querySelector('meta[name="theme-color"]');

    root.dataset.theme = state.dark ? 'dark' : '';
    if (metaTheme) {
      metaTheme.content = state.dark ? (themeColorDark || '#000') : (themeColorLight || '#f5f5f7');
    }
    return state;
  }

  /**
   * 获取主题按钮应显示的图标 HTML
   * @param {string} [mode] - 可选，不传则自动读取 localStorage
   * @returns {string} Font Awesome icon HTML
   */
  function getThemeIcon(mode) {
    var m = mode || safeStorage.getItem('theme');
    if (m === 'dark') return '<i class="fas fa-sun"></i>';
    if (m === 'light') return '<i class="fas fa-moon"></i>';
    return '<i class="fas fa-circle-half-stroke"></i>';
  }

  /**
   * 切换主题（循环：自动 → 浅色 → 深色 → 自动）
   * @returns {{dark: boolean, mode: string}} 新状态
   */
  function toggleTheme() {
    var mode = safeStorage.getItem('theme');
    if (!mode) safeStorage.setItem('theme', 'light');
    else if (mode === 'light') safeStorage.setItem('theme', 'dark');
    else safeStorage.removeItem('theme');
    return getThemeState();
  }

  /**
   * 监听系统主题变化
   * @param {function} callback - 回调函数
   */
  function onSystemThemeChange(callback) {
    global.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', callback);
  }

  // ====================== 移动端汉堡菜单 ======================
  /**
   * 为移动端汉堡菜单绑定事件
   * @param {string} hamburgerSelector
   * @param {string} menuSelector
   */
  function setupMobileMenu(hamburgerSelector, menuSelector) {
    var hamburger = document.querySelector(hamburgerSelector);
    var menu = document.querySelector(menuSelector);
    if (!hamburger || !menu) return;

    hamburger.addEventListener('click', function(e) {
      e.stopPropagation();
      menu.classList.toggle('open');
    });

    document.addEventListener('click', function(e) {
      if (!hamburger.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.remove('open');
      }
    });
  }

  // ====================== 导航栏滚动材质（Apple: 滚动时变实） ======================
  /**
   * 监听页面滚动，给导航栏添加 scrolled 状态：
   * 滚动超过阈值后，玻璃材质变实 + 阴影加深，替代硬分割线。
   */
  function setupNavScrollEffect() {
    var menuBar = document.querySelector('.menu-bar');
    if (!menuBar || menuBar._kjNavScrollBound) return;
    menuBar._kjNavScrollBound = true;

    var lastState = false;
    function update() {
      var scrolled = (window.scrollY || document.documentElement.scrollTop) > 12;
      if (scrolled !== lastState) {
        lastState = scrolled;
        menuBar.classList.toggle('scrolled', scrolled);
      }
    }
    // 使用 rAF 节流，避免滚动性能抖动
    var ticking = false;
    function onScroll() {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function() { update(); ticking = false; });
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
  }

  // ====================== 开放重定向防护 ======================
  /**
   * 安全重定向 URL 校验
   * @param {string} raw - 原始 URL
   * @param {string} [fallback='/'] - 默认跳转
   * @returns {string}
   */
  function safeRedirect(raw, fallback) {
    var def = fallback || '/';
    if (!raw) return def;
    try {
      var u = new URL(raw, location.origin);
      if (u.origin === location.origin && !raw.startsWith('//')) return raw;
    } catch(e) {}
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
    return def;
  }

  // ====================== 错误格式化 ======================
  function formatSupabaseError(err) {
    var msg = typeof err === 'string' ? err : (err?.message || err?.toString() || '未知错误');
    if (msg.includes('Invalid login credentials')) return '邮箱或密码错误';
    if (msg.includes('Email not confirmed')) return '邮箱未验证';
    if (msg.includes('already registered') || msg.includes('already exists')) return '该邮箱已被注册';
    // 检测注册功能是否被关闭（Supabase 控制台可禁用注册）
    if (/sign\s*ups?\s*(are\s*)?not\s*allowed|sign\s*ups?\s*(are\s*)?disabled|sign\s*up\s*(is\s*)?disabled|registration\s*(is\s*)?disabled|signups?\s*not\s*enabled/i.test(msg)) {
      return '暂时关闭注册功能，请联系管理员：LinLyndon153@163.com';
    }
    if (msg.includes('429')) return '请求频繁，请稍后重试';
    if (msg.includes('JWT') || msg.includes('expired')) return '登录已过期，请重新登录';
    return msg;
  }

  // ====================== 日期格式化 ======================
  function formatDate(iso) {
    if (!iso) return '--';
    var d = new Date(iso);
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  // ====================== 服务预热（仅在需要时调用） ======================
  /**
   * 后台预热 REST API 和 Auth 服务，减少冷启动延迟。
   * 注意：不预热 verify-captcha Edge Function，避免发送无效 token 触发 hCaptcha 限流！
   */
  function warmUpServices() {
    setTimeout(function() {
      // 预热 REST API（轻量 HEAD 请求）
      fetch(SUPABASE_URL + '/rest/v1/', {
        method: 'HEAD',
        headers: { 'apikey': SUPABASE_KEY },
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
      }).catch(function() {});
      // 预热 Auth
      fetch(SUPABASE_URL + '/auth/v1/health', {
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
      }).catch(function() {});
    }, 3000);
  }

  // ====================== 设备记录 ======================
  // 防重入：同一 client 60 秒内只记录一次（SIGNED_IN 事件与页面显式调用会先后触发，避免双写）
  var _lastDeviceRecord = { sb: null, ts: 0 };
  /**
   * 记录登录设备到 Supabase + localStorage
   * @param {object} sb - Supabase 客户端实例
   */
  async function recordLoginDevice(sb) {
    if (!sb) return;
    var nowMs = Date.now();
    if (_lastDeviceRecord.sb === sb && nowMs - _lastDeviceRecord.ts < 60000) return;
    _lastDeviceRecord.sb = sb;
    _lastDeviceRecord.ts = nowMs;
    try {
      // 获取当前用户 ID
      var userId = null;
      try {
        var { data: { session } } = await sb.auth.getSession();
        if (session && session.user) userId = session.user.id;
      } catch(e) {}
      if (!userId) return; // 无用户则跳过（未登录状态）

      var ua = parseUA();
      var ip = '获取中...';
      try {
        var apis = ['https://api.ipify.org?format=json', 'https://api.ip.sb/ip', 'https://httpbin.org/ip'];
        for (var ai = 0; ai < apis.length; ai++) {
          try {
            var ctrl = new AbortController();
            var timer = setTimeout(function() { ctrl.abort(); }, 4000);
            var resp = await fetch(apis[ai], { signal: ctrl.signal });
            clearTimeout(timer);
            // api.ip.sb/ip 返回纯文本，需用 text() 解析并 trim；其余两个 API 返回 JSON
            if (apis[ai].indexOf('api.ip.sb') !== -1) {
              ip = (await resp.text()).trim();
            } else {
              var data = await resp.json();
              ip = data.ip || data.origin || '';
            }
            if (ip && !ip.includes('<')) { ip = ip.replace(/^https?:\/\//, ''); break; }
          } catch(e) {}
        }
      } catch(e) {}

      // 写入 Supabase（包含 user_id 和 logged_in_at）
      var now = new Date().toISOString();
      var { error } = await sb.from('login_devices').insert({
        user_id: userId,
        browser: ua.browser + (ua.osVer ? ' ' + ua.osVer : ''),
        os: ua.os,
        os_ver: ua.osVer || '',
        screen: ua.screen,
        ip: ip,
        logged_in_at: now
      });
      if (error) console.warn('Device record insert error:', error);

      // 同时保留 localStorage 记录（离线回退）
      try {
        var history = JSON.parse(localStorage.getItem('kjllin_login_history') || '[]');
        history.push({ browser: ua.browser + (ua.osVer ? ' ' + ua.osVer : ''), os: ua.os, time: new Date().toISOString(), ip: ip });
        if (history.length > 20) history = history.slice(-20);
        localStorage.setItem('kjllin_login_history', JSON.stringify(history));
      } catch(e) {}
    } catch(e) {
      console.warn('recordLoginDevice failed:', e);
    }
  }

  function parseUA() {
    var u = navigator.userAgent;
    var b = 'Unknown';
    if (u.includes('Edg/')) b = 'Edge';
    else if (u.includes('Chrome/')) b = 'Chrome';
    else if (u.includes('Firefox/')) b = 'Firefox';
    else if (u.includes('Safari/') && !u.includes('Chrome/')) b = 'Safari';
    var os = 'Unknown', osVer = '';
    if (u.includes('Windows NT 10')) { os = 'Windows'; osVer = '10/11'; }
    else if (u.includes('Windows NT 6')) { os = 'Windows'; osVer = '7/8'; }
    else if (u.includes('Mac OS X')) { os = 'macOS'; var m1 = u.match(/Mac OS X ([0-9_]+)/); if (m1) osVer = m1[1].replace(/_/g, '.'); }
    else if (u.includes('Linux') && !u.includes('Android')) { os = 'Linux'; }
    else if (u.includes('Android')) { os = 'Android'; var m2 = u.match(/Android ([0-9.]+)/); if (m2) osVer = m2[1]; }
    else if (u.includes('iOS') || u.includes('iPhone') || u.includes('iPad')) { os = 'iOS'; var m3 = u.match(/OS ([0-9_]+)/); if (m3) osVer = m3[1].replace(/_/g, '.'); }
    var screen = '屏幕: ' + window.screen.width + '\u00d7' + window.screen.height + ', ' + navigator.language;
    return { browser: b, os: os, osVer: osVer, screen: screen };
  }

  // ====================== 统一导航栏 Auth 初始化 ======================
  // initNav 专用的模块级懒初始化单例 client（未传入 sb 时复用，避免每次调用都新建客户端）
  var _navSb = null;
  function getNavSupabase() {
    if (_navSb) return _navSb;
    // 页面已通过 createSupabase() 创建过客户端则直接复用（避免双实例）
    if (_primaryClient) return _primaryClient;
    if (!global.supabase) return null;
    try {
      _navSb = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
          persistSession: true,
          storage: {
            getItem: function(k) { return safeStorage.getItem(k); },
            setItem: function(k, v) { safeStorage.setItem(k, v); },
            removeItem: function(k) { safeStorage.removeItem(k); }
          }
        }
      });
    } catch(e) { _navSb = null; }
    return _navSb;
  }

  /**
   * 初始化顶部导航栏的登录状态：隐藏/显示登出按钮、填充用户名
   * 解决全站 14+ 页面重复编写 auth UI 代码的问题
   * 
   * 使用方式（页面仅需一行）：
   *   KJ.initNav(sb);  // sb 为 Supabase 客户端，可选（不传则自动创建）
   * 
   * @param {object} [sb] - Supabase 客户端实例（可选）
   * @param {object} [opts]
   * @param {string} [opts.logoutBtn='#logoutBtn']  - 退出按钮选择器
   * @param {string} [opts.userTag='#userTag']      - 用户标签选择器
   * @param {string} [opts.loginUrl='/login/']       - 登录页路径
   * @param {string} [opts.homeUrl='/']              - 退出后跳转
   */
  function initNav(sb, opts) {
    opts = opts || {};
    var logoutSel = opts.logoutBtn || '#logoutBtn';
    var userTagSel = opts.userTag || '#userTag';
    var loginUrl = opts.loginUrl || '/login/';
    var homeUrl = opts.homeUrl || '/';
    
    var logoutBtn = document.querySelector(logoutSel);
    var userTag = document.querySelector(userTagSel);
    
    // 如果页面没有导航栏，静默退出
    if (!logoutBtn && !userTag) return;

    // 导航栏滚动材质效果（Apple: 滚动时材质变实，而非硬分割线）
    setupNavScrollEffect();

    // 创建 Supabase 客户端（如果未传入；复用模块级懒初始化单例，而不是每次新建）
    if (!sb) sb = getNavSupabase();

    function hideLogout() {
      if (logoutBtn) logoutBtn.style.display = 'none';
      // 未登录：菜单项恢复默认"个人主页"文案，userTag 位置显示登录按钮
      setProfileMenuItem(null);
      if (userTag) {
        userTag.style.display = '';
        var currentPath = encodeURIComponent(global.location.pathname + global.location.search);
        userTag.innerHTML = '<a href="/login/?redirect=' + currentPath + '" class="menu-item" style="color:var(--color-accent);font-weight:600"><i class="fas fa-key"></i> 登录</a>';
      }
    }

    function showLogout() {
      if (logoutBtn) logoutBtn.style.display = '';
    }

    // 将导航栏"个人主页"菜单项（桌面 + 移动下拉）显示为用户昵称；user 为空时恢复默认文案
    function setProfileMenuItem(user, nickOverride) {
      var items = document.querySelectorAll('a.menu-item[href^="/u/"]');
      if (!items.length) return;
      var nick = user ? (nickOverride || getDisplayNick(user)) : '';
      for (var i = 0; i < items.length; i++) {
        var a = items[i];
        if (user && nick) {
          var display = nick.length > 12 ? nick.slice(0, 12) + '…' : nick;
          a.href = user.id ? '/u/?id=' + encodeURIComponent(user.id) : '/u/';
          a.innerHTML = '<i class="fas fa-circle-user"></i> ' + escapeHtml(display);
          a.title = nick;
        } else {
          a.href = '/u/';
          a.innerHTML = '<i class="fas fa-circle-user"></i> 个人主页';
          a.removeAttribute('title');
        }
      }
    }

    function setUserTag(user, nickOverride) {
      // 昵称直接显示在"个人主页"菜单项中，userTag 不再单独显示昵称
      setProfileMenuItem(user, nickOverride);
      if (userTag) {
        userTag.innerHTML = '';
        userTag.style.display = 'none';
      }
    }

    // 绑定退出点击
    if (logoutBtn && !logoutBtn._kjNavBound) {
      logoutBtn._kjNavBound = true;
      logoutBtn.addEventListener('click', async function() {
        if (!confirm('确定退出登录？')) return;
        try { if (sb) await sb.auth.signOut(); } catch(e) {}
        global.location.href = homeUrl;
      });
    }

    // 先从 localStorage 立即显示（无闪烁）
    var storedUser = getStoredUser(sb);
    if (storedUser) {
      showLogout();
      setUserTag(storedUser);
    } else {
      hideLogout();
    }

    // 然后从 Supabase 异步确认（修正可能的偏差）
    if (sb) {
      sb.auth.onAuthStateChange(function(event, session) {
        if (session && session.user) {
          showLogout();
          setUserTag(session.user);
          // CPOAuth 等第三方登录可能没有 user_metadata.nick — 尝试从 identities 获取
          if (!session.user.user_metadata?.nick && !session.user.email) {
            sb.auth.getUserIdentities().then(function(idResp) {
              var identities = idResp?.data?.identities;
              if (identities && identities.length) {
                var idName = identities[0].identity_data?.user_name
                  || identities[0].identity_data?.full_name
                  || identities[0].identity_data?.name
                  || identities[0].identity_data?.email?.split('@')[0];
                if (idName) setUserTag(session.user, idName);
              }
            }).catch(function() {});
          }
        } else {
          hideLogout();
        }
      });
      sb.auth.getSession().then(function(r) {
        if (r?.data?.session?.user) {
          showLogout();
          setUserTag(r.data.session.user);
        } else {
          hideLogout();
        }
      }).catch(function() {
        // 网络失败时保留 localStorage 的检测结果
      });
    }

    // 初始化站内信横幅 + 通知铃铛 + 全站公告
    if (sb) initMessageBanner(sb);
    if (sb) initNotificationBell(sb);
    if (sb) initAnnouncement(sb);
  }

  /**
   * 从 localStorage 读取当前用户信息
   * @param {object} [sb] - 可选 Supabase 客户端
   * @returns {object|null}
   */
  function getStoredUser(sb) {
    try {
      var now = Date.now();
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf('sb-') === 0 && key.indexOf('auth-token') !== -1) {
          var val = JSON.parse(localStorage.getItem(key));
          if (val && val.user) {
            if (val.expires_at) {
              if (val.expires_at * 1000 <= now) {
                try { localStorage.removeItem(key); } catch(e) {}
                return null;
              }
            }
            return val.user;
          }
        }
      }
    } catch(e) {}
    return null;
  }

  /**
   * 获取用户展示昵称（支持 CPOAuth 等第三方登录）
   * @param {object} user - Supabase user 对象
   * @returns {string}
   */
  function getDisplayNick(user) {
    if (!user) return '用户';
    // 1. 自定义昵称
    if (user.user_metadata?.nick) return user.user_metadata.nick;
    // 2. CPOAuth/OAuth username
    if (user.user_metadata?.user_name) return user.user_metadata.user_name;
    // 3. CPOAuth/OAuth full_name  
    if (user.user_metadata?.full_name) return user.user_metadata.full_name;
    if (user.user_metadata?.name) return user.user_metadata.name;
    // 4. Email 前缀
    if (user.email) return user.email.split('@')[0];
    return '用户';
  }
  /**
   * 初始化站内信横幅通知（全站通用，在 /chat 页面自动隐藏）
   * 
   * 使用方式：
   *   页面加载 Supabase 后调用 KJ.initMessageBanner(sb)
   *   支持 Realtime 实时推送新消息时弹出横幅
   * 
   * @param {object} sb - Supabase 客户端实例
   * @param {object} [opts]
   * @param {string} [opts.chatPath='/chat'] - 站内信页面路径
   */
  var _bannerState = { channel: null, currentUnread: 0, sb: null };
  var BANNER_WATERMARK_KEY = 'kj_pm_banner_watermark';

  /**
   * 读取横幅"未读水位"：用户叉掉横幅时记录当时的未读数，
   * 只有未读数超过该水位（出现了新的未读消息）才会再次提醒
   */
  function getBannerWatermark() {
    var v = parseInt(safeStorage.getItem(BANNER_WATERMARK_KEY) || '0', 10);
    return (isNaN(v) || v < 0) ? 0 : v;
  }

  function initMessageBanner(sb, opts) {
    opts = opts || {};
    var chatPath = opts.chatPath || '/chat';

    // 在 /chat 页面本身不显示横幅
    if (global.location.pathname.indexOf(chatPath) === 0) return;

    _bannerState.sb = sb;

    // 初始检查未读消息
    checkAndShowBanner(sb, chatPath);

    // 订阅 Realtime：新消息到达时更新横幅
    try {
      if (_bannerState.channel) _bannerState.channel.unsubscribe();
      _bannerState.channel = sb
        .channel('kj_banner_pm')
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'private_messages' },
          function(payload) {
            // 只处理发给当前用户的消息
            var msg = payload.new || {};
            getCurrentUserId(sb).then(function(uid) {
              if (msg.recipient_id === uid) {
                // 有新消息，重新检查未读数
                checkAndShowBanner(sb, chatPath);
              }
            }).catch(function() {});
          }
        )
        .subscribe();
    } catch(e) {
      console.warn('Message banner realtime subscribe failed:', e);
    }
  }

  /**
   * 获取当前登录用户 ID
   */
  async function getCurrentUserId(sb) {
    try {
      var { data: { session } } = await sb.auth.getSession();
      return session && session.user ? session.user.id : null;
    } catch(e) { return null; }
  }

  /**
   * 检查未读消息并显示/更新横幅
   */
  async function checkAndShowBanner(sb, chatPath) {
    if (global.location.pathname.indexOf(chatPath) === 0) return;

    try {
      var uid = await getCurrentUserId(sb);
      if (!uid) { removeBanner(); return; }

      var { count, error } = await sb
        .from('private_messages')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', uid)
        .or('read.eq.false,read.is.null');

      if (error) { removeBanner(); return; }

      var unread = count || 0;
      _bannerState.currentUnread = unread;

      if (unread === 0) {
        // 未读清零时重置水位
        if (getBannerWatermark() !== 0) safeStorage.setItem(BANNER_WATERMARK_KEY, '0');
        removeBanner();
      } else if (unread > getBannerWatermark()) {
        // 有超过水位的新未读 → 显示/更新横幅
        showBanner(unread, chatPath);
      } else {
        // 用户已叉掉，且没有新的未读 → 不再出现
        removeBanner();
      }
    } catch(e) {
      removeBanner();
    }
  }

  /**
   * 显示横幅
   */
  function showBanner(unread, chatPath) {
    // 移除旧横幅
    var existing = document.getElementById('kj-msg-banner');
    if (existing) {
      existing.querySelector('.kj-banner-count').textContent = unread > 99 ? '99+' : unread;
      existing.style.display = '';
      return;
    }

    var banner = document.createElement('div');
    banner.id = 'kj-msg-banner';
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'polite');

    var countText = unread > 99 ? '99+' : unread;
    var msgText = '您有 ' + countText + ' 条未读站内信';

    banner.innerHTML =
      '<div class="kj-banner-inner">' +
        '<div class="kj-banner-left">' +
          '<i class="fas fa-envelope kj-banner-icon"></i>' +
          '<span class="kj-banner-text">' + escapeHtml(msgText) + '</span>' +
        '</div>' +
        '<div class="kj-banner-right">' +
          '<a href="' + chatPath + '" class="kj-banner-action">查看</a>' +
          '<button class="kj-banner-close" aria-label="关闭通知" title="关闭">' +
            '<i class="fas fa-times"></i>' +
          '</button>' +
        '</div>' +
      '</div>';

    // 关闭按钮
    banner.querySelector('.kj-banner-close').addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dismissBanner();
    });

    // 插入 body 最前面
    document.body.insertBefore(banner, document.body.firstChild);

    // 动画入场（延迟一帧确保 DOM 就绪）
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        banner.classList.add('kj-banner-visible');
      });
    });

    // 调整页面顶部间距（如果有固定导航栏）
    adjustPagePadding(true);
  }

  /**
   * 移除横幅
   */
  function removeBanner() {
    var banner = document.getElementById('kj-msg-banner');
    if (!banner) return;
    banner.classList.remove('kj-banner-visible');
    setTimeout(function() {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
      adjustPagePadding(false);
    }, 350);
  }

  /**
   * 关闭横幅：记录当前未读数水位，
   * 之后只有出现比水位更多的新未读消息时才会再次提醒
   */
  function dismissBanner() {
    safeStorage.setItem(BANNER_WATERMARK_KEY, String(_bannerState.currentUnread || 0));
    removeBanner();
  }

  /**
   * 调整页面顶部间距以容纳横幅
   * 如果页面使用 fixed/sticky 导航栏，需要下移
   */
  function adjustPagePadding(add) {
    // .top-menu 是全站统一的 fixed 导航栏（theme.css），横幅出现时一并下移避免遮挡
    var nav = document.querySelector('.top-menu, .kj-nav, nav.glass-nav, header.glass-nav, .site-nav');
    if (nav && nav.style) {
      if (add) {
        nav.style.top = '44px';
      } else {
        nav.style.top = '0';
      }
    }
    // 同时调整 body padding
    if (add) {
      document.body.style.paddingTop = '44px';
    } else {
      document.body.style.paddingTop = '';
    }
  }

  // ====================== 通知系统：导航栏铃铛 ======================
  // 由 initNav 自动初始化：注入铃铛图标 + 未读徽标，
  // 订阅 notifications 表 Realtime INSERT 事件实时刷新
  var _notifState = { channel: null, sb: null };

  function injectBellStyle() {
    if (document.getElementById('kj-bell-style')) return;
    var style = document.createElement('style');
    style.id = 'kj-bell-style';
    style.textContent =
      '.kj-nav-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;' +
      'min-width:34px;height:34px;border-radius:50%;color:inherit;text-decoration:none;' +
      'font-size:15px;transition:background .2s;cursor:pointer}' +
      '.kj-nav-bell:hover{background:var(--color-bg-glass-hover,rgba(0,0,0,.06))}' +
      '.kj-nav-bell .kj-bell-badge{position:absolute;top:1px;right:0;min-width:16px;height:16px;' +
      'padding:0 4px;border-radius:8px;background:var(--color-danger,#ff3b30);color:#fff;' +
      'font-size:10px;font-weight:600;line-height:16px;text-align:center;box-sizing:border-box;' +
      'pointer-events:none}';
    document.head.appendChild(style);
  }

  function refreshBellBadge(sb) {
    var bell = document.getElementById('kj-nav-bell');
    if (!bell) return;
    sb.auth.getSession().then(function(r) {
      var user = r?.data?.session?.user;
      var badge = bell.querySelector('.kj-bell-badge');
      if (!user) {
        bell.style.display = 'none';
        if (badge) badge.style.display = 'none';
        return;
      }
      bell.style.display = '';
      sb.from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('read', false)
        .then(function(res) {
          if (res.error || !badge) return;
          var n = res.count || 0;
          if (n > 0) {
            badge.textContent = n > 99 ? '99+' : n;
            badge.style.display = '';
          } else {
            badge.style.display = 'none';
          }
        }).catch(function() {});
    }).catch(function() {});
  }

  function subscribeNotifications(sb) {
    try {
      if (_notifState.channel) {
        try { sb.removeChannel(_notifState.channel); } catch(_) {}
        _notifState.channel = null;
      }
      sb.auth.getSession().then(function(r) {
        var user = r?.data?.session?.user;
        if (!user) return;
        _notifState.channel = sb.channel('kj_notif_' + user.id)
          .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + user.id },
            function(payload) {
              refreshBellBadge(sb);
              // 后台标签页时弹系统桌面通知
              var n = payload.new || {};
              showDesktopNotification('新的站内通知', n.title || '你收到一条新通知', n.link || '/notifications/');
            })
          .subscribe();
      }).catch(function() {});
    } catch(e) {
      console.warn('Notification bell subscribe failed:', e);
    }
  }

  function initNotificationBell(sb) {
    if (!sb) return;
    _notifState.sb = sb;
    injectBellStyle();

    // 注入铃铛到导航栏（userTag 之前，一次性）
    var userTag = document.querySelector('#userTag');
    if (userTag && userTag.parentNode && !document.getElementById('kj-nav-bell')) {
      var bell = document.createElement('a');
      bell.id = 'kj-nav-bell';
      bell.className = 'kj-nav-bell';
      bell.href = '/notifications/';
      bell.title = '通知';
      bell.setAttribute('aria-label', '通知');
      bell.style.display = 'none'; // 登录确认后再显示
      bell.innerHTML = '<i class="far fa-bell"></i><span class="kj-bell-badge" style="display:none"></span>';
      userTag.parentNode.insertBefore(bell, userTag);
    }

    // 移动端下拉菜单注入"通知"入口（一次性）
    var mobileMenu = document.getElementById('mobileMenu');
    if (mobileMenu && !mobileMenu.querySelector('a[href="/notifications/"]')) {
      var a = document.createElement('a');
      a.href = '/notifications/';
      a.className = 'menu-item';
      a.innerHTML = '<i class="fas fa-bell"></i> 通知';
      mobileMenu.insertBefore(a, mobileMenu.firstChild);
    }

    refreshBellBadge(sb);
    subscribeNotifications(sb);

    // 登录态变化时刷新铃铛（登出隐藏 / 登录显示）
    try {
      sb.auth.onAuthStateChange(function(event) {
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'SIGNED_OUT') {
          refreshBellBadge(sb);
          if (event === 'SIGNED_IN') subscribeNotifications(sb);
        }
      });
    } catch(e) {}
  }

  // ====================== 浏览器原生通知（Notifications API） ======================
  // 在浏览器支持且用户授权后，后台标签页有新通知时弹出系统桌面通知
  var DESKTOP_NOTIF_KEY = 'kj_desktop_notif_on';

  function isBrowserNotificationEnabled() {
    try { return safeStorage.getItem(DESKTOP_NOTIF_KEY) === '1'; } catch(e) { return false; }
  }

  function browserNotifSupported() {
    return typeof global.Notification !== 'undefined';
  }

  /**
   * 请求浏览器通知权限并开启桌面通知。
   * 必须在用户手势（点击）中调用，否则浏览器会忽略授权请求。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function requestBrowserNotification() {
    if (!browserNotifSupported()) return { ok: false, reason: 'unsupported' };
    if (global.Notification.permission === 'granted') {
      safeStorage.setItem(DESKTOP_NOTIF_KEY, '1');
      return { ok: true, permission: 'granted' };
    }
    if (global.Notification.permission === 'denied') {
      return { ok: false, reason: 'denied' };
    }
    try {
      var p = await global.Notification.requestPermission();
      if (p === 'granted') safeStorage.setItem(DESKTOP_NOTIF_KEY, '1');
      else safeStorage.removeItem(DESKTOP_NOTIF_KEY);
      return { ok: p === 'granted', permission: p };
    } catch(e) {
      return { ok: false, reason: 'error' };
    }
  }

  function disableBrowserNotification() {
    safeStorage.removeItem(DESKTOP_NOTIF_KEY);
  }

  /**
   * 展示系统桌面通知（仅当已授权、开启，且当前页面在后台时触发，避免前台打扰）
   */
  function showDesktopNotification(title, body, link) {
    try {
      if (!browserNotifSupported()) return;
      if (isBrowserNotificationEnabled() !== true) return;
      if (global.Notification.permission !== 'granted') return;
      // 页面处于前台（可见）时不在系统层打扰，可看到站内横幅/铃铛
      if (document.visibilityState === 'visible') return;
      var n = new global.Notification(String(title || '新通知'), {
        body: String(body || ''),
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        tag: 'kj-desktop-notif'
      });
      if (link) {
        n.onclick = function() {
          try { if (global.parent && global.parent !== global) global.parent.focus(); else global.focus(); } catch(e) {}
          try { global.location.href = link; } catch(e) {}
          n.close();
        };
      }
      // 自动关闭，避免占据通知中心
      setTimeout(function() { try { n.close(); } catch(e) {} }, 15000);
    } catch(e) {}
  }

  // ====================== 全站公告横幅 ======================
  // 管理员通过后台发布的公告，全站（所有调用 initNav 的页面）顶部展示一次
  var ANNOUNCEMENT_HIDE_KEY = 'kj_announcement_hidden';

  function injectAnnounceStyle() {
    if (document.getElementById('kj-announce-style')) return;
    var style = document.createElement('style');
    style.id = 'kj-announce-style';
    style.textContent =
      '#kj-announce-bar{position:fixed;top:0;left:0;right:0;z-index:10001;height:44px;' +
      'display:flex;align-items:center;gap:10px;padding:0 14px;box-sizing:border-box;' +
      'background:var(--color-accent,#0a84ff);color:#fff;font-size:13px;overflow:hidden;' +
      'box-shadow:0 1px 6px rgba(0,0,0,.12)}' +
      '#kj-announce-bar .kj-announce-icon{flex-shrink:0}' +
      '#kj-announce-bar .kj-announce-body{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#kj-announce-bar .kj-announce-body b{font-weight:600;margin-right:4px}' +
      '#kj-announce-bar a.kj-announce-link{color:#fff;font-weight:600;text-decoration:underline;flex-shrink:0}' +
      '#kj-announce-bar .kj-announce-close{border:none;background:rgba(255,255,255,.22);color:#fff;' +
      'width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:11px;line-height:1;flex-shrink:0}' +
      '#kj-announce-bar .kj-announce-close:hover{background:rgba(255,255,255,.35)}';
    document.head.appendChild(style);
  }

  function showAnnounceBanner(announce) {
    removeAnnounceBanner();
    var bar = document.createElement('div');
    bar.id = 'kj-announce-bar';
    bar.setAttribute('role', 'banner');
    bar.innerHTML =
      '<i class="fas fa-bullhorn kj-announce-icon"></i>' +
      '<span class="kj-announce-body"><b>' + escapeHtml(announce.title || '公告') + '</b>' +
        (announce.content ? escapeHtml(announce.content) : '') + '</span>' +
      (announce.link
        ? '<a class="kj-announce-link" href="' + announce.link + '" target="_blank" rel="noopener noreferrer">查看详情</a>'
        : '') +
      '<button class="kj-announce-close" aria-label="关闭公告" title="关闭">&#10005;</button>';
    bar.querySelector('.kj-announce-close').addEventListener('click', function() {
      safeStorage.setItem(ANNOUNCEMENT_HIDE_KEY, announce.id);
      removeAnnounceBanner();
    });
    document.body.insertBefore(bar, document.body.firstChild);
    announceAdjustPadding(true);
  }

  function removeAnnounceBanner() {
    var bar = document.getElementById('kj-announce-bar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    // 仅当没有站内信横幅时复位顶部偏移，避免二者同显时把导航顶歪
    if (!document.getElementById('kj-msg-banner')) announceAdjustPadding(false);
  }

  // 公告出现/消失时把固定导航与页面顶部下移/复位 44px
  function announceAdjustPadding(add) {
    try {
      var nav = document.querySelector('.top-menu, .kj-nav, nav.glass-nav, header.glass-nav, .site-nav');
      var bodyPad = 44;
      if (!document.getElementById('kj-msg-banner')) {
        if (nav && nav.style) nav.style.top = add ? bodyPad + 'px' : '0px';
        if (add && document.getElementById('kj-announce-bar')) {
          document.body.style.paddingTop = bodyPad + 'px';
        } else if (!add) {
          document.body.style.paddingTop = '';
        }
      }
    } catch(e) {}
  }

  /**
   * 初始化全站公告：拉取最新一条启用中的公告并展示（已关闭则不再出现）。
   * 由 initNav 在登录态初始化后调用；匿名访问者也可见。
   */
  function initAnnouncement(sb) {
    if (!sb) return;
    injectAnnounceStyle();
    sb.from('announcements')
      .select('id,title,content,link')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(function(res) {
        if (res.error || !res.data || !res.data.length) return;
        var a = res.data[0];
        var hid = safeStorage.getItem(ANNOUNCEMENT_HIDE_KEY);
        if (hid === a.id) return;
        showAnnounceBanner(a);
      }).catch(function() {});
  }

  // ====================== 客户端频率限制（防止操作过于频繁） ======================
  /**
   * 客户端请求频率限制器
   * 使用滑动窗口记录操作时间戳，超出阈值返回 false
   * 
   * 使用方式：if (!KJ.rateLimit('upload', 3000)) return; // 3秒内只能操作一次
   * 
   * @param {string} key - 操作标识（如 'upload', 'post', 'delete'）
   * @param {number} [windowMs=3000] - 时间窗口（毫秒）
   * @param {number} [maxOps=1] - 窗口内最大操作次数
   * @param {string} [msg='操作过于频繁，请稍后再试'] - 超限提示
   * @returns {boolean} true=允许操作，false=被限制
   */
  var _rateLimitStore = {};
  function rateLimit(key, windowMs, maxOps, msg) {
    windowMs = windowMs || 3000;
    maxOps = maxOps || 1;
    msg = msg || '操作过于频繁，请稍后再试';
    var now = Date.now();
    if (!_rateLimitStore[key]) _rateLimitStore[key] = [];
    var timestamps = _rateLimitStore[key];
    // 清理过期记录
    while (timestamps.length > 0 && now - timestamps[0] > windowMs) timestamps.shift();
    if (timestamps.length >= maxOps) {
      toast(msg, 2800);
      return false;
    }
    timestamps.push(now);
    return true;
  }

  // ====================== 暴露 API ======================
  var KJ = {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_KEY: SUPABASE_KEY,
    safeStorage: safeStorage,
    createSupabase: createSupabase,
    escapeHtml: escapeHtml,
    toast: toast,
    injectToastStyle: injectToastStyle,
    smoothScrollTo: smoothScrollTo,
    initGlobalFeedback: initGlobalFeedback,
    applyScrollEdgeMask: applyScrollEdgeMask,
    getSystemDark: getSystemDark,
    isActuallyDark: isActuallyDark,
    getThemeState: getThemeState,
    applyTheme: applyTheme,
    getThemeIcon: getThemeIcon,
    toggleTheme: toggleTheme,
    onSystemThemeChange: onSystemThemeChange,
    setupMobileMenu: setupMobileMenu,
    safeRedirect: safeRedirect,
    formatSupabaseError: formatSupabaseError,
    formatDate: formatDate,
    warmUpServices: warmUpServices,
    recordLoginDevice: recordLoginDevice,
    parseUA: parseUA,
    initMessageBanner: initMessageBanner,
    dismissMessageBanner: dismissBanner,
    initNotificationBell: initNotificationBell,
    requestBrowserNotification: requestBrowserNotification,
    disableBrowserNotification: disableBrowserNotification,
    isBrowserNotificationEnabled: isBrowserNotificationEnabled,
    rateLimit: rateLimit,
    initNav: initNav
  };

  // 注入 Toast 样式
  injectToastStyle();

  // 注入全局交互反馈
  initGlobalFeedback();

  // ====================== Font Awesome CDN 回退 ======================
  /**
   * 检测 Font Awesome 是否成功加载，失败时自动切换到备用 CDN
   * 解决 cdnjs.cloudflare.com 在某些地区不可达的问题
   */
  (function() {
    setTimeout(function() {
      try {
        var test = document.createElement('i');
        test.className = 'fas fa-check';
        test.style.cssText = 'position:absolute;visibility:hidden;width:auto;height:auto;font-size:16px;line-height:1';
        document.body.appendChild(test);
        var w = test.offsetWidth;
        test.remove();
        // FA 图标宽度为 0 说明字体未加载成功
        if (w === 0) {
          var fallback = document.createElement('link');
          fallback.rel = 'stylesheet';
          fallback.href = 'https://cdn.bootcdn.net/ajax/libs/font-awesome/6.5.1/css/all.min.css';
          fallback.crossOrigin = 'anonymous';
          document.head.appendChild(fallback);
          console.warn('Font Awesome CDN fallback activated (primary CDN unreachable)');
        }
      } catch(e) {}
    }, 2500);
  })();

  // 挂载到全局
  global.KJ = KJ;

})(window);
