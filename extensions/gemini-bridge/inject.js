// gemini-bridge MAIN world 捕获层（manifest: document_start + world:"MAIN"，先于页面任何脚本运行）。
// 纯运输：钩 XMLHttpRequest / fetch，URL 命中 GenerateContent 时把响应原文经 window.postMessage 转发给隔离世界。
// 零干扰纪律：全部逻辑 try/catch、不改实参、不碰响应对象、不向页面抛异常；捕获层失手 = 没有消息（响亮停滞）。
// 必须 IIFE：经典脚本顶层 const/function 会进页面全局词法环境，与页面脚本重名将炸页面。
(function () {
  "use strict";

  const MARKER = "gemini-bridge-capture";
  const VERSION = 1;

  function installCaptureHooks(win) {
    if (win.__haCaptureInstalled) return;
    win.__haCaptureInstalled = true;

    let seq = 0;

    const emit = (msg) => {
      try {
        win.postMessage({ __ha: MARKER, v: VERSION, ...msg }, "*");
      } catch {}
    };

    const urlTail = (url) => url.slice(-80);
    const urlMatch = (url) => typeof url === "string" && url.includes("GenerateContent");

    // XHR 主通道（探针确认 AI Studio 走 XHR）：open 记 URL → send 挂 loadend 读全量 responseText
    const OrigXHR = win.XMLHttpRequest;
    if (OrigXHR && OrigXHR.prototype) {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;

      OrigXHR.prototype.open = function (method, url, ...rest) {
        try {
          this.__haUrl = typeof url === "string" ? url : String(url);
        } catch {}
        return origOpen.call(this, method, url, ...rest);
      };

      OrigXHR.prototype.send = function (...args) {
        try {
          const url = this.__haUrl || "";
          if (urlMatch(url)) {
            const reqId = ++seq;
            emit({ kind: "start", reqId, urlTail: urlTail(url) });
            // 先挂监听再 send：同步 XHR 的 loadend 在 send 内就会派发，后挂会漏
            this.addEventListener("loadend", () => {
              try {
                const rt = this.responseType;
                if (rt !== "" && rt !== "text") {
                  emit({ kind: "error", reqId, urlTail: urlTail(url), reason: "responseType=" + rt });
                  return;
                }
                emit({ kind: "done", reqId, raw: this.responseText });
              } catch (err) {
                emit({ kind: "error", reqId, urlTail: urlTail(url), reason: String((err && err.message) || err) });
              }
            });
          }
        } catch {}
        return origSend.apply(this, args);
      };
    }

    // fetch 薄兜底（传输迁移预挂）：命中则响应到达时同步 clone，异步 text() 后发 done；不命中完全透明
    const origFetch = win.fetch;
    if (typeof origFetch === "function") {
      win.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
          const input = args[0];
          let url = "";
          if (typeof input === "string") url = input;
          else if (input && typeof input.url === "string") url = input.url; // Request
          else if (input && typeof input.href === "string") url = input.href; // URL
          if (urlMatch(url)) {
            const reqId = ++seq;
            emit({ kind: "start", reqId, urlTail: urlTail(url) });
            p.then(
              (resp) => {
                try {
                  const clone = resp.clone(); // 响应一到就 clone，抢在页面消费 body 前
                  clone.text().then(
                    (raw) => emit({ kind: "done", reqId, raw }),
                    (err) =>
                      emit({ kind: "error", reqId, urlTail: urlTail(url), reason: String((err && err.message) || err) }),
                  );
                } catch (err) {
                  emit({ kind: "error", reqId, urlTail: urlTail(url), reason: String((err && err.message) || err) });
                }
              },
              () => {}, // 请求本身失败：无需捕获
            );
          }
        } catch {}
        return p;
      };
    }

    // 握手：安装即发 hello；content.js document_idle 才就位会错过首包，其发 ping 时补答
    win.addEventListener("message", (ev) => {
      try {
        if (ev.source !== win) return;
        const d = ev.data;
        if (d && d.__ha === MARKER && d.v === VERSION && d.kind === "ping") {
          emit({ kind: "hello" });
        }
      } catch {}
    });
    emit({ kind: "hello" });
  }

  // CJS 尾巴：vitest 导出供假 window 单测；浏览器经典脚本走 else 自动安装
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { installCaptureHooks };
  } else {
    installCaptureHooks(window);
  }
})();
