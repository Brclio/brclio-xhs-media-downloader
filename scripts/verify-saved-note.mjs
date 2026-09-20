// Developer diagnostic using the downloader's explicitly selected saved session.
// Close the running downloader first. Never prints cookies or signed media URLs.
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { XhsBrowser } from '../desktop/profile-browser.js';
import { ensureNoteDirectory, downloadMedia, verifyFile } from '../desktop/media-download.js';

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error('Pass an absolute downloader userData directory.');
app.setPath('userData', directory);
const timer = setTimeout(() => app.exit(1), 120000);
app.whenReady().then(async () => {
  const browser = new XhsBrowser({ BrowserWindow, session });
  try {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'profile-jobs/profile-job.json'), 'utf8'));
    const note = process.argv[3] ? state.items[Number(process.argv[3])] : state.items.find(item => item.status === 'failed') || state.items[0];
    if (!note) throw new Error('No saved note to inspect.');
    const parsed = await browser.resolveNote(note);
    console.log(JSON.stringify({ noteId: note.id, title: parsed.title,
      strategy: parsed.strategy, images: parsed.images.length, videos: parsed.videos.length, live: parsed.images.filter(image => image.livePhoto).length, paired: parsed.images.filter(image => image.liveVideo).length }));
    const output = process.argv[4];
    if (output) {
      if (!path.isAbsolute(output)) throw new Error('Sample output must be absolute.');
      const root = await fs.promises.realpath(output);
      const target = await ensureNoteDirectory(root, `媒体验收样本-${note.id}`);
      const live = parsed.images.find(image => image.liveVideo)?.liveVideo;
      const video = parsed.videos.find(video => video.isDefault) || parsed.videos[0];
      for (const [key, media] of [['live', live], ['video', video]]) {
        if (!media) continue;
        const file = await downloadMedia({root, directory: target, asset: {key,kind:'video',url:media.url},
          fetchImpl: globalThis.fetch, beforeRequest: () => new Promise(resolve => setTimeout(resolve, 10000))});
        console.log(JSON.stringify({sample:file.name, bytes:file.bytes, verified:await verifyFile(root,target,file)}));
      }
    }
  } catch (error) {
    console.error(error.name, error.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    browser.close();
    app.quit();
  }
});
