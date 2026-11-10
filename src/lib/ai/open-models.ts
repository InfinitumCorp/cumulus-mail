/**
 * Open-weight model access for Cumulus://Mail, with instant automatic switching.
 *
 * Hosts are tried in order: OmniRoute (model "auto" unless OMNIROUTE_MODEL is set),
 * then Cloudflare Workers AI and Groq open models when their credentials are set.
 * An error, timeout or empty reply moves straight to the next host. A host that
 * hasn't answered within `hedgeMs` is raced against the next one, and the first
 * good answer wins.
 *
 * This mirrors @infinitum/ai in infinitum-nexus, kept dependency-free here.
 */

export interface Host {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

type Env = Record<string, string | undefined>;

export function hostsFromEnv(env: Env = process.env): Host[] {
  const hosts: Host[] = [];
  if (env.OMNIROUTE_API_KEY || env.OMNIROUTE_URL) {
    hosts.push({ name: "omniroute", baseUrl: env.OMNIROUTE_URL ?? "http://localhost:20128/v1", model: env.OMNIROUTE_MODEL ?? "auto", apiKey: env.OMNIROUTE_API_KEY });
  }
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN) {
    hosts.push({ name: "workers-ai", baseUrl: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`, model: "@cf/openai/gpt-oss-20b", apiKey: env.CLOUDFLARE_AI_TOKEN });
  }
  if (env.GROQ_API_KEY) hosts.push({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-20b", apiKey: env.GROQ_API_KEY });
  return hosts;
}

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  hedgeMs?: number;
  fetchImpl?: typeof fetch;
}

export class NoModelHost extends Error {}

/** One chat completion from the first host that answers well. */
export async function completeOpen(hosts: Host[], system: string, user: string, opts: CompleteOptions = {}): Promise<{ text: string; host: string }> {
  if (!hosts.length) throw new NoModelHost("No model host is configured.");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const hedgeMs = opts.hedgeMs ?? 4_000;
  const errors: string[] = [];

  return new Promise((resolve, reject) => {
    let next = 0;
    let inflight = 0;
    let done = false;
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const running = new Set<AbortController>();

    const launch = () => {
      if (done) return;
      clearTimeout(hedge);
      if (next >= hosts.length) {
        if (inflight === 0) {
          done = true;
          reject(new Error(`Every model host failed: ${errors.join("; ")}`));
        }
        return;
      }
      const host = hosts[next++]!;
      const ac = new AbortController();
      running.add(ac);
      inflight++;
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      if (hedgeMs > 0 && next < hosts.length) hedge = setTimeout(launch, hedgeMs);

      call(host)
        .then((text) => {
          if (done) return;
          done = true;
          clearTimeout(hedge);
          for (const other of running) if (other !== ac) other.abort();
          resolve({ text, host: host.name });
        })
        .catch((err: Error) => {
          if (done) return;
          errors.push(`${host.name}: ${err.message}`);
          launch();
        })
        .finally(() => {
          clearTimeout(timer);
          running.delete(ac);
          inflight--;
          if (!done && next >= hosts.length && inflight === 0) launch();
        });

      async function call(h: Host): Promise<string> {
        let res: Response;
        try {
          res = await fetchImpl(`${h.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(h.apiKey ? { Authorization: `Bearer ${h.apiKey}` } : {}) },
            body: JSON.stringify({
              model: h.model,
              max_tokens: opts.maxTokens ?? 400,
              temperature: opts.temperature ?? 0.3,
              messages: [{ role: "system", content: system }, { role: "user", content: user }],
            }),
            signal: ac.signal,
          });
        } catch (err) {
          throw new Error(ac.signal.aborted ? "timed out" : (err as Error).message);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string | null } }[] } | null;
        const text = (body?.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (!text) throw new Error("empty reply");
        return text;
      }
    };
    launch();
  });
}
