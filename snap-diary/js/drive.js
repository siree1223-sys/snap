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
  fetchImpl = (...a) => fetch(...a), retryDelay = 800, onUnauthorized = () => {},
  useXhr = typeof XMLHttpRequest !== "undefined"
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

  // ---------- resumable upload (videos, anything over the multipart limit) ----------

  /** One PUT to an upload session. XHR in browsers for upload progress. */
  function put(url, body, headers, onProgress) {
    if (useXhr) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        if (onProgress) xhr.upload.onprogress = (event) => onProgress(event.loaded);
        xhr.onload = () => resolve({ status: xhr.status, header: (n) => xhr.getResponseHeader(n), text: xhr.responseText });
        xhr.onerror = xhr.onabort = xhr.ontimeout = () => reject(new DriveError("업로드 연결이 끊겼습니다.", 0));
        xhr.send(body);
      });
    }
    return fetchImpl(url, { method: "PUT", headers, body }).then(async (response) => ({
      status: response.status, header: (n) => response.headers.get(n), text: await response.text()
    }));
  }

  async function startSession(metadata, blob) {
    const response = await request(`${UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": blob.type || "application/octet-stream",
        "X-Upload-Content-Length": String(blob.size)
      },
      body: JSON.stringify(metadata)
    }, { raw: true });
    const location = response.headers.get("Location");
    if (location) return location;
    // Google exposes X-GUploader-UploadID to browsers; the session URI is
    // the upload endpoint plus that id, so it works even if Location is hidden.
    const uploadId = response.headers.get("X-GUploader-UploadID");
    if (uploadId) {
      return `${UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}&upload_id=${encodeURIComponent(uploadId)}`;
    }
    throw new DriveError("업로드 세션을 시작할 수 없습니다.", response.status);
  }

  /**
   * Uploads a file of any size. After an interruption it asks the session how
   * many bytes arrived and continues from there; an expired session starts over.
   */
  async function uploadResumable(metadata, blob, { onProgress } = {}) {
    const total = blob.size;
    const done = (text) => {
      onProgress?.(total, total);
      return JSON.parse(text);
    };
    for (let session = 0; session < 2; session++) {
      const url = await startSession(metadata, blob);
      let offset = 0;
      let expired = false;
      for (let attempt = 0; attempt < 6 && !expired; attempt++) {
        let result = null;
        try {
          result = await put(url, blob.slice(offset), {
            "Content-Range": total ? `bytes ${offset}-${total - 1}/${total}` : "bytes */0"
          }, (loaded) => onProgress?.(Math.min(total, offset + loaded), total));
        } catch { /* interrupted: ask the session below */ }
        if (result?.status === 200 || result?.status === 201) return done(result.text);
        if (result?.status === 404 || result?.status === 410) break;
        if (result && result.status >= 400 && result.status < 500 && ![408, 429].includes(result.status)) {
          throw new DriveError(`업로드 실패 (${result.status})`, result.status);
        }
        await sleep(retryDelay * 2 ** Math.min(attempt, 4));
        let status;
        try {
          status = await put(url, null, { "Content-Range": `bytes */${total}` });
        } catch {
          continue;
        }
        if (status.status === 200 || status.status === 201) return done(status.text);
        if (status.status === 404 || status.status === 410) expired = true;
        else if (status.status === 308) {
          // No Range header means the session has received nothing yet.
          const last = /bytes=0-(\d+)/.exec(status.header("Range") || "");
          offset = last ? Number(last[1]) + 1 : 0;
        }
      }
    }
    throw new DriveError("파일을 올리지 못했습니다. 연결 상태를 확인하고 다시 동기화하세요.", 0);
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
    uploadResumable,
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
