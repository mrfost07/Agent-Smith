/** Extract final answer text from Antigravity JSON and SSE responses. */
export function readAntigravityResponse(body: string): string {
  const output: string[] = [];
  const collect = (event: any): void => {
    if (Array.isArray(event)) {
      event.forEach(collect);
      return;
    }
    const response = event?.response ?? event;
    if (response?.error) throw new Error(response.error.message || 'Antigravity returned an error.');
    for (const part of response?.candidates?.[0]?.content?.parts ?? []) {
      if (part.thought !== true && typeof part.text === 'string') output.push(part.text);
    }
  };
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    collect(JSON.parse(trimmed));
  } else {
    let data: string[] = [];
    const flush = () => {
      const payload = data.join('\n').trim();
      data = [];
      if (payload && payload !== '[DONE]') collect(JSON.parse(payload));
    };
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) flush();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    flush();
  }
  return output.join('');
}
