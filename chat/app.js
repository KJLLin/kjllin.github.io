// ====================== DOM 引用 ======================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ====================== Supabase ======================
let sb;

// ====================== 全局状态 ======================
const S = {
  user: null,          // { id, email, nick }
  partners: {},        // { [id]: { nick, email } }
  conversations: [],   // [{ partnerId, latestText, latestTime, unread }]
  blockedList: [],     // [{ blocked_id }] from user_blocks table
  selectedId: null,
  messages: [],
  channel: null,
  searchLock: false,
  convMenuPartner: null, // 当前菜单指向的用户
};

// ====================== 工具函数 ======================
const U = {
  escape(str) { return KJ.escapeHtml(str); },
  time(str) {
    if (!str) return '';
    const d = new Date(str);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (isToday) return `${hh}:${mm}`;
    const M = d.getMonth() + 1;
    const D = d.getDate();
    return `${M}/${D} ${hh}:${mm}`;
  },
  async request(promise, msg) {
    try {
      const r = await promise;
      if (r.error) throw r.error;
      return r;
    } catch (e) {
      Toast.error(msg || e.message || '请求失败');
      throw e;
    }
  },
  // 将文本中的 URL 转为可点击链接（在 escape 之后调用）
  linkify(text) {
    // 排除 CJK 字符（汉字、CJK 标点、全角符号等），避免 URL 后紧跟的中文被并入链接
    return text.replace(/(https?:\/\/[^\s<>"{}|\\^`[\]\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="word-break:break-all">$1</a>');
  },
};

// ====================== Toast 通知 ======================
const Toast = {
  _t: null,
  show(text, type) {
    const el = $('#toast');
    if (this._t) clearTimeout(this._t);
    el.className = `toast ${type}`;
    el.textContent = text;
    el.classList.remove('hidden');
    this._t = setTimeout(() => el.classList.add('hidden'), 4000);
  },
  info(t) { this.show(t, 'info'); },
  error(t) { this.show(t, 'error'); },
  success(t) { this.show(t, 'success'); },
};

// ====================== 主题 ======================
const Theme = {
  init() {
    const state = KJ.applyTheme('#f3f3f3', '#0a0a0a');
    this._updateBtn(state.mode);
  },
  toggle() {
    const state = KJ.toggleTheme();
    KJ.applyTheme('#f3f3f3', '#0a0a0a');
    this._updateBtn(state.mode);
  },
  _updateBtn(mode) {
    const btn = $('#themeBtn');
    if (!btn) return;
    btn.innerHTML = KJ.getThemeIcon(mode);
  },
};

// ====================== 对话列表 ======================
const ConvList = {
  async load() {
    if (!S.user) return;
    // 数据加载阶段：渲染骨架占位（render() 时替换，异常时由 finally 兜底移除）
    this._renderSkeleton();
    try {
      // 加载屏蔽列表
      const { data: blocks, error: blocksError } = await sb.from('user_blocks').select('blocked_id').eq('blocker_id', S.user.id);
      if (blocksError) console.warn('加载屏蔽列表失败:', blocksError);
      S.blockedList = blocks || [];

      const { data, error } = await sb
        .from('private_messages')
        .select('id, sender_id, recipient_id, text, created_at, read')
        .or(`sender_id.eq.${S.user.id},recipient_id.eq.${S.user.id}`)
        .order('created_at', { ascending: false })
        .limit(500);

      if (error) { console.warn('加载对话列表失败:', error); this.render(); return; }
      if (!data) { this.render(); return; }

      const convMap = {};
      for (const m of data) {
        const pid = m.sender_id === S.user.id ? m.recipient_id : m.sender_id;
        if (!convMap[pid]) {
          convMap[pid] = { latestText: m.text, latestTime: m.created_at, unread: 0 };
        }
        if (m.recipient_id === S.user.id && !m.read) {
          convMap[pid].unread++;
        }
      }

      S.conversations = Object.entries(convMap).map(([pid, v]) => ({
        partnerId: pid,
        latestText: v.latestText,
        latestTime: v.latestTime,
        unread: v.unread,
      }));
      S.conversations.sort((a, b) => new Date(b.latestTime) - new Date(a.latestTime));

      // 批量加载用户信息
      const ids = S.conversations.map(c => c.partnerId);
      if (ids.length) {
        const { data: users, error: usersError } = await sb.from('users').select('id, nick, email, is_admin').in('id', ids);
        if (usersError) console.warn('加载用户信息失败:', usersError);
        if (users) {
          for (const u of users) S.partners[u.id] = { nick: u.nick, email: u.email, is_admin: u.is_admin === true };
        }
      }

      this.render();
    } finally {
      // 骨架屏兜底移除：正常路径 render() 已通过 innerHTML 替换，此处保证异常时也不残留
      this._removeSkeleton();
    }
  },

  // 对话列表骨架屏（数据加载阶段占位）
  _renderSkeleton() {
    const list = $('#convList');
    if (!list) return;
    const widths = [72, 58, 80, 64, 50];
    let html = '';
    for (let i = 0; i < 5; i++) {
      html += `
        <div class="sk-conv" aria-hidden="true">
          <div class="sk-line sk-circle"></div>
          <div class="sk-body">
            <div class="sk-line sk-name" style="width:${widths[i]}%"></div>
            <div class="sk-line sk-preview"></div>
          </div>
        </div>`;
    }
    list.innerHTML = html;
  },

  _removeSkeleton() {
    document.querySelectorAll('#convList .sk-conv').forEach(el => el.remove());
  },

  render() {
    const list = $('#convList');
    const blockedEl = $('#blockedList');
    const blockedSection = $('#blockedSection');
    const blockedCount = $('#blockedCount');

    // 分离已屏蔽和未屏蔽的对话
    const blockedIds = new Set(S.blockedList.map(b => b.blocked_id));
    const normal = S.conversations.filter(c => !blockedIds.has(c.partnerId));
    const blocked = S.conversations.filter(c => blockedIds.has(c.partnerId));

    // 渲染正常对话
    if (!normal.length && !blocked.length) {
      list.innerHTML = '<div class="conv-empty">暂无对话，搜索用户邮箱发起私信</div>';
    } else if (!normal.length) {
      list.innerHTML = '<div class="conv-empty">暂无活跃对话</div>';
    } else {
      list.innerHTML = normal.map(c => this._renderItem(c)).join('');
    }

    // 渲染屏蔽用户区域
    if (blocked.length) {
      blockedSection.style.display = '';
      blockedCount.textContent = blocked.length;
      blockedEl.innerHTML = blocked.map(c => this._renderItem(c, true)).join('');
    } else {
      blockedSection.style.display = 'none';
    }

    // 保持选中状态高亮
    if (S.selectedId) {
      const item = document.querySelector(`.conv-item[data-id="${S.selectedId}"]`);
      if (item) item.classList.add('active');
    }
  },

  _renderItem(c, isBlocked = false) {
    const p = S.partners[c.partnerId];
    const rawName = p?.nick || p?.email || p?.phone || c.partnerId;
    const name = U.escape(rawName);
    // 管理员徽章（名字本身已 escape）
    const adminBadge = p?.is_admin ? '<span class="chat-admin-badge"><i class="fas fa-shield-halved"></i> 管理员</span>' : '';
    // 头像取首字符（用 Array.from 兼容 emoji 等代理对字符），先取字符再 escape
    const avatar = U.escape(Array.from(rawName)[0] || '?');
    const text = U.escape((c.latestText || '').substring(0, 40));
    const time = U.time(c.latestTime);
    const badge = c.unread > 0 ? `<span class="conv-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
    return `
      <div class="conv-item" data-id="${c.partnerId}">
        <div class="conv-avatar">${avatar}</div>
        <div class="conv-body">
          <div class="conv-top">
            <span class="conv-name">${name}${adminBadge}</span>
            <span class="conv-time">${time}</span>
          </div>
          <div class="conv-preview">${text}${badge}</div>
        </div>
        <button class="conv-menu-trigger" data-id="${c.partnerId}" data-blocked="${isBlocked}" title="更多操作">⋮</button>
      </div>`;
  },

  // 更新单个对话（收到新消息时）
  async refreshOne(partnerId, text, createdAt) {
    let conv = S.conversations.find(c => c.partnerId === partnerId);
    if (conv) {
      conv.latestText = text;
      conv.latestTime = createdAt;
      if (partnerId !== S.selectedId) conv.unread++;
      S.conversations.sort((a, b) => new Date(b.latestTime) - new Date(a.latestTime));
    } else {
      S.conversations.unshift({
        partnerId,
        latestText: text,
        latestTime: createdAt,
        unread: partnerId !== S.selectedId ? 1 : 0,
      });
      // 加载新用户信息
      const { data } = await sb.from('users').select('id, nick, email, is_admin').eq('id', partnerId).limit(1);
      if (data?.length) S.partners[partnerId] = { nick: data[0].nick, email: data[0].email, is_admin: data[0].is_admin === true };
    }
    this.render();
    // 保持选中状态高亮
    if (S.selectedId) {
      const item = $(`.conv-item[data-id="${S.selectedId}"]`);
      if (item) item.classList.add('active');
    }
  },
};

// ====================== 屏蔽/删除操作 ======================
const BlockActions = {
  async blockUser(partnerId) {
    try {
      const { error } = await sb.from('user_blocks').upsert({ blocker_id: S.user.id, blocked_id: partnerId }, { onConflict: 'blocker_id,blocked_id' });
      if (error) throw error;
      S.blockedList.push({ blocked_id: partnerId });
      if (S.selectedId === partnerId) { S.selectedId = null; $('#chatView').classList.add('hidden'); $('#chatPlaceholder').classList.remove('hidden'); }
      ConvList.render();
      Toast.success('已屏蔽该用户');
    } catch(e) { Toast.error('操作失败，请稍后重试'); }
  },
  async unblockUser(partnerId) {
    try {
      const { error } = await sb.from('user_blocks').delete().eq('blocker_id', S.user.id).eq('blocked_id', partnerId);
      if (error) throw error;
      S.blockedList = S.blockedList.filter(b => b.blocked_id !== partnerId);
      ConvList.render();
      Toast.success('已取消屏蔽');
    } catch(e) { Toast.error('操作失败，请稍后重试'); }
  },
  async deleteConversation(partnerId) {
    // RLS 限制只能删除自己发送的消息（物理删除，双方均不可见），对方发送的消息会保留
    if (!confirm('将永久删除你发送的消息（双方均不可见），对方发送的消息仍会保留。确定删除吗？')) return;
    try {
      const { error } = await sb.from('private_messages').delete().eq('sender_id', S.user.id).eq('recipient_id', partnerId);
      if (error) throw error;
      S.conversations = S.conversations.filter(c => c.partnerId !== partnerId);
      if (S.selectedId === partnerId) { S.selectedId = null; $('#chatView').classList.add('hidden'); $('#chatPlaceholder').classList.remove('hidden'); }
      ConvList.render();
      Toast.success('聊天记录已删除');
    } catch(e) { Toast.error('删除失败，请稍后重试'); }
  },
};

// ====================== 聊天视图 ======================
const ChatView = {
  async open(partnerId) {
    S.selectedId = partnerId;
    S.messages = [];

    $('#chatPlaceholder').classList.add('hidden');
    $('#chatView').classList.remove('hidden');

    // 移动端：隐藏侧栏，显示聊天区
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.add('hidden-mobile');
      document.getElementById('chatMain').classList.remove('hidden-mobile');
    }

    const p = S.partners[partnerId];
    // 名字本身需 escape；对方为管理员时在名字后追加徽章
    $('#chatPartnerName').innerHTML = p
      ? `与 ${U.escape(p.nick || p.email || p.phone || partnerId)} 的对话${p.is_admin ? ' <span class="chat-admin-badge"><i class="fas fa-shield-halved"></i> 管理员</span>' : ''}`
      : '对话';

    // 加载消息：降序取最新 200 条，再反转为时间正序渲染
    const { data } = await sb
      .from('private_messages')
      .select('*')
      .or(`and(sender_id.eq.${S.user.id},recipient_id.eq.${partnerId}),and(sender_id.eq.${partnerId},recipient_id.eq.${S.user.id})`)
      .order('created_at', { ascending: false })
      .limit(200);

    S.messages = (data || []).reverse();
    this.render();
    this.scrollBottom();
    this.markRead(partnerId);
    ConvList.render();

    setTimeout(() => $('#msgInput').focus(), 100);
  },

  render() {
    const el = $('#msgList');
    let html = '';
    for (const m of S.messages) {
      const isMe = m.sender_id === S.user.id;
      const text = U.linkify(U.escape(m.text));
      const time = U.time(m.created_at);
      html += `
        <div class="msg-row ${isMe ? 'msg-me' : 'msg-them'}">
          <div class="msg-bubble">${text}</div>
          <div class="msg-time">${time}</div>
        </div>`;
    }
    el.innerHTML = html;
    this.scrollBottom();
  },

  append(msg) {
    const el = $('#msgList');
    const isMe = msg.sender_id === S.user.id;
    const text = U.linkify(U.escape(msg.text));
    const time = U.time(msg.created_at);
    el.insertAdjacentHTML('beforeend', `
      <div class="msg-row ${isMe ? 'msg-me' : 'msg-them'} msg-new">
        <div class="msg-bubble">${text}</div>
        <div class="msg-time">${time}</div>
      </div>
    `);
    this.scrollBottom();
  },

  scrollBottom() {
    const el = $('#msgList');
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  },

  async markRead(partnerId) {
    const { data, error } = await sb
      .from('private_messages')
      .update({ read: true })
      .eq('recipient_id', S.user.id)
      .eq('sender_id', partnerId)
      .or('read.eq.false,read.is.null')
      .select('id');
    // 失败时不更新未读数，避免假成功
    if (error) { console.warn('标记已读失败:', error); return; }
    // RLS 静默过滤（0 行受影响）也视为失败，不本地清零
    if (!data || data.length === 0) { console.warn('标记已读：没有消息被更新'); return; }
    // 刷新对话列表中的未读数
    const conv = S.conversations.find(c => c.partnerId === partnerId);
    if (conv) { conv.unread = 0; ConvList.render(); }
  },

  async send() {
    if (!S.selectedId) return;
    const input = $('#msgInput');
    const text = input.value.trim();
    if (!text) return Toast.error('不能发送空消息');
    if (text.length > 500) return Toast.error('消息不能超过500个字符');

    const btn = $('#sendBtn');
    btn.disabled = true;
    btn.textContent = '发送中...';

    // 保存当前输入内容，失败时恢复
    const savedText = input.value;

    try {
      const { data: inserted } = await U.request(
        sb.from('private_messages').insert([{
          sender_id: S.user.id,
          recipient_id: S.selectedId,
          text,
        }]).select('*').single(),
        '发送失败'
      );
      // 立即更新 UI（乐观渲染，防止实时推送延迟）
      if (inserted) {
        // 去重：实时推送可能先于 insert 响应到达，此时消息已在列表中
        if (!S.messages.some(m => m.id === inserted.id)) {
          S.messages.push(inserted);
          ChatView.append(inserted);
        }
        ConvList.refreshOne(S.selectedId, inserted.text, inserted.created_at);
      }
      input.value = '';
      input.style.height = 'auto';
      $('#msgInput').focus();
    } catch {
      // 发送失败，恢复输入内容
      input.value = savedText;
      input.style.height = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      btn.disabled = false;
      btn.textContent = '发送';
    }
  },
};

// ====================== 搜索用户（邮箱模糊 / 昵称精确 / 手机号精确） ======================
const Search = {
  async input(term) {
    const el = $('#searchResults');
    const trimmed = term.trim();
    if (!trimmed) { el.classList.add('hidden'); el.innerHTML = ''; return; }

    if (S.searchLock) return;
    S.searchLock = true;

    // 规范化手机号：中国大陆 11 位手机号补 +86（与 users.phone 存储格式一致）
    const normPhone = (v) => {
      const p = String(v || '').replace(/[\s\-()]/g, '');
      if (!p || p.startsWith('+')) return p;
      return /^1[3-9]\d{9}$/.test(p) ? '+86' + p : p;
    };
    // 过滤条件值特殊字符用双引号包裹，避免破坏 PostgREST or() 语法
    const pgVal = (v) => /[,.:) ]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;

    try {
      let query = sb
        .from('users')
        .select('id, nick, email, phone, is_admin')
        .neq('id', S.user.id)
        .limit(8);

      if (trimmed.indexOf('@') > -1) {
        // 邮箱：保留模糊匹配
        query = query.ilike('email', `%${trimmed}%`);
      } else {
        // 昵称 / 手机号：需输入完整后精确匹配
        const conds = [];
        const np = normPhone(trimmed);
        if (np) conds.push('phone.eq.' + pgVal(np));
        conds.push('nick.eq.' + pgVal(trimmed));
        query = query.or(conds.join(','));
      }

      const { data, error } = await query;

      if (error) {
        console.error('Search error:', error);
        el.innerHTML = '<div class="search-empty">搜索出错，请稍后重试</div>';
        el.classList.remove('hidden');
        return;
      }

      if (!data?.length) {
        el.innerHTML = '<div class="search-empty">未找到该用户</div>';
        el.classList.remove('hidden');
        return;
      }

      let html = '';
      for (const u of data) {
        const tag = u.email || u.phone || '';
        html += `<div class="search-item" data-id="${u.id}" data-nick="${U.escape(u.nick || '')}" data-email="${U.escape(u.email || '')}" data-phone="${U.escape(u.phone || '')}" data-admin="${u.is_admin === true ? '1' : ''}">
        <span class="search-avatar">${U.escape(Array.from(u.nick || u.email || u.phone || '')[0] || '?')}</span>
        <div class="search-info">
          <span class="search-nick">${U.escape(u.nick || '未设置昵称')}${u.is_admin === true ? ' <span class="chat-admin-badge"><i class="fas fa-shield-halved"></i> 管理员</span>' : ''}</span>
          <span class="search-email">${U.escape(tag)}</span>
        </div>
      </div>`;
      }
      el.innerHTML = html;
      el.classList.remove('hidden');
    } catch (e) {
      console.error('Search failed:', e);
      el.innerHTML = '<div class="search-empty">搜索出错，请稍后重试</div>';
      el.classList.remove('hidden');
    } finally {
      S.searchLock = false;
    }
  },

  select(userId, nick, email, phone, isAdmin) {
    // 添加/更新 partner 信息
    S.partners[userId] = { nick, email, phone, is_admin: isAdmin === true };
    $('#searchResults').classList.add('hidden');
    $('#searchResults').innerHTML = '';
    $('#searchInput').value = '';

    // 如果还没有该对话，创建一个空对话
    if (!S.conversations.find(c => c.partnerId === userId)) {
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

    S.channel = sb
      .channel('private_messages_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'private_messages', filter: `recipient_id=eq.${S.user.id}` },
        (payload) => {
          const msg = payload.new;
          // 如果是当前选中对话，直接在聊天窗口追加
          if (msg.sender_id === S.selectedId) {
            S.messages.push(msg);
            ChatView.append(msg);
            ChatView.markRead(msg.sender_id);
          }
          // 更新对话列表
          ConvList.refreshOne(msg.sender_id, msg.text, msg.created_at);
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'private_messages', filter: `sender_id=eq.${S.user.id}` },
        (payload) => {
          const msg = payload.new;
          // 去重：如果消息已在列表中，忽略实时推送
          const exists = S.messages.some(m => m.id === msg.id);
          if (exists) return;
          // 自己发送的消息：刷新消息列表
          if (msg.recipient_id === S.selectedId) {
            S.messages.push(msg);
            ChatView.append(msg);
          }
          ConvList.refreshOne(msg.recipient_id, msg.text, msg.created_at);
        }
      )
      .subscribe();
  },
};

// ====================== 事件绑定 ======================
function bindEvents() {
  // 主题切换
  $('#themeBtn').addEventListener('click', () => Theme.toggle());

  // 搜索输入（防抖）
  let searchTimer;
  $('#searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => Search.input($('#searchInput').value), 300);
  });
  // 点击外部关闭搜索下拉
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sidebar-search')) {
      $('#searchResults').classList.add('hidden');
    }
  });

  // 搜索下拉点击
  $('#searchResults').addEventListener('click', (e) => {
    const item = e.target.closest('.search-item');
    if (item) {
      Search.select(item.dataset.id, item.dataset.nick, item.dataset.email, item.dataset.phone, item.dataset.admin === '1');
    }
  });

  // 对话列表点击（区分普通点击和菜单按钮）
  $('#convList').addEventListener('click', (e) => {
    const menuBtn = e.target.closest('.conv-menu-trigger');
    if (menuBtn) {
      e.stopPropagation();
      showConvMenu(menuBtn.dataset.id, menuBtn.dataset.blocked === 'true', menuBtn);
      return;
    }
    const item = e.target.closest('.conv-item');
    if (item) {
      document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      ChatView.open(item.dataset.id);
    }
  });

  // 屏蔽用户列表点击
  $('#blockedList').addEventListener('click', (e) => {
    const menuBtn = e.target.closest('.conv-menu-trigger');
    if (menuBtn) {
      e.stopPropagation();
      showConvMenu(menuBtn.dataset.id, true, menuBtn);
      return;
    }
    const item = e.target.closest('.conv-item');
    if (item) {
      document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      ChatView.open(item.dataset.id);
    }
  });

  // 屏蔽用户折叠/展开
  $('#blockedHeader').addEventListener('click', () => {
    const list = $('#blockedList');
    const header = $('#blockedHeader');
    const chevron = $('#blockedChevron');
    const isOpen = list.style.display !== 'none';
    list.style.display = isOpen ? 'none' : '';
    header.classList.toggle('open', !isOpen);
  });

  // 全局点击关闭菜单
  document.addEventListener('click', () => {
    $('#convMenu').classList.add('hidden');
  });

  // 列表滚动或窗口缩放时关闭菜单（fixed 菜单不跟随锚点，避免悬空错位）
  const closeConvMenu = () => $('#convMenu').classList.add('hidden');
  $('#convList').addEventListener('scroll', closeConvMenu, { passive: true });
  $('#blockedList').addEventListener('scroll', closeConvMenu, { passive: true });
  window.addEventListener('resize', closeConvMenu, { passive: true });

  // 菜单选项点击
  $('#convMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const action = e.target.closest('.conv-menu-item')?.dataset.action;
    const pid = S.convMenuPartner;
    $('#convMenu').classList.add('hidden');
    if (!pid || !action) return;
    if (action === 'block') BlockActions.blockUser(pid);
    else if (action === 'unblock') BlockActions.unblockUser(pid);
    else if (action === 'delete') BlockActions.deleteConversation(pid);
  });

  // 全局点击关闭菜单
  window.showConvMenu = function(partnerId, isBlocked, anchor) {
    S.convMenuPartner = partnerId;
    const menu = $('#convMenu');
    const rect = anchor.getBoundingClientRect();
    menu.querySelector('[data-action="block"]').style.display = isBlocked ? 'none' : '';
    menu.querySelector('[data-action="unblock"]').style.display = isBlocked ? '' : 'none';
    menu.classList.remove('hidden');
    // 先置于屏幕外完成布局测量，再按实测尺寸钳制到视口内
    menu.style.left = '-9999px';
    menu.style.top = '0px';
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const margin = 8;
    let left = Math.min(rect.right - mw, window.innerWidth - mw - margin);
    left = Math.max(left, margin);
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - margin) {
      // 底部放不下时改为在锚点上方弹出
      top = Math.max(rect.top - mh - 4, margin);
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  };

  // 发送消息
  $('#sendBtn').addEventListener('click', () => ChatView.send());
  const msgInput = $('#msgInput');
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ChatView.send();
    }
  });
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
  });

  // 移动端：点击对话头部返回列表（绑定到整个 header）
  const headerEl = document.getElementById('chatViewHeader');
  if (headerEl) {
    headerEl.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('hidden-mobile');
        document.getElementById('chatMain').classList.add('hidden-mobile');
      }
    });
  }
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

  // 注册认证状态监听（先注册，再检查初始状态）
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
      window.location.href = '/login/?redirect=/chat';
    } else if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
      if (!session?.user) {
        window.location.href = '/login/?redirect=/chat';
      }
    } else if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
      if (session?.user) S.user = session.user;
    }
  });

  try {
    // 检查认证状态
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      window.location.href = '/login/?redirect=/chat';
      return;
    }

    S.user = session.user;

    // 获取用户昵称
    try {
      const { data: userData } = await sb.from('users').select('nick, email').eq('id', S.user.id).limit(1);
      if (userData?.length) {
        S.user.nick = userData[0].nick;
        S.user.email = userData[0].email;
      } else {
        S.user.nick = S.user.email?.split('@')[0] || '用户';
      }
    } catch(e) {
      S.user.nick = S.user.email?.split('@')[0] || '用户';
      console.warn('Failed to fetch user profile:', e);
    }

    // 绑定事件
    bindEvents();

    // 隐藏全局 loader（SDK/会话阶段结束），数据加载阶段由对话列表骨架屏接替
    hideLoading();

    // 加载对话列表
    try {
      await ConvList.load();
    } catch(e) { console.warn('Failed to load conversations:', e); }

    // 订阅实时消息
    Realtime.subscribe();

    // 支持 ?to= 直达对话（从个人主页「发私信」跳转过来）
    try {
      const to = new URLSearchParams(location.search).get('to');
      if (to && S.user && to !== S.user.id) {
        const { data: tUser } = await sb.from('users').select('id,nick,email,phone,is_admin').eq('id', to).maybeSingle();
        if (tUser) Search.select(tUser.id, tUser.nick, tUser.email, tUser.phone, tUser.is_admin === true);
      }
    } catch(e) { console.warn('open ?to= failed:', e); }

  } catch(e) {
    console.error('Chat init failed:', e);
    Toast.error('加载失败，请刷新页面');
  }

  // 移动端菜单初始化
  KJ.setupMobileMenu('#hamburgerBtn', '#mobileMenu');
  KJ.initNav(sb, { homeUrl: '/' });

  hideLoading();
}

function hideLoading() {
  const overlay = $('#loadingOverlay');
  if (overlay) {
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.classList.add('hidden'); }, 300);
  }
}

// ====================== 生命周期 ======================
document.addEventListener('DOMContentLoaded', init);
KJ.onSystemThemeChange(() => Theme.init());
