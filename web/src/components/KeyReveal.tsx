import { Check, Copy, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, Tabs } from './ui';

function CopyBox({ text, mono = true }: { text: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className={`overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 pr-12 text-[12.5px] ${mono ? 'font-mono' : ''}`}>{text}</pre>
      <button
        className="absolute right-2 top-2 rounded-md border border-border bg-surface p-1.5 text-muted hover:text-fg"
        aria-label="Copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } catch {
            /* clipboard blocked */
          }
        }}
      >
        {done ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/** Shown once after creating / regenerating a gateway key. */
export function KeyReveal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const base = `${location.protocol}//${location.hostname}:${location.port || '80'}/v1`;
  const [tab, setTab] = useState<'curl' | 'python' | 'node'>('curl');
  const snippets = {
    curl: `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "YOUR-ALIAS-OR-MODEL", "messages": [{"role": "user", "content": "Hello"}]}'`,
    python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}", api_key="${secret}")\nr = client.chat.completions.create(\n    model="YOUR-ALIAS-OR-MODEL",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(r.choices[0].message.content)`,
    node: `import OpenAI from 'openai';\n\nconst client = new OpenAI({ baseURL: '${base}', apiKey: '${secret}' });\nconst r = await client.chat.completions.create({\n  model: 'YOUR-ALIAS-OR-MODEL',\n  messages: [{ role: 'user', content: 'Hello' }],\n});\nconsole.log(r.choices[0].message.content);`,
  };
  return (
    <Dialog open wide onClose={onClose} title="Your gateway key" footer={<Button variant="primary" onClick={onClose}>I've saved it</Button>}>
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <span>Copy it now — it is stored only as a hash and can't be shown again. You can regenerate it later.</span>
        </div>
        <CopyBox text={secret} />
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-medium">Use it with any OpenAI SDK</span>
            <Tabs value={tab} onChange={setTab} options={[{ value: 'curl', label: 'curl' }, { value: 'python', label: 'Python' }, { value: 'node', label: 'Node' }]} />
          </div>
          <CopyBox text={snippets[tab]} />
        </div>
      </div>
    </Dialog>
  );
}
