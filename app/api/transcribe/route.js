// Transcribes one audio chunk. Uses Groq if GROQ_API_KEY is set, else OpenAI.
// Vercel request bodies are limited to ~4.5MB, so the browser sends small chunks.
export const maxDuration = 60;

export async function POST(req) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const offset = Number(form.get('offset') || 0);

    if (!file) {
      return Response.json({ error: 'No audio file received' }, { status: 400 });
    }

    const groq = process.env.GROQ_API_KEY;
    const openai = process.env.OPENAI_API_KEY;
    if (!groq && !openai) {
      return Response.json(
        { error: 'Set GROQ_API_KEY or OPENAI_API_KEY in your Vercel environment variables.' },
        { status: 500 }
      );
    }

    const url = groq
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';
    const model = groq ? 'whisper-large-v3-turbo' : 'whisper-1';

    const fd = new FormData();
    fd.append('file', file, 'chunk.mp3');
    fd.append('model', model);
    fd.append('response_format', 'verbose_json');

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groq || openai}` },
      body: fd,
    });

    if (!res.ok) {
      const text = await res.text();
      return Response.json({ error: `Transcription failed: ${text}` }, { status: 502 });
    }

    const data = await res.json();
    const segments = (data.segments || []).map((s) => ({
      start: Number((s.start + offset).toFixed(2)),
      end: Number((s.end + offset).toFixed(2)),
      text: String(s.text || '').trim(),
    }));

    return Response.json({ segments });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
