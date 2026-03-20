/**
 * 即梦官网请求抓包脚本
 * 
 * 使用方法：
 *   1. 浏览器打开 jimeng.jianying.com 并登录
 *   2. F12 打开控制台 → 粘贴本脚本 → 回车
 *   3. 操作即梦的 Omni Reference 模式（上传音频 + 图片 → 生成视频）
 *   4. 操作完成后，控制台执行: __dumpRequests()
 *   5. 把输出的 JSON 复制给开发者分析
 * 
 * 命令：
 *   __dumpRequests()   - 导出所有捕获的请求（JSON 格式，自动复制到剪贴板）
 *   __showRequests()   - 在控制台打印请求摘要
 *   __clearRequests()  - 清空已捕获的请求
 *   __CAPTURED         - 直接访问捕获数组
 */

(function() {
  'use strict';

  if (window.__HOOK_INSTALLED) {
    console.log('[抓包] Hook 已安装，无需重复注入');
    return;
  }
  window.__HOOK_INSTALLED = true;

  const CAPTURED = [];
  window.__CAPTURED = CAPTURED;

  // 需要关注的 URL 关键词
  const KEYWORDS = [
    'upload', 'Upload',
    'aigc_draft', 'generate',
    'get_upload_token',
    'ApplyUpload', 'CommitUpload',
    'ApplyImageUpload', 'CommitImageUpload',
    'vod.bytedanceapi', 'imagex',
    'material', 'audio', 'music', 'sound',
    'draft', 'submit',
  ];

  function shouldCapture(url) {
    if (!url) return false;
    const s = url.toString();
    return KEYWORDS.some(kw => s.includes(kw));
  }

  function safeStringify(obj, maxLen) {
    try {
      const s = JSON.stringify(obj);
      if (maxLen && s && s.length > maxLen) {
        return s.substring(0, maxLen) + `... [truncated, total ${s.length} chars]`;
      }
      return s;
    } catch(e) {
      return String(obj);
    }
  }

  // 尝试解析 body
  function parseBody(body) {
    if (!body) return null;
    if (typeof body === 'string') {
      try { return JSON.parse(body); } catch(e) { return body; }
    }
    if (body instanceof FormData) {
      const obj = {};
      body.forEach((val, key) => {
        if (val instanceof File || val instanceof Blob) {
          obj[key] = `[File: ${val.name || 'blob'}, size=${val.size}, type=${val.type}]`;
        } else {
          obj[key] = val;
        }
      });
      return obj;
    }
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      return `[Binary: ${body.byteLength || body.length} bytes]`;
    }
    if (body instanceof Blob) {
      return `[Blob: size=${body.size}, type=${body.type}]`;
    }
    return String(body);
  }

  // 尝试解析 JSON response body，对 draft_content 等嵌套 JSON 字符串也展开
  function parseResponseBody(text) {
    try {
      const obj = JSON.parse(text);
      return obj;
    } catch(e) {
      return text;
    }
  }

  function expandNestedJson(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string' && obj[key].startsWith('{')) {
        try {
          obj[key] = JSON.parse(obj[key]);
          expandNestedJson(obj[key]);
        } catch(e) {}
      } else if (typeof obj[key] === 'object') {
        expandNestedJson(obj[key]);
      }
    }
    return obj;
  }

  const ts = () => new Date().toISOString();

  // ============== Hook fetch ==============
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = (typeof input === 'string') ? input : (input?.url || String(input));
    const method = init?.method || (input?.method) || 'GET';
    
    const capture = shouldCapture(url);
    
    if (capture) {
      const entry = {
        id: CAPTURED.length + 1,
        type: 'fetch',
        time: ts(),
        method: method.toUpperCase(),
        url: url,
        requestHeaders: {},
        requestBody: parseBody(init?.body),
        status: null,
        responseBody: null,
      };

      // 记录请求头
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { entry.requestHeaders[k] = v; });
        } else if (typeof init.headers === 'object') {
          entry.requestHeaders = { ...init.headers };
        }
      }

      console.log(`[抓包 #${entry.id}] ${entry.method} ${url.substring(0, 120)}`);

      try {
        const response = await originalFetch.call(this, input, init);
        entry.status = response.status;

        // 克隆 response 以读取 body
        const cloned = response.clone();
        try {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('json') || contentType.includes('text')) {
            const text = await cloned.text();
            entry.responseBody = parseResponseBody(text);
            // 展开嵌套 JSON（如 draft_content）
            if (typeof entry.responseBody === 'object') {
              expandNestedJson(entry.responseBody);
            }
          } else {
            entry.responseBody = `[Non-text response: ${contentType}, size=${response.headers.get('content-length') || '?'}]`;
          }
        } catch(e) {
          entry.responseBody = `[Read error: ${e.message}]`;
        }

        CAPTURED.push(entry);
        console.log(`[抓包 #${entry.id}] → ${entry.status} (${typeof entry.responseBody === 'string' ? entry.responseBody.substring(0,80) : 'JSON'})`);

        return response;
      } catch(err) {
        entry.status = 'ERROR';
        entry.responseBody = err.message;
        CAPTURED.push(entry);
        throw err;
      }
    }

    return originalFetch.call(this, input, init);
  };

  // ============== Hook XMLHttpRequest ==============
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const origSetHeader = XHR.setRequestHeader;

  XHR.open = function(method, url, ...args) {
    this.__capture_method = method;
    this.__capture_url = url;
    this.__capture_headers = {};
    this.__capture_should = shouldCapture(url);
    return origOpen.call(this, method, url, ...args);
  };

  XHR.setRequestHeader = function(name, value) {
    if (this.__capture_should && this.__capture_headers) {
      this.__capture_headers[name] = value;
    }
    return origSetHeader.call(this, name, value);
  };

  XHR.send = function(body) {
    if (this.__capture_should) {
      const entry = {
        id: CAPTURED.length + 1,
        type: 'xhr',
        time: ts(),
        method: (this.__capture_method || 'GET').toUpperCase(),
        url: this.__capture_url,
        requestHeaders: this.__capture_headers || {},
        requestBody: parseBody(body),
        status: null,
        responseBody: null,
      };

      console.log(`[抓包 #${entry.id}] XHR ${entry.method} ${entry.url.substring(0, 120)}`);

      this.addEventListener('load', function() {
        entry.status = this.status;
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (ct.includes('json') || ct.includes('text') || !ct) {
            entry.responseBody = parseResponseBody(this.responseText);
            if (typeof entry.responseBody === 'object') {
              expandNestedJson(entry.responseBody);
            }
          } else {
            entry.responseBody = `[Non-text: ${ct}]`;
          }
        } catch(e) {
          entry.responseBody = `[Read error: ${e.message}]`;
        }
        CAPTURED.push(entry);
        console.log(`[抓包 #${entry.id}] XHR → ${entry.status}`);
      });

      this.addEventListener('error', function() {
        entry.status = 'ERROR';
        entry.responseBody = 'XHR Error';
        CAPTURED.push(entry);
      });
    }

    return origSend.call(this, body);
  };

  // ============== 导出命令 ==============

  window.__showRequests = function() {
    if (CAPTURED.length === 0) {
      console.log('[抓包] 暂无捕获的请求。请先操作即梦的上传和生成流程。');
      return;
    }
    console.log(`[抓包] 共捕获 ${CAPTURED.length} 个请求：`);
    CAPTURED.forEach(e => {
      console.log(`  #${e.id} [${e.type}] ${e.method} ${e.status || '...'} ${e.url.substring(0, 100)}`);
    });
  };

  window.__clearRequests = function() {
    CAPTURED.length = 0;
    console.log('[抓包] 已清空');
  };

  window.__dumpRequests = function() {
    if (CAPTURED.length === 0) {
      console.log('[抓包] 暂无捕获的请求。');
      return;
    }

    // 对 requestBody 中的 draft_content 等嵌套 JSON 也展开
    const output = CAPTURED.map(e => {
      const copy = { ...e };
      if (typeof copy.requestBody === 'object' && copy.requestBody) {
        copy.requestBody = expandNestedJson(JSON.parse(JSON.stringify(copy.requestBody)));
      }
      return copy;
    });

    const json = JSON.stringify(output, null, 2);

    // 尝试复制到剪贴板
    try {
      navigator.clipboard.writeText(json).then(() => {
        console.log(`[抓包] 已复制到剪贴板！共 ${CAPTURED.length} 个请求，${json.length} 字符`);
      }).catch(() => {
        console.log(`[抓包] 剪贴板写入失败，请手动复制下方内容：`);
      });
    } catch(e) {}

    console.log(`[抓包] 共 ${CAPTURED.length} 个请求，JSON 输出：`);
    console.log(json);
    return json;
  };

  // ============== 完成提示 ==============
  console.log('='.repeat(50));
  console.log('[抓包脚本已注入]');
  console.log('');
  console.log('现在请操作即梦的 Omni Reference 模式：');
  console.log('  1. 上传音频文件 + 图片');
  console.log('  2. 填写提示词');
  console.log('  3. 点击生成');
  console.log('');
  console.log('操作完成后执行以下命令导出请求日志：');
  console.log('  __dumpRequests()   - 导出 JSON（自动复制到剪贴板）');
  console.log('  __showRequests()   - 查看请求列表');
  console.log('  __clearRequests()  - 清空重新捕获');
  console.log('='.repeat(50));

})();
