'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  apiKeyHeader: 'Authorization',
  apiKeyPrefix: 'Bearer',
  model: 'gpt-4.1-mini',
  suggestionCount: 3,
  language: 'auto',
  toneGuidance: '专业、自然、清晰；避免空话，明确下一步。',
  maxContextChars: 18000,
  temperature: 0.7,
  maxThreadMessages: 0,
  messageBodyChars: 8000,
  recentFullMessages: 12
});

const form = document.getElementById('settings-form');
const statusElement = document.getElementById('status');
const testButton = document.getElementById('test');

document.addEventListener('DOMContentLoaded', loadSettings);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveSettings();
    showStatus('设置已保存。回到邮件会话页面即可生成回复。', 'success');
  } catch (error) {
    showStatus(error.message || String(error), 'error');
  }
});

document.getElementById('toggle-key').addEventListener('click', (event) => {
  const input = document.getElementById('apiKey');
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  event.currentTarget.textContent = reveal ? '隐藏' : '显示';
});

document.getElementById('reset').addEventListener('click', () => {
  fillForm(DEFAULT_SETTINGS);
  showStatus('已恢复表单默认值；点击“保存设置”后生效。', '');
});

testButton.addEventListener('click', async () => {
  testButton.disabled = true;
  showStatus('正在测试 LLM API 连接…', '');
  try {
    await saveSettings();
    const response = await sendRuntimeMessage({ type: 'TEST_API' });
    if (!response?.ok) {
      throw new Error(response?.error || '连接测试失败。');
    }
    showStatus(response.message || '连接成功。', 'success');
  } catch (error) {
    showStatus(error.message || String(error), 'error');
  } finally {
    testButton.disabled = false;
  }
});

async function loadSettings() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  fillForm({ ...DEFAULT_SETTINGS, ...saved });
}

function fillForm(settings) {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const field = document.getElementById(key);
    if (field) {
      field.value = settings[key];
    }
  }
}

function collectSettings() {
  return {
    apiBaseUrl: document.getElementById('apiBaseUrl').value.trim(),
    apiKey: document.getElementById('apiKey').value.trim(),
    apiKeyHeader: document.getElementById('apiKeyHeader').value.trim() || 'Authorization',
    apiKeyPrefix: document.getElementById('apiKeyPrefix').value.trim(),
    model: document.getElementById('model').value.trim(),
    suggestionCount: Number(document.getElementById('suggestionCount').value),
    language: document.getElementById('language').value,
    toneGuidance: document.getElementById('toneGuidance').value.trim(),
    maxContextChars: Number(document.getElementById('maxContextChars').value),
    temperature: Number(document.getElementById('temperature').value),
    maxThreadMessages: Number(document.getElementById('maxThreadMessages').value),
    messageBodyChars: Number(document.getElementById('messageBodyChars').value),
    recentFullMessages: Number(document.getElementById('recentFullMessages').value)
  };
}

async function saveSettings() {
  const settings = collectSettings();
  if (!settings.model) {
    throw new Error('请填写模型名称。');
  }
  const parsed = new URL(settings.apiBaseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('API 地址必须使用 http 或 https。');
  }
  const granted = await chrome.permissions.request({ origins: [parsed.origin + '/*'] });
  if (!granted) {
    throw new Error('未获得 LLM API 域名访问权限，设置尚未保存。');
  }
  await chrome.storage.local.set(settings);
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

function showStatus(message, type) {
  statusElement.textContent = message;
  statusElement.className = 'status' + (type ? ' ' + type : '');
}
