// Sends the transcript to Groq (free) and gets back the best clip ranges as JSON.
export const maxDuration = 60;

function buildTranscript(segments) {
  const lines = [];
  let cur = null;
  for (const s of segments) {
    if (!cur) cur = { start: s.start, end: s.end, text: s.text };
    else {
      cur.end = s.end;
      cur.text += ' ' + s.text;
    }
    if (cur.end - cur.start >= 10) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `[${l.start.toFixed(1)}-${l.end.toFixed(1)}] ${l.text}`).join('\n');
}

export async function POST(req) {
  try {
    const key = process.env.GROQ_API_KEY;
    if (!key) {
      return Response.json(
        { error: 'Set GROQ_API_KEY in your Vercel environment variables.' },
        { status: 500 }
      );
    }

    const { segments, count = 5, minLen = 20, maxLen = 60, duration } = await req.json();
    if (!Array.isArray(segments) || segments.length === 0) {
      return Response.json({ error: 'No transcript segments provided' }, { status: 400 });
    }

    // Groq's free tier has a small size limit, so keep the transcript short.
    const transcript = buildTranscript(segments).slice(0, 28000);

    const prompt = `You pick the best short-form clips (TikTok / Reels / Shorts) from a video transcript.

Transcript lines look like [startSeconds-endSeconds] text.
Video length: ${duration ? Math.round(duration) + ' seconds' : 'unknown'}.

Choose up to ${count} clips. Rules:
- Each clip is between ${minLen} and ${maxLen} seconds long.
- Each clip starts at the beginning of a sentence/thought and ends at a natural stopping point.
- Prefer strong hooks, surprising or emotional moments, clear advice, stories, or punchlines.
- Clips must not overlap.
- Use start/end times that exist in or near the transcript timestamps.

Return ONLY a JSON object like:
{"clips": [{"start": 12.5, "end": 47.0, "title": "Short catchy title", "reason": "One sentence on why this works"}]}

Transcript:
${transcript}`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return Response.json({ error: `Groq request failed: ${text}` }, { status: 502 });
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return Response.json({ error: 'Could not read clip suggestions.' }, { status: 502 });
    }

    let clips = Array.isArray(parsed) ? parsed : parsed.clips;
    if (!Array.isArray(clips)) {
      return Response.json({ error: 'Could not read clip suggestions.' }, { status: 502 });
    }

    clips = clips
      .map((c) => ({
        start: Number(c.start),
        end: Number(c.end),
        title: String(c.title || 'Clip'),
        reason: String(c.reason || ''),
      }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
      .map((c) => (duration ? { ...c, end: Math.min(c.end, duration) } : c));

    return Response.json({ clips });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
      }
