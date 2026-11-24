import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const RELAY_URL = (process.env.RELAY_URL || 'https://melissa-iptv.hostless.app').replace(/\/+$/, '');
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const POLL_INTERVAL_MS = 1500;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'
]);

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

export function buildYtDlpArgs({ url, mode, outputPath, impersonate = false }) {
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress',
    '--js-runtimes', 'node', '--remote-components', 'ejs:github',
    '--max-filesize', '500M'
  ];
  if (impersonate) args.push('--impersonate', 'chrome');
  if (mode === 'audio') {
    args.push('-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '128K');
  } else {
    args.push('-f', '18/best[ext=mp4][vcodec!=none][acodec!=none]');
  }
  args.push('-o', outputPath, '--', url);
  return args;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2500);
      killTimer.unref();
      finish(new Error('Tempo limite do yt-dlp excedido'));
    }, DOWNLOAD_TIMEOUT_MS);
    timer.unref();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    child.once('error', finish);
    child.once('close', code => {
      if (code === 0) return finish();
      finish(new Error(stderr.trim() || ('yt-dlp terminou com código ' + code)));
    });
  });
}

async function downloadMedia(task, directory) {
  const outputPath = join(directory, 'media.%(ext)s');
  try {
    await runYtDlp(buildYtDlpArgs({ url: task.url, mode: task.mode, outputPath }));
  } catch (firstError) {
    console.warn('yt-dlp falhou sem impersonação; tentando Chrome:', firstError.message);
    await runYtDlp(buildYtDlpArgs({ url: task.url, mode: task.mode, outputPath, impersonate: true }));
  }

  const files = await readdir(directory);
  const filename = files.find(name => name.startsWith('media.') && !/\.(part|ytdl)$/i.test(name));
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

async function postTaskResponse(taskId, status, headers, body) {
  const response = await fetch(RELAY_URL + '/download-agent/respond/' + taskId, {
    method: 'POST',
    headers: {
      'x-agent-token': AGENT_TOKEN,
      'x-upstream-status': String(status),
      'x-upstream-headers': encodedHeaders(headers),
      'content-type': headers['content-type'] || 'application/octet-stream'
    },
    body,
    duplex: 'half',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS + 30000)
  });
  if (!response.ok) throw new Error('Relay recusou a resposta da tarefa: HTTP ' + response.status);
  await response.arrayBuffer();
}

async function processTask(job) {
  let task;
  try { task = parseDownloadTask(job); }
  catch (error) {
    console.warn('Tarefa ignorada:', error.message);
    return false;
  }

  const directory = await mkdtemp(join(tmpdir(), 'downloader-reverso-'));
  try {
    const media = await downloadMedia(task, directory);
    const headers = {
      'content-type': media.contentType,
      'content-disposition': 'attachment; filename="' + media.filename + '"',
      'content-length': String(media.size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    };
    await postTaskResponse(task.id, 200, headers, createReadStream(media.filePath));
    console.log('Download reverso concluído: ' + media.filename + ' (' + media.size + ' bytes)');
  } catch (error) {
    console.error('Download reverso falhou:', error.message);
    const body = Buffer.from(JSON.stringify({
      error: 'Falha no download reverso',
      details: String(error.message || '').slice(0, 800)
    }));
    await postTaskResponse(task.id, 502, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store'
    }, body).catch(responseError => {
      console.error('Não foi possível devolver o erro ao relay:', responseError.message);
    });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

async function pollOnce() {
  const response = await fetch(RELAY_URL + '/download-agent/poll', {
    headers: { 'x-agent-token': AGENT_TOKEN },
    signal: AbortSignal.timeout(35000)
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error('Polling respondeu HTTP ' + response.status);
  return response.json();
}

async function main() {
  if (!AGENT_TOKEN || AGENT_TOKEN.length < 32) {
    throw new Error('Configure AGENT_TOKEN com pelo menos 32 caracteres no .env');
  }
  console.log('Downloader reverso conectado ao relay: ' + RELAY_URL);
  while (true) {
    try {
      const job = await pollOnce();
      if (job) await processTask(job);
    } catch (error) {
      console.error('Falha no polling do relay:', error.message);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
