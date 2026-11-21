'use client';

import { useRef, useState } from 'react';

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function Home() {
  const ffmpegRef = useRef(null);
  const [file, setFile] = useState(null);
  const [count, setCount] = useState(5);
  const [minLen, setMinLen] = useState(20);
  const [maxLen, setMaxLen] = useState(60);
  const [vertical, setVertical] = useState(false);
  const [precise, setPrecise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [clips, setClips] = useState([]);

  async function getFFmpeg() {
    if (ffmpegRef.current) return ffmpegRef.current;
    setStatus('Loading video engine (first time only)...');
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ff = new FFmpeg();
    ff.on('progress', ({ progress: p }) => {
      if (p >= 0 && p <= 1) setProgress(p);
    });
    await ff.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegRef.current = ff;
    return ff;
  }

  function getDuration(f) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        resolve(v.duration);
        URL.revokeObjectURL(v.src);
      };
      v.onerror = () => resolve(0);
      v.src = URL.createObjectURL(f);
    });
  }

  async function run() {
    if (!file) return;
    setBusy(true);
    setError('');
    setClips([]);
    setProgress(0);

    try {
      const { fetchFile } = await import('@ffmpeg/util');
      const ff = await getFFmpeg();
      const duration = await getDuration(file);

      // 1. Load the video into the in-browser engine.
      setStatus('Reading your video...');
      const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
      const inputName = `input.${ext}`;
      await ff.writeFile(inputName, await fetchFile(file));

      // 2. Extract small mono audio chunks (10 min each) for transcription.
      setStatus('Extracting audio...');
      setProgress(0);
      await ff.exec([
        '-i', inputName,
        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
        '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1',
        'chunk%03d.mp3',
      ]);

      const entries = await ff.listDir('/');
      const chunkNames = entries
        .filter((e) => !e.isDir && /^chunk\d+\.mp3$/.test(e.name))
        .map((e) => e.name)
        .sort();
      if (chunkNames.length === 0) throw new Error('Could not extract audio from this video.');

      // 3. Transcribe each chunk.
      const segments = [];
      for (let i = 0; i < chunkNames.length; i++) {
        setStatus(`Transcribing part ${i + 1} of ${chunkNames.length}...`);
        setProgress((i / chunkNames.length));
        const data = await ff.readFile(chunkNames[i]);
        const body = new FormData();
        body.append('file', new Blob([data], { type: 'audio/mpeg' }), chunkNames[i]);
        body.append('offset', String(i * 600));
        const res = await fetch('/api/transcribe', { method: 'POST', body });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Transcription failed');
        segments.push(...json.segments);
        await ff.deleteFile(chunkNames[i]);
      }
      if (segments.length === 0) throw new Error('No speech found in this video.');

      // 4. Ask the AI for the best moments.
      setStatus('Finding the best moments...');
      setProgress(0);
      const hRes = await fetch('/api/highlights', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ segments, count, minLen, maxLen, duration }),
      });
      const hJson = await hRes.json();
      if (!hRes.ok) throw new Error(hJson.error || 'Could not pick clips');
      if (!hJson.clips?.length) throw new Error('The AI did not suggest any clips.');

      // 5. Cut each clip in the browser.
      const made = [];
      for (let i = 0; i < hJson.clips.length; i++) {
        const c = hJson.clips[i];
        setStatus(`Cutting clip ${i + 1} of ${hJson.clips.length}...`);
        setProgress(0);
        const out = `clip${i}.mp4`;
        const len = (c.end - c.start).toFixed(2);

        const args = ['-ss', String(c.start), '-i', inputName, '-t', len];
        if (vertical || precise) {
          if (vertical) args.push('-vf', 'crop=ih*9/16:ih,scale=720:1280');
          args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac');
        } else {
          args.push('-c', 'copy');
        }
        args.push(out);

        await ff.exec(args);
        const data = await ff.readFile(out);
        await ff.deleteFile(out);
        const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
        made.push({ ...c, url, name: `${(c.title || 'clip').replace(/[^\w]+/g, '-').slice(0, 40)}.mp4` });
        setClips([...made]);
      }

      await ff.deleteFile(inputName);
      setStatus('Done.');
      setProgress(1);
    } catch (err) {
      setError(String(err?.message || err));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>AI Video Clipper</h1>
      <p className="sub">Upload a long video. AI finds the best moments and cuts them into short clips.</p>

      <div className="card">
        <label>Video file</label>
        <input
          type="file"
          accept="video/*"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />

        <div className="row" style={{ marginTop: 12 }}>
          <div>
            <label>Number of clips</label>
            <input type="number" min="1" max="10" value={count} disabled={busy}
              onChange={(e) => setCount(Number(e.target.value))} />
          </div>
          <div>
            <label>Min seconds</label>
            <input type="number" min="5" max="120" value={minLen} disabled={busy}
              onChange={(e) => setMinLen(Number(e.target.value))} />
          </div>
          <div>
            <label>Max seconds</label>
            <input type="number" min="10" max="180" value={maxLen} disabled={busy}
              onChange={(e) => setMaxLen(Number(e.target.value))} />
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={vertical} disabled={busy}
            onChange={(e) => setVertical(e.target.checked)} />
          Vertical 9:16 (for TikTok / Reels / Shorts) — slower
        </label>
        <label className="check">
          <input type="checkbox" checked={precise} disabled={busy || vertical}
            onChange={(e) => setPrecise(e.target.checked)} />
          Precise cuts (re-encode) — slower
        </label>

        <div style={{ marginTop: 16 }}>
          <button onClick={run} disabled={!file || busy}>
            {busy ? 'Working...' : 'Make clips'}
          </button>
        </div>

        {status && (
          <div className="status">
            {status}
            <div className="bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>

      {clips.map((c, i) => (
        <div className="card clip" key={i}>
          <h3>{c.title}</h3>
          <div className="meta">{fmt(c.start)} – {fmt(c.end)} · {Math.round(c.end - c.start)}s</div>
          {c.reason && <p>{c.reason}</p>}
          <video src={c.url} controls playsInline />
          <div className="actions">
            <a href={c.url} download={c.name}><button>Download</button></a>
          </div>
        </div>
      ))}
    </main>
  );
      }
