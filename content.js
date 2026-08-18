'use strict';

(() => {
  if (window.top !== window || window.__smartEmailReplyBridgeLoaded) {
    return;
  }
  window.__smartEmailReplyBridgeLoaded = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'EXTRACT_CONVERSATION') {
      extractAfterExpansion(Boolean(message.expand))
        .then((conversation) => sendResponse({ ok: true, conversation }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === 'INSERT_REPLY') {
      insertIntoComposer(String(message.text || ''))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    return false;
  });

  async function extractAfterExpansion(shouldExpand) {
    const expandedCount = shouldExpand ? await expandCurrentConversation() : 0;
    const conversation = extractConversation();
    conversation.expandedCount = expandedCount;
    return conversation;
  }

  function extractConversation() {
    if (location.hostname === 'mail.google.com') {
      return extractGmail();
    }
    if (/^outlook\.(?:office|live)\.com$/.test(location.hostname) || location.hostname === 'outlook.cloud.microsoft') {
      return extractOutlook();
    }
    return { platform: 'unsupported', pageTitle: document.title, messages: [] };
  }

  function extractGmail() {
    const messages = [];
    const containers = Array.from(document.querySelectorAll('[role="main"] .adn.ads, [role="main"] .adn'));
    containers.forEach((container) => {
      const bodyElement = container.querySelector('.a3s') || container.querySelector('[dir="ltr"]');
      const senderElement = container.querySelector('.gD') || container.querySelector('[email]');
      const dateElement = container.querySelector('.g3') || container.querySelector('time');
      const recipientElements = Array.from(container.querySelectorAll('[email]')).filter((element) => element !== senderElement);
      addMessage(messages, {
        sender: senderElement?.getAttribute('email') || senderElement?.textContent || 'Unknown sender',
        recipients: recipientElements.map((element) => element.getAttribute('email') || element.textContent || '').filter(Boolean).join(', '),
        date: dateElement?.getAttribute('title') || dateElement?.getAttribute('datetime') || dateElement?.textContent || '',
        subject: document.querySelector('[role="main"] h2.hP')?.textContent || document.title,
        body: getElementText(bodyElement)
      });
    });

    if (!messages.length) {
      Array.from(document.querySelectorAll('[role="main"] .a3s')).forEach((bodyElement) => {
        addMessage(messages, {
          sender: 'Unknown sender',
          subject: document.title,
          body: getElementText(bodyElement)
        });
      });
    }
    return withFallback(messages, 'Gmail');
  }

  function extractOutlook() {
    const messages = [];
    const selector = [
      '[data-testid="message-body-container"]',
      '[data-testid="message-body"]',
      '[data-test-id="message-body-container"]',
      '[data-test-id="message-body"]',
      '[data-app-section="MailReadCompose"] [role="document"]',
      '[role="main"] [role="document"]',
      '[aria-label="Message body"]',
      '[aria-label="邮件正文"]'
    ].join(',');
    const candidates = Array.from(document.querySelectorAll(selector)).filter((element) => {
      if (element.matches('[contenteditable="true"]') || element.closest('[data-testid*="editor"],[data-test-id*="editor"]')) {
        return false;
      }
      return cleanText(getElementText(element)).length >= 2;
    });
    const leafCandidates = candidates.filter((element) => {
      return !candidates.some((other) => other !== element && element.contains(other));
    });

    let splitHistoryBlocks = 0;
    leafCandidates.forEach((bodyElement) => {
      const container = bodyElement.closest('article,[data-testid*="message"],[data-test-id*="message"],[role="listitem"],[data-app-section="MailReadCompose"]') || bodyElement.parentElement;
      const senderElement = container?.querySelector([
        '[data-testid="message-sender"]',
        '[data-testid*="sender"]',
        'a[href^="mailto:"]',
        '[title*="@"]',
        '[aria-label*="@"]'
      ].join(','));
      const dateElement = container?.querySelector('time,[data-testid*="date"],[data-testid*="time"],[data-test-id*="date"],[data-test-id*="time"]');
      const recipientElements = container ? Array.from(container.querySelectorAll('a[href^="mailto:"],[data-testid*="recipient"],[data-test-id*="recipient"],[title*="@"]')) : [];
      const baseMessage = {
        sender: senderElement?.getAttribute('href')?.replace(/^mailto:/i, '') || senderElement?.getAttribute('title') || senderElement?.getAttribute('aria-label') || senderElement?.textContent || 'Unknown sender',
        recipients: recipientElements.map((element) => element.getAttribute('href')?.replace(/^mailto:/i, '') || element.getAttribute('title') || element.textContent || '').filter(Boolean).join(', '),
        date: dateElement?.getAttribute('datetime') || dateElement?.textContent || '',
        subject: findOutlookSubject(),
        body: getElementText(bodyElement)
      };
      const segments = splitQuotedOutlookHistory(baseMessage);
      if (segments.length > 1) {
        splitHistoryBlocks += 1;
      }
      segments.forEach((segment) => addMessage(messages, segment));
    });
    return withFallback(messages, 'Outlook Web', {
      countUnit: splitHistoryBlocks ? '段历史邮件' : '个正文块',
      flattenedHistory: splitHistoryBlocks > 0
    });
  }

  function splitQuotedOutlookHistory(baseMessage) {
    const text = cleanText(baseMessage.body || '');
    if (!text) {
      return [];
    }

    const starts = [];
    const marker = /(?:^|\n)(?:-{2,}\s*(?:Original Message|原始邮件)\s*-{2,}|From\s*[:：]|发件人\s*[:：])/gim;
    let match;
    while ((match = marker.exec(text))) {
      const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
      const headerWindow = text.slice(start, start + 1200);
      const headerKinds = [
        /(?:^|\n)(?:From|发件人)\s*[:：]/im,
        /(?:^|\n)(?:Sent|Date|发送时间|日期)\s*[:：]/im,
        /(?:^|\n)(?:To|收件人)\s*[:：]/im,
        /(?:^|\n)(?:Subject|主题)\s*[:：]/im
      ].filter((pattern) => pattern.test(headerWindow)).length;
      if (headerKinds >= 3 || /Original Message|原始邮件/i.test(match[0])) {
        starts.push(start);
      }
    }

    const uniqueStarts = [];
    for (const start of Array.from(new Set(starts)).sort((a, b) => a - b)) {
      const previous = uniqueStarts.at(-1);
      const isHeaderAfterSeparator = typeof previous === 'number' && start - previous <= 180 &&
        /Original Message|原始邮件/i.test(text.slice(previous, start));
      if (!isHeaderAfterSeparator) {
        uniqueStarts.push(start);
      }
    }
    if (!uniqueStarts.length) {
      return [{ ...baseMessage, body: text }];
    }
    if (uniqueStarts[0] > 0 && text.slice(0, uniqueStarts[0]).trim().length >= 2) {
      uniqueStarts.unshift(0);
    }

    const segments = [];
    for (let index = 0; index < uniqueStarts.length; index += 1) {
      const body = text.slice(uniqueStarts[index], uniqueStarts[index + 1] || text.length).trim();
      if (body.length < 2) {
        continue;
      }
      const sender = quotedHeaderValue(body, ['From', '发件人']) || baseMessage.sender;
      const recipients = [
        quotedHeaderValue(body, ['To', '收件人']),
        quotedHeaderValue(body, ['Cc', '抄送'])
      ].filter(Boolean).join(', ') || baseMessage.recipients;
      segments.push({
        ...baseMessage,
        sender,
        recipients,
        date: quotedHeaderValue(body, ['Sent', 'Date', '发送时间', '日期']) || baseMessage.date,
        subject: quotedHeaderValue(body, ['Subject', '主题']) || baseMessage.subject,
        body
      });
    }
    return segments.length ? segments : [{ ...baseMessage, body: text }];
  }

  function quotedHeaderValue(text, names) {
    const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const match = new RegExp('(?:^|\\n)(?:' + escaped + ')\\s*[:：]\\s*([^\\n]+)', 'i').exec(text);
    return cleanText(match?.[1] || '');
  }

  function findOutlookSubject() {
    const selectors = [
      '[data-testid="message-subject"]',
      '[data-testid*="subject"]',
      '[role="main"] h1',
      '[role="main"] h2'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = cleanText(element?.textContent || '');
      if (text) {
        return text;
      }
    }
    return document.title;
  }

  function withFallback(messages, platform, extra = {}) {
    if (!messages.length) {
      const readingPane = document.querySelector([
        '[data-app-section="MailReadCompose"]',
        '[data-testid="reading-pane"]',
        '[data-testid*="ReadingPane"]',
        '[role="main"]'
      ].join(','));
      const text = cleanText(getElementText(readingPane));
      if (text.length >= 40) {
        addMessage(messages, {
          sender: 'Conversation participants',
          subject: document.title,
          body: text.slice(0, 30000)
        });
      }
    }
    return { platform, pageTitle: document.title, messages, ...extra };
  }

  function addMessage(messages, item) {
    const body = cleanText(item.body || '');
    if (body.length < 2) {
      return;
    }
    const fingerprint = body.replace(/\s/g, '').slice(0, 240);
    if (messages.some((message) => message.fingerprint === fingerprint)) {
      return;
    }
    messages.push({
      sender: cleanText(item.sender || 'Unknown sender').slice(0, 400),
      recipients: cleanText(item.recipients || '').slice(0, 600),
      date: cleanText(item.date || '').slice(0, 160),
      subject: cleanText(item.subject || '').slice(0, 300),
      body: body.slice(0, 30000),
      fingerprint
    });
  }

  async function expandCurrentConversation() {
    const main = document.querySelector('[role="main"]') || document.body;
    const candidates = [];

    if (location.hostname === 'mail.google.com') {
      main.querySelectorAll('.adn, .ads').forEach((container) => {
        const body = container.querySelector('.a3s');
        if (!body || cleanText(body.textContent || '').length < 2) {
          candidates.push(container.querySelector('.kQ,.adx,[aria-expanded="false"]') || container);
        }
      });
    } else {
      main.querySelectorAll('article,[data-testid*="message"],[role="listitem"]').forEach((container) => {
        const trigger = container.querySelector('button[aria-expanded="false"],[role="button"][aria-expanded="false"]');
        if (trigger) {
          candidates.push(trigger);
        }
      });
    }

    main.querySelectorAll('button,[role="button"]').forEach((element) => {
      const label = [element.getAttribute('aria-label'), element.getAttribute('data-tooltip'), element.getAttribute('title')]
        .filter(Boolean).join(' ').toLowerCase();
      if (/show trimmed content|显示修剪内容|显示省略内容|展开邮件|expand message/.test(label)) {
        candidates.push(element);
      }
    });

    const unique = Array.from(new Set(candidates)).filter(isVisible).slice(0, 100);
    for (const element of unique) {
      try {
        element.click();
      } catch (_error) {
        // Continue with content already loaded on the page.
      }
      await delay(35);
    }
    if (unique.length) {
      await delay(700);
    }
    return unique.length;
  }

  async function insertIntoComposer(replyText) {
    if (!cleanText(replyText)) {
      throw new Error('回复内容为空，未插入草稿。');
    }
    if (looksLikeRawReplyEnvelope(replyText)) {
      throw new Error('检测到未解析的模型 JSON，已阻止插入草稿。请重新生成建议。');
    }
    let editor = findComposer();
    if (!editor) {
      const replyButton = findReplyButton();
      if (!replyButton) {
        throw new Error('找不到回复编辑框。请先手动点击邮件中的“回复”，再试一次。');
      }
      replyButton.click();
      editor = await waitForComposer(4500);
    }
    if (!editor) {
      throw new Error('回复编辑框没有出现。请手动打开回复框后重试。');
    }
    editor.focus();
    const inserted = document.execCommand('insertText', false, replyText);
    if (!inserted) {
      const current = cleanText(editor.innerText || editor.textContent || '');
      editor.textContent = current ? current + '\n\n' + replyText : replyText;
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function findComposer() {
    const selectors = location.hostname === 'mail.google.com'
      ? [
          '.Am.Al.editable[contenteditable="true"]',
          '[role="textbox"][contenteditable="true"][g_editable="true"]',
          '[aria-label*="邮件正文"][contenteditable="true"]',
          '[aria-label*="Message Body"][contenteditable="true"]'
        ]
      : [
          '[aria-label*="邮件正文"][contenteditable="true"]',
          '[aria-label*="Message body"][contenteditable="true"]',
          '[aria-label*="邮件正文"][role="textbox"]',
          '[aria-label*="Message body"][role="textbox"]',
          '[role="textbox"][contenteditable="true"]'
        ];
    return visibleElements(document.querySelectorAll(selectors.join(','))).at(-1) || null;
  }

  function findReplyButton() {
    const selectors = [
      'button[aria-label="回复"]', 'button[aria-label^="回复 "]',
      'button[aria-label="Reply"]', 'button[aria-label^="Reply "]',
      '[role="button"][aria-label="回复"]', '[role="button"][aria-label^="回复 "]',
      '[role="button"][aria-label="Reply"]', '[role="button"][aria-label^="Reply "]',
      '[role="button"][data-tooltip="回复"]', '[role="button"][data-tooltip="Reply"]'
    ];
    return visibleElements(document.querySelectorAll(selectors.join(','))).at(-1) || null;
  }

  function waitForComposer(timeoutMs) {
    return new Promise((resolve) => {
      const immediate = findComposer();
      if (immediate) {
        resolve(immediate);
        return;
      }
      const observer = new MutationObserver(() => {
        const editor = findComposer();
        if (editor) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(editor);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  function getElementText(element) {
    return element ? (element.innerText || element.textContent || '') : '';
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function looksLikeRawReplyEnvelope(value) {
    const text = String(value || '').trim();
    return /["']replies["']\s*:/.test(text) && (/^[\[{]/.test(text) || /["']body["']\s*:/.test(text));
  }

  function visibleElements(nodeList) {
    return Array.from(nodeList).filter(isVisible);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
