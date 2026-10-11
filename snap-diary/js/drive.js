// Minimal Google Drive v3 REST client (fetch only, no Google API library).

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,appProperties,trashed";

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Escapes a value for a Drive search query string literal. */
export function quote(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * multipart/related body: JSON metadata part + media part. The Blob has no
 * type on purpose: Blob lowercases its type, which would corrupt a mixed-case
 * boundary. Callers send the Content-Type header explicitly.
 */
export function buildMultipart(metadata, media, boundary) {
  const mediaType = media.type || "application/octet-stream";
  return new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`,
    media,
    `\r\n--${boundary}--`
  ]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDriveClient(getToken, {
  fetchImpl = (...a) => fetch(...a), retryDelay = 800, onUnauthorized = () => {}
} = {}) {
  async function request(url, options = {}, { raw = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await getToken();
      const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
      let response;
      try {
        response = await fetchImpl(url, { ...options, headers });
      } catch (error) {
        if (attempt < 2) { await sleep(retryDelay * 2 ** attempt); continue; }
        throw new DriveError("네트워크에 연결할 수 없습니다.", 0);
      }
      if (response.ok) {
        if (raw) return response;
        return response.status === 204 ? null : response.json();
      }
      if (response.status === 401) {
        onUnauthorized();
        throw new DriveError("Google 로그인이 만료되었습니다. 다시 연결하세요.", 401);
      }
      const retryable = response.status === 429 || response.status >= 500 ||
        (response.status === 403 && /rateLimit|userRateLimit/i.test(await response.clone().text()));
      if (retryable && attempt < 3) { await sleep(retryDelay * 2 ** attempt); continue; }
      let detail = "";
      try { detail = (await response.json())?.error?.message || ""; } catch { /* not JSON */ }
      throw new DriveError(`Drive 오류 ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
  }

  async function list(q, fields = FILE_FIELDS) {
    const files = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q, pageSize: "1000", spaces: "drive", fields: `nextPageToken,files(${fields})`
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await request(`${API}/files?${params}`);
      files.push(...(page.files || []));
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    return files;
  }

  async function createFolder(name, parentId, appProperties) {
    const body = { name, mimeType: FOLDER_MIME, appProperties };
    if (parentId) body.parents = [parentId];
    return request(`${API}/files?fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  /** Finds the app folder tagged `role` (under parentId) or creates it. */
  async function ensureFolder(name, role, parentId) {
    let q = `mimeType=${quote(FOLDER_MIME)} and trashed=false and ` +
      `appProperties has { key='snapDiary' and value=${quote(role)} }`;
    if (parentId) q += ` and ${quote(parentId)} in parents`;
    const found = await list(q);
    if (found.length) {
      found.sort((a, b) => (a.modifiedTime < b.modifiedTime ? -1 : 1));
      return found[0].id;
    }
    return (await createFolder(name, parentId, { snapDiary: role })).id;
  }

  function boundary() {
    return `snapdiary${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }

  async function upload(metadata, blob, fileId) {
    const b = boundary();
    const body = buildMultipart(metadata, blob, b);
    const url = fileId
      ? `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${FILE_FIELDS}`
      : `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`;
    return request(url, {
      method: fileId ? "PATCH" : "POST",
      headers: { "Content-Type": `multipart/related; boundary=${b}` },
      body
    });
  }

  return {
    request,
    list,
    ensureFolder,
    getFile: (fileId) => request(`${API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`),
    createFile: (metadata, blob) => upload(metadata, blob, null),
    /** Metadata `parents` cannot be PATCHed on update; strip it. */
    updateFile: (fileId, metadata, blob) => {
      const { parents, ...rest } = metadata;
      return upload(rest, blob, fileId);
    },
    async download(fileId) {
      const response = await request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {}, { raw: true });
      return response.blob();
    },
    async downloadJSON(fileId) {
      const response = await request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {}, { raw: true });
      return JSON.parse(await response.text());
    },
    async trash(fileId) {
      try {
        await request(`${API}/files/${encodeURIComponent(fileId)}?fields=id`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trashed: true })
        });
      } catch (error) {
        if (error.status !== 404) throw error; // already gone is fine
      }
    }
  };
}
