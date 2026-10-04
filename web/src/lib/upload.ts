// 分块上传：浏览器 → 面板 → 加密通道 → Agent（512KB/块）
// 稳定性：分块失败自动重试；会话过期/乱序时重新 begin 接续（Agent 侧按
// <file>.blocknexus-upload 半成品 + 文件指纹续传），这就是断点续传——
// 网络抖动、页面刷新后点「重试」都只补剩下的字节，不再从头传。
import { api } from '@/lib/api';

export function bufToB64(buf: Uint8Array): string {
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < buf.length; i += STEP) {
    bin += String.fromCharCode(...buf.subarray(i, i + STEP));
  }
  return btoa(bin);
}

interface UploadSession {
  uploadId: string;
  chunk: number;
  /** 已可靠接收的字节数（resume 时为半成品大小） */
  received?: number;
  /** true = 接上了已有的半成品 */
  resumed?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadFile(
  serverId: string,
  instance: string,
  dir: string,
  file: File,
  onProgress?: (pct: number) => void,
  onUploadId?: (uploadId: string) => void,
): Promise<void> {
  const base = `/servers/${serverId}/instances/${encodeURIComponent(instance)}/files`;
  // resume 恒为 true：Agent 侧有指纹匹配的半成品就续传，没有就从头开始，无需调用方区分
  const beginSession = () =>
    api<UploadSession>(`${base}/upload/begin`, {
      method: 'POST',
      body: { dir, filename: file.name, size: file.size, lastModified: file.lastModified, resume: true },
    });

  let session = await beginSession();
  onUploadId?.(session.uploadId);
  const chunkSize = session.chunk || 512 * 1024;
  // 对齐到整块：Agent 端可能留下断电产生的半块，从整块边界继续（必要时 seekTo 截掉；
  // 半块不足一块时对齐点是 0，同样要 seekTo=0 截掉）
  let offset = Math.floor((session.received || 0) / chunkSize) * chunkSize;
  let pendingSeek = offset !== (session.received || 0);
  let seq = 0;
  let recoveries = 0;
  onProgress?.(Math.round((offset / Math.max(file.size, 1)) * 100));

  while (offset < file.size) {
    const len = Math.min(chunkSize, file.size - offset);
    const dataB64 = bufToB64(new Uint8Array(await file.slice(offset, offset + len).arrayBuffer()));
    let advanced = false;
    // 每块原样重试 1 次；再失败就重新 begin 接续（会话过期/序号错位都能恢复）
    for (let attempt = 0; attempt < 2 && !advanced; attempt++) {
      try {
        await api(`${base}/upload/chunk`, {
          method: 'POST',
          body: {
            uploadId: session.uploadId,
            seq: seq + 1,
            dataB64,
            ...(pendingSeek ? { seekTo: offset } : {}),
          },
        });
        seq += 1;
        pendingSeek = false;
        offset += len;
        advanced = true;
        onProgress?.(Math.round((offset / file.size) * 100));
      } catch (e) {
        if (attempt === 0) {
          await sleep(800);
          continue;
        }
        if (++recoveries > 8) throw e;
        session = await beginSession();
        onUploadId?.(session.uploadId);
        const received = session.received || 0;
        const aligned = Math.floor(received / chunkSize) * chunkSize;
        seq = 0;
        pendingSeek = aligned !== received;
        if (aligned !== offset) {
          offset = aligned; // 可能前进（块其实已收到）也可能后退（重新补）
        }
        // 不置 advanced：外层 while 用新的 offset 重新读块发送
      }
    }
    if (!advanced && offset < file.size && recoveries > 8) throw new Error('上传多次重试后仍失败');
  }

  try {
    await api(`${base}/upload/finish`, { method: 'POST', body: { uploadId: session.uploadId } });
  } catch {
    // finish 失败多半是会话过期：重新 begin 看进度，若已收完就再试一次
    session = await beginSession();
    onUploadId?.(session.uploadId);
    if (Math.floor((session.received || 0) / chunkSize) * chunkSize >= file.size) {
      await api(`${base}/upload/finish`, { method: 'POST', body: { uploadId: session.uploadId } });
    } else {
      throw new Error('上传未完成，请点重试继续（已支持断点续传）');
    }
  }
  onProgress?.(100);
}

export async function abortUpload(serverId: string, instance: string, uploadId: string): Promise<void> {
  await api(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/files/upload/abort`, {
    method: 'POST',
    body: { uploadId },
  }).catch(() => {});
}

// SFTP 直传：浏览器 → 面板 →（SSH/SFTP）→ 实例目录。
// 单次 HTTP 请求流式传输，无 200MB 分块上限；用 XHR 以获得上传进度事件。
export function uploadFileViaSftp(
  serverId: string,
  instance: string,
  dir: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ size: number }> {
  return new Promise((resolve, reject) => {
    const url =
      `/api/servers/${serverId}/instances/${encodeURIComponent(instance)}/files/upload/sftp` +
      `?dir=${encodeURIComponent(dir)}&filename=${encodeURIComponent(file.name)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress?.(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误，SFTP 直传失败'));
    xhr.onload = () => {
      const data = (xhr.response ?? {}) as { ok?: boolean; size?: number; error?: string };
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
        onProgress?.(100);
        resolve({ size: data.size ?? file.size });
      } else {
        reject(new Error(data.error || `请求失败 ${xhr.status}`));
      }
    };
    xhr.send(file);
  });
}
