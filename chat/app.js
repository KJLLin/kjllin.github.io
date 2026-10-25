/**
 * 站内信 · app.js
 *
 * 重构要点（相对旧版）：
 *   1. 会话列表改由数据库聚合（chat_conversations），不再「拉 500 条消息在前端归并」
 *   2. 消息分页（chat_messages 游标），支持向上加载更早消息
 *   3. 用户搜索走 chat_search_users RPC，只返回脱敏提示，不再暴露 email / phone 原值
 *   4. 消息按「日期分隔 + 发送者连续分组」渲染，可读性更好
 *   5. 自己发送的消息显示状态：发送中 / 已发送 / 已读（实时更新）
 *   6. 发送采用乐观渲染，失败自动回滚并恢复输入
 *   7. 实时订阅覆盖 INSERT / UPDATE(已读) / DELETE(删除)
 *   8. 滚动行为：贴近底部才自动跟随，否则提示「新消息」
 */

// ====================== DOM ======================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ====================== Supabase ======================
let sb;

// ====================== 常量 ======================
const PAGE_SIZE = 30;          // 每次加载的消息条数
const GROUP_MS = 3 * 60 * 1000; // 同一人连续发言的合并窗口
const MAX_LEN = 500;           // 与输入框 maxlength 一致（服务端上限 2000）

// ====================== 状态 ======================
const S = {
  user: null,
  partners: {},       // { [id]: { nick, is_admin } }
  conversations: [],  // [{ partnerId, latestText, latestTime, unread }]
  blockedList: [],    // [{ blocked_id }]
  selectedId: null,
  messages: [],       // 当前会话消息（时间正序）
  hasMore: false,     // 是否还有更早的消息
  loadingMore: false,
  channel: null,
  searchSeq: 0,       // 搜索请求序号，丢弃过期响应
  convMenuPartner: null,
};

// ====================== 工具 ======================
const U = {
  escape(str) { return KJ.escapeHtml(str == null ? '' : String(str)); },

  /** 消息时间：今天只显示时分，其余带日期 */
  time(str) {
    if (!str) return '';
    const d = new Date(str);
    if (isNaN(d)) return '';
    const now = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  },

  /** 会话列表用的相对时间 */
  shortTime(str) {
    if (!str) return '';
    const d = new Date(str);
    if (isNaN(d)) return '';
    const now = new Date();
    const dayDiff = Math.floor(
      (new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
       new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000
    );
    if (dayDiff === 0) return U.time(str);
    if (dayDiff === 1) return '昨天';
    if (dayDiff < 7) return `${dayDiff}天前`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  },

  /** 日期分隔标题 */
  dayLabel(str) {
    const d = new Date(str);
    if (isNaN(d)) return '';
    const now = new Date();
    const diff = Math.floor(
      (new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
       new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000
    );
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  },

  sameDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() &&
           x.getMonth() === y.getMonth() &&
           x.getDate() === y.getDate();
  },

  /** 先转义再把 URL 变成可点击链接（转义在前，避免属性注入） */
  linkify(escaped) {
    return escaped.replace(
      /(https?:\/\/[^\s<>"{}|\\^`[\]\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
  },

  /** 生成头像字符（兼容 emoji 代理对） */
  initial(name) {
    return U.escape(Array.from(String(name || '?'))[0] || '?');
  },

  debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  },
};

// ====================== Toast ======================
const Toast = {
  _t: null,
  show(text, type) {
    const el = $('#toast');
    if (!el) return;
    if (this._t) clearTimeout(this._t);
    el.className = `toast ${type || 'info'}`;
    el.textContent = text;
    el.classList.remove('hidden');
    this._t = setTimeout(() => el.classList.add('hidden'), 3600);
  },
  info(t) { this.show(t, 'info'); },
  error(t) { this.show(t, 'error'); },
  success(t) { this.show(t, 'success'); },
};

// ====================== 主题 ======================
const Theme = {
  init() { this._apply(KJ.applyTheme('#f3f3f3', '#0a0a0a')); },
  toggle() {
    KJ.toggleTheme();                       // 切换 自动 → 浅色 → 深色
    this._apply(KJ.applyTheme('#f3f3f3', '#0a0a0a'));
  },
  _apply(state) {
    const btn = $('#themeBtn');
    if (btn && state) btn.innerHTML = KJ.getThemeIcon(state.mode);
  },
};

// ====================== 数据访问层 ======================
const Store = {
  /** 会话列表：一条 RPC 拿到对端、最新消息、未读数 */
  async conversations() {
    const { data, error } = await sb.rpc('chat_conversations');
    if (error) throw error;
    return (data || []).map((r) => ({
      partnerId: r.partner_id,
      nick: r.nick || '',
      isAdmin: r.is_admin === true,
      latestText: r.latest_text || '',
      latestTime: r.latest_time,
      unread: Number(r.unread) || 0,
    }));
  },

  /** 拉取一页消息（p_before 为空则取最新；返回时间正序） */
  async messages(partnerId, before, limit) {
    const { data, error } = await sb.rpc('chat_messages', {
      p_partner: partnerId,
      p_before: before || null,
      p_limit: limit || PAGE_SIZE,
    });
    if (error) throw error;
    return data || [];
  },

  /** 标记对方发来的消息为已读，返回更新条数 */
  async markRead(partnerId) {
    const { data, error } = await sb.rpc('chat_mark_read', { p_partner: partnerId });
    if (error) throw error;
    return Number(data) || 0;
  },

  /** 搜索用户（返回 id/nick/is_admin/hint，不含邮箱手机原值） */
  async searchUsers(term) {
    const { data, error } = await sb.rpc('chat_search_users', { p_term: term });
    if (error) throw error;
    return data || [];
  },

  /** 单个用户的最小公开信息 */
  async profile(userId) {
    const { data, error } = await sb
      .from('profiles_public')
      .select('id, nick, is_admin')
      .eq('id', userId)
      .maybeSingle();
    if (error) return null;
    return data ? { nick: data.nick || '', isAdmin: data.is_admin === true } : null;
  },

  async blocks() {
    const { data, error } = await sb
      .from('user_blocks')
      .select('blocked_id')
      .eq('blocker_id', S.user.id);
    if (error) throw error;
    return data || [];
  },
};

// ====================== 对话列表 ======================
const ConvList = {
  async load() {
    if (!S.user) return;
    this._skeleton();
    try {
      const [blocks, convs] = await Promise.all([
        Store.blocks().catch(() => []),
        Store.conversations(),
      ]);
      S.blockedList = blocks;
      S.conversations = convs;
      for (const c of convs) {
        S.partners[c.partnerId] = { nick: c.nick, is_admin: c.isAdmin };
      }
      this.render();
    } catch (e) {
      console.warn('加载对话列表失败:', e);
      const list = $('#convList');
      if (list) list.innerHTML = '<div class="conv-empty">加载失败，请刷新重试</div>';
    } finally {
      this._removeSkeleton();
    }
  },

  _skeleton() {
    const list = $('#convList');
    if (!list) return;
    const widths = [72, 58, 80, 64, 50];
    let html = '';
    for (let i = 0; i < 5; i++) {
      html += `<div class="sk-conv" aria-hidden="true">
        <div class="sk-line sk-circle"></div>
        <div class="sk-body">
          <div class="sk-line sk-name" style="width:${widths[i]}%"></div>
          <div class="sk-line sk-preview"></div>
        </div></div>`;
    }
    list.innerHTML = html;
  },

  _removeSkeleton() {
    $$('#convList .sk-conv').forEach((el) => el.remove());
  },

  render() {
    const list = $('#convList');
    const blockedEl = $('#blockedList');
    const blockedSection = $('#blockedSection');
    const blockedCount = $('#blockedCount');
    if (!list) return;

    const blockedIds = new Set(S.blockedList.map((b) => b.blocked_id));
    const normal = S.conversations.filter((c) => !blockedIds.has(c.partnerId));
    const blocked = S.conversations.filter((c) => blockedIds.has(c.partnerId));

    list.innerHTML = normal.length
      ? normal.map((c) => this._item(c, false)).join('')
      : `<div class="conv-empty">${blocked.length ? '暂无活跃对话' : '暂无对话，搜索用户（手机号/昵称/邮箱）发起私信'}</div>`;

    if (blockedSection) {
      if (blocked.length) {
        blockedSection.style.display = '';
        if (blockedCount) blockedCount.textContent = String(blocked.length);
        if (blockedEl) blockedEl.innerHTML = blocked.map((c) => this._item(c, true)).join('');
      } else {
        blockedSection.style.display = 'none';
      }
    }

    this._highlight();
  },

  _item(c, isBlocked) {
    const p = S.partners[c.partnerId] || {};
    const name = p.nick || '用户';
    const avatar = U.initial(name);
    const preview = U.escape((c.latestText || '').replace(/\s+/g, ' ').slice(0, 40));
    const time = U.shortTime(c.latestTime);
    const badge = c.unread > 0
      ? `<span class="conv-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
    const adminBadge = p.is_admin
      ? '<span class="chat-admin-badge"><i class="fas fa-shield-halved"></i> 管理员</span>' : '';

    return `<div class="conv-item" data-id="${c.partnerId}" role="button" tabindex="0" aria-label="与 ${U.escape(name)} 的对话">
      <div class="conv-avatar">${avatar}</div>
      <div class="conv-body">
        <div class="conv-top">
          <span class="conv-name">${U.escape(name)}${adminBadge}</span>
          <span class="conv-time">${time}</span>
        </div>
        <div class="conv-preview">${preview || '<span class="conv-draft">暂无消息</span>'}${badge}</div>
      </div>
      <button class="conv-menu-trigger" data-id="${c.partnerId}" data-blocked="${isBlocked}" title="更多操作" aria-label="更多操作">⋮</button>
    </div>`;
  },

  _highlight() {
    if (!S.selectedId) return;
    $$('.conv-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === S.selectedId);
    });
  },

  /** 收到新消息 / 发送成功后的局部更新 */
  touch(partnerId, text, createdAt, incoming) {
    let conv = S.conversations.find((c) => c.partnerId === partnerId);
    if (!conv) {
      conv = { partnerId, latestText: text, latestTime: createdAt, unread: 0 };
      S.conversations.unshift(conv);
      if (!S.partners[partnerId]) {
        Store.profile(partnerId).then((p) => {
          if (p) { S.partners[partnerId] = p; this.render(); }
        });
      }
    }
    conv.latestText = text;
    conv.latestTime = createdAt;

    // 只有「别人发来 且 不是当前打开的会话」才计入未读（旧版对自发消息也会 +1）
    if (incoming && partnerId !== S.selectedId) conv.unread += 1;

    S.conversations.sort((a, b) => new Date(b.latestTime) - new Date(a.latestTime));
    this.render();
  },

  clearUnread(partnerId) {
    const conv = S.conversations.find((c) => c.partnerId === partnerId);
    if (conv && conv.unread) { conv.unread = 0; this.render(); }
  },

  remove(partnerId) {
    S.conversations = S.conversations.filter((c) => c.partnerId !== partnerId);
    this.render();
  },
};

// ====================== 屏蔽 / 删除 ======================
const BlockActions = {
  async block(partnerId) {
    try {
      const { error } = await sb.from('user_blocks').upsert(
        { blocker_id: S.user.id, blocked_id: partnerId },
        { onConflict: 'blocker_id,blocked_id' }
      );
      if (error) throw error;
      if (!S.blockedList.some((b) => b.blocked_id === partnerId)) {
        S.blockedList.push({ blocked_id: partnerId });
      }
      ConvList.render();
      Toast.success('已屏蔽该用户');
    } catch (e) {
      console.warn('block failed:', e);
      Toast.error('操作失败，请稍后重试');
    }
  },

  async unblock(partnerId) {
    try {
      const { error } = await sb.from('user_blocks')
        .delete().eq('blocker_id', S.user.id).eq('blocked_id', partnerId);
      if (error) throw error;
      S.blockedList = S.blockedList.filter((b) => b.blocked_id !== partnerId);
      ConvList.render();
      Toast.success('已取消屏蔽');
    } catch (e) {
      console.warn('unblock failed:', e);
      Toast.error('操作失败，请稍后重试');
    }
  },

  async deleteConversation(partnerId) {
    if (!confirm('将永久删除你发送的消息（双方均不可见）。对方发送的消息会保留在对方那里。确定删除吗？')) return;
    try {
      const { error } = await sb.from('private_messages')
        .delete().eq('sender_id', S.user.id).eq('recipient_id', partnerId);
      if (error) throw error;

      // 只从当前视图移除「我发的」消息，对方的仍保留
      S.messages = S.messages.filter((m) => m.sender_id !== S.user.id);
      const conv = S.conversations.find((c) => c.partnerId === partnerId);
      const last = [...S.messages].reverse().find((m) => !m._pending);
      if (conv && last) {
        conv.latestText = last.text;
        conv.latestTime = last.created_at;
        ConvList.render();
      } else if (conv) {
        ConvList.remove(partnerId);
        if (S.selectedId === partnerId) ChatView.close();
      }
      ChatView.render();
      Toast.success('已删除你发送的消息');
    } catch (e) {
      console.warn('delete failed:', e);
      Toast.error('删除失败，请稍后重试');
    }
  },
};

// ====================== 聊天视图 ======================
const ChatView = {
  async open(partnerId) {
    if (!partnerId) return;
    S.selectedId = partnerId;
    S.messages = [];
    S.hasMore = false;
    S.loadingMore = false;
    S._lastNewId = null;
    S.canAutoLoad = false;   // 初始滚动到底之前，先不要触发「自动加载更早」

    $('#chatPlaceholder')?.classList.add('hidden');
    $('#chatView')?.classList.remove('hidden');

    if (window.innerWidth <= 768) {
      document.getElementById('sidebar')?.classList.add('hidden-mobile');
      document.getElementById('chatMain')?.classList.remove('hidden-mobile');
    }

    this._renderHeader(partnerId);
    ConvList._highlight();

    const list = $('#msgList');
    if (list) list.innerHTML = '<div class="msg-loading">加载中...</div>';

    try {
      const rows = await Store.messages(partnerId, null, PAGE_SIZE + 1);
      S.hasMore = rows.length > PAGE_SIZE;
      S.messages = S.hasMore ? rows.slice(rows.length - PAGE_SIZE) : rows;
      this.render({ scroll: 'bottom' });
      this._renderEarlierBtn();
      // 等初始的「滚到底部」完成后再开启向上自动加载
      setTimeout(() => { S.canAutoLoad = true; }, 700);
    } catch (e) {
      console.warn('加载消息失败:', e);
      if (list) list.innerHTML = '<div class="msg-error">消息加载失败，请重试</div>';
      return;
    }

    this.markRead(partnerId);
    setTimeout(() => $('#msgInput')?.focus(), 80);
  },

  close() {
    S.selectedId = null;
    S.messages = [];
    $('#chatView')?.classList.add('hidden');
    $('#chatPlaceholder')?.classList.remove('hidden');
    this._renderEarlierBtn();
  },

  _renderHeader(partnerId) {
    const p = S.partners[partnerId] || {};
    const name = U.escape(p.nick || '用户');
    const badge = p.is_admin
      ? ' <span class="chat-admin-badge"><i class="fas fa-shield-halved"></i> 管理员</span>' : '';
    const el = $('#chatPartnerName');
    if (el) el.innerHTML = `与 ${name} 的对话${badge}`;
  },

  /** 计算每条消息是否需要显示时间（每组最后一条） */
  _metaFlags(msgs) {
    const flags = [];
    for (let i = 0; i < msgs.length; i++) {
      const cur = msgs[i];
      const next = msgs[i + 1];
      if (!next) { flags.push(true); continue; }
      const grouped = next.sender_id === cur.sender_id &&
        U.sameDay(cur.created_at, next.created_at) &&
        (new Date(next.created_at) - new Date(cur.created_at) < GROUP_MS);
      flags.push(!grouped);
    }
    return flags;
  },

  _statusHtml(m) {
    if (m._pending) return '<span class="msg-status pending"><i class="fas fa-circle-notch fa-spin"></i> 发送中</span>';
    if (m._failed) return '<span class="msg-status failed"><i class="fas fa-circle-exclamation"></i> 发送失败</span>';
    return m.read
      ? '<span class="msg-status read" title="已读"><i class="fas fa-check-double"></i> 已读</span>'
      : '<span class="msg-status" title="已发送"><i class="fas fa-check"></i></span>';
  },

  _rowHtml(m, showMeta, isNew) {
    const isMe = m.sender_id === S.user.id;
    const text = U.linkify(U.escape(m.text));
    const cls = ['msg-row', isMe ? 'msg-me' : 'msg-them'];
    if (isNew) cls.push('msg-new');
    if (m._pending) cls.push('msg-pending');
    return `<div class="${cls.join(' ')}" data-mid="${m.id}">
      <div class="msg-bubble">${text}</div>
      ${showMeta ? `<div class="msg-meta"><span class="msg-time">${U.time(m.created_at)}</span>${isMe ? this._statusHtml(m) : ''}</div>` : ''}
    </div>`;
  },

  render(opts = {}) {
    const el = $('#msgList');
    if (!el) return;

    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    const nearBottom = prevHeight - prevTop - el.clientHeight < 120;

    const msgs = S.messages;
    const flags = this._metaFlags(msgs);

    let html = '';
    let lastDay = '';
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const day = U.dayLabel(m.created_at);
      if (day !== lastDay) {
        html += `<div class="msg-day"><span>${U.escape(day)}</span></div>`;
        lastDay = day;
      }
      html += this._rowHtml(m, flags[i], m.id === S._lastNewId);
    }

    if (!msgs.length) html = '<div class="msg-empty">还没有消息，打个招呼吧</div>';
    el.innerHTML = html;

    if (opts.scroll === 'bottom' || (opts.scroll !== 'keep' && nearBottom)) {
      this.scrollBottom(false);
    } else if (opts.scroll === 'keep') {
      el.scrollTop = el.scrollHeight - prevHeight + prevTop;
    } else {
      this._showNewBtn(true);
    }
  },

  scrollBottom(smooth = true) {
    const el = $('#msgList');
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      this._showNewBtn(false);
    });
  },

  _showNewBtn(show) {
    const btn = $('#newMsgBtn');
    if (!btn) return;
    btn.classList.toggle('hidden', !show);
  },

  _renderEarlierBtn() {
    const box = $('#earlierBox');
    if (!box) return;
    box.innerHTML = S.hasMore
      ? '<button id="loadEarlierBtn" class="load-earlier-btn">加载更早的消息</button>'
      : '';
  },

  async loadEarlier() {
    if (!S.selectedId || !S.hasMore || S.loadingMore) return;
    S.loadingMore = true;
    const btn = $('#loadEarlierBtn');
    if (btn) { btn.disabled = true; btn.textContent = '加载中...'; }
    try {
      const oldest = S.messages[0]?.created_at;
      const rows = await Store.messages(S.selectedId, oldest, PAGE_SIZE + 1);
      const more = rows.length > PAGE_SIZE;
      const batch = more ? rows.slice(rows.length - PAGE_SIZE) : rows;
      S.hasMore = more;
      S.messages = batch.concat(S.messages);
      S._lastNewId = null;
      this.render({ scroll: 'keep' });
      this._renderEarlierBtn();
    } catch (e) {
      console.warn('加载更早消息失败:', e);
      Toast.error('加载失败，请重试');
      if (btn) { btn.disabled = false; btn.textContent = '加载更早的消息'; }
    } finally {
      S.loadingMore = false;
    }
  },

  appendIncoming(msg) {
    if (S.messages.some((m) => m.id === msg.id)) return;
    S.messages.push(msg);
    S._lastNewId = msg.id;
    this.render();
  },

  updateMessage(msg) {
    const i = S.messages.findIndex((m) => m.id === msg.id);
    if (i < 0) return;
    S.messages[i] = { ...S.messages[i], ...msg };
    // 已读状态变化只需更新对应行，避免整列重绘
    const row = document.querySelector(`.msg-row[data-mid="${msg.id}"] .msg-meta`);
    if (row && msg.sender_id === S.user.id) {
      const status = row.querySelector('.msg-status');
      if (status) status.outerHTML = this._statusHtml(S.messages[i]);
    } else {
      this.render({ scroll: 'keep' });
    }
  },

  removeMessage(id) {
    const before = S.messages.length;
    S.messages = S.messages.filter((m) => m.id !== id);
    if (S.messages.length !== before) this.render({ scroll: 'keep' });
  },

  async markRead(partnerId) {
    try {
      const n = await Store.markRead(partnerId);
      if (n > 0) ConvList.clearUnread(partnerId);
      else ConvList.clearUnread(partnerId);
    } catch (e) {
      console.warn('标记已读失败:', e);
    }
  },

  async send() {
    if (!S.selectedId) return;
    const input = $('#msgInput');
    const text = (input?.value || '').trim();
    if (!text) { Toast.error('不能发送空消息'); return; }
    if (text.length > MAX_LEN) { Toast.error(`消息不能超过${MAX_LEN}个字符`); return; }

    const partnerId = S.selectedId;
    const btn = $('#sendBtn');
    const saved = input.value;

    // 乐观渲染：先上屏，再发请求
    const temp = {
      id: 'tmp-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      sender_id: S.user.id,
      recipient_id: partnerId,
      text,
      created_at: new Date().toISOString(),
      read: false,
      _pending: true,
    };
    S.messages.push(temp);
    S._lastNewId = temp.id;
    this.render();
    input.value = '';
    input.style.height = 'auto';
    if (btn) { btn.disabled = true; btn.textContent = '发送中...'; }

    try {
      const { data, error } = await sb.from('private_messages')
        .insert([{ sender_id: S.user.id, recipient_id: partnerId, text }])
        .select('id, sender_id, recipient_id, text, read, created_at')
        .single();
      if (error) throw error;

      const i = S.messages.findIndex((m) => m.id === temp.id);
      if (i >= 0) S.messages[i] = data; else S.messages.push(data);
      S._lastNewId = data.id;
      this.render({ scroll: 'bottom' });
      ConvList.touch(partnerId, text, data.created_at, false);
      input.focus();
    } catch (e) {
      console.warn('发送失败:', e);
      const i = S.messages.findIndex((m) => m.id === temp.id);
      if (i >= 0) S.messages.splice(i, 1);
      this.render({ scroll: 'keep' });
      input.value = saved;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      Toast.error(KJ.formatSupabaseError ? KJ.formatSupabaseError(e) : '发送失败，请重试');
      input.focus();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '发送'; }
    }
  },
};

// ====================== 用户搜索 ======================
const Search = {
  async input(term) {
    const el = $('#searchResults');
    if (!el) return;
    const trimmed = String(term || '').trim();

    if (!trimmed) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    if (trimmed.length < 2) {
      el.innerHTML = '<div class="search-empty">至少输入 2 个字符</div>';
      el.classList.remove('hidden');
      return;
    }

    const seq = ++S.searchSeq;
    try {
      const rows = await Store.searchUsers(trimmed);
      if (seq !== S.searchSeq) return; // 丢弃过期响应

      if (!rows.length) {
        el.innerHTML = '<div class="search-empty">未找到该用户</div>';
        el.classList.remove('hidden');
        return;
      }

      el.innerHTML = rows.map((u) => {
        const name = u.nick || '未设置昵称';
        const badge = u.is_admin === true
          ? ' <span class="chat-admin-badge"><i class="fas fa-shield-halved"></i> 管理员</span>' : '';
        return `<div class="search-item" data-id="${u.id}" data-nick="${U.escape(name)}" data-admin="${u.is_admin === true ? '1' : ''}" role="button" tabindex="0">
          <span class="search-avatar">${U.initial(name)}</span>
          <div class="search-info">
            <span class="search-nick">${U.escape(name)}${badge}</span>
            <span class="search-email">${U.escape(u.hint || '')}</span>
          </div>
        </div>`;
      }).join('');
      el.classList.remove('hidden');
    } catch (e) {
      console.warn('搜索失败:', e);
      if (seq !== S.searchSeq) return;
      el.innerHTML = '<div class="search-empty">搜索出错，请稍后重试</div>';
      el.classList.remove('hidden');
    }
  },

  select(userId, nick, isAdmin) {
    S.partners[userId] = { nick: nick || '用户', is_admin: isAdmin === true };
    $('#searchResults')?.classList.add('hidden');
    const box = $('#searchResults');
    if (box) box.innerHTML = '';
    const input = $('#searchInput');
    if (input) input.value = '';

    if (!S.conversations.some((c) => c.partnerId === userId)) {
      S.conversations.unshift({
        partnerId: userId,
        latestText: '',
        latestTime: new Date().toISOString(),
        unread: 0,
      });
      ConvList.render();
    }
    ChatView.open(userId);
  },
};

// ====================== 实时订阅 ======================
const Realtime = {
  subscribe() {
    if (!S.user) return;
    if (S.channel) { sb.removeChannel(S.channel).catch(() => {}); S.channel = null; }

    const uid = S.user.id;
    S.channel = sb.channel('chat:' + uid)
      // 别人发给我的
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'private_messages', filter: `recipient_id=eq.${uid}` },
        (payload) => {
          const msg = payload.new;
          if (msg.sender_id === S.selectedId) {
            ChatView.appendIncoming(msg);
            ChatView.markRead(msg.sender_id);
          }
          ConvList.touch(msg.sender_id, msg.text, msg.created_at, true);
        })
      // 我发的（insert 响应可能晚于推送）
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'private_messages', filter: `sender_id=eq.${uid}` },
        (payload) => {
          const msg = payload.new;
          if (S.messages.some((m) => m.id === msg.id)) return;

          // 与乐观渲染的临时消息合并，避免重复上屏
          const idx = S.messages.findIndex((m) =>
            m._pending && m.text === msg.text && m.recipient_id === msg.recipient_id);
          if (idx >= 0) {
            S.messages[idx] = msg;
            S._lastNewId = msg.id;
            ChatView.render({ scroll: 'keep' });
          } else if (msg.recipient_id === S.selectedId) {
            ChatView.appendIncoming(msg);
          }
          ConvList.touch(msg.recipient_id, msg.text, msg.created_at, false);
        })
      // 已读回执：我发的消息被对方读了
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'private_messages', filter: `sender_id=eq.${uid}` },
        (payload) => {
          if (payload.new && payload.new.read === true) ChatView.updateMessage(payload.new);
        })
      // 消息被删除（双方同步）
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'private_messages' },
        (payload) => {
          const old = payload.old || {};
          if (old.id) ChatView.removeMessage(old.id);
        })
      .subscribe();
  },

  teardown() {
    if (S.channel) { sb.removeChannel(S.channel).catch(() => {}); S.channel = null; }
  },
};

// ====================== 事件绑定 ======================
function bindEvents() {
  $('#themeBtn')?.addEventListener('click', () => Theme.toggle());

  // 搜索（防抖）
  const doSearch = U.debounce((v) => Search.input(v), 280);
  $('#searchInput')?.addEventListener('input', (e) => doSearch(e.target.value));

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sidebar-search')) $('#searchResults')?.classList.add('hidden');
  });

  const onSelectResult = (e) => {
    const item = e.target.closest('.search-item');
    if (!item) return;
    Search.select(item.dataset.id, item.dataset.nick, item.dataset.admin === '1');
  };
  $('#searchResults')?.addEventListener('click', onSelectResult);
  $('#searchResults')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectResult(e); }
  });

  // 会话列表
  const onConvClick = (e) => {
    const menuBtn = e.target.closest('.conv-menu-trigger');
    if (menuBtn) {
      e.stopPropagation();
      showConvMenu(menuBtn.dataset.id, menuBtn.dataset.blocked === 'true', menuBtn);
      return;
    }
    const item = e.target.closest('.conv-item');
    if (item) ChatView.open(item.dataset.id);
  };
  $('#convList')?.addEventListener('click', onConvClick);
  $('#blockedList')?.addEventListener('click', onConvClick);
  const onConvKey = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.conv-item');
    if (item) { e.preventDefault(); ChatView.open(item.dataset.id); }
  };
  $('#convList')?.addEventListener('keydown', onConvKey);
  $('#blockedList')?.addEventListener('keydown', onConvKey);

  // 屏蔽区折叠
  $('#blockedHeader')?.addEventListener('click', () => {
    const list = $('#blockedList');
    const header = $('#blockedHeader');
    if (!list) return;
    const open = list.style.display !== 'none';
    list.style.display = open ? 'none' : '';
    header?.classList.toggle('open', !open);
  });

  // 菜单
  const closeMenu = () => $('#convMenu')?.classList.add('hidden');
  document.addEventListener('click', closeMenu);
  $('#convList')?.addEventListener('scroll', closeMenu, { passive: true });
  $('#blockedList')?.addEventListener('scroll', closeMenu, { passive: true });
  window.addEventListener('resize', closeMenu, { passive: true });

  $('#convMenu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const action = e.target.closest('.conv-menu-item')?.dataset.action;
    const pid = S.convMenuPartner;
    closeMenu();
    if (!pid || !action) return;
    if (action === 'block') BlockActions.block(pid);
    else if (action === 'unblock') BlockActions.unblock(pid);
    else if (action === 'delete') BlockActions.deleteConversation(pid);
  });

  window.showConvMenu = function (partnerId, isBlocked, anchor) {
    S.convMenuPartner = partnerId;
    const menu = $('#convMenu');
    if (!menu) return;
    const rect = anchor.getBoundingClientRect();
    const blockItem = menu.querySelector('[data-action="block"]');
    const unblockItem = menu.querySelector('[data-action="unblock"]');
    if (blockItem) blockItem.style.display = isBlocked ? 'none' : '';
    if (unblockItem) unblockItem.style.display = isBlocked ? '' : 'none';

    menu.classList.remove('hidden');
    menu.style.left = '-9999px';
    menu.style.top = '0px';
    const mw = menu.offsetWidth, mh = menu.offsetHeight, margin = 8;
    let left = Math.min(rect.right - mw, window.innerWidth - mw - margin);
    left = Math.max(left, margin);
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - margin) top = Math.max(rect.top - mh - 4, margin);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  };

  // 发送
  $('#sendBtn')?.addEventListener('click', () => ChatView.send());
  const input = $('#msgInput');
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ChatView.send(); }
  });
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // 加载更早（事件委托，按钮是动态渲染的）
  $('#earlierBox')?.addEventListener('click', (e) => {
    if (e.target.closest('#loadEarlierBtn')) ChatView.loadEarlier();
  });

  // 回到最新
  $('#newMsgBtn')?.addEventListener('click', () => ChatView.scrollBottom(true));

  // 滚动到底部附近时收起「新消息」提示；接近顶部时自动加载更早
  let scrollLock = false;
  $('#msgList')?.addEventListener('scroll', () => {
    const el = $('#msgList');
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 120) ChatView._showNewBtn(false);
    if (S.canAutoLoad && el.scrollTop < 40 && S.hasMore && !S.loadingMore && !scrollLock) {
      scrollLock = true;
      ChatView.loadEarlier().finally(() => setTimeout(() => { scrollLock = false; }, 400));
    }
  }, { passive: true });

  // 移动端返回列表
  $('#chatViewHeader')?.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar')?.classList.remove('hidden-mobile');
      document.getElementById('chatMain')?.classList.add('hidden-mobile');
    }
  });

  window.addEventListener('beforeunload', () => Realtime.teardown());
}

// ====================== 初始化 ======================
async function init() {
  Theme.init();

  sb = KJ.createSupabase();
  if (!sb) {
    Toast.error('Supabase 初始化失败，请刷新页面');
    hideLoading();
    return;
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
      window.location.href = '/login/?redirect=/chat';
    } else if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
      if (!session?.user) window.location.href = '/login/?redirect=/chat';
    } else if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
      if (session?.user) S.user = session.user;
    }
  });

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { window.location.href = '/login/?redirect=/chat'; return; }

    S.user = session.user;

    // 昵称：优先 users.nick，其次 auth 元数据 / 邮箱前缀
    try {
      const { data } = await sb.from('users').select('nick, email').eq('id', S.user.id).limit(1);
      if (data?.length) {
        S.user.nick = data[0].nick;
        S.user.email = data[0].email;
      }
    } catch (e) { /* 忽略，使用回退值 */ }
    if (!S.user.nick) S.user.nick = S.user.email?.split('@')[0] || '用户';

    bindEvents();
    hideLoading();

    try { await ConvList.load(); } catch (e) { console.warn('加载对话失败:', e); }
    Realtime.subscribe();

    // ?to=<uuid> 直达会话
    const to = new URLSearchParams(location.search).get('to');
    if (to && to !== S.user.id) {
      const p = await Store.profile(to).catch(() => null);
      Search.select(to, p?.nick || '用户', p?.isAdmin === true);
    }
  } catch (e) {
    console.error('Chat init failed:', e);
    Toast.error('加载失败，请刷新页面');
  }

  KJ.setupMobileMenu('#hamburgerBtn', '#mobileMenu');
  KJ.initNav(sb, { homeUrl: '/' });
  hideLoading();
}

function hideLoading() {
  const overlay = $('#loadingOverlay');
  if (!overlay) return;
  overlay.style.opacity = '0';
  setTimeout(() => overlay.classList.add('hidden'), 300);
}

// ====================== 生命周期 ======================
document.addEventListener('DOMContentLoaded', init);
if (KJ.onSystemThemeChange) KJ.onSystemThemeChange(() => Theme.init());
