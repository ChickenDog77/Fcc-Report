import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ['https://supplies.barnabastools.com', 'https://barnabastools.com', 'https://www.barnabastools.com'];

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESERVED_SLUGS = ['admin', 'superadmin', 'login', 'logout', 'settings', 'billing', 'signup', 'help', 'support', 'demo'];

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { church_name, admin_name, admin_email } = await req.json();

    // Validate inputs
    if (!church_name || typeof church_name !== 'string' || church_name.trim().length < 2 || church_name.trim().length > 100) {
      return new Response(JSON.stringify({ error: 'Church name must be 2-100 characters.' }), { status: 400, headers: jsonHeaders });
    }
    if (!admin_name || typeof admin_name !== 'string' || admin_name.trim().length < 2 || admin_name.trim().length > 100) {
      return new Response(JSON.stringify({ error: 'Your name must be 2-100 characters.' }), { status: 400, headers: jsonHeaders });
    }
    if (!admin_email || typeof admin_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email.trim())) {
      return new Response(JSON.stringify({ error: 'Please enter a valid email address.' }), { status: 400, headers: jsonHeaders });
    }

    const cleanName = church_name.trim();
    const cleanAdminName = admin_name.trim();
    const cleanEmail = admin_email.trim().toLowerCase();

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Check if email already exists
    const { data: existingUser } = await sb.from('admin_users').select('id').eq('email', cleanEmail).maybeSingle();
    if (existingUser) {
      return new Response(JSON.stringify({ error: 'That email already has an account. Use the login link to sign in.' }), { status: 409, headers: jsonHeaders });
    }

    // Rate limit: max 10 new churches per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await sb.from('churches').select('id', { count: 'exact', head: true }).gte('created_at', oneHourAgo);
    if (count !== null && count >= 10) {
      return new Response(JSON.stringify({ error: 'Too many signups right now. Please try again in an hour.' }), { status: 429, headers: jsonHeaders });
    }

    // Generate slug
    let slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
    if (!slug) slug = 'church';
    if (RESERVED_SLUGS.includes(slug)) slug = slug + '-' + Math.random().toString(36).substring(2, 6);

    // Check slug collision
    const { data: existingChurch } = await sb.from('churches').select('id').eq('slug', slug).maybeSingle();
    if (existingChurch) {
      slug = slug + '-' + Math.random().toString(36).substring(2, 6);
    }

    // Create church
    const { data: church, error: churchErr } = await sb.from('churches')
      .insert({ name: cleanName, slug, admin_email: cleanEmail, admin_name: cleanAdminName, status: 'active' })
      .select().single();
    if (churchErr) throw churchErr;

    // Create admin user
    const { error: userErr } = await sb.from('admin_users')
      .insert({ church_id: church.id, name: cleanAdminName, email: cleanEmail });
    if (userErr) throw userErr;

    // Create session (30-day expiry)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    const { data: session, error: sessErr } = await sb.from('admin_sessions')
      .insert({ email: cleanEmail, name: cleanAdminName, church_id: church.id, expires_at: expiresAt.toISOString() })
      .select().single();
    if (sessErr) throw sessErr;

    // Create starter location
    await sb.from('locations').insert({
      church_id: church.id, location_id: 'main-building', name: 'Main Building',
      items: ['Paper towels', 'Hand soap', 'Toilet paper', 'Trash bags'], active: true,
    });

    // Create starter template
    await sb.from('item_templates').insert({
      church_id: church.id, name: 'Bathroom Supplies',
      items: ['Paper towels', 'Hand soap', 'Toilet paper', 'Air freshener'],
    });

    // Set email recipients
    await sb.from('app_settings').insert({
      key: 'email_recipients', value: [cleanEmail], church_id: church.id, updated_at: new Date().toISOString(),
    });

    // Send magic link email
    const magicLink = `https://supplies.barnabastools.com/${slug}/admin?token=${session.token}`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Barnabas Tools <support@barnabastools.com>',
        to: [cleanEmail],
        subject: `Welcome to Barnabas Tools — ${cleanName}`,
        html: `
          <div style="font-family:'DM Sans',sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#1a2751;padding:24px 32px;border-radius:16px 16px 0 0;border-bottom:3px solid #28c8f0;text-align:center;">
              <h1 style="color:white;margin:0;font-size:22px;">Welcome to Barnabas Tools</h1>
            </div>
            <div style="background:white;padding:32px;border-radius:0 0 16px 16px;border:1px solid #e2e8f0;border-top:none;">
              <p style="color:#1a2751;font-size:16px;">Hi ${escHtml(cleanAdminName)},</p>
              <p style="color:#6b7280;font-size:15px;">Your supply reporting system for <strong>${escHtml(cleanName)}</strong> is ready! Click below to set up your dashboard:</p>
              <p style="text-align:center;margin:28px 0;">
                <a href="${magicLink}" style="background:#1a2751;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">Open Your Dashboard</a>
              </p>
              <div style="background:#f8f9fc;border-radius:10px;padding:16px 20px;margin:20px 0;">
                <p style="margin:0 0 8px;color:#1a2751;font-weight:600;font-size:14px;">Quick Start:</p>
                <ol style="margin:0;padding-left:20px;color:#6b7280;font-size:14px;">
                  <li>Click the link above to open your admin dashboard</li>
                  <li>Add your rooms/locations and the supplies to track</li>
                  <li>Print or share the QR codes for each room</li>
                  <li>When someone scans a QR code, you get an email report</li>
                </ol>
              </div>
              <p style="color:#9ca3af;font-size:13px;text-align:center;">This link expires in 30 days. Need a new one? Just visit barnabastools.com and click "Send me a login link".</p>
            </div>
          </div>
        `,
      }),
    });

    return new Response(JSON.stringify({ success: true }), { headers: jsonHeaders });
  } catch (e: any) {
    console.error('Signup error:', e);
    const msg = e.message?.includes('duplicate key') ? 'That entry already exists. Try logging in instead.' : 'Something went wrong. Please try again.';
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: jsonHeaders });
  }
});
