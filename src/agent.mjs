import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const API_URL = new URL(process.env.API_URL || 'https://melissa-api-server.hostless.app').origin;
const API_KEY = process.env.API_KEY || '';
const RECONNECT_INITIAL_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'
]);

export function buildAgentSocketUrl(apiUrl) {
  let endpoint;
  try {
    endpoint = new URL(apiUrl);
  } catch {
    throw new Error('API_URL deve ser uma URL HTTP ou HTTPS válida');
  }
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  else if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  else throw new Error('API_URL deve usar HTTP ou HTTPS');
  if (endpoint.username || endpoint.password) {
    throw new Error('API_URL não pode conter credenciais');
  }
  endpoint.pathname = '/download-agent/connect';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

export function parseDownloadTask(job) {
  if (!job || typeof job !== 'object' || job.method !== 'GET' || typeof job.path !== 'string') {
    throw new Error('Formato de tarefa reversa inválido');
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(job.id || ''))) {
    throw new Error('Identificador de tarefa inválido');
  }

  let taskUrl;
  try { taskUrl = new URL(job.path, 'http://relay.local'); }
  catch { throw new Error('Caminho da tarefa inválido'); }
  if (taskUrl.pathname !== '/_downloader-reverse') {
    throw new Error('Não é uma tarefa do downloader reverso');
  }

  const rawUrl = taskUrl.searchParams.get('url');
  let mediaUrl;
  try { mediaUrl = new URL(rawUrl); }
  catch { throw new Error('URL do YouTube inválida'); }
  if (mediaUrl.protocol !== 'https:' || !YOUTUBE_HOSTS.has(mediaUrl.hostname.toLowerCase()) ||
      mediaUrl.username || mediaUrl.password || mediaUrl.port) {
    throw new Error('A tarefa aceita somente URLs HTTPS do YouTube');
  }

  const mode = taskUrl.searchParams.get('mode') || 'video';
  if (mode !== 'audio' && mode !== 'video') throw new Error('Modo de download inválido');
  return { id: job.id, url: mediaUrl.toString(), mode };
}

export function buildYtDlpArgs({ url, mode, outputPath }) {
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress',
    '--js-runtimes', 'node', '--remote-components', 'ejs:github',
    '--max-filesize', '500M'
  ];
  if (mode === 'audio') {
    args.push('-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '128K');
  } else {
    args.push('-f', '18/best[ext=mp4][vcodec!=none][acodec!=none]');
  }
  args.push('-o', outputPath, '--', url);
  return args;
}

export function runCommand(command, args, { timeoutMs = DOWNLOAD_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Processo cancelado'));
      return;
    }

    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    let terminationError = null;
    let killTimer = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const terminate = error => {
      if (settled || terminationError) return;
      terminationError = error;
      if (child.exitCode === null) child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2500);
      killTimer.unref();
    };
    const onAbort = () => {
      terminate(signal.reason instanceof Error ? signal.reason : new Error('Processo cancelado'));
    };

    const timer = setTimeout(() => {
      terminate(new Error('Tempo limite do yt-dlp excedido'));
    }, timeoutMs);
    timer.unref();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    child.once('error', finish);
    child.once('close', code => {
      if (terminationError) return finish(terminationError);
      if (code === 0) return finish();
      finish(new Error(stderr.trim() || (command + ' terminou com código ' + code)));
    });

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function downloadMedia(task, directory, signal) {
  const outputPath = join(directory, 'media.%(ext)s');
  await runCommand(YTDLP, buildYtDlpArgs({ url: task.url, mode: task.mode, outputPath }), {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    signal
  });

  const files = await readdir(directory);
  const filename = files.find(name => name.startsWith('media.') && !/\\.(part|ytdl)$/i.test(name));
  if (!filename) throw new Error('yt-dlp terminou sem gerar a mídia');
  const filePath = join(directory, filename);
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error('O arquivo baixado está vazio');
  if (info.size > MAX_DOWNLOAD_BYTES) throw new Error('A mídia excede o limite de 500 MiB');
  return {
    filePath,
    size: info.size,
    filename: task.mode === 'audio' ? 'audio.m4a' : 'video.mp4',
    contentType: task.mode === 'audio' ? 'audio/mp4' : 'video/mp4'
  };
}

function encodedHeaders(headers) {
  return Buffer.from(JSON.stringify(headers)).toString('base64');
}

async function postTaskResponse(taskId, status, headers, body, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Tempo limite ao devolver a resposta ao relay'));
  }, DOWNLOAD_TIMEOUT_MS + 30_000);
  timeout.unref();

  const onAbort = () => {
    controller.abort(signal.reason instanceof Error ? signal.reason : new Error('Conexão com a API encerrada'));
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(API_URL + '/download-agent/respond/' + taskId, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'x-upstream-status': String(status),
        'x-upstream-headers': encodedHeaders(headers),
        'content-type': headers['content-type'] || 'application/octet-stream'
      },
      body,
      duplex: 'half',
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Relay recusou a resposta da tarefa: HTTP ' + response.status);
    await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function processTask(job, signal) {
  let task;
  try {
    task = parseDownloadTask(job);
  } catch (error) {
    console.warn('Tarefa reversa ignorada:', error.message);
    return true;
  }

  const directory = await mkdtemp(join(tmpdir(), 'downloader-reverso-'));
  try {
    const media = await downloadMedia(task, directory, signal);
    const headers = {
      'content-type': media.contentType,
      'content-disposition': 'attachment; filename="' + media.filename + '"',
      'content-length': String(media.size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    };
    await postTaskResponse(task.id, 200, headers, createReadStream(media.filePath), signal);
    console.log('Download reverso concluído: ' + media.filename + ' (' + media.size + ' bytes)');
    return true;
  } catch (error) {
    if (signal && signal.aborted) {
      console.warn('Download interrompido porque o canal com a API foi encerrado.');
      return false;
    }
    console.error('Download reverso falhou:', error.message);
    const body = Buffer.from(JSON.stringify({
      error: 'Falha no download reverso',
      details: String(error.message || '').slice(0, 800)
    }));
    try {
      await postTaskResponse(task.id, 502, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store'
      }, body, signal);
      return true;
    } catch (responseError) {
      console.error('Não foi possível devolver a resposta ao relay:', responseError.message);
      return false;
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function parseSocketMessage(raw) {
  try {
    const message = JSON.parse(raw.toString());
    return message && typeof message === 'object' ? message : null;
  } catch {
    return null;
  }
}

function sendSocketMessage(socket, message) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('Conexão com a API não está aberta'));
      return;
    }
    socket.send(JSON.stringify(message), error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function openAgentSocket(socketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl, {
      headers: { 'x-api-key': API_KEY },
      handshakeTimeout: 15_000,
      perMessageDeflate: false
    });
    let opened = false;
    socket.once('open', () => {
      opened = true;
      resolve(socket);
    });
    socket.on('error', error => {
      if (!opened) reject(error);
      else console.error('Conexão do agente apresentou erro:', error.message);
    });
  });
}

async function serveAgentSocket(socket) {
  let taskActive = false;
  let closing = false;
  let activeTaskController = null;
  let activeTaskPromise = null;

  const heartbeat = setInterval(() => {
    sendSocketMessage(socket, { type: 'heartbeat', timestamp: Date.now() })
      .catch(error => {
        console.error('Falha ao enviar heartbeat:', error.message);
        socket.terminate();
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const closed = new Promise(resolve => {
    socket.once('close', () => {
      closing = true;
      if (activeTaskController && !activeTaskController.signal.aborted) {
        activeTaskController.abort(new Error('Canal com a API encerrado'));
      }
      resolve();
    });
  });

  socket.on('message', raw => {
    const message = parseSocketMessage(raw);
    if (!message) return;

    if (message.type === 'ready') {
      console.log('Canal reverso autenticado; A10s está online.');
      return;
    }
    if (message.type === 'heartbeat_ack') return;

    if (message.type === 'task') {
      if (taskActive || closing || activeTaskPromise) return;
      taskActive = true;
      const job = message.job;
      const taskId = job && typeof job.id === 'string' ? job.id : null;
      const taskController = new AbortController();
      activeTaskController = taskController;

      const taskPromise = processTask(job, taskController.signal).then(async completed => {
        if (!completed) {
          socket.terminate();
          return;
        }
        if (taskId) {
          await sendSocketMessage(socket, { type: 'task_complete', id: taskId });
        }
      }).catch(error => {
        console.error('Falha inesperada ao processar tarefa:', error.message);
        socket.terminate();
      }).finally(() => {
        if (activeTaskController === taskController) activeTaskController = null;
        taskActive = false;
        if (activeTaskPromise === taskPromise) activeTaskPromise = null;
      });
      activeTaskPromise = taskPromise;
    }
  });

  socket.on('error', error => {
    console.error('Canal reverso apresentou erro:', error.message);
  });

  await closed;
  if (activeTaskController && !activeTaskController.signal.aborted) {
    activeTaskController.abort(new Error('Canal com a API encerrado'));
  }
  if (activeTaskPromise) await activeTaskPromise.catch(() => {});
  clearInterval(heartbeat);
}

async function main() {
  if (!API_KEY) {
    throw new Error('Configure API_KEY no .env usando a mesma chave da API principal');
  }

  const socketUrl = buildAgentSocketUrl(API_URL);
  let reconnectDelay = RECONNECT_INITIAL_MS;
  console.log('Downloader reverso aguardando chamadas da API: ' + socketUrl);

  while (true) {
    try {
      const socket = await openAgentSocket(socketUrl);
      reconnectDelay = RECONNECT_INITIAL_MS;
      await serveAgentSocket(socket);
      console.warn('Canal reverso encerrado; tentando reconectar.');
    } catch (error) {
      console.error('Falha ao conectar ao relay:', error.message);
    }

    await new Promise(resolve => setTimeout(resolve, reconnectDelay));
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
