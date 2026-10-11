// In-memory Google Drive v3 fake for Snap Diary tests. It speaks HTTP-shaped
// requests so the real drive.js client (Node tests) and the real browser app
// (Playwright route interception) are both exercised against it.

const enc = new TextEncoder();
const dec = new TextDecoder();

function indexOf(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function parseMultipart(bytes, contentType) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error("missing boundary");
  const delimiter = enc.encode(`--${boundary}`);
  const parts = [];
  let pos = indexOf(bytes, delimiter);
  while (pos !== -1) {
    const start = pos + delimiter.length;
    if (bytes[start] === 45 && bytes[start + 1] === 45) break; // "--" closing
    const headerEnd = indexOf(bytes, enc.encode("\r\n\r\n"), start);
    const headers = dec.decode(bytes.slice(start + 2, headerEnd));
    const next = indexOf(bytes, enc.encode(`\r\n--${boundary}`), headerEnd + 4);
    parts.push({ headers, body: bytes.slice(headerEnd + 4, next) });
    pos = next + 2;
  }
  if (parts.length !== 2) throw new Error(`expected 2 multipart parts, got ${parts.length}`);
  return {
    metadata: JSON.parse(dec.decode(parts[0].body)),
    mime: /Content-Type:\s*([^\r\n]+)/i.exec(parts[1].headers)?.[1] || "application/octet-stream",
    content: parts[1].body
  };
}

const STR = "'((?:[^'\\\\]|\\\\.)*)'";
const unescape = (s) => s.replace(/\\(.)/g, "$1");
const CLAUSES = [
  [new RegExp(`^${STR}\\s+in\\s+parents`), (m) => (f) => f.parents.includes(unescape(m[1]))],
  [/^trashed\s*=\s*(true|false)/, (m, isTrashed) => (f) => isTrashed(f) === (m[1] === "true")],
  [new RegExp(`^mimeType\\s*=\\s*${STR}`), (m) => (f) => f.mimeType === unescape(m[1])],
  [new RegExp(`^name\\s*=\\s*${STR}`), (m) => (f) => f.name === unescape(m[1])],
  [new RegExp(`^appProperties\\s+has\\s+\\{\\s*key\\s*=\\s*${STR}\\s+and\\s+value\\s*=\\s*${STR}\\s*\\}`),
    (m) => (f) => f.appProperties?.[unescape(m[1])] === unescape(m[2])]
];

export function createFakeDrive({ token = "test-token", email = "me@example.com", name = "Me" } = {}) {
  const files = new Map();
  const log = [];
  let seq = 0;
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const stamp = () => new Date((clock += 1000)).toISOString();

  function isTrashed(file) {
    if (file.trashed) return true;
    return file.parents.some((p) => files.has(p) && isTrashed(files.get(p)));
  }

  function compile(q) {
    const tests = [];
    let rest = q.trim();
    while (rest) {
      const hit = CLAUSES.find(([re]) => re.test(rest));
      if (!hit) throw new Error(`fake drive cannot parse query: ${rest}`);
      const m = hit[0].exec(rest);
      tests.push(hit[1](m, isTrashed));
      rest = rest.slice(m[0].length).replace(/^\s+and\s+/, "").trim();
    }
    return (f) => tests.every((t) => t(f));
  }

  function view(file) {
    const { content, parents, ...meta } = file;
    return { ...meta, parents: [...parents], trashed: isTrashed(file) };
  }

  function json(status, body) {
    return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  function create(metadata, content = null, mime = null) {
    const id = `f${++seq}`;
    const file = {
      id,
      name: metadata.name || "untitled",
      mimeType: metadata.mimeType || mime || "application/octet-stream",
      parents: metadata.parents || ["root"],
      appProperties: metadata.appProperties || {},
      trashed: false,
      modifiedTime: stamp(),
      content
    };
    files.set(id, file);
    return file;
  }

  function update(file, metadata, content) {
    for (const key of ["name", "mimeType", "trashed"]) if (key in metadata) file[key] = metadata[key];
    if (metadata.appProperties) file.appProperties = { ...file.appProperties, ...metadata.appProperties };
    if (metadata.parents) throw new Error("parents is not writable on update");
    if (content) file.content = content;
    file.modifiedTime = stamp();
  }

  /** request: { method, url, headers, body: Uint8Array|null } */
  async function handle(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    log.push(`${method} ${url.pathname}${url.search}`);
    if (headers.authorization !== `Bearer ${token}`) return json(401, { error: { code: 401, message: "Invalid Credentials" } });
    const path = url.pathname;
    if (path === "/drive/v3/about") return json(200, { user: { emailAddress: email, displayName: name } });
    if (path === "/drive/v3/files" && method === "GET") {
      const test = compile(url.searchParams.get("q") || "");
      return json(200, { files: [...files.values()].filter(test).map(view) });
    }
    if (path === "/drive/v3/files" && method === "POST") {
      return json(200, view(create(JSON.parse(dec.decode(request.body)))));
    }
    const fileMatch = /^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
    if (fileMatch) {
      const [, isUpload, id] = fileMatch;
      if (isUpload) {
        const { metadata, mime, content } = parseMultipart(request.body, headers["content-type"]);
        if (!id && method === "POST") return json(200, view(create(metadata, content, mime)));
        const file = files.get(decodeURIComponent(id || ""));
        if (!file) return json(404, { error: { code: 404, message: "File not found" } });
        update(file, metadata, content);
        return json(200, view(file));
      }
      const file = files.get(decodeURIComponent(id || ""));
      if (!file) return json(404, { error: { code: 404, message: "File not found" } });
      if (method === "GET" && url.searchParams.get("alt") === "media") {
        return { status: 200, headers: { "content-type": file.mimeType }, body: file.content };
      }
      if (method === "GET") return json(200, view(file));
      if (method === "PATCH") {
        update(file, JSON.parse(dec.decode(request.body)), null);
        return json(200, view(file));
      }
    }
    return json(400, { error: { code: 400, message: `unsupported ${method} ${path}` } });
  }

  /** A fetch() replacement for Node tests. */
  async function fetchImpl(input, init = {}) {
    let body = null;
    if (init.body instanceof Blob) body = new Uint8Array(await init.body.arrayBuffer());
    else if (typeof init.body === "string") body = enc.encode(init.body);
    const result = await handle({ method: init.method || "GET", url: String(input), headers: init.headers || {}, body });
    return new Response(result.body ?? null, { status: result.status, headers: result.headers });
  }

  return {
    files,
    log,
    handle,
    fetch: fetchImpl,
    token,
    byRole: (role) => [...files.values()].filter((f) => f.appProperties.snapDiary === role),
    live: (role) => [...files.values()].filter((f) => f.appProperties.snapDiary === role && !isTrashed(f)),
    trash: (id) => { files.get(id).trashed = true; },
    text: (id) => dec.decode(files.get(id).content)
  };
}
