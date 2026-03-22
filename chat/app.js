// ====================== 你的 Supabase 配置（已填好） ======================
const SUPABASE_URL = "https://ayavdkodhdmcxfufnnxo.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5YXZka29kaGRtY3hmdWZubnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTQ2NTQsImV4cCI6MjA4OTA5MDY1NH0.gn1ORPwILwpJAmNOIXH0suqwetYVBOcBroM4PuaDhLc";
// ==========================================================================

// 全局初始化
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// 全局状态
let currentUser = null;
let userNick = localStorage.getItem("nick") || "";
let isProcessing = false; // 防重复提交锁
let notifyTimer = null;
let msgChannel = null; // 消息实时通道
let onlineChannel = null; // 在线状态通道
let configChannel = null; // 系统配置实时通道
let touchStartData = {}; // 触摸事件数据，防误触

// ====================== 工具函数 ======================
// 全局通知（Win11风格）
function showNotify(type, text) {
  if (notifyTimer) clearTimeout(notifyTimer);
  const notifyEl = $("#winNotify");
  notifyEl.className = `win-notify ${type}`;
  notifyEl.innerText = text;
  notifyEl.classList.remove("hidden");
  notifyTimer = setTimeout(() => notifyEl.classList.add("hidden"), 5000);
}

// 页面切换
function showPage(pageId) {
  $$(".page").forEach(page => page.classList.remove("active"));
  $(`#${pageId}`).classList.add("active");
}

// 触摸事件判定（防滚动误触）
function handleTouchStart(e) {
  touchStartData = {
    x: e.touches[0].clientX,
    y: e.touches[0].clientY,
    time: Date.now()
  };
}

function isVaildClick(e) {
  const touchEnd = {
    x: e.changedTouches[0].clientX,
    y: e.changedTouches[0].clientY,
    time: Date.now()
  };
  const deltaX = Math.abs(touchEnd.x - touchStartData.x);
  const deltaY = Math.abs(touchEnd.y - touchStartData.y);
  const deltaTime = touchEnd.time - touchStartData.time;
  return deltaX < 10 && deltaY < 10 && deltaTime < 300;
}

// 安全绑定事件（PC+移动端双兼容）
function bindEvent(el, handler) {
  if (!el) return;
  el.addEventListener("click", handler);
  el.addEventListener("touchstart", handleTouchStart);
  el.addEventListener("touchend", (e) => {
    if (isVaildClick(e)) {
      e.preventDefault();
      e.stopPropagation();
      handler();
    }
  });
}

// ====================== 页面加载初始化 ======================
document.addEventListener("DOMContentLoaded", async () => {
  // 初始化主题
  initTheme();
  // 绑定所有事件
  bindAllEvents();
  // 监听登录状态变化
  sb.auth.onAuthStateChange(handleAuthChange);
  // 关闭加载页
  setTimeout(() => {
    $("#loadingPage").style.opacity = 0;
    setTimeout(() => $("#loadingPage").classList.add("hidden"), 300);
  }, 400);
});

// 主题系统（解决深浅色不同步问题）
function initTheme() {
  try {
    const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const localDark = localStorage.getItem("theme") === "dark";
    const useDark = localDark || sysDark;
    const root = document.documentElement;
    const metaTheme = $('meta[name="theme-color"]');

    if (useDark) {
      root.dataset.theme = "dark";
      $("#toggleThemeBtn").innerText = "切换浅色模式";
      metaTheme.content = "#0f0f0f";
    } else {
      $("#toggleThemeBtn").innerText = "切换深色模式";
      metaTheme.content = "#f3f3f3";
    }
    void document.body.offsetWidth; // 强制重绘，确保同步
  } catch (e) {
    console.error("主题初始化失败", e);
  }
}

function toggleTheme() {
  try {
    const root = document.documentElement;
    const metaTheme = $('meta[name="theme-color"]');
    const isDark = root.dataset.theme === "dark";

    if (isDark) {
      root.dataset.theme = "";
      localStorage.removeItem("theme");
      $("#toggleThemeBtn").innerText = "切换深色模式";
      metaTheme.content = "#f3f3f3";
    } else {
      root.dataset.theme = "dark";
      localStorage.setItem("theme", "dark");
      $("#toggleThemeBtn").innerText = "切换浅色模式";
      metaTheme.content = "#0f0f0f";
    }
    void document.body.offsetWidth;
  } catch (e) {
    showNotify("error", "主题切换失败");
  }
}

// ====================== 事件全量绑定 ======================
function bindAllEvents() {
  // 登录/注册切换
  bindEvent($("#toRegisterBtn"), () => showPage("registerPage"));
  bindEvent($("#toLoginBtn"), () => showPage("loginPage"));

  // 登录/注册功能
  bindEvent($("#loginBtn"), doLogin);
  bindEvent($("#regBtn"), doRegister);
  bindEvent($("#loginPwd"), (e) => e.key === "Enter" && doLogin());
  bindEvent($("#regPwd"), (e) => e.key === "Enter" && doRegister());

  // 聊天功能
  bindEvent($("#sendBtn"), sendMessage);
  bindEvent($("#msgInput"), (e) => e.key === "Enter" && sendMessage());

  // 页面跳转
  bindEvent($("#settingBtn"), () => showPage("settingPage"));
  bindEvent($("#adminBtn"), () => { loadAdminData(); showPage("adminPage"); });
  bindEvent($("#backToChatBtn"), () => showPage("chatPage"));
  bindEvent($("#backToChatFromAdminBtn"), () => showPage("chatPage"));

  // 设置功能
  bindEvent($("#saveNickBtn"), saveNickname);
  bindEvent($("#toggleThemeBtn"), toggleTheme);
  bindEvent($("#updatePwdBtn"), updatePassword);
  bindEvent($("#showLoginLogBtn"), showMyLoginLogs);
  bindEvent($("#logoutBtn"), userLogout);

  // 管理员功能
  bindEvent($("#saveConfigBtn"), saveSystemConfig);
  bindEvent($("#saveSwBtn"), saveSensitiveWords);
  bindEvent($("#saveAnnounceBtn"), saveAnnouncement);
  bindEvent($("#clearAllMsgBtn"), clearAllMessages);
}

// ====================== 登录/注册核心逻辑 ======================
async function handleAuthChange(event, session) {
  currentUser = session?.user || null;
  // 清理旧通道
  if (msgChannel) sb.removeChannel(msgChannel);
  if (onlineChannel) sb.removeChannel(onlineChannel);
  if (configChannel) sb.removeChannel(configChannel);

  if (currentUser) {
    // 登录成功，初始化聊天
    const isSuccess = await initAfterLogin();
    if (isSuccess) {
      showPage("chatPage");
      showNotify("success", "登录成功，欢迎使用在线聊天系统");
    }
  } else {
    // 未登录，显示登录页
    showPage("loginPage");
  }
}

// 登录
async function doLogin() {
  if (isProcessing) return;
  isProcessing = true;
  $("#loginBtn").disabled = true;
  $("#loginBtn").innerText = "登录中...";

  try {
    const email = $("#loginEmail").value.trim();
    const pwd = $("#loginPwd").value.trim();
    if (!email || !pwd) {
      showNotify("error", "请填写邮箱和密码");
      return;
    }

    const { error } = await sb.auth.signInWithPassword({ email, password: pwd });
    if (error) throw new Error(error.message);
  } catch (e) {
    showNotify("error", `登录失败：${e.message}`);
  } finally {
    isProcessing = false;
    $("#loginBtn").disabled = false;
    $("#loginBtn").innerText = "登录";
  }
}

// 注册（默认无需审核，根据系统配置自动调整）
async function doRegister() {
  if (isProcessing) return;
  isProcessing = true;
  $("#regBtn").disabled = true;
  $("#regBtn").innerText = "注册中...";

  try {
    const nick = $("#regNick").value.trim();
    const email = $("#regEmail").value.trim();
    const pwd = $("#regPwd").value.trim();

    if (!nick || !email || !pwd) {
      showNotify("error", "请填写完整注册信息");
      return;
    }
    if (pwd.length < 8) {
      showNotify("error", "密码长度不能少于8位");
      return;
    }

    // 读取系统配置，判断是否需要审核
    const { data: config } = await sb.from("system_config").select("require_verify").single();
    const needVerify = config?.require_verify || false;

    // 注册账号
    const { error } = await sb.auth.signUp({
      email, password: pwd,
      options: { data: { nick } }
    });

    if (error) throw new Error(error.message);

    if (needVerify) {
      showNotify("info", "注册成功，请前往邮箱验证，等待管理员审核后即可登录");
      showPage("loginPage");
    } else {
      showNotify("success", "注册成功，已自动激活账号，请登录");
      showPage("loginPage");
    }

    // 清空表单
    $("#regNick").value = "";
    $("#regEmail").value = "";
    $("#regPwd").value = "";
  } catch (e) {
    showNotify("error", `注册失败：${e.message}`);
  } finally {
    isProcessing = false;
    $("#regBtn").disabled = false;
    $("#regBtn").innerText = "注册";
  }
}

// 登录后初始化
async function initAfterLogin() {
  try {
    // 获取用户信息
    const { data: userInfo, error } = await sb
      .from("users")
      .select("*")
      .eq("id", currentUser.id)
      .single();

    if (error) throw new Error("用户信息获取失败");

    // 账号状态校验
    if (userInfo.status === "pending") {
      showNotify("error", "账号待管理员审核，暂无法登录");
      await sb.auth.signOut();
      return false;
    }
    if (userInfo.status === "ban") {
      showNotify("error", "账号已被封禁，无法登录");
      await sb.auth.signOut();
      return false;
    }

    // 初始化用户信息
    userNick = localStorage.getItem("nick") || userInfo.nick;
    $("#userTag").innerText = `用户：${userNick}`;

    // 管理员权限判断
    if (userInfo.is_admin) {
      $("#adminBtn").classList.remove("hidden");
      currentUser.isAdmin = true;
    }

    // 记录登录日志
    await recordLoginLog();
    // 加载消息、在线状态、公告
    loadMessages();
    monitorOnline();
    loadSystemConfig();
    loadAnnouncement();

    return true;
  } catch (e) {
    showNotify("error", `初始化失败：${e.message}`);
    await sb.auth.signOut();
    return false;
  }
}

// ====================== 聊天核心功能 ======================
// 加载消息（实时监听）
function loadMessages() {
  msgChannel = sb.channel("message_channel")
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, async () => {
      const { data: msgList } = await sb
        .from("messages")
        .select("*")
        .order("id", { ascending: true })
        .limit(200);

      const msgBox = $("#msgBox");
      let html = "";
      msgList.forEach(msg => {
        const isMe = msg.user_id === currentUser.id;
        html += `
          <div class="msg-item ${isMe ? 'msg-me' : 'msg-other'}">
            <div class="avatar">${msg.nick.charAt(0)}</div>
            <div>
              <div class="msg-name">${msg.nick}</div>
              <div class="bubble">${msg.text}</div>
              <div class="msg-time">${msg.time}</div>
            </div>
            ${currentUser.isAdmin ? `<button class="win-btn small danger" onclick="deleteMsg(${msg.id})">删除</button>` : ''}
          </div>
        `;
      });
      msgBox.innerHTML = html;
      msgBox.scrollTop = msgBox.scrollHeight;
    })
    .subscribe();
}

// 发送消息
async function sendMessage() {
  if (isProcessing || !currentUser) return;
  const msgInput = $("#msgInput");
  const text = msgInput.value.trim();
  if (!text) {
    showNotify("error", "不能发送空消息");
    return;
  }

  isProcessing = true;
  $("#sendBtn").disabled = true;
  $("#sendBtn").innerText = "发送中...";

  try {
    // 检查是否被禁言
    const { data: userInfo } = await sb.from("users").select("is_mute").eq("id", currentUser.id).single();
    if (userInfo.is_mute) {
      showNotify("error", "你已被管理员禁言，无法发送消息");
      return;
    }

    // 敏感词过滤
    const { data: config } = await sb.from("system_config").select("sensitive_words").single();
    let content = text;
    const badWords = (config?.sensitive_words || "").split(",").filter(w => w.trim());
    badWords.forEach(word => {
      content = content.replaceAll(word, "***");
    });

    // 发送消息
    await sb.from("messages").insert([{
      user_id: currentUser.id,
      nick: userNick,
      text: content,
      time: new Date().toLocaleString()
    }]);

    msgInput.value = "";
  } catch (e) {
    showNotify("error", `发送失败：${e.message}`);
  } finally {
    isProcessing = false;
    $("#sendBtn").disabled = false;
    $("#sendBtn").innerText = "发送";
  }
}

// 在线状态监听
function monitorOnline() {
  // 标记自己在线
  sb.from("online_users").upsert({
    user_id: currentUser.id,
    nick: userNick,
    last_active: new Date().toISOString()
  }).catch(() => {});

  // 实时监听在线人数
  onlineChannel = sb.channel("online_channel")
    .on("postgres_changes", { event: "*", schema: "public", table: "online_users" }, async () => {
      const { data } = await sb.from("online_users").select("*");
      $("#onlineNum").innerText = data?.length || 0;
    })
    .subscribe();

  // 30秒心跳更新在线状态
  setInterval(() => {
    if (currentUser) {
      sb.from("online_users").update({ last_active: new Date().toISOString() }).eq("user_id", currentUser.id).catch(() => {});
    }
  }, 30000);
}

// 系统配置实时加载
function loadSystemConfig() {
  configChannel = sb.channel("config_channel")
    .on("postgres_changes", { event: "*", schema: "public", table: "system_config" }, () => {
      loadAnnouncement();
    })
    .subscribe();
}

// 公告加载
async function loadAnnouncement() {
  const { data } = await sb.from("system_config").select("announcement").single();
  const announceBar = $("#announceBar");
  if (data?.announcement) {
    announceBar.innerText = data.announcement;
    announceBar.classList.remove("hidden");
  } else {
    announceBar.classList.add("hidden");
  }
}

// 记录登录日志
async function recordLoginLog() {
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json").catch(() => ({ json: () => ({ ip: "未知IP" }) }));
    const ipData = await ipRes.json();
    const ip = ipData.ip || "未知IP";
    const device = navigator.userAgent.substring(0, 80);
    const time = new Date().toLocaleString();

    await sb.from("login_logs").insert([{
      user_id: currentUser.id,
      ip: ip,
      device: device,
      time: time
    }]);
  } catch (e) {
    console.log("登录日志记录失败", e);
  }
}

// ====================== 设置功能 ======================
// 保存昵称
async function saveNickname() {
  const newNick = $("#nickInput").value.trim();
  if (!newNick) {
    showNotify("error", "请输入有效的昵称");
    return;
  }

  try {
    await sb.from("users").update({ nick: newNick }).eq("id", currentUser.id);
    userNick = newNick;
    localStorage.setItem("nick", newNick);
    $("#userTag").innerText = `用户：${newNick}`;
    showNotify("success", "昵称保存成功");
  } catch (e) {
    showNotify("error", "昵称保存失败");
  }
}

// 修改密码
async function updatePassword() {
  const newPwd = $("#newPwdInput").value.trim();
  if (newPwd.length < 8) {
    showNotify("error", "密码长度不能少于8位");
    return;
  }

  try {
    const { error } = await sb.auth.updateUser({ password: newPwd });
    if (error) throw new Error(error.message);
    showNotify("success", "密码修改成功，请重新登录");
    $("#newPwdInput").value = "";
    setTimeout(userLogout, 1500);
  } catch (e) {
    showNotify("error", `密码修改失败：${e.message}`);
  }
}

// 查看我的登录日志
async function showMyLoginLogs() {
  try {
    const { data } = await sb
      .from("login_logs")
      .select("*")
      .eq("user_id", currentUser.id)
      .order("time", { ascending: false })
      .limit(10);

    let logText = "=== 我的登录日志 ===\n\n";
    data.forEach((log, index) => {
      logText += `${index + 1}. IP：${log.ip}\n   时间：${log.time}\n   设备：${log.device}\n\n`;
    });
    alert(logText);
  } catch (e) {
    showNotify("error", "登录日志加载失败");
  }
}

// 退出登录
async function userLogout() {
  try {
    // 清理在线状态
    await sb.from("online_users").delete().eq("user_id", currentUser.id).catch(() => {});
    // 退出登录
    await sb.auth.signOut();
    showNotify("info", "已安全退出登录");
  } catch (e) {
    showNotify("error", "退出失败");
  }
}

// ====================== 管理员功能 ======================
// 加载管理员数据
async function loadAdminData() {
  if (!currentUser.isAdmin) {
    showNotify("error", "你没有管理员权限");
    return;
  }

  try {
    // 加载系统配置
    const { data: config } = await sb.from("system_config").select("*").single();
    $("#requireVerifyToggle").checked = config?.require_verify || false;
    $("#sensitiveWordsInput").value = config?.sensitive_words || "";
    $("#announceInput").value = config?.announcement || "";

    // 加载待审核用户
    const { data: verifyUsers } = await sb.from("users").select("*").eq("status", "pending");
    let verifyHtml = "";
    verifyUsers.forEach(user => {
      verifyHtml += `
        <div class="list-item">
          <span>${user.email}（${user.nick}）</span>
          <div class="btn-group">
            <button class="win-btn small primary" onclick="verifyUser('${user.id}', 'active')">通过</button>
            <button class="win-btn small danger" onclick="verifyUser('${user.id}', 'ban')">拒绝</button>
          </div>
        </div>
      `;
    });
    $("#verifyUserList").innerHTML = verifyHtml || "暂无待审核用户";

    // 加载全部用户
    const { data: allUsers } = await sb.from("users").select("*").order("created_at", { ascending: false });
    let userHtml = "";
    allUsers.forEach(user => {
      const statusText = user.status === "active" ? "正常" : user.status === "ban" ? "封禁" : "待审核";
      const muteText = user.is_mute ? "解禁" : "禁言";
      userHtml += `
        <div class="list-item">
          <span>${user.email}（${user.nick} | ${statusText}）</span>
          <div class="btn-group">
            <button class="win-btn small secondary" onclick="resetUserPwd('${user.email}')">重置密码</button>
            <button class="win-btn small warning" onclick="setUserMute('${user.id}', ${!user.is_mute})">${muteText}</button>
            <button class="win-btn small ${user.status === 'ban' ? 'primary' : 'danger'}" onclick="setUserStatus('${user.id}', '${user.status === 'ban' ? 'active' : 'ban'}')">
              ${user.status === 'ban' ? '解封' : '封禁'}
            </button>
          </div>
        </div>
      `;
    });
    $("#allUserList").innerHTML = userHtml;

    // 加载全量登录日志
    const { data: allLogs } = await sb
      .from("login_logs")
      .select("*, users!login_logs_user_id_fkey(email, nick)")
      .order("time", { ascending: false })
      .limit(20);
    let logHtml = "";
    allLogs.forEach(log => {
      logHtml += `
        <div class="list-item">
          <span>${log.users.email}（${log.users.nick}）| IP：${log.ip} | ${log.time}</span>
        </div>
      `;
    });
    $("#allLoginLogList").innerHTML = logHtml || "暂无登录日志";
  } catch (e) {
    showNotify("error", "管理数据加载失败");
  }
}

// 审核用户
async function verifyUser(userId, status) {
  try {
    await sb.from("users").update({ status }).eq("id", userId);
    showNotify("success", status === "active" ? "用户审核通过" : "用户审核拒绝");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
}

// 设置用户禁言/解禁
async function setUserMute(userId, isMute) {
  try {
    await sb.from("users").update({ is_mute: isMute }).eq("id", userId);
    showNotify("success", isMute ? "已禁言该用户" : "已解禁该用户");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
}

// 设置用户状态（封禁/解封）
async function setUserStatus(userId, status) {
  try {
    await sb.from("users").update({ status }).eq("id", userId);
    showNotify("success", status === "active" ? "已解封该用户" : "已封禁该用户");
    loadAdminData();
  } catch (e) {
    showNotify("error", "操作失败");
  }
}

// 重置用户密码
async function resetUserPwd(email) {
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/chat`
    });
    if (error) throw new Error(error.message);
    showNotify("success", "密码重置邮件已发送");
  } catch (e) {
    showNotify("error", `重置失败：${e.message}`);
  }
}

// 保存系统配置
async function saveSystemConfig() {
  try {
    const requireVerify = $("#requireVerifyToggle").checked;
    const { data } = await sb.from("system_config").select("id").single();

    if (data) {
      await sb.from("system_config").update({ require_verify, updated_at: new Date() }).eq("id", data.id);
    } else {
      await sb.from("system_config").insert([{ require_verify }]);
    }
    showNotify("success", "系统配置保存成功");
  } catch (e) {
    showNotify("error", "配置保存失败");
  }
}

// 保存敏感词
async function saveSensitiveWords() {
  try {
    const words = $("#sensitiveWordsInput").value.trim();
    const { data } = await sb.from("system_config").select("id").single();

    if (data) {
      await sb.from("system_config").update({ sensitive_words: words, updated_at: new Date() }).eq("id", data.id);
    } else {
      await sb.from("system_config").insert([{ sensitive_words: words }]);
    }
    showNotify("success", "敏感词保存成功");
  } catch (e) {
    showNotify("error", "保存失败");
  }
}

// 保存公告
async function saveAnnouncement() {
  try {
    const content = $("#announceInput").value.trim();
    const { data } = await sb.from("system_config").select("id").single();

    if (data) {
      await sb.from("system_config").update({ announcement: content, updated_at: new Date() }).eq("id", data.id);
    } else {
      await sb.from("system_config").insert([{ announcement: content }]);
    }
    showNotify("success", "公告已推送");
    loadAnnouncement();
  } catch (e) {
    showNotify("error", "推送失败");
  }
}

// 删除消息（管理员）
async function deleteMsg(msgId) {
  try {
    await sb.from("messages").delete().eq("id", msgId);
    showNotify("success", "消息已删除");
  } catch (e) {
    showNotify("error", "删除失败");
  }
}

// 清空所有消息（管理员）
async function clearAllMessages() {
  if (!confirm("确定要清空所有历史消息吗？此操作不可恢复！")) return;
  try {
    await sb.from("messages").delete().neq("id", 0);
    showNotify("success", "所有消息已清空");
  } catch (e) {
    showNotify("error", "清空失败");
  }
}

// 页面关闭时清理在线状态
window.addEventListener("beforeunload", async () => {
  if (currentUser) {
    await sb.from("online_users").delete().eq("user_id", currentUser.id).catch(() => {});
  }
  // 清理所有通道
  if (msgChannel) sb.removeChannel(msgChannel);
  if (onlineChannel) sb.removeChannel(onlineChannel);
  if (configChannel) sb.removeChannel(configChannel);
});

// 系统主题变化自动跟随
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", initTheme);
