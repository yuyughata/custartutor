import type { SupabaseClient } from '@supabase/supabase-js';

export interface NewChild {
  id: string;
  householdId: string;
  alias: string;
  avatar: string | null;
  levelCode: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
  readingMode: 'reader' | 'pre_reader';
}

export interface PinStatus {
  hasPin: boolean;
  lockedUntil: string | null;
}

/**
 * Account-level actions that need the network and a signed-in guardian (not part of sync). The real
 * implementation uses supabase-js; demo mode supplies an in-memory one.
 */
export interface HouseholdApi {
  signInWithEmail(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  /** Creates the guardian's household (their first). Returns its id. */
  createHousehold(name: string): Promise<string>;
  createChild(child: NewChild): Promise<void>;
  pinStatus(): Promise<PinStatus>;
}

export function createSupabaseHouseholdApi(supabase: SupabaseClient): HouseholdApi {
  return {
    async signInWithEmail(email) {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) throw new Error(error.message);
    },
    async verifyEmailCode(email, code) {
      const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
      if (error) throw new Error(error.message);
    },
    async signOut() {
      await supabase.auth.signOut();
    },
    async createHousehold(name) {
      const { data, error } = await supabase.rpc('create_household', { p_name: name });
      if (error) throw new Error(error.message);
      return data as string;
    },
    async createChild(child) {
      const { error } = await supabase.from('children').insert({
        id: child.id,
        household_id: child.householdId,
        display_alias: child.alias,
        avatar: child.avatar,
        level_code: child.levelCode,
        reading_mode: child.readingMode,
      });
      if (error) throw new Error(error.message);
    },
    async pinStatus() {
      const { data, error } = await supabase.rpc('get_grownup_pin_status');
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as
        { has_pin: boolean; locked_until: string | null } | undefined;
      return { hasPin: row?.has_pin ?? false, lockedUntil: row?.locked_until ?? null };
    },
  };
}
