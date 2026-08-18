'use strict';

const state = {
  tabId: parseTargetTabId(),
  conversation: null,
  busy: false
};

const elements = {
  platform: document.getElementById('platform'),
  count: document.getElementById('count'),
  subject: document.getElementById('subject'),
  inspectStatus: document.getElementById('inspect-status'),
  result: document.getElementById('result'),
  generate: document.getElementById('generate'),
  customPrompt: document.getElementById('custom-prompt'),
  generateCustom: document.getElementById('generate-custom'),
  refresh: document.getElementById('refresh'),
  settings: document.getElementById('settings')
};

document.addEventListener('DOMContentLoaded', () => inspectCurrentTab(false));
elements.refresh.addEventListener('click', () => inspectCurrentTab(true));
elements.generate.addEventListener('click', () => generateReplies(''));
elements.generateCustom.addEventListener('click', () => generateReplies(elements.customPrompt.value));
elements.customPrompt.addEventListener('input', updateGenerateButtons);
elements.customPrompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!elements.generateCustom.disabled) {
      generateReplies(elements.customPrompt.value);
    }
  }
});
elements.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === state.tabId && changeInfo.status === 'complete') {
    inspectCurrentTab(false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) {
    state.conversation = null;
    updateGenerateButtons();
    setInspectStatus('此侧边栏绑定的标签页已关闭。', 'error');
  }
});

async function inspectCurrentTab(expand) {
  if (state.busy) {
    return null;
  }
  elements.generate.disabled = true;
  elements.generateCustom.disabled = true;
  setInspectStatus(expand ? '正在展开并重新读取会话…' : '正在读取当前页面…', '');
  try {
    const tab = await getTargetTab();
    state.tabId = tab?.id || null;
    if (!state.tabId) {
      throw new Error('找不到当前浏览器标签页。');
    }
    const response = await sendTabMessage(state.tabId, { type: 'EXTRACT_CONVERSATION', expand });
    if (!response?.ok) {
      throw new Error(response?.error || '当前页面读取失败。');
    }
    state.conversation = response.conversation;
    renderConversationState(state.conversation);
    return state.conversation;
  } catch (error) {
    state.conversation = null;
    elements.platform.textContent = '未连接页面';
    elements.platform.className = 'platform unsupported';
    elements.count.textContent = '0 个正文块';
    elements.subject.textContent = '请在 Gmail 或 Outlook Web 打开邮件会话';
    setInspectStatus(normalizePageError(error), 'error');
    return null;
  }
}

function renderConversationState(conversation) {
  const count = conversation?.messages?.length || 0;
  const countUnit = conversation?.countUnit || '条消息';
  const supported = conversation?.platform && conversation.platform !== 'unsupported';
  elements.platform.textContent = supported ? conversation.platform : '不支持的页面';
  elements.platform.className = 'platform' + (supported ? '' : ' unsupported');
  elements.count.textContent = count + ' ' + countUnit;
  elements.subject.textContent = conversation?.pageTitle || '未识别邮件主题';
  if (!supported) {
    setInspectStatus('支持 Gmail、Outlook Web 和 outlook.cloud.microsoft。', 'error');
  } else if (!count) {
    setInspectStatus('已识别邮箱页面，但没有找到邮件正文。请打开具体邮件后重新读取。', 'error');
  } else {
    const expanded = Number(conversation.expandedCount || 0);
    const flattened = conversation.flattenedHistory ? '，并已拆分正文中的引用邮件' : '';
    setInspectStatus('已读取当前会话' + flattened + (expanded ? '，并展开 ' + expanded + ' 处历史内容。' : '。'), 'success');
  }
  updateGenerateButtons();
}

async function generateReplies(customPrompt) {
  if (state.busy) {
    return;
  }
  const requestedPrompt = String(customPrompt || '').trim();
  if (customPrompt && !requestedPrompt) {
    setInspectStatus('请先输入你希望生成内容满足的要求。', 'error');
    elements.customPrompt.focus();
    return;
  }
  state.busy = true;
  updateGenerateButtons();
  elements.result.innerHTML = '<div class="loading"><span class="spinner"></span>' +
    (requestedPrompt ? '正在结合历史和你的提示生成内容…' : '正在读取全部历史并生成回复…') + '</div>';
  try {
    const tab = await getTargetTab();
    if (!tab?.id) {
      throw new Error('找不到当前浏览器标签页。');
    }
    state.tabId = tab.id;
    const extraction = await sendTabMessage(tab.id, { type: 'EXTRACT_CONVERSATION', expand: true });
    if (!extraction?.ok) {
      throw new Error(extraction?.error || '当前会话读取失败。');
    }
    state.conversation = extraction.conversation;
    renderConversationState(state.conversation);
    if (!state.conversation.messages?.length) {
      throw new Error('当前页面没有识别到邮件正文。');
    }
    const payload = { ...state.conversation, currentPrompt: requestedPrompt };
    setInspectStatus('已读取 ' + state.conversation.messages.length + ' ' + (state.conversation.countUnit || '条消息') +
      (requestedPrompt ? '，正在按你的提示调用 LLM…' : '，正在调用 LLM…'), '');
    const response = await sendRuntimeMessage({ type: 'GENERATE_REPLIES', payload });
    if (!response?.ok) {
      throw new Error(response?.error || '生成失败，请稍后重试。');
    }
    renderReplies(response.replies || []);
    setInspectStatus(
      '已基于 ' + response.messageCount + ' ' + (state.conversation.countUnit || '条消息') +
      (requestedPrompt ? '并按你的提示' : '') + '，生成 ' + response.replies.length + ' 条建议' +
      (response.generationRetried ? '；模型首次输出不完整，已自动重试。' : '') +
      (response.historySummarized ? '；较早内容已压缩摘要。' : '。'),
      'success'
    );
  } catch (error) {
    renderError(normalizePageError(error));
    setInspectStatus(normalizePageError(error), 'error');
  } finally {
    state.busy = false;
    updateGenerateButtons();
  }
}

function updateGenerateButtons() {
  const hasConversation = Boolean(state.conversation?.messages?.length);
  elements.generate.disabled = state.busy || !hasConversation;
  elements.generateCustom.disabled = state.busy || !hasConversation || !elements.customPrompt.value.trim();
}

function renderReplies(replies) {
  elements.result.textContent = '';
  const safeReplies = replies.filter((reply) => reply?.body && !looksLikeRawReplyEnvelope(reply.body));
  if (!safeReplies.length) {
    renderError('没有收到可用回复建议。');
    return;
  }
  safeReplies.forEach((reply) => {
    const card = document.createElement('article');
    card.className = 'card';
    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = reply.title || '回复建议';
    const tone = document.createElement('span');
    tone.className = 'tone';
    tone.textContent = reply.tone || '备选';
    head.append(title, tone);

    const text = document.createElement('div');
    text.className = 'reply';
    text.textContent = reply.body || '';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const insert = makeButton('插入草稿', 'primary', async (button) => {
      if (looksLikeRawReplyEnvelope(reply.body)) {
        throw new Error('检测到未解析的模型 JSON，已阻止插入。请重新生成建议。');
      }
      const tab = await getTargetTab();
      const response = await sendTabMessage(tab?.id, { type: 'INSERT_REPLY', text: reply.body || '' });
      if (!response?.ok) {
        throw new Error(response?.error || '插入草稿失败。');
      }
      button.textContent = '已插入';
      setInspectStatus('已插入草稿，请确认后再发送。', 'success');
    });
    const copy = makeButton('复制', 'secondary', async (button) => {
      await navigator.clipboard.writeText(reply.body || '');
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = '复制'; }, 1300);
    });
    actions.append(insert, copy);
    card.append(head, text, actions);
    elements.result.appendChild(card);
  });
}

function makeButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await handler(button);
    } catch (error) {
      renderCardError(button.closest('.card'), error.message || String(error));
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderError(message) {
  elements.result.textContent = '';
  const error = document.createElement('div');
  error.className = 'error';
  error.textContent = message;
  elements.result.appendChild(error);
}

function renderCardError(card, message) {
  card.querySelector('.error')?.remove();
  const error = document.createElement('div');
  error.className = 'error';
  error.style.marginTop = '10px';
  error.style.marginBottom = '0';
  error.textContent = message;
  card.appendChild(error);
}

function setInspectStatus(message, type) {
  elements.inspectStatus.textContent = message;
  elements.inspectStatus.className = 'inspect-status' + (type ? ' ' + type : '');
}

function parseTargetTabId() {
  const value = Number(new URLSearchParams(location.search).get('tabId'));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

async function getTargetTab() {
  if (Number.isInteger(state.tabId)) {
    try {
      return await chrome.tabs.get(state.tabId);
    } catch (_error) {
      throw new Error('此侧边栏绑定的标签页不存在，请在目标页面重新点击插件图标。');
    }
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0] || null;
  state.tabId = tab?.id || null;
  return tab;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    if (!tabId) {
      reject(new Error('找不到当前标签页。'));
      return;
    }
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function normalizePageError(error) {
  const message = error?.message || String(error || '未知错误');
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return '页面脚本尚未加载。请刷新当前 Outlook/Gmail 页面，然后重新读取。';
  }
  return message;
}

function looksLikeRawReplyEnvelope(value) {
  const text = String(value || '').trim();
  return /["']replies["']\s*:/.test(text) && (/^[\[{]/.test(text) || /["']body["']\s*:/.test(text));
}
