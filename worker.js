// worker.js —— 零成本图片网盘（无口令版）
// 原则：宁可拒绝服务，绝不产生费用

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;          // 单图硬上限 5MB
const STORAGE_SOFT_CAP = 8 * 1024 * 1024 * 1024;  // 存储软顶 8GB（留 2GB 缓冲）
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif",
  "image/webp", "image/avif", "image/svg+xml", "image/bmp"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ===== 读取图片 =====
    if (request.method === "GET" && path.startsWith("/img/")) {
      const key = decodeURIComponent(path.slice(5));
      if (!key) return new Response("404", { status: 404 });

      const obj = await env.IMAGE_BUCKET.get(key);
      if (!obj) return new Response("404 不存在", { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      return new Response(obj.body, { headers });
    }

    // ===== 上传页 =====
    if (request.method === "GET" && path === "/") {
      return new Response(UPLOAD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    // ===== 上传接口（无需口令）=====
    if (request.method === "POST" && path === "/upload") {
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("multipart/form-data")) {
        return new Response("415 只接受 multipart", { status: 415 });
      }

      // content-length 先拦一遍
      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > MAX_IMAGE_BYTES) {
        return new Response("413 图片超过 5MB", { status: 413 });
      }

      let form;
      try {
        form = await request.formData();
      } catch {
        return new Response("400 解析失败", { status: 400 });
      }

      const file = form.get("file");
      if (!file || typeof file === "string") {
        return new Response("400 没有文件", { status: 400 });
      }

      // MIME 白名单
      const mime = file.type || "";
      if (!ALLOWED_TYPES.has(mime)) {
        return new Response("415 只接受图片类型", { status: 415 });
      }

      // 流式读 + 实时字节计数，超 5MB 立刻中断
      const buf = await safeReadWithCap(file, MAX_IMAGE_BYTES);
      if (buf === null) {
        return new Response("413 图片超过 5MB，已中断", { status: 413 });
      }

      // 存储软顶检查（粗估）
      try {
        const usage = await estimateUsage(env);
        if (usage + buf.length > STORAGE_SOFT_CAP) {
          return new Response("507 存储将满，拒绝上传", { status: 507 });
        }
      } catch {
        // 估算失败不阻塞，靠 R2 10GB 硬顶兜底
      }

      // 写 R2，文件名做安全化
      const rawName = (file.name || "image.bin").replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
      const key = `img/${Date.now()}_${rawName}`;
      await env.IMAGE_BUCKET.put(key, buf, {
        httpMetadata: { contentType: mime }
      });

      return new Response(JSON.stringify({
        ok: true,
        url: `${url.origin}/img/${encodeURIComponent(key)}`
      }), {
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    return new Response("404", { status: 404 });
  }
};

// 流式读取 + 字节硬 cap
async function safeReadWithCap(file, cap) {
  const reader = file.stream().getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } catch {
    await reader.cancel();
    return null;
  }
}

// 粗估已用存储（只列前 1000 个对象）
async function estimateUsage(env) {
  let size = 0;
  const listed = await env.IMAGE_BUCKET.list({ limit: 1000 });
  for (const item of listed.objects) {
    size += item.size || 0;
  }
  return size;
}

// 上传页（无口令输入框）
const UPLOAD_HTML = `<!doctype html>
<meta charset=utf-8>
<title>零成本图床</title>
<style>body{font-family:sans-serif;max-width:480px;margin:40px auto}progress{width:100%}</style>
<h3>传一张图（≤5MB）</h3>
<input id=f type=file accept=image/*>
<button onclick=up()>上传</button>
<progress id=p value=0></progress>
<pre id=out></pre>
<script>
async function up(){
  const f=document.getElementById('f').files[0];
  if(!f)return alert('选张图');
  if(f.size>5*1024*1024)return alert('超过5MB');
  const fd=new FormData();fd.append('file',f);
  const xhr=new XMLHttpRequest();
  xhr.open('POST','/upload');
  xhr.upload.onprogress=e=>document.getElementById('p').value=e.loaded/e.total;
  xhr.onload=()=>document.getElementById('out').textContent=xhr.responseText;
  xhr.send(fd);
}
</script>`;
