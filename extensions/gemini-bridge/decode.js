// gemini-bridge 响应解码器（经典脚本：content_scripts js 数组中先于 content.js 加载，隔离世界共享全局名）。
// 输入：MAIN world 捕获的 GenerateContent 响应原文（application/json+protobuf 的 JSON 增量流，全量一次性）。
// 输出：{ answer, deltaCount, thoughtCount } | null —— 任何异常一律 null（响亮停滞：本轮不投递，绝不修补）。
// 两条铁律：必须 JSON.parse 全量后一次 walk（delta 切分任意——可切词中/token 中/跨 chunk，逐片解析必死）；
// parse 同时消化 < 转义，喂给 AST 的才是原文（正则抠原始字节会失配 AST 的标记正则）。
function haDecodeGenerateContent(rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return null;
  }

  let deltaCount = 0; // 参与拼接的正文 delta 数（非空、非 thought）
  let thoughtCount = 0; // 被过滤的 thinking delta 数
  const answerParts = [];

  const walk = (x) => {
    if (!Array.isArray(x)) return;
    if (x[0] === null && typeof x[1] === "string") {
      // thought 判据：数组长度 > 12 且 index 12 === 1（探针校准，spec §3）
      if (x.length > 12 && x[12] === 1) {
        thoughtCount += 1;
      } else if (x[1].length > 0) {
        // 空文本 part（signature / usage 尾块）自然滤除
        answerParts.push(x[1]);
        deltaCount += 1;
      }
      return;
    }
    for (const item of x) walk(item);
  };
  walk(data);

  const answer = answerParts.join("");
  if (answer === "") return null;
  return { answer, deltaCount, thoughtCount };
}

// CJS 尾巴：vitest 直接 import 单测；浏览器经典脚本下 module 不存在，走全局函数声明
if (typeof module !== "undefined" && module.exports) module.exports = { haDecodeGenerateContent };
