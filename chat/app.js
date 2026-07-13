// ====================== 配置 ======================
const CFG = Object.freeze({
  SUPABASE_URL: "https://vzqspcuxnwpakofwumat.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6cXNwY3V4bndwYWtvZnd1bWF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODI4MTUsImV4cCI6MjA5OTQ1ODgxNX0.AlV_3gWTWTrFBO-_nYD_8RaKoC-m5p-7VpZwbnPp-Pg",
});

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
  escape(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
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
    const mode = localStorage.getItem('theme');
    if (mode === 'dark') {
      document.documentElement.dataset.theme = 'dark';
    } else if (mode === 'light') {
      document.documentElement.dataset.theme = 'light';
    } else {
      delete document.documentElement.dataset.theme;
    }
    this._updateBtn();
  },
  toggle() {
    const mode = localStorage.getItem('theme');
    if (!mode || mode === 'auto') {
      localStorage.setItem('theme', 'dark');
      document.documentElement.dataset.theme = 'dark';
    } else if (mode === 'dark') {
      localStorage.setItem('theme', 'light');
      document.documentElement.dataset.theme = 'light';
    } else {
      localStorage.removeItem('theme');
      delete document.documentElement.dataset.theme;
    }
    this._updateBtn();
  },
  _updateBtn() {
    const mode = localStorage.getItem('theme');
    const btn = $('#themeBtn');
    if (!btn) return;
    if (mode === 'dark') btn.textContent = '🌙';
    else if (mode === 'light') btn.textContent = '☀️';
    else btn.textContent = '🅐';
  },
};

// ====================== 对话列表 ======================
const ConvList = {
  async load() {
    if (!S.user) return;
    // 加载屏蔽列表
    const { data: blocks } = await sb.from('user_blocks').select('blocked_id').eq('blocker_id', S.user.id);
    S.blockedList = blocks || [];

    const { data } = await sb
      .from('private_messages')
      .select('id, sender_id, recipient_id, text, created_at, read')
      .or(`sender_id.eq.${S.user.id},recipient_id.eq.${S.user.id}`)
      .order('created_at', { ascending: false })
      .limit(500);

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
      const { data: users } = await sb.from('users').select('id, nick, email').in('id', ids);
      if (users) {
        for (const u of users) S.partners[u.id] = { nick: u.nick, email: u.email };
      }
    }

    this.render();
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
    const name = U.escape(p?.nick || p?.email || c.partnerId);
    const text = U.escape((c.latestText || '').substring(0, 40));
    const time = U.time(c.latestTime);
    const badge = c.unread > 0 ? `<span class="conv-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
    return `
      <div class="conv-item" data-id="${c.partnerId}">
        <div class="conv-avatar">${name.charAt(0)}</div>
        <div class="conv-body">
          <div class="conv-top">
            <span class="conv-name">${name}</span>
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
      const { data } = await sb.from('users').select('id, nick, email').eq('id', partnerId).limit(1);
      if (data?.length) S.partners[partnerId] = { nick: data[0].nick, email: data[0].email };
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
      await sb.from('user_blocks').upsert({ blocker_id: S.user.id, blocked_id: partnerId }, { onConflict: 'blocker_id,blocked_id' });
      S.blockedList.push({ blocked_id: partnerId });
      if (S.selectedId === partnerId) { S.selectedId = null; $('#chatView').classList.add('hidden'); $('#chatPlaceholder').classList.remove('hidden'); }
      ConvList.render();
      Toast.success('已屏蔽该用户');
    } catch(e) { Toast.error('操作失败'); }
  },
  async unblockUser(partnerId) {
    try {
      await sb.from('user_blocks').delete().eq('blocker_id', S.user.id).eq('blocked_id', partnerId);
      S.blockedList = S.blockedList.filter(b => b.blocked_id !== partnerId);
      ConvList.render();
      Toast.success('已取消屏蔽');
    } catch(e) { Toast.error('操作失败'); }
  },
  async deleteConversation(partnerId) {
    if (!confirm('确定删除与该用户的所有聊天记录？（仅你这边删除，对方不受影响）')) return;
    try {
      await sb.from('private_messages').delete().eq('sender_id', S.user.id).eq('recipient_id', partnerId);
      S.conversations = S.conversations.filter(c => c.partnerId !== partnerId);
      if (S.selectedId === partnerId) { S.selectedId = null; $('#chatView').classList.add('hidden'); $('#chatPlaceholder').classList.remove('hidden'); }
      ConvList.render();
      Toast.success('聊天记录已删除');
    } catch(e) { Toast.error('删除失败'); }
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
    $('#chatPartnerName').textContent = p ? `与 ${p.nick || p.email} 的对话` : '对话';

    // 加载消息
    const { data } = await sb
      .from('private_messages')
      .select('*')
      .or(`and(sender_id.eq.${S.user.id},recipient_id.eq.${partnerId}),and(sender_id.eq.${partnerId},recipient_id.eq.${S.user.id})`)
      .order('created_at', { ascending: true })
      .limit(200);

    S.messages = data || [];
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
      const text = U.escape(m.text);
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
    const text = U.escape(msg.text);
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
    await sb
      .from('private_messages')
      .update({ read: true })
      .eq('recipient_id', S.user.id)
      .eq('sender_id', partnerId)
      .eq('read', false);
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
        S.messages.push(inserted);
        ChatView.append(inserted);
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

// ====================== 搜索用户 ======================
const Search = {
  async input(term) {
    const el = $('#searchResults');
    const trimmed = term.trim();
    if (!trimmed) { el.classList.add('hidden'); el.innerHTML = ''; return; }

    const { data } = await sb
      .from('users')
      .select('id, nick, email')
      .ilike('email', `%${trimmed}%`)
      .neq('id', S.user.id)
      .limit(5);

    if (!data?.length) {
      el.innerHTML = '<div class="search-empty">未找到用户</div>';
      el.classList.remove('hidden');
      return;
    }

    let html = '';
    for (const u of data) {
      html += `<div class="search-item" data-id="${u.id}" data-nick="${U.escape(u.nick || '')}" data-email="${U.escape(u.email)}">
        <span class="search-avatar">${U.escape((u.nick || u.email || '').charAt(0))}</span>
        <div class="search-info">
          <span class="search-nick">${U.escape(u.nick || '未设置昵称')}</span>
          <span class="search-email">${U.escape(u.email)}</span>
        </div>
      </div>`;
    }
    el.innerHTML = html;
    el.classList.remove('hidden');
  },

  select(userId, nick, email) {
    // 添加/更新 partner 信息
    S.partners[userId] = { nick, email };
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
  // 退出登录
  $('#logoutBtn').addEventListener('click', async () => {
    await sb.auth.signOut();
    window.location.href = '/login/?redirect=/chat';
  });

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
      Search.select(item.dataset.id, item.dataset.nick, item.dataset.email);
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
    menu.style.left = Math.min(rect.right - 160, window.innerWidth - 170) + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
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

  // 创建 Supabase 客户端
  if (!window.supabase) {
    Toast.error('SDK 加载失败，请刷新页面');
    return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { autoRefreshToken: true, persistSession: true, storage: { getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, setItem: (k,v) => { try { localStorage.setItem(k,v); } catch {} }, removeItem: (k) => { try { localStorage.removeItem(k); } catch {} } } },
  });

  // 检查认证状态
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = '/login/?redirect=/chat';
    return;
  }

  S.user = session.user;

  // 获取用户昵称
  const { data: userData } = await sb.from('users').select('nick, email').eq('id', S.user.id).limit(1);
  if (userData?.length) {
    S.user.nick = userData[0].nick;
    S.user.email = userData[0].email;
  } else {
    S.user.nick = S.user.email?.split('@')[0] || '用户';
  }

  // 显示用户信息
  $('#userTag').textContent = S.user.nick || S.user.email;

  // 绑定事件
  bindEvents();

  // 加载对话列表
  await ConvList.load();

  // 订阅实时消息
  Realtime.subscribe();

  // 隐藏加载遮罩
  const overlay = $('#loadingOverlay');
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.classList.add('hidden'); }, 300);
}

// ====================== 生命周期 ======================
document.addEventListener('DOMContentLoaded', init);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => Theme.init());
