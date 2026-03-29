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

type SB = ReturnType<typeof createClient>;

async function verifySuperAdmin(sb: SB, token: string): Promise<{ valid: boolean; email?: string }> {
  if (!token || typeof token !== 'string') return { valid: false };
  const { data: session, error: sessErr } = await sb
    .from('admin_sessions')
    .select('expires_at, email')
    .eq('token', token)
    .single();
  if (sessErr || !session || new Date(session.expires_at) < new Date()) return { valid: false };
  const { data: user, error: userErr } = await sb
    .from('admin_users')
    .select('is_super_admin')
    .eq('email', session.email)
    .single();
  if (userErr || !user || !user.is_super_admin) return { valid: false };
  return { valid: true, email: session.email };
}

async function dashboardStats(sb: SB) {
  const { count: churchCount } = await sb.from('churches').select('*', { count: 'exact', head: true });
  const { count: activeChurches } = await sb.from('churches').select('*', { count: 'exact', head: true }).eq('status', 'active');
  const { count: reportCount } = await sb.from('church_reports').select('*', { count: 'exact', head: true });
  const { count: openReports } = await sb.from('church_reports').select('*', { count: 'exact', head: true }).eq('status', 'open');
  const { count: userCount } = await sb.from('admin_users').select('*', { count: 'exact', head: true });
  return {
    churches: { total: churchCount || 0, active: activeChurches || 0 },
    reports: { total: reportCount || 0, open: openReports || 0 },
    users: userCount || 0,
  };
}

async function listChurches(sb: SB) {
  const { data, error } = await sb.from('churches').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  // Get report and user counts per church
  const churches = data || [];
  for (const c of churches) {
    const { count: reports } = await sb.from('church_reports').select('*', { count: 'exact', head: true }).eq('church_id', c.id);
    const { count: users } = await sb.from('admin_users').select('*', { count: 'exact', head: true }).eq('church_id', c.id);
    const { count: locations } = await sb.from('locations').select('*', { count: 'exact', head: true }).eq('church_id', c.id);
    c.report_count = reports || 0;
    c.user_count = users || 0;
    c.location_count = locations || 0;
  }
  return churches;
}

async function addChurch(sb: SB, payload: any) {
  const { name, slug } = payload;
  if (!name || !slug) throw new Error('Name and slug are required');
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 100);
  if (!cleanSlug) throw new Error('Invalid slug');
  const { data, error } = await sb.from('churches').insert({ name, slug: cleanSlug, status: 'active' }).select().single();
  if (error) throw error;
  return data;
}

async function editChurch(sb: SB, payload: any) {
  const { id, name, slug, status } = payload;
  if (!id) throw new Error('Church ID is required');
  const updates: any = {};
  if (name) updates.name = name;
  if (slug) updates.slug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 100);
  if (status) updates.status = status;
  const { error } = await sb.from('churches').update(updates).eq('id', id);
  if (error) throw error;
  return { success: true };
}

async function toggleChurch(sb: SB, payload: any) {
  const { id, status } = payload;
  if (!id) throw new Error('Church ID is required');
  const { error } = await sb.from('churches').update({ status }).eq('id', id);
  if (error) throw error;
  return { success: true };
}

async function listAllReports(sb: SB) {
  const { data, error } = await sb
    .from('church_reports')
    .select('*, churches(name, slug)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

async function listAllUsers(sb: SB) {
  const { data, error } = await sb
    .from('admin_users')
    .select('*, churches(name, slug)')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const body = await req.json();
    const { action, token, ...payload } = body;

    if (!action || typeof action !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: jsonHeaders });
    }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const auth = await verifySuperAdmin(sb, token);
    if (!auth.valid) {
      return new Response(JSON.stringify({ error: 'Unauthorized — super admin access required' }), { status: 401, headers: jsonHeaders });
    }

    let result: any;
    switch (action) {
      case 'dashboard-stats': result = await dashboardStats(sb); break;
      case 'list-churches': result = await listChurches(sb); break;
      case 'add-church': result = await addChurch(sb, payload); break;
      case 'edit-church': result = await editChurch(sb, payload); break;
      case 'toggle-church': result = await toggleChurch(sb, payload); break;
      case 'list-all-reports': result = await listAllReports(sb); break;
      case 'list-all-users': result = await listAllUsers(sb); break;
      default:
        return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: jsonHeaders });
    }

    return new Response(JSON.stringify(result), { headers: jsonHeaders });
  } catch (e: any) {
    console.error('Superadmin error:', e);
    const msg = e.message?.includes('duplicate key') ? 'That entry already exists.' : (e.message || 'Operation failed.');
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: jsonHeaders });
  }
});
