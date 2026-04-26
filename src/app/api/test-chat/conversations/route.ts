/**
 * Test-chat conversations API.
 *
 * GET  → list test conversations (is_test = true), most recent first.
 * POST → create a new test conversation with a synthetic +91TEST_* phone.
 *
 * Gated by ENABLE_TEST_CHAT=1 in the environment. Off in production.
 */
import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function gateOff(): boolean {
  return process.env.ENABLE_TEST_CHAT !== "1";
}

const VALID_LANGS = new Set(["en", "hi", "mr", "gu"]);

export async function GET() {
  if (gateOff()) return new Response("not found", { status: 404 });

  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("is_test", true)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Attach last message preview per conversation.
  const withLastMessage = await Promise.all(
    (conversations ?? []).map(async (convo) => {
      const { data: msgs } = await supabase
        .from("messages")
        .select("content, role, created_at")
        .eq("conversation_id", convo.id)
        .order("created_at", { ascending: false })
        .limit(1);
      return {
        ...convo,
        last_message: msgs?.[0]?.content ?? null,
        last_message_role: msgs?.[0]?.role ?? null,
      };
    })
  );

  return Response.json(withLastMessage);
}

export async function POST(request: NextRequest) {
  if (gateOff()) return new Response("not found", { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { language?: string };
  const language = VALID_LANGS.has(body.language ?? "") ? body.language : "en";

  // Synthetic phone — must satisfy unique constraint and never collide with
  // a real Interakt number. The +91TEST_ prefix is non-E.164 so any code
  // path that tries to dial it via Interakt fails fast.
  const synthetic = `+91TEST_${Math.random().toString(36).slice(2, 10)}`;

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      phone: synthetic,
      name: null,
      mode: "agent",
      status: "new",
      language,
      is_test: true,
    })
    .select("id, phone, language, status, created_at")
    .single();

  if (error || !data) {
    return Response.json(
      { error: error?.message ?? "insert failed" },
      { status: 500 }
    );
  }

  return Response.json(data, { status: 201 });
}
