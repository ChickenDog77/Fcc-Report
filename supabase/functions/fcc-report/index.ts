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

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { church_slug, location_id, location_name, items_needed, notes } = await req.json();

    if (!church_slug || typeof church_slug !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid church_slug' }), { status: 400, headers: jsonHeaders });
    }
    if (!location_id || typeof location_id !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid location_id' }), { status: 400, headers: jsonHeaders });
    }
    if (!location_name || typeof location_name !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid location_name' }), { status: 400, headers: jsonHeaders });
    }
    if (!Array.isArray(items_needed) || items_needed.length === 0 || items_needed.length > 50) {
      return new Response(JSON.stringify({ error: 'items_needed must be a non-empty array (max 50)' }), { status: 400, headers: jsonHeaders });
    }
    if (!items_needed.every((i: unknown) => typeof i === 'string' && i.length <= 200)) {
      return new Response(JSON.stringify({ error: 'Each item must be a string (max 200 chars)' }), { status: 400, headers: jsonHeaders });
    }
    if (notes && (typeof notes !== 'string' || notes.length > 500)) {
      return new Response(JSON.stringify({ error: 'Notes must be a string (max 500 chars)' }), { status: 400, headers: jsonHeaders });
    }

    const cleanSlug = church_slug.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 100);
    const cleanLocationId = location_id.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 100);
    const cleanLocationName = location_name.substring(0, 200);
    const cleanNotes = notes ? notes.replace(/<[^>]*>/g, '').substring(0, 500) : null;

    const sb = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: church, error: churchErr } = await sb
      .from('churches')
      .select('id, name, slug')
      .eq('slug', cleanSlug)
      .eq('status', 'active')
      .single();

    if (churchErr || !church) {
      return new Response(JSON.stringify({ error: 'Church not found' }), { status: 404, headers: jsonHeaders });
    }

    const { data: report, error: insertErr } = await sb
      .from('church_reports')
      .insert({
        church_id: church.id,
        location_id: cleanLocationId,
        location_name: cleanLocationName,
        items_needed,
        notes: cleanNotes,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Skip email for demo church
    if (church.slug === 'demo') {
      return new Response(JSON.stringify({ success: true, report }), { headers: jsonHeaders });
    }

    // Get recipients
    const { data: settings } = await sb
      .from('app_settings')
      .select('value')
      .eq('key', 'email_recipients')
      .eq('church_id', church.id)
      .maybeSingle();

    let allRecipients: string[] = Array.isArray(settings?.value) ? settings.value : [];

    if (allRecipients.length === 0) {
      return new Response(JSON.stringify({ success: true, report }), { headers: jsonHeaders });
    }

    const resolveUrl = `${SUPABASE_URL}/functions/v1/fcc-resolve?id=${report.id}`;
    const safeName = escHtml(cleanLocationName);
    const itemsList = items_needed.map((i: string) => `<li style="padding:4px 0;color:#1a2751;">${escHtml(i)}</li>`).join('');
    const notesSection = cleanNotes
      ? `<div style="background:#e0f7fd;border-left:3px solid #28c8f0;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;">
           <p style="margin:0;color:#1a2751;font-style:italic;">${escHtml(cleanNotes)}</p>
         </div>`
      : '';
    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });

    const html = `
      <div style="font-family:'DM Sans',sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1a2751;padding:24px 32px;border-radius:16px 16px 0 0;border-bottom:3px solid #28c8f0;text-align:center;">
          <h1 style="color:white;margin:0;font-size:20px;">Supply Report — ${escHtml(church.name)}</h1>
        </div>
        <div style="background:white;padding:32px;border-radius:0 0 16px 16px;border:1px solid #e2e8f0;border-top:none;">
          <div style="background:#f8f9fc;border-radius:10px;padding:20px;margin-bottom:20px;">
            <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Location</p>
            <p style="margin:0;color:#1a2751;font-size:18px;font-weight:600;">${safeName}</p>
          </div>
          <p style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">Items Needed</p>
          <ul style="margin:0 0 16px;padding-left:20px;">${itemsList}</ul>
          ${notesSection}
          <p style="color:#9ca3af;font-size:13px;margin:16px 0 24px;">Submitted: ${timestamp} ET</p>
          <p style="text-align:center;">
            <a href="${resolveUrl}" style="background:#1a2751;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">Mark as Resolved</a>
          </p>
          <p style="text-align:center;margin-top:20px;">
            <a href="https://supplies.barnabastools.com/${church.slug}/admin" style="color:#28c8f0;font-size:13px;">Open Admin Dashboard</a>
          </p>
        </div>
      </div>`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Barnabas Tools <support@barnabastools.com>',
        to: allRecipients,
        subject: `Supply Report: ${cleanLocationName}`,
        html,
      }),
    });

    return new Response(JSON.stringify({ success: true, report }), { headers: jsonHeaders });
  } catch (e) {
    console.error('Report submission error:', e);
    return new Response(JSON.stringify({ error: 'Failed to submit report. Please try again.' }), { status: 500, headers: jsonHeaders });
  }
});
