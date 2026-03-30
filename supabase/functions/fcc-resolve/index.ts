import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id || typeof id !== 'string') {
    return new Response(htmlPage('Invalid Request', 'No report ID provided.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const cleanId = id.replace(/[^a-f0-9-]/gi, '').substring(0, 36);
  if (!cleanId) {
    return new Response(htmlPage('Invalid Request', 'Invalid report ID.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: report, error: fetchErr } = await sb
      .from('church_reports')
      .select('id, status, location_name')
      .eq('id', cleanId)
      .single();

    if (fetchErr || !report) {
      return new Response(htmlPage('Not Found', 'This report was not found.'), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    if (report.status === 'resolved') {
      return new Response(htmlPage('Already Resolved', `The report for <strong>${escHtml(report.location_name)}</strong> has already been resolved.`), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const { error: updateErr } = await sb
      .from('church_reports')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('id', cleanId);

    if (updateErr) throw updateErr;

    return new Response(htmlPage('Resolved!', `The supply report for <strong>${escHtml(report.location_name)}</strong> has been marked as resolved.`), {
      headers: { 'Content-Type': 'text/html' },
    });
  } catch (e) {
    console.error('Resolve error:', e);
    return new Response(htmlPage('Error', 'Something went wrong. Please try again.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    });
  }
});

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Barnabas Tools</title>
  <style>
    body { font-family: 'DM Sans', system-ui, sans-serif; background: #f1f5f9; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 440px; width: 90%; overflow: hidden; }
    .header { background: #1a2751; padding: 24px 32px; border-bottom: 3px solid #28c8f0; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 20px; }
    .body { padding: 32px; text-align: center; }
    .body p { color: #374151; font-size: 16px; line-height: 1.6; }
    .check { font-size: 48px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header"><h1>Supply Reports</h1></div>
    <div class="body">
      <div class="check">${title === 'Resolved!' ? '&#10003;' : title === 'Already Resolved' ? '&#10003;' : '&#9888;'}</div>
      <h2 style="color:#1a2751;margin:0 0 12px;">${title}</h2>
      <p>${message}</p>
    </div>
  </div>
</body>
</html>`;
}
