// Edge Function: envia (ou reenvia) o e-mail de notificação de um convite de
// equipe já existente. NUNCA cria o convite — isso continua sendo feito
// exclusivamente pela RPC public.create_company_invite(), que já é a barreira
// de segurança para "quem pode convidar quem, com qual papel".
//
// Autorização: esta function não reimplementa a hierarquia owner/admin/attendant/cashier.
// Em vez disso, consulta company_invites usando um client Supabase escopado
// ao JWT de quem chamou — a mesma policy de RLS que já governa o app inteiro
// decide se o chamador pode "ver" aquele convite (só owner/admin da empresa
// do convite). Se a consulta não retornar nada, a resposta é 403: não há
// como usar esta function como um relay arbitrário de e-mail, nem para um
// endereço que não seja exatamente o do convite, nem para um convite de uma
// empresa da qual o chamador não é owner/admin, nem para um convite já
// expirado/revogado.
import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Dono(a)",
  admin: "Administrador",
  cashier: "Caixa / Balcão",
  attendant: "Atendente",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  // Importante: a checagem de autorização (abaixo) roda ANTES de checar se o
  // provedor de e-mail está configurado. A resposta para quem não tem
  // permissão deve ser sempre 403, nunca vazar um 500 de infraestrutura que
  // permitiria a alguém de fora inferir se a configuração existe ou não.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "não autenticado" }, 401);
  }

  let body: { inviteId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "corpo da requisição inválido" }, 400);
  }

  const inviteId = body.inviteId;
  if (typeof inviteId !== "string" || inviteId.length === 0) {
    return json({ error: "inviteId é obrigatório" }, 400);
  }

  // Client escopado ao usuário chamador: respeita RLS exatamente como o
  // frontend respeitaria numa consulta direta.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: invite, error: fetchError } = await callerClient
    .from("company_invites")
    .select("id, email, role, company_name, status, expires_at")
    .eq("id", inviteId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (fetchError) {
    return json({ error: "falha ao consultar o convite" }, 500);
  }
  if (!invite) {
    // Não distinguimos "não existe" de "sem permissão" nem "expirado" na
    // resposta — qualquer um desses casos deve se comportar da mesma forma
    // para quem está do lado de fora dessa autorização.
    return json(
      { error: "convite não encontrado, expirado, revogado, ou sem permissão para notificá-lo" },
      403,
    );
  }

  // Só chegamos aqui se o chamador está autorizado a notificar este convite
  // específico. Agora sim faz sentido checar se o envio em si está possível.
  if (!RESEND_API_KEY) {
    return json(
      { error: "RESEND_API_KEY não configurada nos secrets desta Edge Function." },
      500,
    );
  }

  const acceptUrl = `${APP_BASE_URL}/login?email=${encodeURIComponent(invite.email)}&invite=1`;
  const expiresLabel = new Date(invite.expires_at).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const roleLabel = ROLE_LABEL[invite.role] ?? invite.role;
  const companyName = escapeHtml(invite.company_name);

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; color: #3f3b46;">
      <p style="color:#7c3aed; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; font-size:13px;">Gestão de Atendimento Pro</p>
      <h2 style="color:#0d0b12;">Você foi convidado(a) para ${companyName}</h2>
      <p>Você foi convidado(a) para participar da empresa <strong>${companyName}</strong> no Gestão de Atendimento Pro, como <strong>${roleLabel}</strong>.</p>
      <p>Este convite é válido até <strong>${expiresLabel}</strong>.</p>
      <p style="margin: 24px 0;">
        <a href="${acceptUrl}" style="background:#7c3aed; color:#fff; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:600; display:inline-block;">Entrar no Gestão de Atendimento Pro</a>
      </p>
      <p style="color:#6b6375; font-size:13px;">
        Se você ainda não tem conta, clique no botão acima e crie uma usando exatamente
        o e-mail <strong>${escapeHtml(invite.email)}</strong> — é assim que o Gestão de Atendimento Pro
        reconhece que o convite é seu.
      </p>
    </div>
  `;

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Gestão de Atendimento Pro <noreply@alexproapps.com.br>",
      to: [invite.email],
      subject: `Convite para ${invite.company_name} no Gestão de Atendimento Pro`,
      html,
    }),
  });

  if (!resendResponse.ok) {
    const detail = await resendResponse.text();
    console.error("Resend API error:", resendResponse.status, detail);
    return json({ error: "falha ao enviar e-mail pelo provedor" }, 502);
  }

  // Bookkeeping interno (quando o e-mail foi enviado pela última vez), só
  // depois de já termos confirmado a autorização acima via RLS. service_role
  // é usado apenas aqui, dentro da function, nunca chega ao frontend.
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  await serviceClient
    .from("company_invites")
    .update({ email_last_sent_at: new Date().toISOString() })
    .eq("id", invite.id);

  return json({ ok: true });
});
