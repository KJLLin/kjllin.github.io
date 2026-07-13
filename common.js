/**
 * KJLLin 共享工具模块 — common.js
 * 所有页面统一引用，消除重复代码
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
  /**
   * 创建 Supabase 客户端（安全存储）
   * @returns {object|null} Supabase client 或 null
   */
  function createSupabase() {
    try {
      if (!global.supabase) return null;
      return global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
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
    style.textContent = '.kj-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:20px;font-size:14px;z-index:9999;background:var(--text-primary,#1a1a1a);color:var(--bg-body,#f3f3f3);box-shadow:0 4px 16px rgba(0,0,0,0.15);animation:kjToastIn .3s cubic-bezier(.34,1.56,.64,1)}@keyframes kjToastIn{from{opacity:0;transform:translateX(-50%) translateY(12px)}}';
    document.head.appendChild(style);
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

  // ====================== 暴露 API ======================
  var KJ = {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_KEY: SUPABASE_KEY,
    safeStorage: safeStorage,
    createSupabase: createSupabase,
    escapeHtml: escapeHtml,
    toast: toast,
    injectToastStyle: injectToastStyle,
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
    warmUpServices: warmUpServices
  };

  // 注入 Toast 样式
  injectToastStyle();

  // 挂载到全局
  global.KJ = KJ;

})(window);
