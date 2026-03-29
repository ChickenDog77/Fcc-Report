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

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { email } = await req.json();
    if (!email || typeof email !== 'string') {
      return new Response(JSON.stringify({ success: true }), { headers: jsonHeaders });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return new Response(JSON.stringify({ success: true }), { headers: jsonHeaders });
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: user, error: userErr } = await sb
      .from('admin_users')
      .select('*, churches(name, slug)')
      .eq('email', cleanEmail)
      .single();

    if (userErr || !user) {
      return new Response(JSON.stringify({ success: true }), { headers: jsonHeaders });
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const { data: session, error: sessErr } = await sb
      .from('admin_sessions')
      .insert({
        email: user.email,
        name: user.name,
        church_id: user.church_id,
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (sessErr) throw sessErr;

    const magicLink = `https://supplies.barnabastools.com/admin.html?token=${session.token}`;
    const churchName = (user.churches as any)?.name || 'Your Church';

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Barnabas Tools <support@barnabastools.com>',
        to: [cleanEmail],
        subject: `${churchName} Supply Admin — Login Link`,
        html: `
          <div style="font-family:'DM Sans',sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#1a2751;padding:24px 32px;border-radius:16px 16px 0 0;border-bottom:3px solid #28c8f0;text-align:center;">
              <h1 style="color:white;margin:0;font-size:22px;">${churchName.replace(/</g,'&lt;').replace(/>/g,'&gt;')} Supply Admin</h1>
            </div>
            <div style="background:white;padding:32px;border-radius:0 0 16px 16px;border:1px solid #e2e8f0;border-top:none;">
              <p style="color:#1a2751;font-size:16px;">Hi ${user.name.replace(/</g,'&lt;').replace(/>/g,'&gt;')},</p>
              <p style="color:#6b7280;font-size:15px;">Click the button below to access your Supply Reports dashboard:</p>
              <p style="text-align:center;margin:28px 0;">
                <a href="${magicLink}" style="background:#1a2751;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">Open Admin Dashboard</a>
              </p>
              <p style="color:#9ca3af;font-size:13px;text-align:center;">This link expires in 30 days. If you didn't request this, you can ignore this email.</p>
            </div>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      const errData = await emailRes.json();
      console.error('Resend error:', errData);
      throw new Error('Email delivery failed');
    }

    return new Response(JSON.stringify({ success: true }), { headers: jsonHeaders });
  } catch (e) {
    console.error('Magic link error:', e);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), { status: 500, headers: jsonHeaders });
  }
});
