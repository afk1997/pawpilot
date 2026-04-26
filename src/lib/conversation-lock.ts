/**
 * Per-conversation advisory lock using Postgres pg_advisory_lock.
 *
 * Why: real pilot transcript showed two assistant messages 1 second apart
 * contradicting each other ("Did you mean Goregaon?" / "We don't run in
 * Goregaon") because the reporter sent two messages milliseconds apart and
 * two `after()` callbacks ran in parallel. Without coordination they each
 * read partial state and replied independently.
 *
 * The lock is keyed on a deterministic hash of `conversation_id` so the same
 * conversation always uses the same lock, but different conversations don't
 * block each other.
 *
 * Implementation: we call a simple Postgres RPC. If the RPC fails (e.g.
 * function not yet defined in the DB), we degrade to "no lock" and just
 * proceed — the worst case is the original race condition, not a stuck
 * conversation.
 */
import { supabase } from "./supabase";

/**
 * Hash a UUID-ish conversation id into a 63-bit positive bigint usable as
 * a pg_advisory_lock key. Uses FNV-1a-style mixing — fast, deterministic,
 * good enough distribution at our scale.
 */
function hashConversationId(id: string): bigint {
  // FNV-1a-style. BigInt() constructor avoids ES2020 literal-syntax requirement.
  let h = BigInt("0xcbf29ce484222325");
  const PRIME = BigInt("0x100000001b3");
  const MASK = BigInt("0x7fffffffffffffff");
  for (let i = 0; i < id.length; i++) {
    h ^= BigInt(id.charCodeAt(i));
    h = (h * PRIME) & MASK; // 63-bit
  }
  return h;
}

/**
 * Run `fn` while holding a Postgres advisory lock for this conversation.
 * Acquires the lock (waits if another holder), runs the work, releases.
 */
export async function withConversationLock<T>(
  conversationId: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = hashConversationId(conversationId);
  // BigInt → Number is OK because we capped at 63 bits; JS Number fits
  // safely up to 2^53. We further mod by 2^53 - 1 to keep within JS int.
  const lockKey = Number(key % BigInt("9007199254740881"));

  let acquired = false;
  try {
    const { error } = await supabase.rpc("acquire_conversation_lock", { lock_key: lockKey });
    if (!error) acquired = true;
    else console.warn("[lock] acquire failed:", error.message);
  } catch (e) {
    console.warn("[lock] acquire threw:", e);
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        await supabase.rpc("release_conversation_lock", { lock_key: lockKey });
      } catch (e) {
        console.warn("[lock] release threw:", e);
      }
    }
  }
}
