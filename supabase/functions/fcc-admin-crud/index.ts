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

async function verifyToken(sb: SB, token: string): Promise<{ valid: boolean; church_id?: string; email?: string }> {
  if (!token || typeof token !== 'string') return { valid: false };
  const { data, error } = await sb
    .from('admin_sessions')
    .select('expires_at, email, church_id')
    .eq('token', token)
    .single();
  if (error || !data) return { valid: false };
  if (new Date(data.expires_at) < new Date()) return { valid: false };
  return { valid: true, church_id: data.church_id, email: data.email };
}

async function listLocations(sb: SB, church_id: string) {
  const { data, error } = await sb.from('locations').select('*').eq('church_id', church_id).order('name');
  if (error) throw error;
  return data || [];
}

const RESERVED_SLUGS = ['admin', 'superadmin', 'login', 'logout', 'settings', 'billing', 'signup', 'help', 'support', 'demo'];

async function saveLocation(sb: SB, church_id: string, payload: any) {
  const { editId, location_id, name, items, active } = payload;
  if (!name || typeof name !== 'string') throw new Error('Name is required');
  if (editId) {
    const { error } = await sb.from('locations').update({ name, items: items || [], active: active !== false }).eq('id', editId).eq('church_id', church_id);
    if (error) throw error;
    return { success: true };
  } else {
    if (!location_id || typeof location_id !== 'string') throw new Error('Location ID is required');
    const cleanId = location_id.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 100);
    if (RESERVED_SLUGS.includes(cleanId.toLowerCase())) throw new Error(`"${cleanId}" is a reserved word and cannot be used as a room ID.`);
    const { data, error } = await sb.from('locations').insert({ church_id, location_id: cleanId, name, items: items || [], active: active !== false }).select().single();
    if (error) throw error;
    return data;
  }
}

async function toggleLocationActive(sb: SB, church_id: string, payload: any) {
  const { id, active } = payload;
  if (!id) throw new Error('ID is required');
  const { error } = await sb.from('locations').update({ active }).eq('id', id).eq('church_id', church_id);
  if (error) throw error;
  return { success: true };
}

async function deleteLocation(sb: SB, church_id: string, payload: any) {
  const { id } = payload;
  if (!id) throw new Error('ID is required');
  const { error } = await sb.from('locations').delete().eq('id', id).eq('church_id', church_id);
  if (error) throw error;
  return { success: true };
}

async function listTemplates(sb: SB, church_id: string) {
  const { data, error } = await sb.from('item_templates').select('*').eq('church_id', church_id).order('name');
  if (error) throw error;
  return data || [];
}

async function saveTemplate(sb: SB, church_id: string, payload: any) {
  const { editId, name, items } = payload;
  if (!name || typeof name !== 'string') throw new Error('Name is required');
  if (editId) {
    const { error } = await sb.from('item_templates').update({ name, items: items || [] }).eq('id', editId).eq('church_id', church_id);
    if (error) throw error;
    return { success: true };
  } else {
    const { data, error } = await sb.from('item_templates').insert({ church_id, name, items: items || [] }).select().single();
    if (error) throw error;
    return data;
  }
}

async function deleteTemplate(sb: SB, church_id: string, payload: any) {
  const { id } = payload;
  if (!id) throw new Error('ID is required');
  const { error } = await sb.from('item_templates').delete().eq('id', id).eq('church_id', church_id);
  if (error) throw error;
  return { success: true };
}

async function listUsers(sb: SB, church_id: string) {
  const { data, error } = await sb.from('admin_users').select('*').eq('church_id', church_id).order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addUser(sb: SB, church_id: string, payload: any) {
  const { name, email } = payload;
  if (!name || !email) throw new Error('Name and email are required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email format');
  const { data, error } = await sb.from('admin_users').insert({ church_id, name, email: email.trim().toLowerCase() }).select().single();
  if (error) throw error;
  return data;
}

async function removeUser(sb: SB, church_id: string, payload: any) {
  const { id } = payload;
  if (!id) throw new Error('ID is required');
  const { error } = await sb.from('admin_users').delete().eq('id', id).eq('church_id', church_id);
  if (error) throw error;
  return { success: true };
}

async function getSettings(sb: SB, church_id: string) {
  const { data, error } = await sb.from('app_settings').select('*').eq('key', 'email_recipients').eq('church_id', church_id).maybeSingle();
  if (error) throw error;
  return data;
}

async function saveSettings(sb: SB, church_id: string, payload: any) {
  const { recipients } = payload;
  if (!Array.isArray(recipients)) throw new Error('Recipients must be an array');
  // Upsert church-specific setting
  const { data: existing } = await sb.from('app_settings').select('id').eq('key', 'email_recipients').eq('church_id', church_id).maybeSingle();
  if (existing) {
    const { error } = await sb.from('app_settings').update({ value: recipients, updated_at: new Date().toISOString() }).eq('key', 'email_recipients').eq('church_id', church_id);
    if (error) throw error;
  } else {
    const { error } = await sb.from('app_settings').insert({ key: 'email_recipients', value: recipients, church_id, updated_at: new Date().toISOString() });
    if (error) throw error;
  }
  return { success: true };
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

    const session = await verifyToken(sb, token);
    if (!session.valid) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: jsonHeaders });
    }

    const church_id = session.church_id!;

    let result: any;
    switch (action) {
      case 'list-locations': result = await listLocations(sb, church_id); break;
      case 'save-location': result = await saveLocation(sb, church_id, payload); break;
      case 'toggle-location-active': result = await toggleLocationActive(sb, church_id, payload); break;
      case 'delete-location': result = await deleteLocation(sb, church_id, payload); break;
      case 'list-templates': result = await listTemplates(sb, church_id); break;
      case 'save-template': result = await saveTemplate(sb, church_id, payload); break;
      case 'delete-template': result = await deleteTemplate(sb, church_id, payload); break;
      case 'list-users': result = await listUsers(sb, church_id); break;
      case 'add-user': result = await addUser(sb, church_id, payload); break;
      case 'remove-user': result = await removeUser(sb, church_id, payload); break;
      case 'get-settings': result = await getSettings(sb, church_id); break;
      case 'save-settings': result = await saveSettings(sb, church_id, payload); break;
      default:
        return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: jsonHeaders });
    }

    return new Response(JSON.stringify(result), { headers: jsonHeaders });
  } catch (e: any) {
    console.error('Admin CRUD error:', e);
    const msg = e.message?.includes('duplicate key') ? 'That entry already exists.' : 'Operation failed. Please try again.';
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: jsonHeaders });
  }
});
