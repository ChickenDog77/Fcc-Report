import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ['https://supplies.barnabastools.com', 'https://supplies.farragutcc.com'];

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const church_slug = url.searchParams.get('church_slug') || '';
  const cleanSlug = church_slug.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 100);

  if (!cleanSlug) {
    return new Response(JSON.stringify({ error: 'church_slug required' }), { status: 400, headers: jsonHeaders });
  }

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: church, error: churchErr } = await sb
    .from('churches')
    .select('id')
    .eq('slug', cleanSlug)
    .eq('status', 'active')
    .single();

  if (churchErr || !church) {
    return new Response(JSON.stringify({ error: 'Church not found' }), { status: 404, headers: jsonHeaders });
  }

  const { data, error } = await sb
    .from('locations')
    .select('location_id, name, items, active')
    .eq('church_id', church.id)
    .eq('active', true)
    .order('name');

  if (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch locations' }), { status: 500, headers: jsonHeaders });
  }

  return new Response(JSON.stringify(data || []), { headers: jsonHeaders });
});
