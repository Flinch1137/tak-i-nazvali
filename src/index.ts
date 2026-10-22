import { handle } from './community';
import type { Env } from './types';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) return handle(request, env);
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
