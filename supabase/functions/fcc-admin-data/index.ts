import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ['https://supplies.barnabastools.com', 'https://supplies.farragutcc.com'];

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { token } = await req.json();

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Verify token
    const { data: session, error: sessErr } = await sb
      .from('admin_sessions')
      .select('expires_at, church_id')
      .eq('token', token)
      .single();

    if (sessErr || !session || new Date(session.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: jsonHeaders });
    }

    // Fetch reports scoped to church
    const { data, error } = await sb
      .from('church_reports')
      .select('*')
      .eq('church_id', session.church_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return new Response(JSON.stringify(data || []), { headers: jsonHeaders });
  } catch (e) {
    console.error('Admin data error:', e);
    return new Response(JSON.stringify({ error: 'Failed to fetch reports.' }), { status: 500, headers: jsonHeaders });
  }
});
