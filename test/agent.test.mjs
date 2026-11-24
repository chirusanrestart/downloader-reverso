import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDownloadTask, buildYtDlpArgs } from '../src/agent.mjs';

test('accepts only reverse-download tasks with a supported YouTube URL', () => {
  const task = parseDownloadTask({
    id: '123e4567-e89b-12d3-a456-426614174000',
    method: 'GET',
    path: '/_downloader-reverse?url=https%3A%2F%2Fyoutu.be%2Fabcdefghijk&mode=audio'
  });
  assert.deepEqual(task, {
    id: '123e4567-e89b-12d3-a456-426614174000',
    url: 'https://youtu.be/abcdefghijk',
    mode: 'audio'
  });
});

test('rejects non-YouTube URLs and unrelated tunnel tasks', () => {
  assert.throws(() => parseDownloadTask({
    id: '123e4567-e89b-12d3-a456-426614174000', method: 'GET',
    path: '/_downloader-reverse?url=https%3A%2F%2Fevil.example%2Fvideo&mode=video'
  }), /YouTube/);
  assert.throws(() => parseDownloadTask({
    id: '123e4567-e89b-12d3-a456-426614174000', method: 'GET', path: '/playlist.m3u8'
  }), /tarefa/);
});

test('builds separate yt-dlp output arguments for video and M4A audio', () => {
  const video = buildYtDlpArgs({ url: 'https://youtu.be/abcdefghijk', mode: 'video', outputPath: '/tmp/media.%(ext)s' });
  const audio = buildYtDlpArgs({ url: 'https://youtu.be/abcdefghijk', mode: 'audio', outputPath: '/tmp/media.%(ext)s' });
  assert.ok(video.includes('18/best[ext=mp4][vcodec!=none][acodec!=none]'));
  assert.ok(audio.includes('bestaudio/best'));
  assert.ok(audio.includes('--extract-audio'));
  assert.ok(audio.includes('m4a'));
  assert.ok(!video.includes('--impersonate'));
  assert.ok(!audio.includes('--impersonate'));
});
