// gemini-bridge MAIN world 捕获层（manifest: document_start + world:"MAIN"，先于页面任何脚本运行）。
// 纯运输：钩 XMLHttpRequest / fetch，URL 命中 GenerateContent 时把响应原文经 window.postMessage 转发给隔离世界。
// 零干扰纪律：全部逻辑 try/catch、不改实参、不碰响应对象、不向页面抛异常；捕获层失手 = 没有消息（响亮停滞）。
// 完成捕获统一走快照取证：同一判据（responseText 构成完整 JSON）在三个同步点调用（rs=3/4 事件、abort() 前、loadend 兜底）——
// done 通道只承载完整 JSON，截断/非文本就地转 error。AI Studio 在流完成瞬间 abort()：放行后状态置 unsent、
// responseText 按规范立即读为空，完成事件可能一件都不发；快照在原文构成完整 JSON 的窗口内取走，不依赖任何完成事件。
// 诊断日志统一前缀 [ha-capture]（浏览器控制台可过滤）：异常吞没点一律 console.warn（不再有空的 catch），
// 关键链路逐点留痕（open 命中 → send 命中 → readyState 轨迹 → loadend/快照 → done 已发出），链路断在哪一环一眼可诊。
// 必须 IIFE：经典脚本顶层 const/function 会进页面全局词法环境，与页面脚本重名将炸页面。
(function () {
  "use strict";

  const MARKER = "gemini-bridge-capture";
  const VERSION = 1;

  function installCaptureHooks(win) {
    if (win.__haCaptureInstalled) return;
    win.__haCaptureInstalled = true;

    let seq = 0;
    let objSeq = 0; // XHR 对象身份序号（诊断：区分新旧实例）

    const emit = (msg) => {
      try {
        win.postMessage({ __ha: MARKER, v: VERSION, ...msg }, "*");
      } catch (err) {
        console.warn("[ha-capture] postMessage 发送失败", err);
      }
    };

    const urlTail = (url) => url.slice(-80);
    const urlMatch = (url) => typeof url === "string" && url.includes("GenerateContent");

    // 快照取证：responseText 构成完整 JSON 即取走（残片必抛）。三个同步调用点：
    // ① readystatechange rs=3/4 事件 ② 页面 abort() 调用前 ③ loadend 兜底（原 abort 执行后状态即被清，晚一步就永久拿不到）
    const trySnapshot = (xhr, reqId, source) => {
      if (xhr.__haDoneSent) return false;
      const rt = xhr.responseType;
      if (rt !== "" && rt !== "text") return false; // 非文本响应由 loadend 路径统一发 error
      const snap = xhr.responseText;
      if (typeof snap !== "string" || snap.length === 0) return false;
      const tail = snap.trimEnd();
      if (!tail.endsWith("]") && !tail.endsWith("}")) return false; // 便宜的完整形态预筛
      try {
        JSON.parse(snap); // 流中间的残片必抛 → 继续等
      } catch {
        return false;
      }
      xhr.__haDoneSent = true;
      console.log("[ha-capture] 快照兜底（" + source + "）：JSON 已完整（" + snap.length + " 字符），发 done", { uid: xhr.__haUid, reqId });
      emit({ kind: "done", reqId, raw: snap });
      return true;
    };

    // XHR 主通道（探针确认 AI Studio 走 XHR）：open 记 URL → send 挂 loadend 读全量 responseText
    const OrigXHR = win.XMLHttpRequest;
    if (OrigXHR && OrigXHR.prototype) {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;

      OrigXHR.prototype.open = function (method, url, ...rest) {
        try {
          if (this.__haUid == null) this.__haUid = ++objSeq; // 对象身份（诊断）
          // XHR 规范：open() 在请求进行中再次调用会静默丢弃进行中的请求（不触发任何事件）——若命中过我们，这里点名
          if (this.__haInFlight != null) {
            console.warn("[ha-capture] open() 在已捕获请求完成前被再次调用（进行中的请求将被静默丢弃、不触发任何事件）", {
              uid: this.__haUid,
              reqId: this.__haInFlight,
              nextUrlTail: urlTail(typeof url === "string" ? url : String(url)),
            });
          }
          this.__haUrl = typeof url === "string" ? url : String(url);
          if (urlMatch(this.__haUrl)) {
            console.log("[ha-capture] open 命中 GenerateContent（…" + urlTail(this.__haUrl) + "）", { uid: this.__haUid });
          }
        } catch (err) {
          console.warn("[ha-capture] open 钩子异常", err);
        }
        return origOpen.call(this, method, url, ...rest);
      };

      OrigXHR.prototype.send = function (...args) {
        try {
          const url = this.__haUrl || "";
          if (urlMatch(url)) {
            const reqId = ++seq;
            const uid = this.__haUid;
            this.__haInFlight = reqId;
            this.__haDoneSent = false; // 同一对象可能被复用发下一请求：取证标志按请求复位
            console.log("[ha-capture] send 命中 GenerateContent", { uid, reqId, urlTail: urlTail(url) });
            emit({ kind: "start", reqId, urlTail: urlTail(url) });
            // 事件轨迹 + 快照取证：readyState 逐次留痕；rs=3/4、abort() 前、loadend 三处同步点取完整 JSON。
            this.addEventListener("readystatechange", () => {
              try {
                if (this.__haLastRS !== this.readyState) {
                  this.__haLastRS = this.readyState; // 连续同名状态（流式 3）只记一次
                  console.log("[ha-capture] readyState → " + this.readyState, { uid, reqId });
                }
                if (this.readyState === 0) {
                  this.__haInFlight = null; // 对象已被重置，不再是「进行中」
                  if (!this.__haDoneSent) {
                    // 危险重置：原文尚未到手就被静默抹除——响亮告警 + 调用栈点名（正常收尾的 abort 不喧哗）
                    console.warn("[ha-capture] readyState 归零：对象被静默重置（无 abort/error/loadend）", {
                      uid,
                      reqId,
                      status: this.status,
                    });
                    console.warn("[ha-capture] 归零调用栈：\n" + (new Error("readyState=0").stack || ""));
                  }
                  return;
                }
                if (this.readyState === 3 || this.readyState === 4) {
                  trySnapshot(this, reqId, "rs" + this.readyState);
                }
              } catch (err) {
                console.warn("[ha-capture] readyState 处理异常", { uid, reqId, err });
              }
            });
            for (const t of ["error", "abort", "timeout"]) {
              this.addEventListener(t, () => {
                console.warn("[ha-capture] 请求事件 " + t, { uid, reqId, readyState: this.readyState });
              });
            }
            // 先挂监听再 send：同步 XHR 的 loadend 在 send 内就会派发，后挂会漏
            this.addEventListener(
              "loadend",
              () => {
                this.__haInFlight = null;
                try {
                  console.log("[ha-capture] loadend 触发", {
                    uid,
                    reqId,
                    readyState: this.readyState,
                    responseType: this.responseType,
                  });
                  if (this.__haDoneSent) {
                    console.log("[ha-capture] done 已由快照发出，loadend 不重复", { uid, reqId });
                    return;
                  }
                  if (trySnapshot(this, reqId, "loadend")) return; // 兜底取证：done 只承载完整 JSON
                  const rt = this.responseType;
                  const raw = this.responseText;
                  this.__haDoneSent = true; // 结果已送出（error），后续 rs0 不再误报「静默重置」
                  const reason =
                    rt !== "" && rt !== "text"
                      ? "responseType=" + rt
                      : "原文非完整 JSON（" + (typeof raw === "string" ? raw.length : 0) + " 字符）";
                  console.warn("[ha-capture] loadend 放弃：" + reason, { uid, reqId });
                  emit({ kind: "error", reqId, urlTail: urlTail(url), reason });
                } catch (err) {
                  console.warn("[ha-capture] loadend 处理异常", { uid, reqId, err });
                  emit({ kind: "error", reqId, urlTail: urlTail(url), reason: String((err && err.message) || err) });
                }
              },
              { once: true },
            );
          }
        } catch (err) {
          console.warn("[ha-capture] send 钩子异常", err);
        }
        return origSend.apply(this, args);
      };

      // abort 拦截：AI Studio 在流完成瞬间 abort()——这是它的「完成信号」，此刻原文仍在
      // （abort 放行后状态即置 unsent、responseText 读空）。先取证；取不到（真·流中打断）才响亮告警。
      const origAbort = OrigXHR.prototype.abort;
      if (typeof origAbort === "function") {
        OrigXHR.prototype.abort = function (...args) {
          try {
            if (this.__haInFlight != null && !this.__haDoneSent) {
              if (!trySnapshot(this, this.__haInFlight, "abort")) {
                console.warn(
                  "[ha-capture] abort() 在原文到手前被调用（本次捕获可能被吞）",
                  { uid: this.__haUid, reqId: this.__haInFlight, readyState: this.readyState },
                  new Error("abort()").stack || "",
                );
              }
            }
          } catch (err) {
            console.warn("[ha-capture] abort 拦截异常", err);
          }
          return origAbort.apply(this, args);
        };
      }
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
            console.log("[ha-capture] fetch 命中 GenerateContent", { reqId, urlTail: urlTail(url) });
            emit({ kind: "start", reqId, urlTail: urlTail(url) });
            p.then(
              (resp) => {
                try {
                  const clone = resp.clone(); // 响应一到就 clone，抢在页面消费 body 前
                  clone.text().then(
                    (raw) => {
                      console.log("[ha-capture] fetch done 已发出", { reqId, chars: typeof raw === "string" ? raw.length : typeof raw });
                      emit({ kind: "done", reqId, raw });
                    },
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
        } catch (err) {
          console.warn("[ha-capture] fetch 钩子异常", err);
        }
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
      } catch (err) {
        console.warn("[ha-capture] 握手监听异常", err);
      }
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
