import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ['https://supplies.barnabastools.com', 'https://admin.barnabastools.com', 'https://supplies.farragutcc.com'];

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
    if (!token || typeof token !== 'string') {
      return new Response(JSON.stringify({ valid: false }), { headers: jsonHeaders });
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: session, error } = await sb
      .from('admin_sessions')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !session) {
      return new Response(JSON.stringify({ valid: false }), { headers: jsonHeaders });
    }

    if (new Date(session.expires_at) < new Date()) {
      return new Response(JSON.stringify({ valid: false }), { headers: jsonHeaders });
    }

    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + 30);

    await sb.from('admin_sessions').update({
      expires_at: newExpiry.toISOString(),
      last_used_at: new Date().toISOString(),
    }).eq('id', session.id);

    const { data: adminUser } = await sb
      .from('admin_users')
      .select('church_id')
      .eq('email', session.email)
      .single();

    return new Response(JSON.stringify({
      valid: true,
      name: session.name,
      email: session.email,
      church_id: adminUser?.church_id || null,
    }), { headers: jsonHeaders });
  } catch (e) {
    console.error('Verify token error:', e);
    return new Response(JSON.stringify({ valid: false }), { status: 500, headers: jsonHeaders });
  }
});
