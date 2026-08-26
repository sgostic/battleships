import { storeKind } from '@/lib/net/store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — reports which backing store online play is using, so a
 * misconfigured deployment is obvious before two people try to play on it.
 */
export async function GET() {
  const store = storeKind();
  return Response.json(
    {
      store,
      online: store !== 'missing',
      hint:
        store === 'redis'
          ? null
          : store === 'memory'
            ? 'In-memory store: fine for local dev, but rooms are not shared between deployed instances.'
            : 'No Redis credentials. Run `vercel integration add upstash/upstash-kv` then `vercel env pull`.',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
